import { bot } from "@/telegram/client";
import { logger } from "@/core/logger";
import { withTopicPrefix } from "@/core/config";
import { getUnmigratedTopics, migrateTopicToThisServer } from "@/telegram/forum-sessions";

const RENAME_DELAY_MS = 1000; // Telegram rate limit safety

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * D1 migration: ensure every legacy topic (server_name IS NULL) gets:
 * 1. its DB row tagged with SERVER_NAME
 * 2. its Telegram forum topic title renamed to include the [SERVER_NAME] prefix
 *
 * Idempotent — re-running after success is a no-op (no NULL rows remain).
 * Telegram failures are logged but do not block the DB tag (we still mark
 * server_name so future lookups work; the user can rename the title manually).
 */
export async function runServerMigration(): Promise<void> {
  const legacy = getUnmigratedTopics();
  if (legacy.length === 0) {
    logger.info("Server migration: no legacy topics to migrate");
    return;
  }

  logger.info({ count: legacy.length }, "Server migration: backfilling server_name and renaming Telegram topics");

  let renamed = 0;
  let renameFailed = 0;
  let dbOnly = 0;

  for (let i = 0; i < legacy.length; i++) {
    const t = legacy[i];
    if (i > 0) await delay(RENAME_DELAY_MS);

    const newName = withTopicPrefix(t.name);
    if (newName === t.name) {
      // Already prefixed (e.g. user manually renamed) — DB tag only.
      try {
        migrateTopicToThisServer(t.userId, t.name, t.name);
        dbOnly++;
      } catch (e) {
        logger.error({ err: e, topic: t }, "Server migration: DB tag failed");
      }
      continue;
    }

    // Try Telegram rename first; only commit DB rename if it succeeds.
    let telegramOk = false;
    try {
      await bot.editForumTopic(t.forumGroupId, t.messageThreadId, { name: newName });
      telegramOk = true;
      renamed++;
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      logger.warn({ topic: t, error: errMsg }, "Server migration: Telegram rename failed (keeping old title, tagging DB)");
      renameFailed++;
    }

    try {
      if (telegramOk) {
        migrateTopicToThisServer(t.userId, t.name, newName);
      } else {
        // Telegram failed — keep the original DB name so the topic still resolves
        // by (groupId, threadId) on the next message. We still tag server_name so
        // findUserByGroupAndThread() will match.
        migrateTopicToThisServer(t.userId, t.name, t.name);
      }
    } catch (e) {
      logger.error({ err: e, topic: t }, "Server migration: DB update failed");
    }
  }

  logger.info({ total: legacy.length, renamed, renameFailed, dbOnly }, "Server migration: complete");
}
