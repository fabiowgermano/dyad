import { db } from "@/db";
import { apps, chats } from "@/db/schema";
import type { CreateAppParams } from "@/ipc/types/app";
import { initialChatExecution } from "@/ipc/utils/chat_execution_selection";
import { getDyadAppPath, isAppLocationAccessible } from "@/paths/paths";
import {
  sanitizeAppDisplayName,
  slugifyAppFolderName,
} from "@/shared/app_names";
import { eq } from "drizzle-orm";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { readSettings } from "@/main/settings";
import { resolveUniqueFolderName } from "@/ipc/utils/app_name_resolution";
import { getInitialChatModeForNewChat } from "@/ipc/handlers/chat_mode_resolution";
import { createFromTemplate } from "@/ipc/handlers/createFromTemplate";
import { ensureDyadGitignored } from "@/ipc/handlers/gitignoreUtils";
import { gitService } from "@/ipc/services/git_service";

export interface CreatedDyadApp {
  app: typeof apps.$inferSelect & { resolvedPath: string };
  chatId: number;
}

/**
 * Creates a Dyad app using the same database/template/git semantics as the
 * desktop application without depending on IPC or a renderer.
 */
export async function createDyadApp(
  params: CreateAppParams,
  options: {
    needsAppBlueprint?: boolean;
    testingEnabled?: boolean;
  } = {},
): Promise<CreatedDyadApp> {
  const appName = sanitizeAppDisplayName(params.name);

  const nameConflict = await db.query.apps.findFirst({
    where: eq(apps.name, appName),
  });
  if (nameConflict) {
    throw new DyadError(
      `An app named "${appName}" already exists.`,
      DyadErrorKind.Conflict,
    );
  }

  const appPath = await resolveUniqueFolderName(slugifyAppFolderName(appName));
  const fullAppPath = getDyadAppPath(appPath);

  if (!isAppLocationAccessible(fullAppPath)) {
    throw new DyadError(
      `The path ${fullAppPath} is inaccessible. Please check the configured apps folder.`,
      DyadErrorKind.Precondition,
    );
  }

  const settings = readSettings();
  const [app] = await db
    .insert(apps)
    .values({
      name: appName,
      path: appPath,
      needsAppBlueprint:
        options.needsAppBlueprint ?? settings.enableAppBlueprint,
      testingEnabled:
        options.testingEnabled ?? settings.enableTestingForNewApps ?? false,
    })
    .returning();

  try {
    const initialChatMode = await getInitialChatModeForNewChat(
      params.initialChatMode,
    );
    const [chat] = await db
      .insert(chats)
      .values({
        appId: app.id,
        chatMode: initialChatMode,
        ...(await initialChatExecution()),
      })
      .returning();

    await createFromTemplate({ fullAppPath });
    await ensureDyadGitignored(fullAppPath);
    const commitHash = await gitService.initRepoWithInitialCommit({
      path: fullAppPath,
    });
    await db
      .update(chats)
      .set({ initialCommitHash: commitHash })
      .where(eq(chats.id, chat.id));

    return {
      app: { ...app, resolvedPath: fullAppPath },
      chatId: chat.id,
    };
  } catch (error) {
    // Creation after the app row is inserted is transactional only at the
    // service boundary. The caller owns cleanup policy because desktop
    // first-prompt cancellation and headless operation recovery differ.
    throw Object.assign(
      error instanceof Error ? error : new Error(String(error)),
      {
        factoryPartialApp: {
          appId: app.id,
          resolvedPath: fullAppPath,
        },
      },
    );
  }
}
