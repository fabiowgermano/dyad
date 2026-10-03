// @vitest-environment node
import { describe, expect, it } from "vitest";
import { computeChatTurnPayloadHash } from "@/ipc/utils/chat_turn_intent_hash";
import type { SerializableChatTurnIntent } from "@/chat_stream/transport";

function buildIntent(input: {
  appId: number;
  chatId: number;
  operationId: string;
  intentId: string;
  prompt: string;
}): SerializableChatTurnIntent {
  const invocationRef = {
    kind: "chat-stream" as const,
    entityKey: input.chatId,
    operationId: input.operationId,
  };
  const withoutHash: Omit<SerializableChatTurnIntent, "payloadHash"> = {
    schemaVersion: 1,
    intentId: input.intentId,
    appId: input.appId,
    chatId: input.chatId,
    invocationRef,
    prompt: input.prompt,
    requestedChatMode: "build",
  };
  return {
    ...withoutHash,
    payloadHash: computeChatTurnPayloadHash(withoutHash),
  };
}

describe("Factory headless chat intent", () => {
  it("uses the canonical immutable Dyad payload hash", () => {
    const intent = buildIntent({
      appId: 42,
      chatId: 7,
      operationId: "op-1",
      intentId: "intent-1",
      prompt: "Build the UI",
    });
    const { payloadHash, ...withoutHash } = intent;
    expect(payloadHash).toBe(computeChatTurnPayloadHash(withoutHash));
    expect(payloadHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("binds the hash to immutable routing and prompt fields", () => {
    const first = buildIntent({
      appId: 42,
      chatId: 7,
      operationId: "op-1",
      intentId: "intent-1",
      prompt: "Build the UI",
    });
    const changed = buildIntent({
      appId: 42,
      chatId: 7,
      operationId: "op-1",
      intentId: "intent-1",
      prompt: "Build a different UI",
    });
    expect(first.payloadHash).not.toBe(changed.payloadHash);
  });
});
