// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DyadPrototypeExecutor,
  type DyadExecutionFacade,
} from "./prototype_executor";
import { FactoryModelRegistry } from "./model_registry";

const roots: string[] = [];

async function appRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-executor-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(
    path.join(root, "src", "App.tsx"),
    "export default () => <main>ok</main>;\n",
  );
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }).catch(() => undefined),
    ),
  );
});

function registry() {
  return new FactoryModelRegistry([
    {
      configSha256: "a".repeat(64),
      factoryProvider: "openrouter",
      factoryModelId: "model-a",
      dyad: {
        provider: "openrouter",
        name: "model-a",
        effortLevel: "medium",
        connection: "api-key",
      },
    },
  ]);
}

function request(requirement: "static" | "functional" = "functional") {
  return {
    idempotencyKey: "idem-1234567890123456",
    inputSha256: "b".repeat(64),
    requirement,
    brief: "Build the requested UI.",
    references: [
      {
        repository: "example/reference",
        revision: "deadbeef",
        path: "design.md",
        sha256: "c".repeat(64),
        content: "Use a compact navigation.",
      },
    ],
    model: {
      provider: "openrouter",
      modelId: "model-a",
      configSha256: "a".repeat(64),
    },
  };
}

describe("DyadPrototypeExecutor", () => {
  it("runs create -> model bind -> real build -> preview -> manifest", async () => {
    const root = await appRoot();
    const calls: string[] = [];
    const facade: DyadExecutionFacade = {
      createApp: vi.fn(async () => {
        calls.push("create");
        return { appId: 42, chatId: 7, resolvedPath: root };
      }),
      bindModel: vi.fn(async () => {
        calls.push("model");
      }),
      runBuild: vi.fn(async (input) => {
        calls.push("build");
        expect(input.prompt).toContain("Factory reference material");
        expect(input.prompt).toContain("Use a compact navigation.");
        return { updatedFiles: true, providerRequestId: "req-1" };
      }),
      startPreview: vi.fn(async () => {
        calls.push("preview");
        return "http://127.0.0.1:41342";
      }),
    };

    const executor = new DyadPrototypeExecutor(facade, registry());
    const result = await executor.execute(request(), { operationId: "op-1" });

    expect(calls).toEqual(["create", "model", "build", "preview"]);
    expect(result).toMatchObject({
      state: "completed",
      projectId: "42",
      previewRef: "http://127.0.0.1:41342",
      providerRequestId: "req-1",
    });
    expect(result.files).toHaveLength(1);
    expect(result.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("does not start preview for a static requirement", async () => {
    const root = await appRoot();
    const startPreview = vi.fn(async () => "should-not-run");
    const facade: DyadExecutionFacade = {
      createApp: async () => ({ appId: 42, chatId: 7, resolvedPath: root }),
      bindModel: async () => undefined,
      runBuild: async () => ({ updatedFiles: true }),
      startPreview,
    };
    const executor = new DyadPrototypeExecutor(facade, registry());
    const result = await executor.execute(request("static"), {
      operationId: "op-static",
    });

    expect(startPreview).not.toHaveBeenCalled();
    expect(result.previewRef).toBeUndefined();
  });

  it("fails closed for a model identity that is not admitted", async () => {
    const facade = {} as DyadExecutionFacade;
    const executor = new DyadPrototypeExecutor(facade, registry());
    await expect(
      executor.execute(
        {
          ...request(),
          model: {
            provider: "openrouter",
            modelId: "model-a",
            configSha256: "d".repeat(64),
          },
        },
        { operationId: "op-model" },
      ),
    ).rejects.toThrow("not admitted");
  });
});
