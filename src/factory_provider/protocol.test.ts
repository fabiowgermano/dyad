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
