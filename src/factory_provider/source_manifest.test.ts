// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSourceManifest } from "./source_manifest";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-manifest-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      fs.rm(root, { recursive: true, force: true }).catch(() => undefined),
    ),
  );
});

describe("buildSourceManifest", () => {
  it("is deterministic regardless of filesystem creation order", async () => {
    const a = await tempRoot();
    const b = await tempRoot();

    await fs.mkdir(path.join(a, "src"), { recursive: true });
    await fs.writeFile(path.join(a, "src", "b.ts"), "export const b = 2;\n");
    await fs.writeFile(path.join(a, "src", "a.ts"), "export const a = 1;\n");

    await fs.mkdir(path.join(b, "src"), { recursive: true });
    await fs.writeFile(path.join(b, "src", "a.ts"), "export const a = 1;\n");
    await fs.writeFile(path.join(b, "src", "b.ts"), "export const b = 2;\n");

    const ma = await buildSourceManifest(a);
    const mb = await buildSourceManifest(b);

    expect(ma).toEqual(mb);
    expect(ma.files.map((file) => file.path)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("excludes non-source dependency and git directories", async () => {
    const root = await tempRoot();
    await fs.mkdir(path.join(root, "node_modules", "x"), { recursive: true });
    await fs.mkdir(path.join(root, ".git"), { recursive: true });
    await fs.writeFile(path.join(root, "app.ts"), "ok\n");
    await fs.writeFile(path.join(root, "node_modules", "x", "index.js"), "no\n");
    await fs.writeFile(path.join(root, ".git", "HEAD"), "ref\n");

    const manifest = await buildSourceManifest(root);
    expect(manifest.files.map((file) => file.path)).toEqual(["app.ts"]);
  });
});
