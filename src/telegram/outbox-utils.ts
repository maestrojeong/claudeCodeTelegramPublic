import { mkdirSync, watch, FSWatcher, existsSync, renameSync, readFileSync, unlinkSync } from "fs";
import { logger } from "@/core/logger";

export const FALLBACK_INTERVAL_MS = 5_000; // fallback poll every 5s in case fs.watch misses events

export function debouncedFlush(fn: () => Promise<void>, label: string, delayMs: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let pending = false;

  async function run(): Promise<void> {
    if (running) { pending = true; return; }
    while (true) {
      running = true;
      pending = false;
      try {
        await fn();
      } catch (e) {
        logger.error({ err: e }, `${label}: Unhandled error`);
      } finally {
        running = false;
      }
      if (!pending) break;
    }
  }

  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      run();
    }, delayMs);
  };
}

/**
 * Atomically acquire lines from a JSONL file using the .processing rename pattern.
 * Returns parsed lines, or null if file doesn't exist / is empty.
 * Handles crash recovery of leftover .processing files.
 */
export function acquireJsonlLines(filePath: string, label: string): string[] | null {
  const processingPath = filePath + ".processing";

  // Recover .processing file left from a previous crash
  if (!existsSync(filePath) && existsSync(processingPath)) {
    logger.info({ processingPath }, `${label}: Recovering leftover .processing file`);
    try { renameSync(processingPath, filePath); } catch {}
  }

  if (!existsSync(filePath)) return null;

  // Atomically rename to prevent race with writers
  try {
    renameSync(filePath, processingPath);
  } catch (e) {
    logger.warn({ err: e, filePath }, `${label}: Failed to rename`);
    return null;
  }

  let lines: string[];
  try {
    lines = readFileSync(processingPath, "utf-8").trim().split("\n").filter(Boolean);
  } catch (e) {
    logger.warn({ err: e, processingPath }, `${label}: Failed to read`);
    try { unlinkSync(processingPath); } catch {}
    return null;
  }

  if (lines.length === 0) {
    try { unlinkSync(processingPath); } catch {}
    return null;
  }

  return lines;
}

/** Delete the .processing file after lines have been consumed. */
export function cleanupProcessing(filePath: string): void {
  try { unlinkSync(filePath + ".processing"); } catch {}
}

export function watchDir(dir: string, onChange: () => void): FSWatcher | null {
  try {
    mkdirSync(dir, { recursive: true });
    const watcher = watch(dir, { recursive: true }, () => onChange());
    watcher.on("error", (e) => {
      logger.warn({ err: e, dir }, "outbox: fs.watch error");
    });
    return watcher;
  } catch (e) {
    logger.warn({ err: e, dir }, "outbox: Failed to watch dir");
    return null;
  }
}
