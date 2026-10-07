// @vitest-environment node
import { describe, expect, it } from "vitest";
import { FactoryModelRegistry } from "./model_registry";

const SHA = "a".repeat(64);

describe("FactoryModelRegistry", () => {
  it("resolves an admitted Factory model identity to an explicit Dyad selection", () => {
    const registry = new FactoryModelRegistry([
      {
        configSha256: SHA,
        factoryProvider: "openrouter",
        factoryModelId: "openai/gpt-5.6-luna",
        dyad: {
          provider: "openrouter",
          name: "openai/gpt-5.6-luna",
          effortLevel: "medium",
          connection: "api-key",
        },
      },
    ]);

    expect(
      registry.resolve({
        provider: "openrouter",
        modelId: "openai/gpt-5.6-luna",
        configSha256: SHA,
      }),
    ).toEqual({
      provider: "openrouter",
      name: "openai/gpt-5.6-luna",
      effortLevel: "medium",
      connection: "api-key",
    });
  });

  it("fails closed for an unknown config hash", () => {
    const registry = new FactoryModelRegistry([
      {
        configSha256: SHA,
        factoryProvider: "openrouter",
        factoryModelId: "model-a",
        dyad: {
          provider: "openrouter",
          name: "model-a",
          effortLevel: "medium",
        },
      },
    ]);

    expect(() =>
      registry.resolve({
        provider: "openrouter",
        modelId: "model-a",
        configSha256: "b".repeat(64),
      }),
    ).toThrow("not admitted");
  });

  it("fails closed when provider/model does not match the hash entry", () => {
    const registry = new FactoryModelRegistry([
      {
        configSha256: SHA,
        factoryProvider: "openrouter",
        factoryModelId: "model-a",
        dyad: {
          provider: "openrouter",
          name: "model-a",
          effortLevel: "medium",
        },
      },
    ]);

    expect(() =>
      registry.resolve({
        provider: "openai",
        modelId: "model-a",
        configSha256: SHA,
      }),
    ).toThrow("does not match");
  });
});
