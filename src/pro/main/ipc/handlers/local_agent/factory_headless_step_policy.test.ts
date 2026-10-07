import { describe, expect, it } from "vitest";
import { getFactoryHeadlessStepOverride } from "./factory_headless_step_policy";

describe("Factory headless step policy", () => {
  it("allows one inspection step before forcing the first mutation", () => {
    expect(
      getFactoryHeadlessStepOverride({
        stepNumber: 0,
        workspaceMutated: false,
        repairTurn: false,
      }),
    ).toBeUndefined();

    expect(
      getFactoryHeadlessStepOverride({
        stepNumber: 1,
        workspaceMutated: false,
        repairTurn: false,
      }),
    ).toEqual({
      activeTools: ["write_file", "search_replace"],
      toolChoice: "required",
    });
  });

  it("forces write_file immediately for a repair turn", () => {
    expect(
      getFactoryHeadlessStepOverride({
        stepNumber: 0,
        workspaceMutated: false,
        repairTurn: true,
      }),
    ).toEqual({
      activeTools: ["write_file"],
      toolChoice: { type: "tool", toolName: "write_file" },
    });
  });

  it("forces repair step zero even when mutation state leaked from the prior turn", () => {
    expect(
      getFactoryHeadlessStepOverride({
        stepNumber: 0,
        workspaceMutated: true,
        repairTurn: true,
      }),
    ).toEqual({
      activeTools: ["write_file"],
      toolChoice: { type: "tool", toolName: "write_file" },
    });
  });

  it("returns to automatic tool choice after a repair has made a fresh mutation", () => {
    expect(
      getFactoryHeadlessStepOverride({
        stepNumber: 1,
        workspaceMutated: true,
        repairTurn: true,
      }),
    ).toEqual({
      toolChoice: "auto",
    });
  });
});
