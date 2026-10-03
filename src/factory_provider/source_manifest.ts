import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface SourceManifestFile {
  path: string;
  sha256: string;
  byteSize: number;
}

export interface SourceManifest {
  files: SourceManifestFile[];
  sourceSha256: string;
}

function sha256(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function normalizeRelativePath(root: string, filePath: string): string {
  const relative = path.relative(root, filePath).split(path.sep).join("/");
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith("../") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`unsafe source path: ${filePath}`);
  }
  return relative;
}

async function walk(root: string, current: string): Promise<string[]> {
  const entries = await fs.readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(root, fullPath)));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

export async function buildSourceManifest(
  rootDirectory: string,
): Promise<SourceManifest> {
  const root = path.resolve(rootDirectory);
  const absoluteFiles = await walk(root, root);
  const files: SourceManifestFile[] = [];

  for (const absoluteFile of absoluteFiles) {
    const relativePath = normalizeRelativePath(root, absoluteFile);
    const content = await fs.readFile(absoluteFile);
    files.push({
      path: relativePath,
      sha256: sha256(content),
      byteSize: content.byteLength,
    });
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  const canonical = files
    .map((file) => `${file.path}\0${file.sha256}\0${file.byteSize}\n`)
    .join("");

  return { files, sourceSha256: sha256(canonical) };
}
