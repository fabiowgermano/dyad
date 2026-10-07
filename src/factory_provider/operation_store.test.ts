// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PrototypeOperationStore } from "./operation_store";

const tempDirs: string[] = [];
const stores: PrototypeOperationStore[] = [];

async function createStore() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "factory-op-store-"));
  tempDirs.push(dir);
  const store = new PrototypeOperationStore(path.join(dir, "operations.db"));
  stores.push(store);
  return { dir, store };
}

afterEach(async () => {
  while (stores.length) stores.pop()!.close();
  await Promise.all(
    tempDirs
      .splice(0)
      .map((dir) =>
        fs.rm(dir, { recursive: true, force: true }).catch(() => undefined),
      ),
  );
});

describe("PrototypeOperationStore", () => {
  it("persists operations across process-like reopen", async () => {
    const { dir, store } = await createStore();
    const operation = {
      protocolVersion: "v1" as const,
      operationId: "op-1",
      idempotencyKey: "idem-1",
      state: "accepted" as const,
      projectId: "project-1",
    };
    store.create(operation, "a".repeat(64));
    store.close();
    stores.pop();

    const reopened = new PrototypeOperationStore(
      path.join(dir, "operations.db"),
    );
    stores.push(reopened);
    expect(reopened.getByOperationId("op-1")?.operation).toEqual(operation);
    expect(reopened.getByIdempotencyKey("idem-1")?.inputSha256).toBe(
      "a".repeat(64),
    );
  });

  it("enforces one operation per idempotency key", async () => {
    const { store } = await createStore();
    store.create(
      {
        protocolVersion: "v1",
        operationId: "op-1",
        idempotencyKey: "same-key",
        state: "accepted",
      },
      "a".repeat(64),
    );

    expect(() =>
      store.create(
        {
          protocolVersion: "v1",
          operationId: "op-2",
          idempotencyKey: "same-key",
          state: "accepted",
        },
        "b".repeat(64),
      ),
    ).toThrow();
  });

  it("recovers accepted/running operations as indeterminate after restart", async () => {
    const { dir, store } = await createStore();
    store.create(
      {
        protocolVersion: "v1",
        operationId: "op-accepted",
        idempotencyKey: "idem-accepted",
        state: "accepted",
      },
      "a".repeat(64),
    );
    store.create(
      {
        protocolVersion: "v1",
        operationId: "op-done",
        idempotencyKey: "idem-done",
        state: "completed",
        projectId: "p1",
        sourceSha256: "b".repeat(64),
        files: [],
      },
      "c".repeat(64),
    );
    store.close();
    stores.pop();

    const reopened = new PrototypeOperationStore(
      path.join(dir, "operations.db"),
    );
    stores.push(reopened);
    expect(reopened.recoverInterruptedOperations()).toBe(1);
    expect(reopened.getByOperationId("op-accepted")?.operation).toMatchObject({
      state: "indeterminate",
      errorCode: "SERVICE_RESTARTED_DURING_OPERATION",
    });
    expect(reopened.getByOperationId("op-done")?.operation.state).toBe(
      "completed",
    );
  });

  it("updates terminal operation state without changing input identity", async () => {
    const { store } = await createStore();
    store.create(
      {
        protocolVersion: "v1",
        operationId: "op-1",
        idempotencyKey: "idem-1",
        state: "accepted",
      },
      "a".repeat(64),
    );
    store.update({
      protocolVersion: "v1",
      operationId: "op-1",
      idempotencyKey: "idem-1",
      state: "completed",
      sourceSha256: "b".repeat(64),
      files: [],
    });

    const stored = store.getByOperationId("op-1");
    expect(stored?.operation.state).toBe("completed");
    expect(stored?.inputSha256).toBe("a".repeat(64));
  });
});
