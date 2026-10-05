// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  attachFactoryUsageCollector,
  FactoryUsageCollector,
  providerReportedCostMicros,
  reportFactoryModelUsage,
} from "./usage_collector";

describe("FactoryUsageCollector", () => {
  it("is unknown until a model run started and every run reported", () => {
    const c = new FactoryUsageCollector();
    expect(c.snapshot()).toBeUndefined();
    c.beginTurn();
    expect(c.snapshot()).toBeUndefined();
    c.add({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(c.snapshot()).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      modelRuns: 1,
    });
    c.beginTurn();
    // The second run never reported: the whole usage is unknown again.
    expect(c.snapshot()).toBeUndefined();
  });

  it("sums every run and omits a dimension that not every run reported", () => {
    const c = new FactoryUsageCollector();
    c.beginTurn();
    c.add({
      inputTokens: 100,
      outputTokens: 10,
      totalTokens: 110,
      cachedInputTokens: 40,
    });
    c.beginTurn();
    c.add({ inputTokens: 200, outputTokens: 20, totalTokens: 220 });
    const usage = c.snapshot();
    expect(usage).toMatchObject({
      inputTokens: 300,
      outputTokens: 30,
      totalTokens: 330,
      modelRuns: 2,
    });
    // cache reads were reported by one run only: unknown, not 40.
    expect(usage).not.toHaveProperty("cacheReadTokens");
    expect(usage).not.toHaveProperty("costMicros");
  });

  it("never turns an absent number into zero", () => {
    const c = new FactoryUsageCollector();
    c.beginTurn();
    c.add({ totalTokens: undefined, inputTokens: -1 });
    expect(c.snapshot()).toBeUndefined();
  });

  it("reads the provider-charged cost in USD when every run carries it", () => {
    expect(
      providerReportedCostMicros({ openrouter: { usage: { cost: 0.0123 } } }),
    ).toBe(12300);
    expect(
      providerReportedCostMicros({ openrouter: { usage: {} } }),
    ).toBeUndefined();
    const c = new FactoryUsageCollector();
    c.beginTurn();
    c.add({ totalTokens: 1 }, { openrouter: { usage: { cost: 0.5 } } });
    expect(c.snapshot()).toMatchObject({ costMicros: 500000, currency: "USD" });
  });
});

describe("reportFactoryModelUsage", () => {
  it("is a no-op without an attached collector and reaches the attached chat only", () => {
    reportFactoryModelUsage(1, { totalTokens: 9 });
    const c = new FactoryUsageCollector();
    c.beginTurn();
    const detach = attachFactoryUsageCollector(7, c);
    reportFactoryModelUsage(8, { totalTokens: 9 });
    expect(c.snapshot()).toBeUndefined();
    reportFactoryModelUsage(7, { totalTokens: 9 });
    expect(c.snapshot()).toMatchObject({ totalTokens: 9 });
    expect(() =>
      attachFactoryUsageCollector(7, new FactoryUsageCollector()),
    ).toThrow();
    detach();
    reportFactoryModelUsage(7, { totalTokens: 100 });
    expect(c.snapshot()).toMatchObject({ totalTokens: 9 });
  });
});
