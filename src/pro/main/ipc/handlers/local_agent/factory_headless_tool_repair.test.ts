import { describe, expect, it } from "vitest";
import type { LanguageModelV3ToolCall } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";
import { repairFactoryHeadlessToolCall } from "./factory_headless_tool_repair";

function toolCall(
  toolName: string,
  input: Record<string, unknown>,
): LanguageModelV3ToolCall {
  return {
    type: "tool-call",
    toolCallId: "call-1",
    toolName,
    input: JSON.stringify(input),
  };
}

describe("Factory headless tool-call repair", () => {
  it("restores a missing write_file path from the latest read_file target", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "read-1",
            toolName: "read_file",
            input: { path: "src/pages/Index.tsx" },
          },
        ],
      },
    ];

    const repaired = repairFactoryHeadlessToolCall({
      toolCall: toolCall("write_file", { content: "export default 1;" }),
      messages,
    });

    expect(repaired).not.toBeNull();
    expect(JSON.parse(repaired!.input)).toEqual({
      content: "export default 1;",
      path: "src/pages/Index.tsx",
    });
  });

  it("prefers the build failure path over the latest read target", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "read-1",
            toolName: "read_file",
            input: { path: "src/components/ui/card.tsx" },
          },
        ],
      },
      {
        role: "user",
        content:
          "# Factory headless build correction\n\n# Build verification failure\n[builtin:vite-transform] Unexpected token at src/pages/Index.tsx:86:54",
      },
    ];

    const repaired = repairFactoryHeadlessToolCall({
      toolCall: toolCall("write_file", { content: "export default 1;" }),
      messages,
    });

    expect(repaired).not.toBeNull();
    expect(JSON.parse(repaired!.input)).toEqual({
      content: "export default 1;",
      path: "src/pages/Index.tsx",
    });
  });

  it("normalizes file_path to path", () => {
    const repaired = repairFactoryHeadlessToolCall({
      toolCall: toolCall("write_file", {
        file_path: "src/App.tsx",
        content: "export default 1;",
      }),
      messages: [],
    });

    expect(repaired).not.toBeNull();
    expect(JSON.parse(repaired!.input)).toEqual({
      path: "src/App.tsx",
      content: "export default 1;",
    });
  });

  it("fails closed when no unambiguous prior read target exists", () => {
    expect(
      repairFactoryHeadlessToolCall({
        toolCall: toolCall("write_file", { content: "export default 1;" }),
        messages: [],
      }),
    ).toBeNull();
  });

  it("does not invent a path for unrelated tools", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "read-1",
            toolName: "read_file",
            input: { path: "src/pages/Index.tsx" },
          },
        ],
      },
    ];

    expect(
      repairFactoryHeadlessToolCall({
        toolCall: toolCall("search_replace", {
          search: "old",
          replace: "new",
        }),
        messages,
      }),
    ).toBeNull();
  });
});
