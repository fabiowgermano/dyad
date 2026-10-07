import { randomUUID } from "node:crypto";

import { appRunDefinition } from "@/app_run/definition";
import { appRunActorService } from "@/ipc/services/app_run_actor_service";
import { appRuntimeService } from "@/ipc/services/app_runtime_service";
import { remoteMachineHost } from "@/ipc/services/distributed_machine_actor_host";
import { runningApps, stopAllAppsSync } from "@/ipc/utils/process_manager";

let machineRegistered = false;
let exitHookInstalled = false;

export function ensureFactoryAppRunMachineRegistered(): void {
  if (machineRegistered) return;
  try {
    remoteMachineHost.register(appRunDefinition);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/is already registered/.test(message)) throw error;
  }
  machineRegistered = true;
}

export function installFactoryRuntimeExitHooks(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  const stop = () => {
    try {
      stopAllAppsSync();
    } catch {
      // best effort during process termination
    }
  };
  process.once("exit", stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

export async function startFactoryPreview(options: {
  appId: number;
  operationId?: string;
  readyTimeoutMs?: number;
}): Promise<string> {
  ensureFactoryAppRunMachineRegistered();
  installFactoryRuntimeExitHooks();

  const activePreview = runningApps.get(options.appId)?.proxyUrl;
  if (activePreview) {
    return activePreview;
  }

  await appRunActorService.dispatchStart(options.appId, {
    operationId: options.operationId ?? randomUUID(),
    startedAt: Date.now(),
  });
  await appRuntimeService.waitForReady(options.appId, {
    timeoutMs: options.readyTimeoutMs ?? 2 * 60 * 1_000,
  });
  const url = runningApps.get(options.appId)?.proxyUrl;
  if (!url) {
    throw new Error("Dyad app runtime became ready without a preview URL");
  }
  return url;
}

export async function stopFactoryPreview(appId: number): Promise<void> {
  try {
    await appRuntimeService.stop(appId);
  } finally {
    if (machineRegistered) {
      await appRunActorService.disposeApp(appId).catch(() => undefined);
    }
  }
}
