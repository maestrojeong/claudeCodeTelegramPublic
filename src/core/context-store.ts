import { mkdirSync, existsSync, readFileSync, appendFileSync, readdirSync, unlinkSync, statSync } from "fs";
import { join } from "path";
import { USERS_LOG_DIR } from "@/core/config";
import { logger } from "@/core/logger";

// --- Context store: user_{id}/contexts/{contextId}.jsonl ---

const CONTEXT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export interface ContextExchange {
  role: string;      // topic name (sender)
  content: string;   // message content
  ts: string;        // ISO timestamp
}

export function getContextsDir(userId: number): string {
  return join(USERS_LOG_DIR, String(userId), "contexts");
}

const MAX_CONTEXT_EXCHANGES = 20; // Keep last N exchanges to prevent prompt explosion
const MAX_CONTEXTS_PER_USER = 100; // Cap context files per user

/** Sanitize contextId to prevent path traversal */
function sanitizeContextId(contextId: string): string {
  return contextId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Generate a new contextId */
export function createContextId(): string {
  return `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Append an exchange to a context */
export function appendContext(userId: number, contextId: string, exchange: ContextExchange): void {
  try {
    const dir = getContextsDir(userId);
    mkdirSync(dir, { recursive: true });
    const safe = sanitizeContextId(contextId);
    const filePath = join(dir, `${safe}.jsonl`);
    appendFileSync(filePath, JSON.stringify(exchange) + "\n");
  } catch (err) {
    logger.warn({ err, contextId }, "context-store: failed to append context");
  }
}

/** Load all exchanges for a context (returns last MAX_CONTEXT_EXCHANGES) */
export function loadContext(userId: number, contextId: string): ContextExchange[] {
  const safe = sanitizeContextId(contextId);
  const filePath = join(getContextsDir(userId), `${safe}.jsonl`);
  if (!existsSync(filePath)) return [];

  try {
    const lines = readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
    const all: ContextExchange[] = [];
    for (const line of lines) {
      try { all.push(JSON.parse(line) as ContextExchange); }
      catch { logger.warn({ contextId }, "context-store: skipping malformed line"); }
    }
    // Return last N exchanges to prevent prompt explosion
    return all.length > MAX_CONTEXT_EXCHANGES ? all.slice(-MAX_CONTEXT_EXCHANGES) : all;
  } catch (err) {
    logger.warn({ err, contextId }, "context-store: failed to load context");
    return [];
  }
}

/** Format context exchanges as a prompt prefix */
export function formatContextForPrompt(exchanges: ContextExchange[]): string {
  if (exchanges.length === 0) return "";
  const lines = exchanges.map((e) => `${e.role}: ${e.content}`);
  return `[이전 교환 내역]\n${lines.join("\n")}\n\n`;
}

/** Clean up expired context files + enforce per-user cap */
export function sweepExpiredContexts(userId: number): number {
  const dir = getContextsDir(userId);
  if (!existsSync(dir)) return 0;

  const now = Date.now();
  let deleted = 0;

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      try {
        const filePath = join(dir, f);
        return { name: f, path: filePath, mtime: statSync(filePath).mtimeMs };
      } catch { return null; }
    })
    .filter((f): f is NonNullable<typeof f> => f !== null)
    .sort((a, b) => b.mtime - a.mtime); // newest first

  for (const file of files) {
    // Delete expired or over cap
    if (now - file.mtime > CONTEXT_TTL_MS || files.indexOf(file) >= MAX_CONTEXTS_PER_USER) {
      try { unlinkSync(file.path); deleted++; } catch { /* ignore */ }
    }
  }

  if (deleted > 0) {
    logger.info({ userId, deleted }, "context-store: swept expired/excess contexts");
  }
  return deleted;
}
