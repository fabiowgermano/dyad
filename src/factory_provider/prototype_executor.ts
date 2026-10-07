import crypto from "node:crypto";
import type { ModelSelection } from "@/lib/schemas";
import type {
  FactoryCreatePrototypeRequest,
  FactoryPrototypeOperation,
} from "./protocol";
import type { PrototypeExecutor } from "./durable_runtime";
import { buildSourceManifest, type SourceManifest } from "./source_manifest";
import {
  buildReachableFunctionalPaths,
  isFunctionalCodePath,
} from "./source_reachability";
import { FactoryModelRegistry } from "./model_registry";
import { FactoryUsageCollector, type FactoryLimitHit } from "./usage_collector";
import type { FactoryPrototypeBuild, FactoryPrototypeUsage } from "./protocol";

/**
 * A failed execution that keeps what the provider spent before it failed, so
 * the operation can report usage and model even when it did not complete.
 */
export class FactoryExecutionError extends Error {
  constructor(
    message: string,
    readonly detail: {
      errorCode?: string;
      usage?: FactoryPrototypeUsage;
      build?: FactoryPrototypeBuild;
      resolvedModel?: { provider: string; name: string };
    },
  ) {
    super(message);
    this.name = "FactoryExecutionError";
  }
}

/** A contract v0.4 ceiling was reached; the build stopped. */
export class FactoryLimitReachedError extends Error {
  constructor(readonly hit: FactoryLimitHit) {
    super(
      `LIMIT_REACHED: ${hit.limit} ${hit.ceiling} reached (seen ${hit.seen}); the build was stopped`,
    );
    this.name = "FactoryLimitReachedError";
  }
}

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
    /** Attached to the chat for this turn; counts the turn and its usage. */
    usage: FactoryUsageCollector;
  }): Promise<{
    updatedFiles: boolean;
    providerRequestId?: string;
  }>;

  verifyBuild(input: { appPath: string }): Promise<{
    ok: boolean;
    error?: string;
    /** The install and build command that ran, for the operation record. */
    command?: string;
  }>;

  startPreview(input: { appId: number; operationId: string }): Promise<string>;
}

export class DyadPrototypeExecutor implements PrototypeExecutor {
  constructor(
    private readonly facade: DyadExecutionFacade,
    private readonly models: FactoryModelRegistry,
  ) {}

