// @vitest-environment node
import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadFactoryWindowsServiceConfig } from "./windows_service_config";
import { startFactoryProviderServer } from "./http_server";

const tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-config-"));
const TOKEN_FILE = path.join(tokenDir, "service.token");
fs.writeFileSync(TOKEN_FILE, `${"x".repeat(48)}\n`);

const BAKED_COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** A dist directory as scripts/build-factory-provider.mjs leaves it. */
function makeDist(
  overrides: Record<string, unknown> = {},
  bundle = "// bundle\n",
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-dist-"));
  fs.writeFileSync(path.join(dir, "service.cjs"), bundle);
  const info = {
    commit: BAKED_COMMIT,
    version: "1.18.0-beta.1",
    dirty: false,
    builtAt: "2026-10-07T00:00:00.000Z",
    serviceSha256: crypto.createHash("sha256").update(bundle).digest("hex"),
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, "build-info.json"), JSON.stringify(info));
  return dir;
}
const DIST = makeDist();
const MINIMAL_ENV = {
  FACTORY_DYAD_TOKEN_FILE: TOKEN_FILE,
  FACTORY_DYAD_MODEL_REGISTRY_FILE: "C:\\FactoryDyad\\models.json",
};

describe("loadFactoryWindowsServiceConfig", () => {
  it("loads explicit Windows service paths and private bind config", () => {
    const config = loadFactoryWindowsServiceConfig(
      {
        FACTORY_DYAD_TOKEN_FILE: TOKEN_FILE,
        FACTORY_DYAD_DATA_DIR: "C:\\FactoryDyad\\data",
        FACTORY_DYAD_WORKSPACE_ROOT: "D:\\FactoryDyad\\workspaces",
        FACTORY_DYAD_BIND: "10.77.0.2",
        FACTORY_DYAD_PORT: "8787",
        FACTORY_DYAD_MODEL_REGISTRY_FILE: "C:\\FactoryDyad\\models.json",
        FACTORY_DYAD_BUILD_VERSION: "1.18.0-beta.1",
        FACTORY_DYAD_BUILD_COMMIT: BAKED_COMMIT,
      },
      DIST,
    );

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
      FACTORY_DYAD_BUILD_COMMIT: BAKED_COMMIT,
      FACTORY_DYAD_PREVIEW_BIND: "10.77.0.2",
    };
    expect(() => loadFactoryWindowsServiceConfig(base)).toThrow(
      "FACTORY_DYAD_PREVIEW_ALLOWED_PEERS is required",
    );
    const config = loadFactoryWindowsServiceConfig(
      {
        ...base,
        FACTORY_DYAD_PREVIEW_ALLOWED_PEERS: "10.77.0.4, 10.77.0.1",
      },
      DIST,
    );
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

  it("reports the commit baked into the dist on /healthz, without the env claim", async () => {
    const config = loadFactoryWindowsServiceConfig(MINIMAL_ENV, DIST);
    expect(config.buildCommit).toBe(BAKED_COMMIT);
    expect(config.buildVersion).toBe("1.18.0-beta.1");
    const server = await startFactoryProviderServer({
      runtime: {
        createPrototype: async () => {
          throw new Error("unused");
        },
        getOperation: async () => null,
      },
      tokens: () => ["t".repeat(48)],
      dyadVersion: config.buildVersion,
      dyadCommit: config.buildCommit,
    });
    try {
      const health = await fetch(
        `http://${server.host}:${server.port}/healthz`,
      );
      expect(await health.json()).toMatchObject({
        dyadCommit: BAKED_COMMIT,
        dyadVersion: "1.18.0-beta.1",
      });
    } finally {
      await server.close();
    }
  });

  it("refuses to start when the checkout claims a commit the dist was not built from", () => {
    expect(() =>
      loadFactoryWindowsServiceConfig(
        { ...MINIMAL_ENV, FACTORY_DYAD_BUILD_COMMIT: "f".repeat(40) },
        DIST,
      ),
    ).toThrow(
      `FACTORY_DYAD_BUILD_COMMIT=${"f".repeat(40)} but the dist was built from ${BAKED_COMMIT}: run node scripts\\build-factory-provider.mjs`,
    );
    expect(() =>
      loadFactoryWindowsServiceConfig(
        { ...MINIMAL_ENV, FACTORY_DYAD_BUILD_VERSION: "9.9.9" },
        DIST,
      ),
    ).toThrow("but the dist was built from 1.18.0-beta.1");
  });

  it("refuses to start without build info", () => {
    const dir = makeDist();
    fs.rmSync(path.join(dir, "build-info.json"));
    expect(() => loadFactoryWindowsServiceConfig(MINIMAL_ENV, dir)).toThrow(
      "is missing or unreadable",
    );
    expect(() =>
      loadFactoryWindowsServiceConfig(MINIMAL_ENV, makeDist({ commit: "" })),
    ).toThrow("has no commit");
  });

  it("refuses a dirty build and a bundle that does not match its build info", () => {
    expect(() =>
      loadFactoryWindowsServiceConfig(MINIMAL_ENV, makeDist({ dirty: true })),
    ).toThrow("dirty checkout");
    const dir = makeDist();
    fs.writeFileSync(path.join(dir, "service.cjs"), "// another build\n");
    expect(() => loadFactoryWindowsServiceConfig(MINIMAL_ENV, dir)).toThrow(
      "does not match its build info",
    );
  });
});
