import os from "node:os";
import path from "node:path";
import { readServiceTokens } from "./service_tokens";
import { parsePortRange } from "./preview_gateway";
import { readFactoryBuildInfo } from "./build_info";

export interface FactoryWindowsServiceConfig {
  bindHost: string;
  port: number;
  /** File with the service bearer token(s); never an environment variable. */
  tokenFile: string;
  /**
   * Where the preview of a finished prototype is served: the private-network
   * address (for example the WireGuard one). Empty keeps the preview on
   * loopback, which only the host itself can open.
   */
  previewBindHost: string;
  /** Peer addresses allowed to open the preview; empty allows none. */
  previewAllowedPeers: string[];
  /** Inclusive port range the preview gateway binds in (for the firewall). */
  previewPortRange: [number, number];
  dataDirectory: string;
  operationsDatabasePath: string;
  workspaceRoot: string;
  modelRegistryFile: string;
  /** From the build info baked into the dist, never from the environment. */
  buildVersion: string;
  buildCommit: string;
}

export function loadFactoryWindowsServiceConfig(
  env: NodeJS.ProcessEnv = process.env,
  /** Directory holding service.cjs and build-info.json (the bundle's own directory). */
  distDir: string = __dirname,
): FactoryWindowsServiceConfig {
  if (env.FACTORY_DYAD_TOKEN?.trim()) {
    // A token in the environment ends up in start scripts and process
    // listings; the service takes it from a file only.
    throw new Error(
      "FACTORY_DYAD_TOKEN is not accepted: put the token in the file named by FACTORY_DYAD_TOKEN_FILE",
    );
  }
  const tokenFile = path.resolve(
    required(env.FACTORY_DYAD_TOKEN_FILE, "FACTORY_DYAD_TOKEN_FILE"),
  );
  // Fail at boot on an unreadable or weak token file.
  readServiceTokens(tokenFile);
  const previewBindHost = env.FACTORY_DYAD_PREVIEW_BIND?.trim() ?? "";
  const previewAllowedPeers = (env.FACTORY_DYAD_PREVIEW_ALLOWED_PEERS ?? "")
    .split(",")
    .map((peer) => peer.trim())
    .filter(Boolean);
  if (previewBindHost && previewAllowedPeers.length === 0) {
    throw new Error(
      "FACTORY_DYAD_PREVIEW_ALLOWED_PEERS is required when FACTORY_DYAD_PREVIEW_BIND is set",
    );
  }

  const dataDirectory = path.resolve(
    env.FACTORY_DYAD_DATA_DIR?.trim() ||
      path.join(os.homedir(), "AppData", "Local", "FactoryDyadProvider"),
  );
  const workspaceRoot = path.resolve(
    env.FACTORY_DYAD_WORKSPACE_ROOT?.trim() ||
      path.join(dataDirectory, "workspaces"),
  );

  const port = parsePort(env.FACTORY_DYAD_PORT);
  const bindHost = env.FACTORY_DYAD_BIND?.trim() || "127.0.0.1";

  return {
    bindHost,
    port,
    tokenFile,
    previewBindHost,
    previewAllowedPeers,
    previewPortRange: parsePortRange(env.FACTORY_DYAD_PREVIEW_PORTS),
    dataDirectory,
    operationsDatabasePath: path.join(dataDirectory, "operations.db"),
    workspaceRoot,
    modelRegistryFile: path.resolve(
      required(
        env.FACTORY_DYAD_MODEL_REGISTRY_FILE,
        "FACTORY_DYAD_MODEL_REGISTRY_FILE",
      ),
    ),
    ...bakedBuild(env, distDir),
  };
}

function bakedBuild(
  env: NodeJS.ProcessEnv,
  distDir: string,
): Pick<FactoryWindowsServiceConfig, "buildVersion" | "buildCommit"> {
  const info = readFactoryBuildInfo(distDir);
  // The start script still passes what the checkout says; a disagreement means
  // the checkout moved without a rebuild, so /healthz would lie.
  const claims: [string, string][] = [
    ["FACTORY_DYAD_BUILD_COMMIT", info.commit],
    ["FACTORY_DYAD_BUILD_VERSION", info.version],
  ];
  for (const [name, baked] of claims) {
    const claimed = env[name]?.trim();
    if (claimed && claimed !== baked) {
      throw new Error(
        `${name}=${claimed} but the dist was built from ${baked}: run node scripts\\build-factory-provider.mjs`,
      );
    }
  }
  return { buildVersion: info.version, buildCommit: info.commit };
}

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

function parsePort(raw: string | undefined): number {
  if (!raw?.trim()) return 8787;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("FACTORY_DYAD_PORT must be an integer from 1 to 65535");
  }
  return port;
}
