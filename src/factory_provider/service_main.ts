import fs from "node:fs";
import path from "node:path";

import { loadFactoryWindowsServiceConfig } from "./windows_service_config";

export async function runFactoryDyadService(): Promise<void> {
  const config = loadFactoryWindowsServiceConfig();

  // These must be set before importing Dyad production modules. Several
  // platform seams resolve their runtime behavior at module evaluation time.
  process.env.DYAD_HEADLESS_SERVICE = "1";
  process.env.DYAD_HEADLESS_USER_DATA_DIR = path.join(
    config.dataDirectory,
    "dyad-user-data",
  );
  process.env.DYAD_HEADLESS_APPS_DIR = config.workspaceRoot;

  fs.mkdirSync(config.dataDirectory, { recursive: true });
  fs.mkdirSync(process.env.DYAD_HEADLESS_USER_DATA_DIR, { recursive: true });
  fs.mkdirSync(config.workspaceRoot, { recursive: true });

  const [
    { initializeDatabase, closeDatabase },
    { PrototypeOperationStore },
    { DurableFactoryPrototypeRuntime },
    { FactoryModelRegistry },
    { DyadPrototypeExecutor },
    { ProductionDyadExecutionFacade },
    { startFactoryProviderServer },
    { stopAllAppsSync },
    { applyManagedPnpmToProcessPath },
  ] = await Promise.all([
    import("@/db"),
    import("./operation_store"),
    import("./durable_runtime"),
    import("./model_registry"),
    import("./prototype_executor"),
    import("./production_facade"),
    import("./http_server"),
    import("@/ipc/utils/process_manager"),
    import("@/ipc/utils/socket_firewall"),
  ]);

  // app_runtime_service calls fixPath() at module evaluation time. Apply the
  // service toolchain only after every production runtime module has loaded so
  // the Windows child-process PATH cannot be overwritten by desktop startup
  // behavior that the headless composition root intentionally skips.
  prependFactoryServiceNodeRuntimeToPath();
  applyManagedPnpmToProcessPath();

  initializeDatabase();

  const store = new PrototypeOperationStore(config.operationsDatabasePath);
  const models = FactoryModelRegistry.fromFile(config.modelRegistryFile);
  const facade = new ProductionDyadExecutionFacade();
  const executor = new DyadPrototypeExecutor(facade, models);
  const runtime = new DurableFactoryPrototypeRuntime({ store, executor });

  const server = await startFactoryProviderServer({
    runtime,
    token: config.token,
    host: config.bindHost,
    port: config.port,
    dyadVersion: config.buildVersion,
    dyadCommit: config.buildCommit,
  });

  process.stdout.write(
    JSON.stringify({
      event: "factory-dyad-provider.started",
      host: server.host,
      port: server.port,
      dyadVersion: config.buildVersion,
      dyadCommit: config.buildCommit,
      nodeRuntime: process.execPath,
    }) + "\n",
  );

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      process.stdout.write(
        JSON.stringify({ event: "factory-dyad-provider.stopping" }) + "\n",
      );
      try {
        await server.close();
      } finally {
        try {
          stopAllAppsSync();
        } finally {
          try {
            store.close();
          } finally {
            closeDatabase();
          }
        }
      }
    })();
    return closing;
  };

  const signal = (name: NodeJS.Signals) => {
    void close().finally(() => {
      process.stdout.write(
        JSON.stringify({
          event: "factory-dyad-provider.stopped",
          signal: name,
        }) + "\n",
      );
      process.exit(0);
    });
  };

  process.once("SIGINT", () => signal("SIGINT"));
  process.once("SIGTERM", () => signal("SIGTERM"));

  process.once("uncaughtException", (error) => {
    process.stderr.write(
      JSON.stringify({
        event: "factory-dyad-provider.uncaught-exception",
        message: safeMessage(error),
      }) + "\n",
    );
    void close().finally(() => process.exit(1));
  });

  process.once("unhandledRejection", (error) => {
    process.stderr.write(
      JSON.stringify({
        event: "factory-dyad-provider.unhandled-rejection",
        message: safeMessage(error),
      }) + "\n",
    );
    void close().finally(() => process.exit(1));
  });
}

function safeMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.slice(0, 2_000);
}

export function prependFactoryServiceNodeRuntimeToPath(
  env: NodeJS.ProcessEnv = process.env,
  executablePath = process.execPath,
): void {
  const pathKey =
    Object.keys(env).find((key) => key.toLowerCase() === "path") ??
    (process.platform === "win32" ? "Path" : "PATH");
  const nodeDir = path.dirname(executablePath);
  const entries = (env[pathKey] ?? "").split(path.delimiter).filter(Boolean);

  const normalize = (value: string) =>
    process.platform === "win32" ? value.toLowerCase() : value;

  if (!entries.some((entry) => normalize(entry) === normalize(nodeDir))) {
    env[pathKey] = [nodeDir, ...entries].join(path.delimiter);
  }
}
