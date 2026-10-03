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
  plugins: [
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
