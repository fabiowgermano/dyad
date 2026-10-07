const FACTORY_HEADLESS_INSPECTION_STEP_BUDGET = 1;

const FACTORY_HEADLESS_MUTATION_TOOLS = [
  "write_file",
  "search_replace",
] as const;

const FACTORY_HEADLESS_FORCE_WRITE = {
  activeTools: ["write_file"] as const,
  toolChoice: { type: "tool" as const, toolName: "write_file" as const },
};

export function getFactoryHeadlessStepOverride(input: {
  stepNumber: number;
  workspaceMutated: boolean;
  repairTurn: boolean;
}) {
  // A repair is a fresh governed attempt. Force its first model step to
  // actually write source even if the shared context still reports a
  // mutation from the preceding turn.
  if (input.repairTurn && input.stepNumber === 0) {
    return FACTORY_HEADLESS_FORCE_WRITE;
  }

  if (input.workspaceMutated) {
    return {
      toolChoice: "auto" as const,
    };
  }

  // If the forced repair write failed to mutate, keep requiring write_file
  // instead of allowing the model to fall back to prose or more inspection.
  if (input.repairTurn) {
    return FACTORY_HEADLESS_FORCE_WRITE;
  }

  if (input.stepNumber < FACTORY_HEADLESS_INSPECTION_STEP_BUDGET) {
    return undefined;
  }

  return {
    activeTools: [...FACTORY_HEADLESS_MUTATION_TOOLS],
    toolChoice: "required" as const,
  };
}
