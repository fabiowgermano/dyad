import { and, desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { chats, messages } from "@/db/schema";
import { createDyadApp } from "@/ipc/services/app_creation_service";
import {
  executeChatStreamFromActor,
  registerChatStreamHandlers,
} from "@/ipc/handlers/chat_stream_handlers";
import type { RoutableSafeSender } from "@/ipc/utils/safe_sender";
import { executionBackendForModel } from "@/shared/execution_backend";
import type { SerializableChatTurnIntent } from "@/chat_stream/transport";
import { computeChatTurnPayloadHash } from "@/ipc/utils/chat_turn_intent_hash";
import type {
  ChatStreamEndPayload,
  ChatStreamErrorPayload,
} from "@/chat_stream/protocol";
import type { ModelSelection } from "@/lib/schemas";
import { startFactoryPreview } from "./preview_runtime";
import type { DyadCreatedApp, DyadExecutionFacade } from "./prototype_executor";

let chatRuntimeRegistered = false;

function ensureHeadlessChatRuntime(): void {
  if (chatRuntimeRegistered) return;
  registerChatStreamHandlers({ registerIPC: false });
  chatRuntimeRegistered = true;
}

const headlessSender: RoutableSafeSender = {
  // NaN deliberately keeps high-volume delivery out of WindowRegistry while
  // satisfying the sender identity contract used by the production stream.
  id: Number.NaN,
  isDestroyed: () => false,
  isCrashed: () => false,
  send: () => undefined,
};

export class ProductionDyadExecutionFacade implements DyadExecutionFacade {
  async createApp(input: {
    name: string;
    operationId: string;
  }): Promise<DyadCreatedApp> {
    const created = await createDyadApp(
      {
        name: input.name,
        initialChatMode: "build",
      },
      {
        needsAppBlueprint: false,
        testingEnabled: false,
      },
    );
    return {
      appId: created.app.id,
      chatId: created.chatId,
      resolvedPath: created.app.resolvedPath,
    };
  }

  async bindModel(input: {
    chatId: number;
    selection: ModelSelection;
  }): Promise<void> {
    const backend = executionBackendForModel(input.selection);
    if (backend !== "dyad") {
      throw new Error(
        `Factory Dyad v1 only admits the Dyad execution backend; resolved ${backend}`,
      );
    }

    const updated = await db
      .update(chats)
      .set({
        modelSelection: input.selection,
        executionBackend: backend,
        chatMode: "build",
      })
      .where(eq(chats.id, input.chatId))
      .returning({ id: chats.id });

    if (updated.length !== 1) {
      throw new Error(`Dyad chat not found: ${input.chatId}`);
    }
  }

  async runBuild(input: {
    appId: number;
    chatId: number;
    operationId: string;
    intentId: string;
    prompt: string;
  }): Promise<{
    updatedFiles: boolean;
    providerRequestId?: string;
  }> {
    ensureHeadlessChatRuntime();

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
    const intent: SerializableChatTurnIntent = {
      ...withoutHash,
      payloadHash: computeChatTurnPayloadHash(withoutHash),
    };

    let terminalEnd: ChatStreamEndPayload | undefined;
    let terminalError: ChatStreamErrorPayload | undefined;

    const result = await executeChatStreamFromActor(
      headlessSender,
      {
        chatId: input.chatId,
        appId: input.appId,
        invocationRef,
        prompt: input.prompt,
        intentId: input.intentId,
        requestedChatMode: "build",
      },
      {
        intent,
        sessionQueued: false,
        onEnd: (response) => {
          terminalEnd = response;
        },
        onError: (error) => {
          terminalError = error;
        },
      },
    );

    if (terminalError) {
      throw new Error(`Dyad build failed: ${boundError(terminalError.error)}`);
    }
    if (result === "error") {
      throw new Error("Dyad build failed without a terminal completion");
    }
    if (!terminalEnd) {
      throw new Error("Dyad build ended without a terminal response");
    }
    if (terminalEnd.wasCancelled) {
      throw new Error("Dyad build was cancelled");
    }

    const latestAssistant = await db.query.messages.findFirst({
      where: and(
        eq(messages.chatId, input.chatId),
        eq(messages.role, "assistant"),
      ),
      orderBy: [desc(messages.id)],
    });

    return {
      updatedFiles: terminalEnd.updatedFiles ?? false,
      providerRequestId: latestAssistant?.requestId ?? undefined,
    };
  }

  startPreview(input: { appId: number; operationId: string }): Promise<string> {
    return startFactoryPreview({
      appId: input.appId,
      operationId: `${input.operationId}-preview`,
    });
  }
}

function boundError(message: string): string {
  const normalized = message.trim();
  return normalized.length <= 2_000 ? normalized : normalized.slice(0, 2_000);
}