  async reconcileCompleted(
    operation: FactoryPrototypeOperation,
  ): Promise<FactoryPrototypeOperation> {
    if (
      operation.state !== "completed" ||
      !operation.previewRef ||
      !operation.projectId
    ) {
      return operation;
    }

    const appId = Number(operation.projectId);
    if (!Number.isSafeInteger(appId) || appId <= 0) {
      throw new Error("completed Dyad operation has an invalid project id");
    }

    const previewRef = await this.facade.startPreview({
      appId,
      operationId: operation.operationId,
    });
    return { ...operation, previewRef };
  }

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
    const usage = new FactoryUsageCollector(request.limits);
    const resolvedModel = {
      provider: selection.provider,
      name: selection.name,
    };
    const evidence: { build?: FactoryPrototypeBuild } = {};
    try {
      return await this.run(
        request,
        identity,
        selection,
        usage,
        resolvedModel,
        evidence,
      );
    } catch (error) {
      throw new FactoryExecutionError(
        error instanceof Error ? error.message : String(error),
        {
          usage: usage.snapshot(),
          resolvedModel,
          build: evidence.build,
          ...(error instanceof FactoryLimitReachedError
            ? { errorCode: "LIMIT_REACHED" }
            : {}),
        },
      );
    }
  }

  private async run(
    request: FactoryCreatePrototypeRequest,
    identity: { operationId: string },
    selection: ReturnType<FactoryModelRegistry["resolve"]>,
    usage: FactoryUsageCollector,
    resolvedModel: { provider: string; name: string },
    evidence: { build?: FactoryPrototypeBuild },
  ): Promise<
    Omit<
      FactoryPrototypeOperation,
      "protocolVersion" | "operationId" | "idempotencyKey"
    >
  > {
    const created = await this.facade.createApp({
      name: projectName(identity.operationId),
      operationId: identity.operationId,
    });

    await this.facade.bindModel({
      chatId: created.chatId,
      selection,
    });

    const beforeBuild = await buildSourceManifest(created.resolvedPath);
    const beforeReachable =
      request.requirement === "functional"
        ? await buildReachableFunctionalPaths(created.resolvedPath, beforeBuild)
        : new Set<string>();
    let buildManifest = beforeBuild;
    let providerRequestId: string | undefined;
    let functionalBuildVerified = request.requirement !== "functional";
    let lastVerificationError: string | undefined;
    let admissibleBuildChange = false;

    for (let turn = 1; turn <= MAX_BUILD_TURNS; turn++) {
      const manifestBeforeTurn = buildManifest;
      const build = await this.facade.runBuild({
        appId: created.appId,
        chatId: created.chatId,
        operationId: `${identity.operationId}-build-${turn}`,
        usage,
        intentId: intentId(identity.operationId, request.idempotencyKey, turn),
        prompt:
          turn === 1
            ? renderBuildPrompt(
                request,
                beforeBuild.files.map((file) => file.path),
              )
            : renderRepairPrompt(
                request,
                beforeBuild.files.map((file) => file.path),
                lastVerificationError,
              ),
      });
      providerRequestId = build.providerRequestId ?? providerRequestId;
      const hit = usage.limitHit();
      if (hit) throw new FactoryLimitReachedError(hit);
      buildManifest = await buildSourceManifest(created.resolvedPath);

      const turnChanged =
        buildManifest.sourceSha256 !== manifestBeforeTurn.sourceSha256;
      const afterReachable =
        request.requirement === "functional"
          ? await buildReachableFunctionalPaths(
              created.resolvedPath,
              buildManifest,
            )
          : new Set<string>();
      admissibleBuildChange = isAdmissibleBuildChange(
        request,
        beforeBuild,
        buildManifest,
        beforeReachable,
        afterReachable,
      );

      if (!admissibleBuildChange) {
        continue;
      }

      if (request.requirement !== "functional") {
        break;
      }

      // After a failed verification, the repair turn must actually change
      // source again before the same candidate can be re-verified.
      if (turn > 1 && lastVerificationError && !turnChanged) {
        continue;
      }

      const verification = await this.facade.verifyBuild({
        appPath: created.resolvedPath,
      });
      const command = verification.command ?? "build verification";
      if (verification.ok) {
        evidence.build = { ok: true, command };
        functionalBuildVerified = true;
        break;
      }

      lastVerificationError =
        verification.error ?? "build verification failed without details";
      evidence.build = {
        ok: false,
        command,
        error: lastVerificationError.slice(0, 2_000),
      };
    }

    // Freeze source evidence immediately after the Dyad build. Verification
    // may install dependencies or emit generated build outputs; those are
    // runtime side effects and must never manufacture a false source-change
    // signal or contaminate the returned artifact hash.
    if (!admissibleBuildChange) {
      const reason =
        request.requirement === "functional"
          ? "without an admissible functional source change"
          : "without changing prototype source";
      throw new Error(
        `Dyad build completed ${reason} after ${MAX_BUILD_TURNS} bounded turns`,
      );
    }

    if (request.requirement === "functional" && !functionalBuildVerified) {
      throw new Error(
        `Dyad functional build verification failed after ${MAX_BUILD_TURNS} bounded turns: ${lastVerificationError ?? "unknown build error"}`,
      );
    }

    let previewRef: string | undefined;
    if (request.requirement === "functional") {
      previewRef = await this.facade.startPreview({
        appId: created.appId,
        operationId: identity.operationId,
      });
    }

    // The preview serves the workspace the build produced. Starting it may add
    // files (a lockfile, caches) that never belong to the frozen source, but
    // no file of the frozen source may have changed or disappeared: that would
    // make the preview something other than the source recorded here.
    if (previewRef) {
      const served = await buildSourceManifest(created.resolvedPath);
      const servedByPath = new Map(
        served.files.map((file) => [file.path, file.sha256] as const),
      );
      const drifted = buildManifest.files.filter(
        (file) => servedByPath.get(file.path) !== file.sha256,
      );
      if (drifted.length > 0) {
        throw new Error(
          `Prototype source changed after the build was frozen (${drifted
            .slice(0, 5)
            .map((file) => file.path)
            .join(", ")}); the preview does not match the recorded source`,
        );
      }
    }

    return {
      state: "completed",
      projectId: String(created.appId),
      previewRef,
      files: buildManifest.files,
      sourceSha256: buildManifest.sourceSha256,
      // The frozen source was intact while the preview was live.
      ...(previewRef
        ? { previewSourceSha256: buildManifest.sourceSha256 }
        : {}),
      providerRequestId,
      usage: usage.snapshot(),
      // A functional prototype only completes after a passing build.
      ...(evidence.build ? { build: evidence.build } : {}),
      model: request.model,
      resolvedModel,
      ...(request.limits ? { limits: request.limits } : {}),
    };
  }
}

