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

    const build = await this.facade.runBuild({
      appId: created.appId,
      chatId: created.chatId,
      operationId: identity.operationId,
      intentId: intentId(identity.operationId, request.idempotencyKey),
      prompt: renderBuildPrompt(request),
    });

    let previewRef: string | undefined;
    if (request.requirement === "functional") {
      previewRef = await this.facade.startPreview({
        appId: created.appId,
        operationId: identity.operationId,
      });
    }

    const manifest = await buildSourceManifest(created.resolvedPath);
    return {
      state: "completed",
      projectId: String(created.appId),
      previewRef,
      files: manifest.files,
      sourceSha256: manifest.sourceSha256,
      providerRequestId: build.providerRequestId,
    };
  }
}

function projectName(operationId: string): string {
  const compact = operationId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(-48);
  return `Factory ${compact || crypto.randomUUID()}`;
}

function intentId(operationId: string, idempotencyKey: string): string {
  return crypto
    .createHash("sha256")
    .update(`factory-dyad-turn\0${operationId}\0${idempotencyKey}`)
    .digest("hex");
}

function renderBuildPrompt(request: FactoryCreatePrototypeRequest): string {
  let prompt = request.brief.trim();
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
