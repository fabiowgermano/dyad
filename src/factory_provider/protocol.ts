import { z } from "zod";

export const FACTORY_PROVIDER_PROTOCOL_VERSION = "v1" as const;

export const FactoryPrototypeModelSchema = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  configSha256: z.string().regex(/^[a-f0-9]{64}$/i),
});

export const FactoryPrototypeReferenceSchema = z.object({
  repository: z.string().min(1),
  revision: z.string().min(1),
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  content: z.string(),
});

/**
 * Price of the model in micro-USD per million tokens. The service uses it only
 * to bound the cost when the model provider does not report the charge per
 * step; the Core owns the real price and cost.
 */
export const FactoryPrototypePricesSchema = z.object({
  inputMicrosPerMtok: z.number().int().nonnegative(),
  outputMicrosPerMtok: z.number().int().nonnegative(),
  cacheReadMicrosPerMtok: z.number().int().nonnegative().optional(),
});

/**
 * Contract v0.4: a ceiling the service enforces while it builds. The build
 * stops after the model step that reaches a ceiling and the operation fails
 * with LIMIT_REACHED and the usage so far. A cost ceiling needs prices, so the
 * service never accepts a cost limit it cannot measure.
 */
export const FactoryPrototypeLimitsSchema = z
  .object({
    maxTotalTokens: z.number().int().positive().optional(),
    maxCostMicros: z.number().int().positive().optional(),
    prices: FactoryPrototypePricesSchema.optional(),
  })
  .refine(
    (l) => l.maxTotalTokens !== undefined || l.maxCostMicros !== undefined,
    { message: "limits needs maxTotalTokens or maxCostMicros" },
  )
  .refine((l) => l.maxCostMicros === undefined || l.prices !== undefined, {
    message: "maxCostMicros needs prices",
  });

export type FactoryPrototypeLimits = z.infer<
  typeof FactoryPrototypeLimitsSchema
>;

export const FactoryCreatePrototypeRequestSchema = z.object({
  idempotencyKey: z.string().min(16).max(512),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  requirement: z.enum(["static", "functional"]),
  brief: z.string().min(1).max(1_000_000),
  references: z.array(FactoryPrototypeReferenceSchema).max(256).default([]),
  model: FactoryPrototypeModelSchema,
  limits: FactoryPrototypeLimitsSchema.optional(),
});

export type FactoryCreatePrototypeRequest = z.infer<
  typeof FactoryCreatePrototypeRequestSchema
>;

export const FactoryPrototypeFileSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  byteSize: z.number().int().nonnegative(),
});

export const FactoryPrototypeOperationStateSchema = z.enum([
  "accepted",
  "running",
  "completed",
  "rejected",
  "failed",
  "indeterminate",
]);

/**
 * Model usage as the model provider reported it, summed over every model call
 * of the operation. A field that is absent is unknown, never zero: the service
 * reports a dimension only when every call reported it. `modelRuns` is how many
 * model runs (one per build turn, each an agent loop of steps) the figures cover; `scope` says what is excluded.
 */
export const FactoryPrototypeUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  costMicros: z.number().int().nonnegative().optional(),
  currency: z.string().min(1).optional(),
  modelRuns: z.number().int().nonnegative().optional(),
  scope: z.string().min(1).optional(),
});

export type FactoryPrototypeUsage = z.infer<typeof FactoryPrototypeUsageSchema>;

/**
 * The verification build of the prototype source: dependencies installed and
 * the production build run in the workspace. `ok` is true only when the whole
 * command succeeded; a functional prototype never completes without it.
 */
export const FactoryPrototypeBuildSchema = z.object({
  ok: z.boolean(),
  command: z.string().min(1),
  error: z.string().min(1).optional(),
});

export type FactoryPrototypeBuild = z.infer<typeof FactoryPrototypeBuildSchema>;

/** The Dyad-side model the admitted Factory identity was mapped to. */
export const FactoryResolvedModelSchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1),
});

export const FactoryPrototypeOperationSchema = z.object({
  protocolVersion: z.literal(FACTORY_PROVIDER_PROTOCOL_VERSION),
  operationId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  state: FactoryPrototypeOperationStateSchema,
  projectId: z.string().min(1).optional(),
  previewRef: z.string().min(1).optional(),
  files: z.array(FactoryPrototypeFileSchema).optional(),
  sourceSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
  providerRequestId: z.string().min(1).optional(),
  /** Hash of the workspace source again, taken when the preview was started. */
  previewSourceSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
  usage: FactoryPrototypeUsageSchema.optional(),
  /** Result of the verification build; absent when none was run (static). */
  build: FactoryPrototypeBuildSchema.optional(),
  /** The Factory model identity the operation ran with (echo of the request). */
  model: FactoryPrototypeModelSchema.optional(),
  resolvedModel: FactoryResolvedModelSchema.optional(),
  /** The limits the operation ran under (echo of the request). */
  limits: FactoryPrototypeLimitsSchema.optional(),
  /** True only on a response that returned an operation already admitted. */
  replayed: z.boolean().optional(),
  errorCode: z.string().min(1).optional(),
  errorMessage: z.string().min(1).optional(),
});

export type FactoryPrototypeOperation = z.infer<
  typeof FactoryPrototypeOperationSchema
>;

export const FactoryHealthSchema = z.object({
  status: z.literal("ok"),
  protocolVersion: z.literal(FACTORY_PROVIDER_PROTOCOL_VERSION),
  dyadVersion: z.string().min(1),
  dyadCommit: z.string().min(1),
});
