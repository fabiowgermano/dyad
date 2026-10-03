import crypto from "node:crypto";
import type { ModelSelection } from "@/lib/schemas";
import type {
  FactoryCreatePrototypeRequest,
  FactoryPrototypeOperation,
} from "./protocol";
import type { PrototypeExecutor } from "./durable_runtime";
import { buildSourceManifest } from "./source_manifest";
import { FactoryModelRegistry } from "./model_registry";

export interface DyadCreatedApp {
  appId: number;
  chatId: number;
  resolvedPath: string;
}

export interface DyadExecutionFacade {
  createApp(input: {
    name: string;
    operationId: string;
  }): Promise<DyadCreatedApp>;

  bindModel(input: {
    chatId: number;
    selection: ModelSelection;
  }): Promise<void>;

  runBuild(input: {
    appId: number;
    chatId: number;
    operationId: string;
    intentId: string;
    prompt: string;
  }): Promise<{
    updatedFiles: boolean;
    providerRequestId?: string;
  }>;

  startPreview(input: {
    appId: number;
    operationId: string;
  }): Promise<string>;
}

export class DyadPrototypeExecutor implements PrototypeExecutor {
  constructor(
    private readonly facade: DyadExecutionFacade,
    private readonly models: FactoryModelRegistry,
  ) {}

  async execute(
    request: FactoryCreatePrototypeRequest,
    identity: { operationId: string },
  ): Promise<
    Omit<
      FactoryPrototypeOperation,
      "protocolVersion" | "operationId" | "idempotencyKey"
    >
  > {
    const selection = this.models.resolve(request.model);
    if (selection.provider === "claude-code") {
      throw new Error(
        "Factory Dyad v1 does not admit the claude-code execution backend",
      );
    }

    const created = await this.facade.createApp({
      name: projectName(identity.operationId),
      operationId: identity.operationId,
    });

    await this.facade.bindModel({
      chatId: created.chatId,
      selection,
    });

    const beforeBuild = await buildSourceManifest(created.resolvedPath);
    let buildManifest = beforeBuild;
    let providerRequestId: string | undefined;

    for (let turn = 1; turn <= MAX_BUILD_TURNS; turn++) {
      const build = await this.facade.runBuild({
        appId: created.appId,
        chatId: created.chatId,
        operationId: `${identity.operationId}-build-${turn}`,
        intentId: intentId(identity.operationId, request.idempotencyKey, turn),
        prompt:
          turn === 1
            ? renderBuildPrompt(request, beforeBuild.files.map((file) => file.path))
            : renderRepairPrompt(
                request,
                beforeBuild.files.map((file) => file.path),
              ),
      });
      providerRequestId = build.providerRequestId ?? providerRequestId;
      buildManifest = await buildSourceManifest(created.resolvedPath);
      if (buildManifest.sourceSha256 !== beforeBuild.sourceSha256) {
        break;
      }
    }

    // Freeze source evidence immediately after the Dyad build. Preview startup
    // may install dependencies or create package-manager metadata; those are
    // runtime side effects and must never be allowed to manufacture a false
    // "prototype changed" signal or contaminate the artifact hash.
    if (buildManifest.sourceSha256 === beforeBuild.sourceSha256) {
      throw new Error(
        `Dyad build completed without changing prototype source after ${MAX_BUILD_TURNS} bounded turns`,
      );
    }

    let previewRef: string | undefined;
    if (request.requirement === "functional") {
      previewRef = await this.facade.startPreview({
        appId: created.appId,
        operationId: identity.operationId,
      });
    }

    return {
      state: "completed",
      projectId: String(created.appId),
      previewRef,
      files: buildManifest.files,
      sourceSha256: buildManifest.sourceSha256,
      providerRequestId,
    };
  }
}

function projectName(operationId: string): string {
  const compact = operationId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(-48);
  return `Factory ${compact || crypto.randomUUID()}`;
}

const MAX_BUILD_TURNS = 2;
const MAX_WORKSPACE_HINT_FILES = 120;

function intentId(
  operationId: string,
  idempotencyKey: string,
  turn: number,
): string {
  return crypto
    .createHash("sha256")
    .update(
      `factory-dyad-turn\0${operationId}\0${idempotencyKey}\0${turn}`,
    )
    .digest("hex");
}

function toolArgumentContract(): string {
  return (
    'Tool argument names are strict: call read_file with {"path":"src/..."} (never "file_path"), and call write_file with {"path":"src/...","content":"..."} (never "file_path"). '
  );
}

function workspaceHint(paths: string[]): string {
  return paths
    .filter(
      (filePath) =>
        filePath === "package.json" ||
        filePath.startsWith("src/") ||
        filePath.startsWith("app/"),
    )
    .slice(0, MAX_WORKSPACE_HINT_FILES)
    .map((filePath) => `- ${filePath}`)
    .join("\n");
}

function renderBuildPrompt(
  request: FactoryCreatePrototypeRequest,
  workspacePaths: string[],
): string {
  let prompt =
    "# Factory headless execution contract\n" +
    "You are executing an automated prototype build with no interactive renderer. " +
    "Do not answer with suggested code, snippets, instructions, or a prose-only solution. " +
    "Inspect the existing workspace with the available file tools, then use the available mutation tools to implement the requested prototype directly in the workspace. " +
    toolArgumentContract() +
    "Preserve existing dependencies unless the brief explicitly requires otherwise. " +
    "Finish only after the requested source changes have actually been written to disk.\n\n" +
    "# Known workspace files\n" +
    (workspaceHint(workspacePaths) || "- inspect the workspace with file tools") +
    "\n\n# Prototype brief\n" +
    request.brief.trim();

  if (request.references.length === 0) return prompt;

  prompt +=
    "\n\n# Factory reference material\n" +
    "The following inputs are read-only, pinned references supplied by Factory. " +
    "Use them as context; do not claim they were modified.\n";

  for (const reference of request.references) {
    prompt +=
      `\n## ${reference.repository}@${reference.revision}:${reference.path}\n` +
      `SHA-256: ${reference.sha256}\n` +
      "~~~text\n" +
      reference.content +
      "\n~~~\n";
  }
  return prompt;
}


function renderRepairPrompt(
  request: FactoryCreatePrototypeRequest,
  workspacePaths: string[],
): string {
  return (
    "# Factory headless build correction\n" +
    "The previous build turn completed without writing any source change. " +
    "This operation cannot succeed with a prose answer. Do not ask the user questions and do not merely show code. " +
    "Use the available file-reading and file-mutation tools now. Inspect one of the known existing source files below, then write the requested implementation into the actual workspace. " +
    toolArgumentContract() +
    "Finish only after a mutation tool succeeds.\n\n" +
    "# Known workspace files\n" +
    (workspaceHint(workspacePaths) || "- inspect the workspace with file tools") +
    "\n\n# Prototype brief\n" +
    request.brief.trim()
  );
}
