import crypto from "node:crypto";
import type {
  FactoryCreatePrototypeRequest,
  FactoryPrototypeOperation,
} from "./protocol";
import { PrototypeOperationStore } from "./operation_store";
import { FactoryExecutionError } from "./prototype_executor";
import type { FactoryPrototypeRuntime } from "./runtime";

export interface PrototypeExecutor {
  execute(
    request: FactoryCreatePrototypeRequest,
    identity: {
      operationId: string;
    },
  ): Promise<
    Omit<
      FactoryPrototypeOperation,
      "protocolVersion" | "operationId" | "idempotencyKey"
    >
  >;
  reconcileCompleted?(
    operation: FactoryPrototypeOperation,
  ): Promise<FactoryPrototypeOperation>;
}

export interface DurableFactoryPrototypeRuntimeOptions {
  store: PrototypeOperationStore;
  executor: PrototypeExecutor;
  operationId?: () => string;
}

/**
 * Durable Factory provider runtime.
 *
 * Admission is persisted before provider execution starts. That ordering is
 * deliberate: if the Windows service dies after accepting a request, a replay
 * with the same idempotency key can discover the prior operation instead of
 * launching a second build.
 */
export class DurableFactoryPrototypeRuntime implements FactoryPrototypeRuntime {
  private readonly store: PrototypeOperationStore;
  private readonly executor: PrototypeExecutor;
  private readonly operationId: () => string;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly reconciliations = new Map<
    string,
    Promise<FactoryPrototypeOperation>
  >();

  constructor(options: DurableFactoryPrototypeRuntimeOptions) {
    this.store = options.store;
    this.executor = options.executor;
    this.operationId =
      options.operationId ?? (() => `op-${crypto.randomUUID()}`);
    this.store.recoverInterruptedOperations();
  }

  async createPrototype(
    request: FactoryCreatePrototypeRequest,
  ): Promise<FactoryPrototypeOperation> {
    const existing = this.store.getByIdempotencyKey(request.idempotencyKey);
    if (existing) {
      if (existing.inputSha256 !== request.inputSha256) {
        return {
          protocolVersion: "v1",
          operationId: existing.operation.operationId,
          idempotencyKey: request.idempotencyKey,
          state: "rejected",
          errorCode: "IDEMPOTENCY_CONFLICT",
          errorMessage:
            "The idempotency key was already admitted for a different input SHA-256.",
        };
      }
      return { ...existing.operation, replayed: true };
    }

    const operation: FactoryPrototypeOperation = {
      protocolVersion: "v1",
      operationId: this.operationId(),
      idempotencyKey: request.idempotencyKey,
      state: "accepted",
      model: request.model,
    };

    try {
      this.store.create(operation, request.inputSha256);
    } catch (error) {
      // Another request may have won the unique idempotency-key race between
      // our lookup and insert. Re-read instead of guessing or executing twice.
      const raced = this.store.getByIdempotencyKey(request.idempotencyKey);
      if (raced) {
        if (raced.inputSha256 !== request.inputSha256) {
          return {
            protocolVersion: "v1",
            operationId: raced.operation.operationId,
            idempotencyKey: request.idempotencyKey,
            state: "rejected",
            errorCode: "IDEMPOTENCY_CONFLICT",
            errorMessage:
              "The idempotency key was concurrently admitted for a different input SHA-256.",
          };
        }
        return { ...raced.operation, replayed: true };
      }
      throw error;
    }

    this.startExecution(request, operation);
    return operation;
  }

  async getOperation(
    operationId: string,
  ): Promise<FactoryPrototypeOperation | null> {
    const stored = this.store.getByOperationId(operationId)?.operation ?? null;
    if (
      !stored ||
      stored.state !== "completed" ||
      !stored.previewRef ||
      !this.executor.reconcileCompleted
    ) {
      return stored;
    }

    const existing = this.reconciliations.get(operationId);
    if (existing) return existing;

    const reconciliation = this.reconcileCompleted(stored).finally(() => {
      this.reconciliations.delete(operationId);
    });
    this.reconciliations.set(operationId, reconciliation);
    return reconciliation;
  }

  private async reconcileCompleted(
    stored: FactoryPrototypeOperation,
  ): Promise<FactoryPrototypeOperation> {
    const refreshed = await this.executor.reconcileCompleted!(stored);
    if (
      refreshed.operationId !== stored.operationId ||
      refreshed.idempotencyKey !== stored.idempotencyKey ||
      refreshed.state !== "completed"
    ) {
      throw new Error(
        "completed prototype reconciliation changed operation identity",
      );
    }
    this.store.update(refreshed);
    return refreshed;
  }

  private startExecution(
    request: FactoryCreatePrototypeRequest,
    admitted: FactoryPrototypeOperation,
  ): void {
    const existing = this.inFlight.get(admitted.operationId);
    if (existing) return;

    const execution = this.runExecution(request, admitted).finally(() => {
      this.inFlight.delete(admitted.operationId);
    });
    this.inFlight.set(admitted.operationId, execution);
    void execution;
  }

  private async runExecution(
    request: FactoryCreatePrototypeRequest,
    admitted: FactoryPrototypeOperation,
  ): Promise<void> {
    const running: FactoryPrototypeOperation = {
      ...admitted,
      state: "running",
    };
    this.store.update(running);

    try {
      const result = await this.executor.execute(request, {
        operationId: admitted.operationId,
      });
      this.store.update({
        protocolVersion: "v1",
        operationId: admitted.operationId,
        idempotencyKey: admitted.idempotencyKey,
        ...result,
      });
    } catch (error) {
      // What the provider spent before failing is still the operation's usage.
      const detail =
        error instanceof FactoryExecutionError ? error.detail : undefined;
      this.store.update({
        ...running,
        state: "failed",
        errorCode: detail?.errorCode ?? "EXECUTION_FAILED",
        errorMessage: safeErrorMessage(error),
        ...(detail?.usage ? { usage: detail.usage } : {}),
        ...(detail?.build ? { build: detail.build } : {}),
        ...(detail?.resolvedModel
          ? { resolvedModel: detail.resolvedModel }
          : {}),
      });
    }
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_000);
}
