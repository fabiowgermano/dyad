import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Provenance written next to the bundle by scripts/build-factory-provider.mjs.
 * /healthz reports this, so it describes the build that runs, not whatever the
 * checkout happens to be at start time.
 */
export interface FactoryBuildInfo {
  commit: string;
  version: string;
  dirty: boolean;
  builtAt: string;
  serviceSha256: string;
}

export const BUILD_INFO_FILE = "build-info.json";
export const SERVICE_BUNDLE_FILE = "service.cjs";
const REBUILD = "run node scripts\\build-factory-provider.mjs";

/** Reads and checks the build info of the bundle in distDir; throws (fail closed) on anything off. */
export function readFactoryBuildInfo(distDir: string): FactoryBuildInfo {
  const file = path.join(distDir, BUILD_INFO_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `Build info ${file} is missing or unreadable (${(error as Error).message}): ${REBUILD}`,
    );
  }
  const info = raw as Partial<FactoryBuildInfo>;
  for (const key of [
    "commit",
    "version",
    "builtAt",
    "serviceSha256",
  ] as const) {
    if (typeof info[key] !== "string" || !info[key]) {
      throw new Error(`Build info ${file} has no ${key}: ${REBUILD}`);
    }
  }
  if (info.dirty !== false) {
    throw new Error(
      `The bundle was built from a dirty checkout (commit ${info.commit}); rebuild from a clean checkout: ${REBUILD}`,
    );
  }
  const bundle = path.join(distDir, SERVICE_BUNDLE_FILE);
  const actual = crypto
    .createHash("sha256")
    .update(fs.readFileSync(bundle))
    .digest("hex");
  if (actual !== info.serviceSha256) {
    throw new Error(
      `${bundle} does not match its build info (sha256 ${actual}, build info says ${info.serviceSha256}): ${REBUILD}`,
    );
  }
  return info as FactoryBuildInfo;
}
