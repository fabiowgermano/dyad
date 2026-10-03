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
  entryPoints: ["src/factory_provider/service_main.ts"],
  outfile: path.join(outdir, "service.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  sourcemap: true,
  packages: "external",
  tsconfig: path.join(repoRoot, "tsconfig.factory-provider.json"),
  logLevel: "info",
});

fs.copyFileSync(
  path.join(repoRoot, "package.json"),
  path.join(outdir, "package.json"),
);
