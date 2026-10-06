// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  attachFactoryUsageCollector,
  factoryLimitReached,
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

describe("Factory limits (contract v0.4)", () => {
  const step = (total: number, cost?: number) => ({
    usage: { inputTokens: total - 10, outputTokens: 10, totalTokens: total },
    providerMetadata:
      cost === undefined ? undefined : { openrouter: { usage: { cost } } },
  });

  it("does nothing without limits", () => {
    const c = new FactoryUsageCollector();
    c.beginTurn();
    expect(c.observeSteps([step(1_000_000_000)])).toBeUndefined();
  });

  it("stops at the token ceiling counting finished runs and the run in flight", () => {
    const c = new FactoryUsageCollector({ maxTotalTokens: 1000 });
    c.beginTurn();
    expect(c.observeSteps([step(400)])).toBeUndefined();
    // the same list again never double counts
    expect(c.observeSteps([step(400)])).toBeUndefined();
    expect(c.observeSteps([step(400), step(500)])).toBeUndefined();
    expect(c.observeSteps([step(400), step(600)])).toMatchObject({
      limit: "maxTotalTokens",
      ceiling: 1000,
      seen: 1000,
    });
    c.add({ totalTokens: 1000, inputTokens: 990, outputTokens: 10 });
    c.beginTurn();
    // the finished run counts: one more token step of the next run reaches it
    expect(c.limitHit()).toMatchObject({ limit: "maxTotalTokens" });
  });

  it("bounds the cost by the higher of the provider charge and the price table", () => {
    const prices = {
      inputMicrosPerMtok: 100_000,
      outputMicrosPerMtok: 500_000,
    };
    const c = new FactoryUsageCollector({ maxCostMicros: 1000, prices });
    c.beginTurn();
    // 4000 in * 0.1 + 10 out * 0.5 = 405 micros by the table: below 1000
    expect(c.observeSteps([step(4010)])).toBeUndefined();
    // the provider charged more than the table says: its figure wins
    expect(c.observeSteps([step(4010, 0.001)])).toMatchObject({
      limit: "maxCostMicros",
      seen: 1000,
    });
    // by the table alone: 9990 in * 0.1 + 10 * 0.5 = 1004.
    expect(c.observeSteps([step(10_000)])).toMatchObject({
      limit: "maxCostMicros",
      seen: 1004,
    });
  });

  it("reaches only the attached chat and is false outside a Factory chat", () => {
    const c = new FactoryUsageCollector({ maxTotalTokens: 10 });
    const detach = attachFactoryUsageCollector(5, c);
    c.beginTurn();
    expect(factoryLimitReached(5, [step(50)])).toBe(true);
    expect(factoryLimitReached(6, [step(50)])).toBe(false);
    detach();
    expect(factoryLimitReached(5, [step(50)])).toBe(false);
  });
});
