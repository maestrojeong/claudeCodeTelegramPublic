import { appendFileSync, mkdirSync, readdirSync, statSync, renameSync, unlinkSync } from "fs";
import { join } from "path";
import { logger } from "@/core/logger";
import { PROJECT_ROOT } from "@/core/config";
import type { TokenUsage } from "@/core/types";

const LOG_DIR = join(PROJECT_ROOT, "logs");
mkdirSync(LOG_DIR, { recursive: true });

// --- Log rotation config ---
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB per log file
const MAX_TOTAL_SIZE = 200 * 1024 * 1024; // 200MB total log budget
const ROTATION_CHECK_INTERVAL = 60 * 60 * 1000; // check every hour

export interface LogEntry {
  timestamp: string;
  userId: number;
  sessionId: string | null;
  session: string;
  prompt: string;
  response: string;
  usage?: TokenUsage;
}

export function writeLog(entry: LogEntry) {
  const line = JSON.stringify(entry) + "\n";
  const safeSession = entry.session.replace(/[^a-zA-Z0-9가-힣_-]/g, "_");
  const sidShort = entry.sessionId ? entry.sessionId.slice(0, 8) : "new";
  const file = join(LOG_DIR, `${entry.userId}_${safeSession}_${sidShort}.jsonl`);

  // Rotate if file is too large
  try {
    const stat = statSync(file);
    if (stat.size >= MAX_FILE_SIZE) {
      const rotated = file.replace(/\.jsonl$/, `.${Date.now()}.jsonl`);
      renameSync(file, rotated);
    }
  } catch {
    // File doesn't exist yet, fine
  }

  appendFileSync(file, line);
}

/** Remove oldest log files when total size exceeds budget */
export function rotateOldLogs() {
  try {
    const files = readdirSync(LOG_DIR)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        try {
          const stat = statSync(join(LOG_DIR, f));
          return { name: f, size: stat.size, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((f): f is NonNullable<typeof f> => f !== null);

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    if (totalSize <= MAX_TOTAL_SIZE) return;

    // Delete oldest files first until under budget
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let freed = 0;
    const toFree = totalSize - MAX_TOTAL_SIZE;
    for (const file of files) {
      if (freed >= toFree) break;
      try {
        unlinkSync(join(LOG_DIR, file.name));
        freed += file.size;
        logger.info({ file: file.name, sizeKB: (file.size / 1024).toFixed(0) }, "Rotated out old log");
      } catch {}
    }
  } catch (e) {
    logger.warn({ err: e }, "Log rotation failed");
  }
}

// Run rotation check periodically
rotateOldLogs();
setInterval(rotateOldLogs, ROTATION_CHECK_INTERVAL);

