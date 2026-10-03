import crypto from "node:crypto";
import type {
  FactoryCreatePrototypeRequest,
  FactoryPrototypeOperation,
} from "./protocol";
import { PrototypeOperationStore } from "./operation_store";
import type { FactoryPrototypeRuntime } from "./runtime";

export interface PrototypeExecutor {
  execute(
    request: FactoryCreatePrototypeRequest,
    identity: {
      operationId: string;
    },
  ): Promise<Omit<FactoryPrototypeOperation, "protocolVersion" | "operationId" | "idempotencyKey">>;
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

  constructor(options: DurableFactoryPrototypeRuntimeOptions) {
    this.store = options.store;
    this.executor = options.executor;
    this.operationId =
      options.operationId ?? (() => `op-${crypto.randomUUID()}`);
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
      return existing.operation;
    }

    const operation: FactoryPrototypeOperation = {
      protocolVersion: "v1",
      operationId: this.operationId(),
      idempotencyKey: request.idempotencyKey,
      state: "accepted",
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
        return raced.operation;
      }
      throw error;
    }

    this.startExecution(request, operation);
    return operation;
  }

  async getOperation(
    operationId: string,
  ): Promise<FactoryPrototypeOperation | null> {
    return this.store.getByOperationId(operationId)?.operation ?? null;
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
      this.store.update({
        ...running,
        state: "failed",
        errorCode: "EXECUTION_FAILED",
        errorMessage: safeErrorMessage(error),
      });
    }
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_000);
}
