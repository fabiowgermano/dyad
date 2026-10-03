import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const outdir = path.join(repoRoot, "dist", "factory-dyad-provider");
fs.mkdirSync(outdir, { recursive: true });

await build({
  absWorkingDir: repoRoot,
  entryPoints: ["src/factory_provider/service_entry.ts"],
  outfile: path.join(outdir, "service.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: true,
  packages: "external",
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
