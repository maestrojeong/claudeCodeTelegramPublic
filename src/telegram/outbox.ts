import { USERS_LOG_DIR } from "@/core/config";
import { debouncedFlush, watchDir, FALLBACK_INTERVAL_MS } from "@/telegram/outbox-utils";
import { flushCronOutbox } from "@/telegram/cron-outbox";
import { flushDmCommands, DM_CMD_DIR } from "@/telegram/dm-commands";
import { flushSessionInbox, SESSION_INBOX_DIR } from "@/telegram/session-inbox";
import { flushProgressOutbox, PROGRESS_DIR } from "@/telegram/progress-outbox";
import { sweepExpiredContexts } from "@/core/context-store";
import { readdirSync } from "fs";
import { join } from "path";

// Re-export callback registrations for bot.ts
export { onSessionInject, onAbortRequest } from "@/telegram/outbox-types";

/** Start outbox watchers with fallback polling. Call once from bot.ts during init.
 *  Returns a cleanup function that stops watchers and intervals. */
export function startOutboxPolling(): () => void {
  const triggerCron = debouncedFlush(flushCronOutbox, "cron-outbox", 500);
  const triggerDm = debouncedFlush(flushDmCommands, "dm-commands", 300);
  const triggerSessionInbox = debouncedFlush(flushSessionInbox, "session-inbox", 200);
  const triggerProgress = debouncedFlush(flushProgressOutbox, "progress-outbox", 200);

  // Watch cron-outbox dirs under each user
  const watchers = [
    watchDir(USERS_LOG_DIR, triggerCron),
    watchDir(DM_CMD_DIR, triggerDm),
    watchDir(SESSION_INBOX_DIR, triggerSessionInbox),
    watchDir(PROGRESS_DIR, triggerProgress),
  ];

  // Fallback polling for reliability
  const intervals = [
    setInterval(triggerCron, FALLBACK_INTERVAL_MS),
    setInterval(triggerDm, FALLBACK_INTERVAL_MS),
    setInterval(triggerSessionInbox, FALLBACK_INTERVAL_MS),
    setInterval(triggerProgress, FALLBACK_INTERVAL_MS),
  ];

  // Sweep expired context files every hour
  const CONTEXT_SWEEP_MS = 60 * 60 * 1000;
  const contextSweepInterval = setInterval(() => {
    try {
      for (const dir of readdirSync(USERS_LOG_DIR)) {
        const uid = Number(dir);
        if (!isNaN(uid)) sweepExpiredContexts(uid);
      }
    } catch { /* ignore */ }
  }, CONTEXT_SWEEP_MS);

  // Initial flush on startup
  triggerCron();
  triggerDm();
  triggerSessionInbox();

  return () => {
    watchers.forEach((w) => w?.close());
    intervals.forEach((i) => clearInterval(i));
    clearInterval(contextSweepInterval);
  };
}
