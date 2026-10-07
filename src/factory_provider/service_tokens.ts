import fs from "node:fs";

/** Tokens shorter than this are refused: they are guessable. */
export const MIN_SERVICE_TOKEN_LENGTH = 32;

/**
 * Reads the service bearer tokens from the token file: one token per line,
 * blank lines and `#` comments ignored. Two lines are allowed so a token can be
 * rotated without downtime (the new one first, the old one until the caller
 * has switched). The file is read again on every request, so a rotation needs
 * no restart. Error messages never contain a token.
 */
export function readServiceTokens(filePath: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    throw new Error("FACTORY_DYAD_TOKEN_FILE could not be read");
  }
  const tokens = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
  if (tokens.length === 0) {
    throw new Error("FACTORY_DYAD_TOKEN_FILE holds no token");
  }
  if (tokens.length > 2) {
    throw new Error(
      "FACTORY_DYAD_TOKEN_FILE holds more than two tokens (current and previous)",
    );
  }
  if (new Set(tokens).size !== tokens.length) {
    throw new Error("FACTORY_DYAD_TOKEN_FILE repeats a token");
  }
  if (tokens.some((token) => token.length < MIN_SERVICE_TOKEN_LENGTH)) {
    throw new Error(
      `FACTORY_DYAD_TOKEN_FILE tokens must be at least ${MIN_SERVICE_TOKEN_LENGTH} characters`,
    );
  }
  return tokens;
}
