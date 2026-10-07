// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildSourceManifest } from "./source_manifest";
import { buildReachableFunctionalPaths } from "./source_reachability";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-reach-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("buildReachableFunctionalPaths", () => {
  it("follows relative and @/ imports from the real entrypoint", async () => {
    const root = await tempRoot();
    await fs.mkdir(path.join(root, "src", "pages"), { recursive: true });
    await fs.mkdir(path.join(root, "src", "components"), { recursive: true });
    await fs.writeFile(
      path.join(root, "src", "main.tsx"),
      'import App from "./App";\nvoid App;\n',
    );
    await fs.writeFile(
      path.join(root, "src", "App.tsx"),
      'import Index from "@/pages/Index";\nexport default Index;\n',
    );
    await fs.writeFile(
      path.join(root, "src", "pages", "Index.tsx"),
      'import { Card } from "../components/Card";\nexport default () => <Card />;\n',
    );
    await fs.writeFile(
      path.join(root, "src", "components", "Card.tsx"),
      "export const Card = () => <div />;\n",
    );
    await fs.writeFile(
      path.join(root, "src", "components", "Orphan.tsx"),
      "export const Orphan = () => <div />;\n",
    );

    const manifest = await buildSourceManifest(root);
    const reachable = await buildReachableFunctionalPaths(root, manifest);

    expect([...reachable].sort()).toEqual([
      "src/App.tsx",
      "src/components/Card.tsx",
      "src/main.tsx",
      "src/pages/Index.tsx",
    ]);
    expect(reachable.has("src/components/Orphan.tsx")).toBe(false);
  });
});
