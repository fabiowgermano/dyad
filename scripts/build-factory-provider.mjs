import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";

const outdir = path.resolve("dist/factory-dyad-provider");
fs.mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: ["src/factory_provider/service_main.ts"],
  outfile: path.join(outdir, "service.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  sourcemap: true,
  packages: "external",
  tsconfig: "tsconfig.factory-provider.json",
  logLevel: "info",
});

fs.copyFileSync(
  "package.json",
  path.join(outdir, "package.json"),
);
