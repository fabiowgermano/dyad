import os from "node:os";
import path from "node:path";

export interface FactoryWindowsServiceConfig {
  bindHost: string;
  port: number;
  token: string;
  dataDirectory: string;
  operationsDatabasePath: string;
  workspaceRoot: string;
}

export function loadFactoryWindowsServiceConfig(
  env: NodeJS.ProcessEnv = process.env,
): FactoryWindowsServiceConfig {
  const token = required(env.FACTORY_DYAD_TOKEN, "FACTORY_DYAD_TOKEN");
  if (token.length < 32) {
    throw new Error("FACTORY_DYAD_TOKEN must be at least 32 characters");
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
    token,
    dataDirectory,
    operationsDatabasePath: path.join(dataDirectory, "operations.db"),
    workspaceRoot,
  };
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
