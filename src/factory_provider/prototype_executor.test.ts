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
    roots
      .splice(0)
      .map((root) =>
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
        expect(input.prompt).toContain("Factory headless execution contract");
        expect(input.prompt).toContain(
          "implement the requested prototype directly in the workspace",
        );
        expect(input.prompt).toContain(
          'read_file with {"path":"src/..."} (never "file_path")',
        );
        expect(input.prompt).toContain("Factory reference material");
        expect(input.prompt).toContain("Use a compact navigation.");
        await fs.writeFile(
          path.join(root, "src", "App.tsx"),
          "export default () => <main>changed</main>;\n",
        );
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

  it("freezes source evidence before preview runtime side effects", async () => {
    const root = await appRoot();
    const facade: DyadExecutionFacade = {
      createApp: async () => ({ appId: 42, chatId: 7, resolvedPath: root }),
      bindModel: async () => undefined,
      runBuild: async () => {
        await fs.writeFile(
          path.join(root, "src", "App.tsx"),
          "export default () => <main>build output</main>;\n",
        );
        return { updatedFiles: true };
      },
      startPreview: async () => {
        await fs.writeFile(path.join(root, "package-lock.json"), "{}\n");
        return "http://127.0.0.1:41342";
      },
    };

    const executor = new DyadPrototypeExecutor(facade, registry());
    const result = await executor.execute(request("functional"), {
      operationId: "op-preview-side-effect",
    });

    expect(result.previewRef).toBe("http://127.0.0.1:41342");
    expect(
      result.files?.some((file) => file.path === "package-lock.json"),
    ).toBe(false);
  });

  it("reconciles a completed functional preview without rebuilding", async () => {
    const startPreview = vi.fn(async () => "http://127.0.0.1:42042");
    const facade = { startPreview } as unknown as DyadExecutionFacade;
    const executor = new DyadPrototypeExecutor(facade, registry());

    const operation = {
      protocolVersion: "v1" as const,
      operationId: "op-completed",
      idempotencyKey: "idem-completed-123456",
      state: "completed" as const,
      projectId: "42",
      previewRef: "http://127.0.0.1:41042",
      files: [],
      sourceSha256: "c".repeat(64),
    };

    const reconciled = await executor.reconcileCompleted(operation);

    expect(startPreview).toHaveBeenCalledWith({
      appId: 42,
      operationId: "op-completed",
    });
    expect(reconciled.previewRef).toBe("http://127.0.0.1:42042");
  });

  it("does not start preview for a static requirement", async () => {
    const root = await appRoot();
    const startPreview = vi.fn(async () => "should-not-run");
    const facade: DyadExecutionFacade = {
      createApp: async () => ({ appId: 42, chatId: 7, resolvedPath: root }),
      bindModel: async () => undefined,
      runBuild: async () => {
        await fs.writeFile(
          path.join(root, "src", "App.tsx"),
          "export default () => <main>static changed</main>;\n",
        );
        return { updatedFiles: true };
      },
      startPreview,
    };
    const executor = new DyadPrototypeExecutor(facade, registry());
    const result = await executor.execute(request("static"), {
      operationId: "op-static",
    });

    expect(startPreview).not.toHaveBeenCalled();
    expect(result.previewRef).toBeUndefined();
  });

  it("uses one bounded repair turn when the first build writes nothing", async () => {
    const root = await appRoot();
    let turns = 0;
    const runBuild = vi.fn(async (input) => {
      turns++;
      if (turns === 2) {
        expect(input.prompt).toContain("Factory headless build correction");
        await fs.writeFile(
          path.join(root, "src", "App.tsx"),
          "export default () => <main>repaired</main>;\n",
        );
      }
      return { updatedFiles: turns === 2 };
    });
    const facade: DyadExecutionFacade = {
      createApp: async () => ({ appId: 42, chatId: 7, resolvedPath: root }),
      bindModel: async () => undefined,
      runBuild,
      startPreview: async () => "http://127.0.0.1:41342",
    };
    const executor = new DyadPrototypeExecutor(facade, registry());

    const result = await executor.execute(request("static"), {
      operationId: "op-repair",
    });

    expect(runBuild).toHaveBeenCalledTimes(2);
    expect(result.state).toBe("completed");
  });

  it("fails closed when Dyad reports completion without source mutation", async () => {
    const root = await appRoot();
    const runBuild = vi.fn(async () => ({ updatedFiles: false }));
    const facade: DyadExecutionFacade = {
      createApp: async () => ({ appId: 42, chatId: 7, resolvedPath: root }),
      bindModel: async () => undefined,
      runBuild,
      startPreview: async () => "http://127.0.0.1:41342",
    };
    const executor = new DyadPrototypeExecutor(facade, registry());

    await expect(
      executor.execute(request("static"), { operationId: "op-no-change" }),
    ).rejects.toThrow("without changing prototype source");
    expect(runBuild).toHaveBeenCalledTimes(2);
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
