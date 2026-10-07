// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  FACTORY_PROVIDER_PROTOCOL_VERSION,
  FactoryCreatePrototypeRequestSchema,
} from "./protocol";

describe("Factory provider protocol", () => {
  it("accepts a bounded governed request", () => {
    const parsed = FactoryCreatePrototypeRequestSchema.parse({
      idempotencyKey: "idem-1234567890123456",
      inputSha256: "a".repeat(64),
      requirement: "functional",
      brief: "Build a prototype",
      references: [],
      model: {
        provider: "openrouter",
        modelId: "test/model",
        configSha256: "b".repeat(64),
      },
    });
    expect(parsed.requirement).toBe("functional");
    expect(FACTORY_PROVIDER_PROTOCOL_VERSION).toBe("v1");
  });

  it("rejects malformed hashes", () => {
    expect(() =>
      FactoryCreatePrototypeRequestSchema.parse({
        idempotencyKey: "idem-1234567890123456",
        inputSha256: "nope",
        requirement: "functional",
        brief: "Build",
        references: [],
        model: {
          provider: "openrouter",
          modelId: "test/model",
          configSha256: "b".repeat(64),
        },
      }),
    ).toThrow();
  });
});

describe("Factory provider limits (contract v0.4)", () => {
  const base = {
    idempotencyKey: "idem-1234567890123456",
    inputSha256: "a".repeat(64),
    requirement: "functional" as const,
    brief: "Build",
    references: [],
    model: {
      provider: "openrouter",
      modelId: "m",
      configSha256: "b".repeat(64),
    },
  };
  const prices = { inputMicrosPerMtok: 100_000, outputMicrosPerMtok: 500_000 };

  it("accepts a token ceiling alone and a cost ceiling with prices", () => {
    expect(() =>
      FactoryCreatePrototypeRequestSchema.parse({
        ...base,
        limits: { maxTotalTokens: 1000 },
      }),
    ).not.toThrow();
    expect(() =>
      FactoryCreatePrototypeRequestSchema.parse({
        ...base,
        limits: {
          maxCostMicros: 500_000,
          prices: { ...prices, cacheReadMicrosPerMtok: 10_000 },
        },
      }),
    ).not.toThrow();
  });

  it("refuses a cost ceiling it cannot measure, an empty limits and non-positive ceilings", () => {
    for (const limits of [
      { maxCostMicros: 500_000 },
      {},
      { maxTotalTokens: 0 },
      { maxTotalTokens: 1.5 },
      { prices },
    ]) {
      expect(() =>
        FactoryCreatePrototypeRequestSchema.parse({ ...base, limits }),
      ).toThrow();
    }
  });
});
