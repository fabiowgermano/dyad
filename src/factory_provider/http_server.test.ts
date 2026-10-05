// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import type { FactoryPrototypeRuntime } from "./runtime";
import type {
  FactoryCreatePrototypeRequest,
  FactoryPrototypeOperation,
} from "./protocol";
import {
  startFactoryProviderServer,
  type FactoryProviderServer,
} from "./http_server";

const TOKEN = "t".repeat(48);
let running: FactoryProviderServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

function requestBody() {
  return {
    idempotencyKey: "idem-1234567890123456",
    inputSha256: "a".repeat(64),
    requirement: "functional",
    brief: "Build the governed prototype",
    references: [],
    model: {
      provider: "openrouter",
      modelId: "example/model",
      configSha256: "b".repeat(64),
    },
  };
}

class FakeRuntime implements FactoryPrototypeRuntime {
  readonly operations = new Map<string, FactoryPrototypeOperation>();

  async createPrototype(
    request: FactoryCreatePrototypeRequest,
  ): Promise<FactoryPrototypeOperation> {
    const operation: FactoryPrototypeOperation = {
      protocolVersion: "v1",
      operationId: "op-1",
      idempotencyKey: request.idempotencyKey,
      state: "accepted",
      projectId: "project-1",
    };
    this.operations.set(operation.operationId, operation);
    return operation;
  }

  async getOperation(
    operationId: string,
  ): Promise<FactoryPrototypeOperation | null> {
    return this.operations.get(operationId) ?? null;
  }
}

async function start(runtime = new FakeRuntime()) {
  running = await startFactoryProviderServer({
    runtime,
    tokens: () => [TOKEN],
    dyadVersion: "test",
    dyadCommit: "deadbeef",
  });
  return {
    runtime,
    baseUrl: `http://${running.host}:${running.port}`,
  };
}

describe("Factory provider HTTP server", () => {
  it("exposes health without credentials", async () => {
    const { baseUrl } = await start();
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ok",
      protocolVersion: "v1",
      dyadVersion: "test",
    });
  });

  it("requires bearer auth for provider operations", async () => {
    const { baseUrl } = await start();
    const response = await fetch(`${baseUrl}/v1/prototypes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody()),
    });
    expect(response.status).toBe(401);
  });

  it("creates and reads an operation", async () => {
    const { baseUrl } = await start();
    const created = await fetch(`${baseUrl}/v1/prototypes`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody()),
    });
    expect(created.status).toBe(202);
    expect(await created.json()).toMatchObject({
      operationId: "op-1",
      state: "accepted",
    });

    const fetched = await fetch(`${baseUrl}/v1/operations/op-1`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(fetched.status).toBe(202);
    expect(await fetched.json()).toMatchObject({ operationId: "op-1" });
  });

  it("rejects invalid governed input", async () => {
    const { baseUrl } = await start();
    const response = await fetch(`${baseUrl}/v1/prototypes`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("accepts the current and the previous token and re-reads them per request", async () => {
    let tokens = ["n".repeat(40), TOKEN];
    running = await startFactoryProviderServer({
      runtime: new FakeRuntime(),
      tokens: () => tokens,
      dyadVersion: "test",
      dyadCommit: "deadbeef",
    });
    const base = `http://${running.host}:${running.port}`;
    const get = (token: string) =>
      fetch(`${base}/v1/operations/op-x`, {
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await get(TOKEN)).status).toBe(404);
    expect((await get("n".repeat(40))).status).toBe(404);
    tokens = ["n".repeat(40)];
    expect((await get(TOKEN)).status).toBe(401);
    expect((await get("n".repeat(40))).status).toBe(404);
    tokens = [];
    expect((await get("n".repeat(40))).status).toBe(401);
  });
});
