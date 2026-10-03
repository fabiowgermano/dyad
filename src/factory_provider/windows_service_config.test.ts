// @vitest-environment node
import { describe, expect, it } from "vitest";
import path from "node:path";
import { loadFactoryWindowsServiceConfig } from "./windows_service_config";

describe("loadFactoryWindowsServiceConfig", () => {
  it("loads explicit Windows service paths and private bind config", () => {
    const config = loadFactoryWindowsServiceConfig({
      FACTORY_DYAD_TOKEN: "x".repeat(48),
      FACTORY_DYAD_DATA_DIR: "C:\\FactoryDyad\\data",
      FACTORY_DYAD_WORKSPACE_ROOT: "D:\\FactoryDyad\\workspaces",
      FACTORY_DYAD_BIND: "10.77.0.2",
      FACTORY_DYAD_PORT: "8787",
      FACTORY_DYAD_MODEL_REGISTRY_FILE: "C:\\FactoryDyad\\models.json",
      FACTORY_DYAD_BUILD_VERSION: "1.18.0-beta.1",
      FACTORY_DYAD_BUILD_COMMIT: "49ec81c7",
    });

    expect(config.bindHost).toBe("10.77.0.2");
    expect(config.port).toBe(8787);
    expect(config.token).toHaveLength(48);
    expect(path.basename(config.operationsDatabasePath)).toBe("operations.db");
  });

  it("fails closed without a strong service token", () => {
    expect(() => loadFactoryWindowsServiceConfig({})).toThrow(
      "FACTORY_DYAD_TOKEN is required",
    );
    expect(() =>
      loadFactoryWindowsServiceConfig({ FACTORY_DYAD_TOKEN: "short" }),
    ).toThrow("at least 32");
  });

  it("requires an explicit model registry", () => {
    expect(() =>
      loadFactoryWindowsServiceConfig({
        FACTORY_DYAD_TOKEN: "x".repeat(48),
      }),
    ).toThrow("FACTORY_DYAD_MODEL_REGISTRY_FILE is required");
  });

  it("rejects invalid ports", () => {
    expect(() =>
      loadFactoryWindowsServiceConfig({
        FACTORY_DYAD_TOKEN: "x".repeat(48),
        FACTORY_DYAD_PORT: "70000",
        FACTORY_DYAD_MODEL_REGISTRY_FILE: "C:\\FactoryDyad\\models.json",
      FACTORY_DYAD_BUILD_VERSION: "1.18.0-beta.1",
      FACTORY_DYAD_BUILD_COMMIT: "49ec81c7",
      }),
    ).toThrow("1 to 65535");
  });
});