function isAdmissibleBuildChange(
  request: FactoryCreatePrototypeRequest,
  before: SourceManifest,
  after: SourceManifest,
  beforeReachable: Set<string>,
  afterReachable: Set<string>,
): boolean {
  if (after.sourceSha256 === before.sourceSha256) return false;
  if (request.requirement !== "functional") return true;

  const beforeByPath = new Map(
    before.files.map((file) => [file.path, file.sha256] as const),
  );
  const reachable = new Set([...beforeReachable, ...afterReachable]);

  return after.files.some((file) => {
    if (!isFunctionalCodePath(file.path) || !reachable.has(file.path)) {
      return false;
    }
    return beforeByPath.get(file.path) !== file.sha256;
  });
}

function projectName(operationId: string): string {
  const compact = operationId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(-48);
  return `Factory ${compact || crypto.randomUUID()}`;
}

const MAX_BUILD_TURNS = 3;
const MAX_WORKSPACE_HINT_FILES = 120;

function intentId(
  operationId: string,
  idempotencyKey: string,
  turn: number,
): string {
  return crypto
    .createHash("sha256")
    .update(`factory-dyad-turn\0${operationId}\0${idempotencyKey}\0${turn}`)
    .digest("hex");
}

function toolArgumentContract(): string {
  return 'Tool argument names are strict: call read_file with {"path":"src/..."} (never "file_path"), and call write_file with {"path":"src/...","content":"..."} (never "file_path"). ';
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
    "Prioritize user-visible implementation in reachable app code; do not satisfy the request with ancillary config, lockfile, or stylesheet-only changes. " +
    "If you create a new page or component, wire it into the existing entry point or routing unless the framework makes the new file reachable by convention. " +
    "Finish only after the requested behavior and acceptance criteria are implemented in the actual app.\n\n" +
    "# Known workspace files\n" +
    (workspaceHint(workspacePaths) ||
      "- inspect the workspace with file tools") +
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
  buildVerificationError?: string,
): string {
  const verificationContext = buildVerificationError
    ? "\n\n# Build verification failure\nThe previous implementation did not compile. Fix this exact build failure before finishing:\n" +
      buildVerificationError.trim()
    : "";

  return (
    "# Factory headless build correction\n" +
    "The previous build turn did not produce an admissible, buildable implementation of the requested prototype. " +
    "This operation cannot succeed with a prose answer, an ancillary config/style-only change, or an unreferenced new page. Do not ask the user questions and do not merely show code. " +
    "The previous turn already inspected the workspace, so keep further inspection minimal. " +
    "Use write_file or search_replace now to implement the requested prototype in reachable app code, wiring any new surface into the existing entry point or routing when required. " +
    toolArgumentContract() +
    "Continue until the requested behavior and acceptance criteria are observable in the app." +
    verificationContext +
    "\n\n# Known workspace files\n" +
    (workspaceHint(workspacePaths) ||
      "- inspect the workspace with file tools") +
    "\n\n# Prototype brief\n" +
    request.brief.trim()
  );
}
