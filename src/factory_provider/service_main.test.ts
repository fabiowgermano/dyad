// @vitest-environment node
import path from "node:path";
import { describe, expect, it } from "vitest";
import { prependFactoryServiceNodeRuntimeToPath } from "./service_main";

describe("prependFactoryServiceNodeRuntimeToPath", () => {
  it("prepends the service Node directory exactly once", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: ["first", "second"].join(path.delimiter),
    };
    const executable = path.join("C:", "FactoryDyad", "node", "node.exe");
    const nodeDir = path.dirname(executable);

    prependFactoryServiceNodeRuntimeToPath(env, executable);
    prependFactoryServiceNodeRuntimeToPath(env, executable);

    expect(env.PATH?.split(path.delimiter)).toEqual([
      nodeDir,
      "first",
      "second",
    ]);
  });
});
