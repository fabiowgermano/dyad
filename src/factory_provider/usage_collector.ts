import type { FactoryPrototypeLimits, FactoryPrototypeUsage } from "./protocol";

/**
 * Model usage of a headless Factory build, as the model provider reported it.
 *
 * The collector is attached to one Dyad chat for the duration of a Factory
 * operation. Dyad's local agent reports each finished model run (all its
 * steps) through `reportFactoryModelUsage`; outside a Factory operation nothing
 * is attached and the report is a no-op, so the desktop app is unaffected.
 *
 * Honesty rules (ADR-0028 decision 6): a dimension is reported only when every
 * model run reported it, a run that never reported makes the whole usage
 * unknown, and nothing is ever estimated.
 */
export const FACTORY_USAGE_SCOPE =
  "agent-run totalUsage as reported by the model provider; excludes auxiliary calls outside the build agent run";

/** The subset of the AI SDK usage the collector reads. */
export interface ReportedUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  reasoningTokens?: number | undefined;
}

type Dimension =
  | "inputTokens"
  | "outputTokens"
  | "totalTokens"
  | "cacheReadTokens"
  | "reasoningTokens"
  | "costMicros";

const DIMENSIONS: Dimension[] = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadTokens",
  "reasoningTokens",
  "costMicros",
];

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

/** OpenRouter reports the charged cost in USD under its provider metadata. */
export function providerReportedCostMicros(
  providerMetadata: unknown,
): number | undefined {
  const cost = (
    providerMetadata as {
      openrouter?: { usage?: { cost?: unknown } };
    } | null
  )?.openrouter?.usage?.cost;
  return typeof cost === "number" && Number.isFinite(cost) && cost >= 0
    ? Math.round(cost * 1_000_000)
    : undefined;
}

/** What stopped a build: the ceiling that was reached and the value seen. */
export interface FactoryLimitHit {
  limit: "maxTotalTokens" | "maxCostMicros";
  ceiling: number;
  seen: number;
}

/** One finished model step as the AI SDK reports it. */
export interface ReportedStep {
  usage?: ReportedUsage;
  providerMetadata?: unknown;
}

export class FactoryUsageCollector {
  constructor(private readonly limits?: FactoryPrototypeLimits) {}

  // Steps of the model run in flight: not yet folded into the sums.
  private stepTokens = 0;
  private stepCost = 0;
  private stepInput = 0;
  private stepOutput = 0;
  private stepCached = 0;
  private turns = 0;
  private reports = 0;
  private readonly sums = new Map<Dimension, number>();
  private readonly seen = new Map<Dimension, number>();

  /** A model run is about to start (one build turn). */
  beginTurn(): void {
    this.turns += 1;
    this.resetSteps();
  }

  private resetSteps(): void {
    this.stepTokens = this.stepCost = 0;
    this.stepInput = this.stepOutput = this.stepCached = 0;
  }

  /**
   * The steps finished so far in the run in flight. Recomputed from the whole
   * list each time, so calling it twice for the same steps never double counts.
   * Returns the ceiling reached, if any.
   */
  observeSteps(steps: ReportedStep[]): FactoryLimitHit | undefined {
    this.resetSteps();
    for (const step of steps) {
      const u = step.usage;
      const input = nonNegativeInt(u?.inputTokens) ?? 0;
      const output = nonNegativeInt(u?.outputTokens) ?? 0;
      this.stepInput += input;
      this.stepOutput += output;
      this.stepCached += nonNegativeInt(u?.cachedInputTokens) ?? 0;
      this.stepTokens += nonNegativeInt(u?.totalTokens) ?? input + output;
      this.stepCost += providerReportedCostMicros(step.providerMetadata) ?? 0;
    }
    return this.limitHit();
  }

