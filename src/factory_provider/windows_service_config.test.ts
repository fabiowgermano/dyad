// @vitest-environment node
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadFactoryWindowsServiceConfig } from "./windows_service_config";

const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-config-"));
const TOKEN_FILE = path.join(tokenDir, "service.token");
fs.writeFileSync(TOKEN_FILE, `${"x".repeat(48)}\n`);

describe("loadFactoryWindowsServiceConfig", () => {
  it("loads explicit Windows service paths and private bind config", () => {
    const config = loadFactoryWindowsServiceConfig({
      FACTORY_DYAD_TOKEN_FILE: TOKEN_FILE,
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
    expect(config.tokenFile).toBe(path.resolve(TOKEN_FILE));
    expect(config.previewBindHost).toBe("");
    expect(path.basename(config.operationsDatabasePath)).toBe("operations.db");
  });

  it("fails closed without a strong token file and refuses a token in the environment", () => {
    expect(() => loadFactoryWindowsServiceConfig({})).toThrow(
      "FACTORY_DYAD_TOKEN_FILE is required",
    );
    const weak = path.join(tokenDir, "weak.token");
    fs.writeFileSync(weak, "short");
    expect(() =>
      loadFactoryWindowsServiceConfig({ FACTORY_DYAD_TOKEN_FILE: weak }),
    ).toThrow("at least 32");
    expect(() =>
      loadFactoryWindowsServiceConfig({
        FACTORY_DYAD_TOKEN: "x".repeat(48),
        FACTORY_DYAD_TOKEN_FILE: TOKEN_FILE,
      }),
    ).toThrow("not accepted");
  });

  it("serves the preview on a private address only for listed peers", () => {
    const base = {
      FACTORY_DYAD_TOKEN_FILE: TOKEN_FILE,
      FACTORY_DYAD_MODEL_REGISTRY_FILE: "C:\\FactoryDyad\\models.json",
      FACTORY_DYAD_BUILD_VERSION: "1.18.0-beta.1",
      FACTORY_DYAD_BUILD_COMMIT: "49ec81c7",
      FACTORY_DYAD_PREVIEW_BIND: "10.77.0.2",
    };
    expect(() => loadFactoryWindowsServiceConfig(base)).toThrow(
      "FACTORY_DYAD_PREVIEW_ALLOWED_PEERS is required",
    );
    const config = loadFactoryWindowsServiceConfig({
      ...base,
      FACTORY_DYAD_PREVIEW_ALLOWED_PEERS: "10.77.0.4, 10.77.0.1",
    });
    expect(config.previewBindHost).toBe("10.77.0.2");
    expect(config.previewAllowedPeers).toEqual(["10.77.0.4", "10.77.0.1"]);
  });

  it("requires an explicit model registry", () => {
    expect(() =>
      loadFactoryWindowsServiceConfig({
        FACTORY_DYAD_TOKEN_FILE: TOKEN_FILE,
      }),
    ).toThrow("FACTORY_DYAD_MODEL_REGISTRY_FILE is required");
  });

  it("rejects invalid ports", () => {
    expect(() =>
      loadFactoryWindowsServiceConfig({
        FACTORY_DYAD_TOKEN_FILE: TOKEN_FILE,
        FACTORY_DYAD_PORT: "70000",
        FACTORY_DYAD_MODEL_REGISTRY_FILE: "C:\\FactoryDyad\\models.json",
        FACTORY_DYAD_BUILD_VERSION: "1.18.0-beta.1",
        FACTORY_DYAD_BUILD_COMMIT: "49ec81c7",
      }),
    ).toThrow("1 to 65535");
  });
});
