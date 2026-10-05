import type { LanguageModelV3ToolCall } from "@ai-sdk/provider";
import type { ModelMessage } from "ai";

type JsonObject = Record<string, unknown>;

export function repairFactoryHeadlessToolCall(input: {
  toolCall: LanguageModelV3ToolCall;
  messages: ModelMessage[];
}): LanguageModelV3ToolCall | null {
  const args = parseJsonObject(input.toolCall.input);
  if (!args) return null;

  const explicitPath = nonEmptyString(args.path);
  if (explicitPath) return null;

  const aliasPath = nonEmptyString(args.file_path);
  if (aliasPath) {
    const repaired: JsonObject = { ...args, path: aliasPath };
    delete repaired.file_path;
    return {
      ...input.toolCall,
      input: JSON.stringify(repaired),
    };
  }

  if (
    input.toolCall.toolName !== "write_file" ||
    typeof args.content !== "string"
  ) {
    return null;
  }

  const repairPath =
    findBuildVerificationFailurePath(input.messages) ??
    findLatestReadFilePath(input.messages);
  if (!repairPath) return null;

  return {
    ...input.toolCall,
    input: JSON.stringify({
      ...args,
      path: repairPath,
    }),
  };
}

function findBuildVerificationFailurePath(
  messages: ModelMessage[],
): string | undefined {
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex--
  ) {
    const message = messages[messageIndex];
    if (message?.role !== "user") continue;

    const text = modelMessageText(message);
    const markerIndex = text.indexOf("# Build verification failure");
    if (markerIndex < 0) continue;

    const verificationText = text.slice(markerIndex);
    const match = verificationText.match(
      /\b((?:src|app)\/[A-Za-z0-9._/-]+\.(?:[cm]?[jt]sx?|vue|svelte|html))(?::\d+(?::\d+)?)?/i,
    );
    if (match?.[1]) return match[1];
  }

  return undefined;
}

function modelMessageText(message: ModelMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";

  return message.content
    .map((raw) => {
      const part = raw as unknown;
      if (!isJsonObject(part)) return "";
      return part.type === "text" && typeof part.text === "string"
        ? part.text
        : "";
    })
    .join("\n");
}

function findLatestReadFilePath(messages: ModelMessage[]): string | undefined {
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex--
  ) {
    const content = messages[messageIndex]?.content;
    if (!Array.isArray(content)) continue;

    for (let partIndex = content.length - 1; partIndex >= 0; partIndex--) {
      const part = content[partIndex] as unknown;
      if (!isJsonObject(part)) continue;
      if (part.type !== "tool-call" || part.toolName !== "read_file") continue;

      const toolInput = part.input;
      if (isJsonObject(toolInput)) {
        const path = nonEmptyString(toolInput.path);
        if (path) return path;
      }

      if (typeof toolInput === "string") {
        const parsed = parseJsonObject(toolInput);
        const path = parsed ? nonEmptyString(parsed.path) : undefined;
        if (path) return path;
      }
    }
  }

  return undefined;
}

function parseJsonObject(value: string): JsonObject | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}