  /** The ceiling reached by the finished runs plus the run in flight. */
  limitHit(): FactoryLimitHit | undefined {
    const l = this.limits;
    if (!l) return undefined;
    const tokens = (this.sums.get("totalTokens") ?? 0) + this.stepTokens;
    if (l.maxTotalTokens !== undefined && tokens >= l.maxTotalTokens) {
      return {
        limit: "maxTotalTokens",
        ceiling: l.maxTotalTokens,
        seen: tokens,
      };
    }
    if (l.maxCostMicros !== undefined && l.prices) {
      const p = l.prices;
      const input = (this.sums.get("inputTokens") ?? 0) + this.stepInput;
      const output = (this.sums.get("outputTokens") ?? 0) + this.stepOutput;
      const cached = Math.min(
        input,
        (this.sums.get("cacheReadTokens") ?? 0) + this.stepCached,
      );
      // Worst case: a provider charge, or the price table, whichever is higher.
      const computed = Math.ceil(
        ((input - cached) * p.inputMicrosPerMtok +
          cached * (p.cacheReadMicrosPerMtok ?? p.inputMicrosPerMtok) +
          output * p.outputMicrosPerMtok) /
          1_000_000,
      );
      const reported = (this.sums.get("costMicros") ?? 0) + this.stepCost;
      const cost = Math.max(computed, reported);
      if (cost >= l.maxCostMicros) {
        return { limit: "maxCostMicros", ceiling: l.maxCostMicros, seen: cost };
      }
    }
    return undefined;
  }

  /** A model run finished and the provider reported its total usage. */
  add(usage: ReportedUsage | undefined, providerMetadata?: unknown): void {
    this.reports += 1;
    this.resetSteps();
    const values: Record<Dimension, number | undefined> = {
      inputTokens: nonNegativeInt(usage?.inputTokens),
      outputTokens: nonNegativeInt(usage?.outputTokens),
      totalTokens: nonNegativeInt(usage?.totalTokens),
      cacheReadTokens: nonNegativeInt(usage?.cachedInputTokens),
      reasoningTokens: nonNegativeInt(usage?.reasoningTokens),
      costMicros: providerReportedCostMicros(providerMetadata),
    };
    for (const dimension of DIMENSIONS) {
      const value = values[dimension];
      if (value === undefined) continue;
      this.sums.set(dimension, (this.sums.get(dimension) ?? 0) + value);
      this.seen.set(dimension, (this.seen.get(dimension) ?? 0) + 1);
    }
  }

  /** How many build turns started and how many of them reported. */
  counts(): { turns: number; reports: number } {
    return { turns: this.turns, reports: this.reports };
  }

  /**
   * The usage of the operation, or undefined (unknown) when no model run
   * started or any run ended without reporting. Dimensions that not every run
   * reported are left out.
   */
  snapshot(): FactoryPrototypeUsage | undefined {
    if (this.turns === 0 || this.reports < this.turns) return undefined;
    const out: FactoryPrototypeUsage = {
      modelRuns: this.reports,
      scope: FACTORY_USAGE_SCOPE,
    };
    let any = false;
    for (const dimension of DIMENSIONS) {
      if (this.seen.get(dimension) === this.reports) {
        out[dimension] = this.sums.get(dimension);
        any = true;
      }
    }
    if (out.costMicros !== undefined) out.currency = "USD";
    return any ? out : undefined;
  }
}

const attached = new Map<number, FactoryUsageCollector>();

/** Attach a collector to a Dyad chat; returns the function that detaches it. */
export function attachFactoryUsageCollector(
  chatId: number,
  collector: FactoryUsageCollector,
): () => void {
  if (attached.has(chatId)) {
    throw new Error(`a usage collector is already attached to chat ${chatId}`);
  }
  attached.set(chatId, collector);
  return () => {
    if (attached.get(chatId) === collector) attached.delete(chatId);
  };
}

/**
 * Called by Dyad's local agent when a model run finishes. A no-op unless a
 * Factory operation attached a collector to this chat.
 */
export function reportFactoryModelUsage(
  chatId: number,
  usage: ReportedUsage | undefined,
  providerMetadata?: unknown,
): void {
  attached.get(chatId)?.add(usage, providerMetadata);
}

/**
 * Called from the agent's stop condition with the steps finished so far.
 * True means a Factory limit was reached and the run must stop. A no-op
 * (false) outside a Factory chat or without limits.
 */
export function factoryLimitReached(
  chatId: number,
  steps: ReportedStep[],
): boolean {
  return attached.get(chatId)?.observeSteps(steps) !== undefined;
}
