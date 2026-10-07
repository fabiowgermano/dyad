import type { WindowEndpoint } from "./window_registry";
import type { ChatResponseChunk } from "@/ipc/types/chat";
import type { AppOutput } from "@/ipc/types/misc";
import {
  isWindowRoutableSender,
  safeSend,
  type RoutableSafeSender,
} from "@/ipc/utils/safe_sender";
import { HighVolumeWindowInterests } from "./high_volume_interests";
import { windowRegistry } from "./window_registry";

export const appOutputInterests = new HighVolumeWindowInterests<AppOutput>(
  windowRegistry,
  "app:output-batch",
  100,
);

export const chatChunkInterests =
  new HighVolumeWindowInterests<ChatResponseChunk>(
    windowRegistry,
    "chat:response:chunk",
    0,
    "individual",
  );

export function ensureProducerInterest(
  sender: WindowEndpoint,
  interest:
    | { kind: "app-output"; appId: number }
    | { kind: "chat-chunk"; chatId: number },
): void {
  windowRegistry.ensureRegistered(sender);
  if (interest.kind === "app-output") {
    appOutputInterests.attachLive(sender.id, interest);
  } else {
    chatChunkInterests.attachLive(sender.id, interest);
  }
}

export function sendChatChunk(
  sender: RoutableSafeSender,
  payload: ChatResponseChunk,
): void {
  if (!isWindowRoutableSender(sender) || sender.isDestroyed()) {
    safeSend(sender, "chat:response:chunk", payload);
  } else {
    ensureProducerInterest(sender as WindowEndpoint, {
      kind: "chat-chunk",
      chatId: payload.chatId,
    });
  }
  const interest = { kind: "chat-chunk" as const, chatId: payload.chatId };
  chatChunkInterests.sendImmediate(interest, payload, "chat:response:chunk");
}

export function releaseChatProducerInterest(
  sender: RoutableSafeSender,
  chatId: number,
): void {
  if (!isWindowRoutableSender(sender)) return;
  chatChunkInterests.releaseLive(sender.id, {
    kind: "chat-chunk",
    chatId,
  });
}
