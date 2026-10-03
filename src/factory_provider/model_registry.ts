import fs from "node:fs";
import { z } from "zod";
import type { ModelSelection } from "@/lib/schemas";

const SHA256_HEX = /^[a-f0-9]{64}$/i;

const RegistryEntrySchema = z.object({
  configSha256: z.string().regex(SHA256_HEX),
  factoryProvider: z.string().min(1),
  factoryModelId: z.string().min(1),
  dyad: z.object({
    provider: z.string().min(1),
    name: z.string().min(1),
    effortLevel: z.string().min(1),
    connection: z.enum(["subscription", "pro", "api-key"]).optional(),
  }),
});

const RegistrySchema = z.object({
  models: z.array(RegistryEntrySchema).min(1),
});

export type FactoryModelRegistryEntry = z.infer<typeof RegistryEntrySchema>;

export class FactoryModelRegistry {
  private readonly byConfig = new Map<string, FactoryModelRegistryEntry>();

  constructor(entries: FactoryModelRegistryEntry[]) {
    for (const entry of entries) {
      const key = entry.configSha256.toLowerCase();
      if (this.byConfig.has(key)) {
        throw new Error(
          `duplicate Factory model config SHA-256: ${entry.configSha256}`,
        );
      }
      this.byConfig.set(key, entry);
    }
  }

  static fromFile(filePath: string): FactoryModelRegistry {
    const parsed = RegistrySchema.parse(
      JSON.parse(fs.readFileSync(filePath, "utf8")),
    );
    return new FactoryModelRegistry(parsed.models);
  }

  resolve(input: {
    provider: string;
    modelId: string;
    configSha256: string;
  }): ModelSelection {
    const entry = this.byConfig.get(input.configSha256.toLowerCase());
    if (!entry) {
      throw new Error(
        `Factory model config is not admitted by this Dyad service: ${input.configSha256}`,
      );
    }
    if (
      entry.factoryProvider !== input.provider ||
      entry.factoryModelId !== input.modelId
    ) {
      throw new Error(
        "Factory model identity does not match the configured model registry entry",
      );
    }

    return {
      provider: entry.dyad.provider,
      name: entry.dyad.name,
      effortLevel: entry.dyad.effortLevel,
      ...(entry.dyad.connection
        ? { connection: entry.dyad.connection }
        : {}),
    };
  }
}
