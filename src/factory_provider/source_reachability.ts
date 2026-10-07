import fs from "node:fs/promises";
import path from "node:path";

import type { SourceManifest } from "./source_manifest";

const FUNCTIONAL_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
  ".vue",
  ".svelte",
  ".html",
] as const;

export async function buildReachableFunctionalPaths(
  rootDirectory: string,
  manifest: SourceManifest,
): Promise<Set<string>> {
  const root = path.resolve(rootDirectory);
  const paths = new Set(manifest.files.map((file) => file.path));
  const entrypoints = findEntrypoints(paths);
  const reachable = new Set<string>();
  const pending = [...entrypoints];

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (reachable.has(current) || !paths.has(current)) continue;
    reachable.add(current);

    let source: string;
    try {
      source = await fs.readFile(
        path.join(root, ...current.split("/")),
        "utf8",
      );
    } catch {
      continue;
    }

    for (const specifier of extractLocalSpecifiers(source)) {
      const resolved = resolveLocalSpecifier(current, specifier, paths);
      if (resolved && !reachable.has(resolved)) pending.push(resolved);
    }
  }

  return new Set([...reachable].filter(isFunctionalCodePath));
}

export function isFunctionalCodePath(filePath: string): boolean {
  return FUNCTIONAL_EXTENSIONS.some((extension) =>
    filePath.toLowerCase().endsWith(extension),
  );
}

function findEntrypoints(paths: Set<string>): string[] {
  const all = [...paths];

  const mainEntrypoints = all.filter((filePath) =>
    /^(?:src\/)?main\.(?:[cm]?[jt]sx?|vue|svelte)$/i.test(filePath),
  );
  if (mainEntrypoints.length > 0) return mainEntrypoints.sort();

  const indexEntrypoints = all.filter((filePath) =>
    /^(?:src\/)?index\.(?:[cm]?[jt]sx?|vue|svelte|html)$/i.test(filePath),
  );
  if (indexEntrypoints.length > 0) return indexEntrypoints.sort();

  const appEntrypoints = all.filter((filePath) =>
    /^(?:src\/)?App\.(?:[cm]?[jt]sx?|vue|svelte)$/i.test(filePath),
  );
  if (appEntrypoints.length > 0) return appEntrypoints.sort();

  const frameworkRoutes = all.filter(
    (filePath) =>
      /^(?:src\/)?app\/(?:.*\/)?(?:page|layout)\.(?:[cm]?[jt]sx?|vue|svelte)$/i.test(
        filePath,
      ) || /^(?:src\/)?pages\/.+\.(?:[cm]?[jt]sx?|vue|svelte)$/i.test(filePath),
  );
  if (frameworkRoutes.length > 0) return frameworkRoutes.sort();

  return all.includes("index.html") ? ["index.html"] : [];
}

function extractLocalSpecifiers(source: string): string[] {
  const specifiers = new Set<string>();
  const patterns = [
    /(?:import|export)\s+(?:[^"\'\n]*?\s+from\s*)?["\']([^"\']+)["\']/g,
    /import\s*\(\s*["\']([^"\']+)["\']\s*\)/g,
    /require\s*\(\s*["\']([^"\']+)["\']\s*\)/g,
    /<script[^>]+src=["\']([^"\']+)["\']/gi,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

function resolveLocalSpecifier(
  importer: string,
  specifier: string,
  paths: Set<string>,
): string | undefined {
  const candidates: string[] = [];

  if (specifier.startsWith(".")) {
    candidates.push(
      path.posix.normalize(
        path.posix.join(path.posix.dirname(importer), specifier),
      ),
    );
  } else if (specifier.startsWith("@/")) {
    candidates.push(`src/${specifier.slice(2)}`);
  } else if (specifier.startsWith("~/")) {
    candidates.push(`src/${specifier.slice(2)}`, specifier.slice(2));
  } else if (specifier.startsWith("/src/")) {
    candidates.push(specifier.slice(1));
  } else {
    return undefined;
  }

  for (const candidate of candidates) {
    const resolved = resolveCandidate(candidate, paths);
    if (resolved) return resolved;
  }
  return undefined;
}

function resolveCandidate(
  candidate: string,
  paths: Set<string>,
): string | undefined {
  const normalized = candidate.replace(/\\/g, "/").replace(/^\.\//, "");
  if (paths.has(normalized)) return normalized;

  for (const extension of FUNCTIONAL_EXTENSIONS) {
    if (paths.has(`${normalized}${extension}`))
      return `${normalized}${extension}`;
  }

  for (const extension of FUNCTIONAL_EXTENSIONS) {
    const indexPath = `${normalized}/index${extension}`;
    if (paths.has(indexPath)) return indexPath;
  }

  return undefined;
}
