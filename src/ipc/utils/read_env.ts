import { shellEnvSync } from "shell-env";

// Need to look up run-time env vars this way
// otherwise it doesn't work as expected in MacOs apps:
// https://github.com/sindresorhus/shell-env

let _env: Record<string, string> | null = null;

export function getEnvVar(key: string) {
  // A Windows service has no interactive login shell to recover. Its explicit
  // service environment is the authority and must not be replaced by shell-env.
  if (process.env.DYAD_HEADLESS_SERVICE === "1") {
    return process.env[key];
  }

  // Cache the interactive desktop shell environment.
  if (!_env) {
    _env = shellEnvSync();
  }
  return _env[key];
}
