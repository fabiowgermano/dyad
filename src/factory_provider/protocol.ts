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

export const FactoryCreatePrototypeRequestSchema = z.object({
  idempotencyKey: z.string().min(16).max(512),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  requirement: z.enum(["static", "functional"]),
  brief: z.string().min(1).max(1_000_000),
  references: z.array(FactoryPrototypeReferenceSchema).max(256).default([]),
  model: FactoryPrototypeModelSchema,
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
]);

export const FactoryPrototypeOperationSchema = z.object({
  protocolVersion: z.literal(FACTORY_PROVIDER_PROTOCOL_VERSION),
  operationId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  state: FactoryPrototypeOperationStateSchema,
  projectId: z.string().min(1).optional(),
  previewRef: z.string().min(1).optional(),
  files: z.array(FactoryPrototypeFileSchema).optional(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  providerRequestId: z.string().min(1).optional(),
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
