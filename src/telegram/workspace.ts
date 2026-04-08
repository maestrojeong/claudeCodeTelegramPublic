import TelegramBot from "node-telegram-bot-api";
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, unlinkSync, readdirSync, renameSync } from "fs";
import { join } from "path";
import { ACTIVE_QUERY_STALE_MS, USERS_LOG_DIR, AGENTS_PROMPTS_DIR, META_DIR, DEBUG_FILE, loadAgentPrompt } from "@/core/config";
import type { QueryState } from "@/core/types";
import { logger } from "@/core/logger";

// --- Per-user workspace initialization ---

// Cache known user display names to avoid reading CLAUDE.md on every message
const userNameCache = new Map<number, string>();

export function initUserWorkspace(userId: number, from?: TelegramBot.User) {
  const userDir = join(USERS_LOG_DIR, String(userId));
  const claudeMdPath = join(userDir, "CLAUDE.md");

  // Build user display name
  const firstName = from?.first_name || "";
  const lastName = from?.last_name || "";
  const username = from?.username || "";
  const displayName = `${firstName} ${lastName}`.trim() || username || `User ${userId}`;

  // First time: copy meta template
  if (!existsSync(userDir)) {
    mkdirSync(userDir, { recursive: true });

    // Copy CLAUDE.md template and prepend user info
    const metaClaudeMd = join(META_DIR, "CLAUDE.md");
    const templateContent = existsSync(metaClaudeMd) ? readFileSync(metaClaudeMd, "utf-8") : "";
    const userHeader = [
      `# Workspace Owner: ${displayName}`,
      ``,
      `- Telegram ID: ${userId}`,
      username ? `- Username: @${username}` : null,
      `- Name: ${displayName}`,
      `- 이 워크스페이스의 관리자입니다.`,
      `- 이 워크스페이스의 토픽은 여러 사용자가 함께 사용할 수 있습니다.`,
      ``,
      `---`,
      ``,
    ].filter((line) => line !== null).join("\n");
    writeFileSync(claudeMdPath, userHeader + templateContent);

    // Copy autonomous agents to user workspace
    const agentFiles = getAutonomousAgentFiles();
    if (agentFiles.length > 0) {
      const agentsDir = join(userDir, ".claude", "agents");
      mkdirSync(agentsDir, { recursive: true });
      for (const f of agentFiles) cpSync(join(AGENTS_PROMPTS_DIR, f.name), join(agentsDir, f.name));
    }

    userNameCache.set(userId, displayName);
    logger.info({ userId, displayName }, "Initialized workspace");
  } else {
    // Only check file if display name changed from cached value
    const cachedName = userNameCache.get(userId);
    if (cachedName !== displayName) {
      if (existsSync(claudeMdPath)) {
        const existing = readFileSync(claudeMdPath, "utf-8");
        const expectedHeader = `# Workspace Owner: ${displayName}`;
        if (!existing.startsWith(expectedHeader)) {
          const updated = existing
            .replace(/^# (User|Workspace Owner): .+$/m, expectedHeader)
            .replace(/- Name: .+$/m, `- Name: ${displayName}`);
          if (updated !== existing) {
            writeFileSync(claudeMdPath, updated);
          }
        }
      }
      userNameCache.set(userId, displayName);
    }
  }
}

// --- Sync meta CLAUDE.md template to all existing user workspaces ---
export function syncMetaClaudeMd() {
  const metaClaudeMd = join(META_DIR, "CLAUDE.md");
  if (!existsSync(metaClaudeMd)) return;
  const templateContent = readFileSync(metaClaudeMd, "utf-8");

  if (!existsSync(USERS_LOG_DIR)) return;
  for (const entry of readdirSync(USERS_LOG_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const claudeMdPath = join(USERS_LOG_DIR, entry.name, "CLAUDE.md");
    if (!existsSync(claudeMdPath)) continue;
    const existing = readFileSync(claudeMdPath, "utf-8");
    const separatorIdx = existing.indexOf("\n---\n");
    if (separatorIdx === -1) continue;
    const userHeader = existing.slice(0, separatorIdx);
    const updated = `${userHeader}\n---\n\n${templateContent}`;
    if (updated !== existing) {
      writeFileSync(claudeMdPath, updated);
      logger.info({ user: entry.name }, "Synced meta CLAUDE.md template");
    }
  }
}

function getAutonomousAgentFiles() {
  if (!existsSync(AGENTS_PROMPTS_DIR)) return [];
  return readdirSync(AGENTS_PROMPTS_DIR, { withFileTypes: true })
    .filter(f => f.isFile() && f.name.endsWith(".md"))
    .filter(f => { try { return loadAgentPrompt(f.name).type === "autonomous"; } catch { return false; } });
}

// --- Sync meta agents to all existing user workspaces (always overwrite — system-managed files) ---
export function syncMetaAgents() {
  if (!existsSync(USERS_LOG_DIR)) return;

  const agentFiles = getAutonomousAgentFiles();
  if (agentFiles.length === 0) return;

  for (const userEntry of readdirSync(USERS_LOG_DIR, { withFileTypes: true })) {
    if (!userEntry.isDirectory()) continue;
    const agentsDir = join(USERS_LOG_DIR, userEntry.name, ".claude", "agents");
    mkdirSync(agentsDir, { recursive: true });
    for (const agent of agentFiles) {
      cpSync(join(AGENTS_PROMPTS_DIR, agent.name), join(agentsDir, agent.name), { recursive: true });
    }
  }
}

// --- Debug mode (per-user toggle, file-backed for MCP access) ---
let debugUsersCache: Set<string> | null = null;

function loadDebugUsers(): Set<string> {
  if (debugUsersCache) return debugUsersCache;
  try {
    if (existsSync(DEBUG_FILE)) {
      debugUsersCache = new Set(JSON.parse(readFileSync(DEBUG_FILE, "utf-8")));
      return debugUsersCache;
    }
  } catch (e) {
    logger.warn({ err: e }, "Failed to load debug users");
  }
  debugUsersCache = new Set();
  return debugUsersCache;
}

export function isDebug(userId: number): boolean {
  return loadDebugUsers().has(String(userId));
}

export function toggleDebug(userId: number): boolean {
  const users = loadDebugUsers();
  const key = String(userId);
  if (users.has(key)) {
    users.delete(key);
  } else {
    users.add(key);
  }
  debugUsersCache = users;
  writeFileSync(DEBUG_FILE, JSON.stringify([...users], null, 2));
  return users.has(key);
}

// --- Active query state files ---

function queryStateDirPath(userId: number): string {
  return join(USERS_LOG_DIR, String(userId), "active-queries");
}

export function writeQueryState(userId: number, topicName: string, task?: string) {
  const dir = queryStateDirPath(userId);
  mkdirSync(dir, { recursive: true });
  const state: QueryState = { since: new Date().toISOString() };
  if (task) state.task = [...task.replace(/\n+/g, " ").trim()].slice(0, 100).join("");
  const target = join(dir, `${topicName}.json`);
  const tmp = `${target}.tmp`; // same dir as target — safe for renameSync (no EXDEV)
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, target);
}

export function clearQueryState(userId: number, topicName: string) {
  try { unlinkSync(join(queryStateDirPath(userId), `${topicName}.json`)); } catch {}
}

export function cleanStaleQueryStates() {
  const now = Date.now();
  try {
    mkdirSync(USERS_LOG_DIR, { recursive: true });
    const userDirs = readdirSync(USERS_LOG_DIR, { withFileTypes: true });
    for (const dir of userDirs) {
      if (!dir.isDirectory()) continue;
      const stateDir = join(USERS_LOG_DIR, dir.name, "active-queries");
      let files: string[];
      try { files = readdirSync(stateDir); } catch { continue; }
      for (const file of files) {
        const filePath = join(stateDir, file);
        try {
          // Clean up legacy .lock files from pre-migration
          if (file.endsWith(".lock") || file.endsWith(".tmp")) {
            try { unlinkSync(filePath); } catch {}
            logger.info({ filePath }, "Removed legacy lock/tmp file");
            continue;
          }
          if (file.endsWith(".json")) {
            let stale = false;
            try {
              const state = JSON.parse(readFileSync(filePath, "utf-8")) as QueryState;
              stale = now - new Date(state.since).getTime() > ACTIVE_QUERY_STALE_MS;
            } catch {
              stale = true; // corrupt/unreadable — safe to remove
            }
            if (stale) {
              try { unlinkSync(filePath); } catch {}
              logger.info({ filePath }, "Removed stale query state file");
            }
          }
        } catch { /* ignore individual file errors */ }
      }
    }
  } catch (e) {
    logger.warn({ err: e }, "cleanStaleQueryStates: failed");
  }
}
