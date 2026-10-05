// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DyadPrototypeExecutor,
  FactoryExecutionError,
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

const verifyBuildOk = async () => ({ ok: true });

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
      verifyBuild: vi.fn(async () => {
        calls.push("verify");
        return { ok: true };
      }),
      startPreview: vi.fn(async () => {
        calls.push("preview");
        return "http://127.0.0.1:41342";
      }),
    };

    const executor = new DyadPrototypeExecutor(facade, registry());
    const result = await executor.execute(request(), { operationId: "op-1" });

    expect(calls).toEqual(["create", "model", "build", "verify", "preview"]);
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
      verifyBuild: verifyBuildOk,
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
      verifyBuild: verifyBuildOk,
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
        expect(input.prompt).toContain(
          "did not produce an admissible, buildable implementation",
        );
        expect(input.prompt).toContain("Use write_file or search_replace now");
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
      verifyBuild: verifyBuildOk,
      startPreview: async () => "http://127.0.0.1:41342",
    };
    const executor = new DyadPrototypeExecutor(facade, registry());

    const result = await executor.execute(request("static"), {
      operationId: "op-repair",
    });

    expect(runBuild).toHaveBeenCalledTimes(2);
    expect(result.state).toBe("completed");
  });

  it("repairs a functional turn that only changes ancillary styles", async () => {
    const root = await appRoot();
    let turns = 0;
    const runBuild = vi.fn(async (input) => {
      turns++;
      if (turns === 1) {
        await fs.writeFile(
          path.join(root, "src", "index.css"),
          "@tailwind base;\n",
        );
      } else {
        expect(input.prompt).toContain("ancillary config/style-only change");
        await fs.writeFile(
          path.join(root, "src", "App.tsx"),
          "export default () => <main>functional repaired</main>;\n",
        );
      }
      return { updatedFiles: true };
    });
    const startPreview = vi.fn(async () => "http://127.0.0.1:41342");
    const facade: DyadExecutionFacade = {
      createApp: async () => ({ appId: 42, chatId: 7, resolvedPath: root }),
      bindModel: async () => undefined,
      runBuild,
      verifyBuild: verifyBuildOk,
      startPreview,
    };
    const executor = new DyadPrototypeExecutor(facade, registry());

    const result = await executor.execute(request("functional"), {
      operationId: "op-functional-style-repair",
    });

    expect(runBuild).toHaveBeenCalledTimes(2);
    expect(startPreview).toHaveBeenCalledTimes(1);
    expect(result.state).toBe("completed");
  });

  it("repairs a functional implementation after build verification fails", async () => {
    const root = await appRoot();
    let turns = 0;
    const runBuild = vi.fn(async (input) => {
      turns++;
      if (turns === 2) {
        expect(input.prompt).toContain("# Build verification failure");
        expect(input.prompt).toContain("Unexpected token");
      }
      await fs.writeFile(
        path.join(root, "src", "App.tsx"),
        `export default () => <main>turn ${turns}</main>;\n`,
      );
      return { updatedFiles: true };
    });
    const verifyBuild = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: "src/pages/Index.tsx:65 Unexpected token",
      })
      .mockResolvedValueOnce({ ok: true });
    const startPreview = vi.fn(async () => "http://127.0.0.1:41342");
    const facade: DyadExecutionFacade = {
      createApp: async () => ({ appId: 42, chatId: 7, resolvedPath: root }),
      bindModel: async () => undefined,
      runBuild,
      verifyBuild,
      startPreview,
    };
    const executor = new DyadPrototypeExecutor(facade, registry());

    const result = await executor.execute(request("functional"), {
      operationId: "op-build-repair",
    });

    expect(runBuild).toHaveBeenCalledTimes(2);
    expect(verifyBuild).toHaveBeenCalledTimes(2);
    expect(startPreview).toHaveBeenCalledTimes(1);
    expect(result.state).toBe("completed");
  });

  it("fails closed when functional build verification fails twice", async () => {
    const root = await appRoot();
    let turns = 0;
    const runBuild = vi.fn(async () => {
      turns++;
      await fs.writeFile(
        path.join(root, "src", "App.tsx"),
        `export default () => <main>broken ${turns}</main>;\n`,
      );
      return { updatedFiles: true };
    });
    const verifyBuild = vi.fn(async () => ({
      ok: false,
      error: "vite build failed: Unexpected token",
    }));
    const startPreview = vi.fn(async () => "http://127.0.0.1:41342");
    const facade: DyadExecutionFacade = {
      createApp: async () => ({ appId: 42, chatId: 7, resolvedPath: root }),
      bindModel: async () => undefined,
      runBuild,
      verifyBuild,
      startPreview,
    };
    const executor = new DyadPrototypeExecutor(facade, registry());

    await expect(
      executor.execute(request("functional"), {
        operationId: "op-build-fail-closed",
      }),
    ).rejects.toThrow("functional build verification failed");

    expect(runBuild).toHaveBeenCalledTimes(3);
    expect(verifyBuild).toHaveBeenCalledTimes(3);
    expect(startPreview).not.toHaveBeenCalled();
  });

  it("fails closed when only an existing but unreachable component changes", async () => {
    const root = await appRoot();
    await fs.mkdir(path.join(root, "src", "components"), { recursive: true });
    await fs.writeFile(
      path.join(root, "src", "components", "Card.tsx"),
      "export const Card = () => <div>original</div>;\n",
    );

    let turns = 0;
    const runBuild = vi.fn(async () => {
      turns++;
      await fs.writeFile(
        path.join(root, "src", "components", "Card.tsx"),
        `export const Card = () => <div>orphan turn ${turns}</div>;\n`,
      );
      return { updatedFiles: true };
    });
    const startPreview = vi.fn(async () => "http://127.0.0.1:41342");
    const facade: DyadExecutionFacade = {
      createApp: async () => ({ appId: 42, chatId: 7, resolvedPath: root }),
      bindModel: async () => undefined,
      runBuild,
      verifyBuild: verifyBuildOk,
      startPreview,
    };
    const executor = new DyadPrototypeExecutor(facade, registry());

    await expect(
      executor.execute(request("functional"), {
        operationId: "op-functional-unreachable-existing",
      }),
    ).rejects.toThrow("without an admissible functional source change");

    expect(runBuild).toHaveBeenCalledTimes(3);
    expect(startPreview).not.toHaveBeenCalled();
  });

  it("fails closed for a functional build that only creates an unreferenced page", async () => {
    const root = await appRoot();
    let turns = 0;
    const runBuild = vi.fn(async () => {
      turns++;
      await fs.mkdir(path.join(root, "src", "pages"), { recursive: true });
      await fs.writeFile(
        path.join(root, "src", "pages", "Dashboard.tsx"),
        `export default () => <main>dashboard turn ${turns}</main>;\n`,
      );
      return { updatedFiles: true };
    });
    const startPreview = vi.fn(async () => "http://127.0.0.1:41342");
    const facade: DyadExecutionFacade = {
      createApp: async () => ({ appId: 42, chatId: 7, resolvedPath: root }),
      bindModel: async () => undefined,
      runBuild,
      verifyBuild: verifyBuildOk,
      startPreview,
    };
    const executor = new DyadPrototypeExecutor(facade, registry());

    await expect(
      executor.execute(request("functional"), {
        operationId: "op-functional-unreferenced",
      }),
    ).rejects.toThrow("without an admissible functional source change");

    expect(runBuild).toHaveBeenCalledTimes(3);
    expect(startPreview).not.toHaveBeenCalled();
  });

  it("fails closed when Dyad reports completion without source mutation", async () => {
    const root = await appRoot();
    const runBuild = vi.fn(async () => ({ updatedFiles: false }));
    const facade: DyadExecutionFacade = {
      createApp: async () => ({ appId: 42, chatId: 7, resolvedPath: root }),
      bindModel: async () => undefined,
      runBuild,
      verifyBuild: verifyBuildOk,
      startPreview: async () => "http://127.0.0.1:41342",
    };
    const executor = new DyadPrototypeExecutor(facade, registry());

    await expect(
      executor.execute(request("static"), { operationId: "op-no-change" }),
    ).rejects.toThrow("without changing prototype source");
    expect(runBuild).toHaveBeenCalledTimes(3);
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

  it("reports the admitted model, the Dyad model it ran on and the provider usage", async () => {
    const root = await appRoot();
    const facade: DyadExecutionFacade = {
      createApp: async () => ({ appId: 42, chatId: 7, resolvedPath: root }),
      bindModel: async () => undefined,
      runBuild: async (input) => {
        input.usage.beginTurn();
        await fs.writeFile(
          path.join(root, "src", "App.tsx"),
          "export default () => <main>changed</main>;\n",
        );
        input.usage.add({
          inputTokens: 120,
          outputTokens: 30,
          totalTokens: 150,
        });
        return { updatedFiles: true, providerRequestId: "req-1" };
      },
      verifyBuild: verifyBuildOk,
      startPreview: async () => "http://10.77.0.2:41342/",
    };
    const result = await new DyadPrototypeExecutor(facade, registry()).execute(
      request(),
      { operationId: "op-usage" },
    );
    expect(result.model).toEqual(request().model);
    expect(result.resolvedModel).toEqual({
      provider: "openrouter",
      name: "model-a",
    });
    expect(result.usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150,
      modelRuns: 1,
    });
    expect(result.previewSourceSha256).toBe(result.sourceSha256);
  });

  it("keeps the usage of a build that spent tokens and then failed", async () => {
    const root = await appRoot();
    const facade: DyadExecutionFacade = {
      createApp: async () => ({ appId: 42, chatId: 7, resolvedPath: root }),
      bindModel: async () => undefined,
      runBuild: async (input) => {
        input.usage.beginTurn();
        input.usage.add({ inputTokens: 10, outputTokens: 1, totalTokens: 11 });
        return { updatedFiles: false };
      },
      verifyBuild: verifyBuildOk,
      startPreview: async () => "http://127.0.0.1:41342",
    };
    const failure = await new DyadPrototypeExecutor(facade, registry())
      .execute(request("static"), { operationId: "op-fail" })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FactoryExecutionError);
    expect((failure as FactoryExecutionError).detail.usage).toMatchObject({
      totalTokens: 33,
      modelRuns: 3,
    });
    expect((failure as FactoryExecutionError).detail.resolvedModel).toEqual({
      provider: "openrouter",
      name: "model-a",
    });
  });

  it("refuses to complete when the frozen source changes under the preview", async () => {
    const root = await appRoot();
    const facade: DyadExecutionFacade = {
      createApp: async () => ({ appId: 42, chatId: 7, resolvedPath: root }),
      bindModel: async () => undefined,
      runBuild: async () => {
        await fs.writeFile(
          path.join(root, "src", "App.tsx"),
          "export default () => <main>frozen</main>;\n",
        );
        return { updatedFiles: true };
      },
      verifyBuild: verifyBuildOk,
      startPreview: async () => {
        await fs.writeFile(
          path.join(root, "src", "App.tsx"),
          "export default () => <main>drifted</main>;\n",
        );
        return "http://127.0.0.1:41342";
      },
    };
    await expect(
      new DyadPrototypeExecutor(facade, registry()).execute(request(), {
        operationId: "op-drift",
      }),
    ).rejects.toThrow("does not match the recorded source");
  });
});
