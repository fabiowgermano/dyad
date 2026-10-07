import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const outdir = path.join(repoRoot, "dist", "factory-dyad-provider");
fs.mkdirSync(outdir, { recursive: true });
// Remove the old provenance first: a failed build must not leave a stale
// build-info.json vouching for a bundle it does not describe.
fs.rmSync(path.join(outdir, "build-info.json"), { force: true });

const git = (...args) =>
  execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
// Same rule as the start script: a dirty tree is recorded, and the service and
// the start script refuse to run such a build.
const dirty = git("status", "--porcelain") !== "";

await build({
  absWorkingDir: repoRoot,
  entryPoints: ["src/factory_provider/service_entry.ts"],
  outfile: path.join(outdir, "service.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  sourcemap: true,
  packages: "external",
  plugins: [
    {
      name: "factory-safe-storage-cjs",
      setup(buildApi) {
        buildApi.onLoad({ filter: /safe_storage_legacy\.ts$/ }, (args) => {
          const source = fs
            .readFileSync(args.path, "utf8")
            .replace(
              "createRequire(import.meta.url)",
              "createRequire(__filename)",
            );
          return { contents: source, loader: "ts" };
        });
      },
    },
    {
      name: "factory-src-alias",
      setup(buildApi) {
        buildApi.onResolve({ filter: /^@\// }, (args) => {
          const relative = args.path.slice(2).replace(/\?raw$/, "");
          const base = path.join(repoRoot, "src", relative);
          const candidates = [
            base,
            `${base}.ts`,
            `${base}.tsx`,
            `${base}.js`,
            `${base}.json`,
            path.join(base, "index.ts"),
            path.join(base, "index.tsx"),
            path.join(base, "index.js"),
          ];
          const resolved = candidates.find((candidate) => {
            try {
              return fs.statSync(candidate).isFile();
            } catch {
              return false;
            }
          });
          if (!resolved) {
            return {
              errors: [
                {
                  text: `Factory alias could not resolve ${args.path}`,
                },
              ],
            };
          }
          return { path: resolved };
        });
      },
    },
  ],
  loader: {
    ".md": "text",
    ".txt": "text",
  },
  tsconfig: path.join(repoRoot, "tsconfig.factory-provider.json"),
  logLevel: "info",
});

fs.copyFileSync(
  path.join(repoRoot, "package.json"),
  path.join(outdir, "package.json"),
);

const serviceFile = path.join(outdir, "service.cjs");
const buildInfo = {
  commit,
  version: JSON.parse(
    fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
  ).version,
  dirty,
  builtAt: new Date().toISOString(),
  serviceSha256: crypto
    .createHash("sha256")
    .update(fs.readFileSync(serviceFile))
    .digest("hex"),
};
fs.writeFileSync(
  path.join(outdir, "build-info.json"),
  JSON.stringify(buildInfo, null, 2) + "\n",
);
console.log(`factory-dyad-provider build info: ${JSON.stringify(buildInfo)}`);
if (dirty) {
  console.warn(
    "WARNING: built from a dirty checkout; the service and the start script will refuse to run this build.",
  );
}
