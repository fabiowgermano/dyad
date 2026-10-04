// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PrototypeOperationStore } from "./operation_store";
import {
  DurableFactoryPrototypeRuntime,
  type PrototypeExecutor,
} from "./durable_runtime";
import type { FactoryCreatePrototypeRequest } from "./protocol";

const dirs: string[] = [];
const stores: PrototypeOperationStore[] = [];

async function makeStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "factory-runtime-"));
  dirs.push(dir);
  const store = new PrototypeOperationStore(path.join(dir, "operations.db"));
  stores.push(store);
  return store;
}

afterEach(async () => {
  while (stores.length) stores.pop()!.close();
  await Promise.all(
    dirs
      .splice(0)
      .map((dir) =>
        fs.rm(dir, { recursive: true, force: true }).catch(() => undefined),
      ),
  );
});

function request(
  overrides: Partial<FactoryCreatePrototypeRequest> = {},
): FactoryCreatePrototypeRequest {
  return {
    idempotencyKey: "idem-1234567890123456",
    inputSha256: "a".repeat(64),
    requirement: "functional",
    brief: "Build it",
    references: [],
    model: {
      provider: "openrouter",
      modelId: "example/model",
      configSha256: "b".repeat(64),
    },
    ...overrides,
  };
}

async function eventually<T>(
  fn: () => Promise<T> | T,
  predicate: (value: T) => boolean,
): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await fn();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not reached");
}

describe("DurableFactoryPrototypeRuntime", () => {
  it("persists admission before asynchronous execution", async () => {
    const store = await makeStore();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor: PrototypeExecutor = {
      async execute() {
        await blocked;
        return { state: "completed", files: [], sourceSha256: "c".repeat(64) };
      },
    };
    const runtime = new DurableFactoryPrototypeRuntime({
      store,
      executor,
      operationId: () => "op-1",
    });

    const admitted = await runtime.createPrototype(request());
    expect(admitted.state).toBe("accepted");
    expect(store.getByOperationId("op-1")).not.toBeNull();

    release();
    const completed = await eventually(
      () => runtime.getOperation("op-1"),
      (value) => value?.state === "completed",
    );
    expect(completed?.sourceSha256).toBe("c".repeat(64));
  });

  it("does not replay an interrupted operation after service restart", async () => {
    const store = await makeStore();
    store.create(
      {
        protocolVersion: "v1",
        operationId: "op-interrupted",
        idempotencyKey: "idem-1234567890123456",
        state: "running",
      },
      "a".repeat(64),
    );
    let executions = 0;
    const runtime = new DurableFactoryPrototypeRuntime({
      store,
      executor: {
        async execute() {
          executions++;
          return {
            state: "completed",
            files: [],
            sourceSha256: "c".repeat(64),
          };
        },
      },
    });

    const replay = await runtime.createPrototype(request());
    expect(replay.state).toBe("indeterminate");
    expect(replay.operationId).toBe("op-interrupted");
    expect(executions).toBe(0);
  });

  it("replays the same admitted operation for the same idempotency input", async () => {
    const store = await makeStore();
    let executions = 0;
    const executor: PrototypeExecutor = {
      async execute() {
        executions++;
        return { state: "completed", files: [], sourceSha256: "c".repeat(64) };
      },
    };
    const runtime = new DurableFactoryPrototypeRuntime({
      store,
      executor,
      operationId: () => "op-1",
    });

    const first = await runtime.createPrototype(request());
    const replay = await runtime.createPrototype(request());

    expect(replay.operationId).toBe(first.operationId);
    await eventually(
      () => runtime.getOperation("op-1"),
      (value) => value?.state === "completed",
    );
    expect(executions).toBe(1);
  });

  it("deduplicates completed preview reconciliation after restart", async () => {
    const store = await makeStore();
    const completed = {
      protocolVersion: "v1" as const,
      operationId: "op-preview",
      idempotencyKey: "idem-preview-1234567890",
      state: "completed" as const,
      projectId: "42",
      previewRef: "http://localhost:41000",
      files: [],
      sourceSha256: "c".repeat(64),
    };
    store.create(completed, "a".repeat(64));

    let reconciliations = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const executor: PrototypeExecutor = {
      async execute() {
        throw new Error("execute must not run during reconciliation");
      },
      async reconcileCompleted(operation) {
        reconciliations++;
        await blocked;
        return { ...operation, previewRef: "http://localhost:42042" };
      },
    };
    const runtime = new DurableFactoryPrototypeRuntime({ store, executor });

    const first = runtime.getOperation("op-preview");
    const second = runtime.getOperation("op-preview");
    release();
    const [one, two] = await Promise.all([first, second]);

    expect(reconciliations).toBe(1);
    expect(one?.previewRef).toBe("http://localhost:42042");
    expect(two?.previewRef).toBe("http://localhost:42042");
    expect(store.getByOperationId("op-preview")?.operation.previewRef).toBe(
      "http://localhost:42042",
    );
  });

  it("rejects reuse of an idempotency key for a different input", async () => {
    const store = await makeStore();
    const executor: PrototypeExecutor = {
      async execute() {
        return { state: "completed", files: [], sourceSha256: "c".repeat(64) };
      },
    };
    const runtime = new DurableFactoryPrototypeRuntime({
      store,
      executor,
      operationId: () => "op-1",
    });

    await runtime.createPrototype(request());
    const conflict = await runtime.createPrototype(
      request({ inputSha256: "d".repeat(64) }),
    );

    expect(conflict.state).toBe("rejected");
    expect(conflict.errorCode).toBe("IDEMPOTENCY_CONFLICT");
  });
});
