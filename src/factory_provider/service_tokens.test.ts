// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readServiceTokens } from "./service_tokens";

const dirs: string[] = [];
function tokenFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-token-"));
  dirs.push(dir);
  const file = path.join(dir, "service.token");
  fs.writeFileSync(file, content);
  return file;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("readServiceTokens", () => {
  it("reads one token, ignoring blanks, comments and CRLF", () => {
    expect(readServiceTokens(tokenFile(`# current\r\n${A}\r\n\r\n`))).toEqual([
      A,
    ]);
  });

  it("accepts a current and a previous token for a rotation", () => {
    expect(readServiceTokens(tokenFile(`${B}\n${A}\n`))).toEqual([B, A]);
  });

  it("refuses an empty, weak, repeated or oversized file without printing a token", () => {
    expect(() => readServiceTokens(tokenFile("\n# nothing\n"))).toThrow(
      "no token",
    );
    expect(() => readServiceTokens(tokenFile("short-secret-value"))).toThrow(
      "at least 32",
    );
    expect(() => readServiceTokens(tokenFile(`${A}\n${A}\n`))).toThrow(
      "repeats",
    );
    expect(() =>
      readServiceTokens(tokenFile(`${A}\n${B}\n${"c".repeat(40)}\n`)),
    ).toThrow("more than two");
    try {
      readServiceTokens(tokenFile("short-secret-value"));
    } catch (error) {
      expect(String(error)).not.toContain("short-secret-value");
    }
    expect(() =>
      readServiceTokens(path.join(os.tmpdir(), "does-not-exist.token")),
    ).toThrow("could not be read");
  });
});
