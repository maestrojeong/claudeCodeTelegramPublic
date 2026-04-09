import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import { logger } from "@/core/logger";
import { SESSIONS_DB, SERVER_NAME } from "@/core/config";
import type { EffortLevel } from "@/core/types";

/** Listener called when a user disconnects a forum group. Registered externally to avoid circular deps. */
let _onGroupRemoveListener: ((userId: number, groupId: number) => void) | null = null;
export function onForumGroupRemove(listener: (userId: number, groupId: number) => void) {
  _onGroupRemoveListener = listener;
}

// --- DB singleton ---
mkdirSync(dirname(SESSIONS_DB), { recursive: true });
const db = new Database(SESSIONS_DB, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    forum_group_ids TEXT NOT NULL DEFAULT '[]',
    forum_group_titles TEXT NOT NULL DEFAULT '{}',
    dm_session_id TEXT,
    communicate_thread_id INTEGER
  );

  CREATE TABLE IF NOT EXISTS topics (
    user_id TEXT NOT NULL REFERENCES users(id),
    forum_group_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    message_thread_id INTEGER NOT NULL,
    session_id TEXT,
    cron_session_id TEXT,
    created_at TEXT NOT NULL,
    description TEXT,
    model TEXT,
    effort TEXT CHECK (effort IN ('low', 'medium', 'high', 'max')),
    PRIMARY KEY (user_id, name),
    UNIQUE (forum_group_id, message_thread_id)
  );

  CREATE INDEX IF NOT EXISTS idx_topics_lookup ON topics(forum_group_id, message_thread_id);
`);

// Migrations: add new columns if they don't exist yet
try { db.exec("ALTER TABLE topics ADD COLUMN mcp_enabled TEXT"); } catch {}
try { db.exec("ALTER TABLE topics ADD COLUMN mcp_extra TEXT"); } catch {}
try { db.exec("ALTER TABLE topics ADD COLUMN cwd TEXT"); } catch {}
// server_name: which bot/server owns this topic. Backfilled by runStartupServerMigration().
try { db.exec("ALTER TABLE topics ADD COLUMN server_name TEXT"); } catch {}
// Rename system_prompt_extra → description
{
  const cols = db.query<{ name: string }, []>("PRAGMA table_info(topics)").all();
  if (cols.some(c => c.name === "system_prompt_extra")) {
    db.exec("ALTER TABLE topics RENAME COLUMN system_prompt_extra TO description");
  }
}

// Migration: forum_group_id (single INTEGER) → forum_group_ids (JSON array)
{
  const userCols = db.query<{ name: string }, []>("PRAGMA table_info(users)").all();
  const hasOldCol = userCols.some(c => c.name === "forum_group_id");
  const hasNewCol = userCols.some(c => c.name === "forum_group_ids");

  if (hasOldCol && !hasNewCol) {
    logger.info("Migrating users table: forum_group_id → forum_group_ids");
    db.transaction(() => {
      db.exec("ALTER TABLE users ADD COLUMN forum_group_ids TEXT NOT NULL DEFAULT '[]'");
      db.exec("ALTER TABLE users ADD COLUMN forum_group_titles TEXT NOT NULL DEFAULT '{}'");

      type OldUserRow = { id: string; forum_group_id: number; forum_group_title: string | null };
      const oldUsers = db.query<OldUserRow, []>("SELECT id, forum_group_id, forum_group_title FROM users").all();
      for (const u of oldUsers) {
        if (u.forum_group_id && u.forum_group_id !== 0) {
          const ids = JSON.stringify([u.forum_group_id]);
          const titles = JSON.stringify({ [String(u.forum_group_id)]: u.forum_group_title || "" });
          db.query("UPDATE users SET forum_group_ids = ?, forum_group_titles = ? WHERE id = ?").run(ids, titles, u.id);
        }
      }
    })();
    logger.info("Migration complete: forum_group_ids");
  }
}

// --- Types ---

export interface ForumTopicInfo {
  forumGroupId: number;
  messageThreadId: number;
  sessionId: string;
  cronSessionId?: string;
  createdAt: string;
  name: string;
  description?: string;
  model?: string;
  cwd?: string;
  effort?: EffortLevel;
}

export interface UserForumConfig {
  forumGroupIds: number[];
  forumGroupTitles: Record<string, string>;
  communicateThreadId?: number;
  dmSessionId?: string;
  topics: { [topicName: string]: ForumTopicInfo };
}

type TopicRow = {
  user_id: string;
  forum_group_id: number;
  name: string;
  message_thread_id: number;
  session_id: string | null;
  cron_session_id: string | null;
  created_at: string;
  description: string | null;
  model: string | null;
  cwd: string | null;
  effort: EffortLevel | null;
};

type UserRow = {
  id: string;
  forum_group_ids: string;
  forum_group_titles: string;
  dm_session_id: string | null;
  communicate_thread_id: number | null;
};

function rowToTopic(row: TopicRow): ForumTopicInfo {
  return {
    forumGroupId: row.forum_group_id,
    messageThreadId: row.message_thread_id,
    sessionId: row.session_id ?? "",
    createdAt: row.created_at,
    name: row.name,
    ...(row.cron_session_id && { cronSessionId: row.cron_session_id }),
    ...(row.description && { description: row.description }),
    ...(row.model && { model: row.model }),
    ...(row.cwd && { cwd: row.cwd }),
    ...(row.effort && { effort: row.effort }),
  };
}

/** Close DB cleanly on shutdown — checkpoints WAL back into main DB file */
export function flushSessionCache() {
  db.close();
}

// --- Server migration helpers (called from bot.ts startup) ---

/** Topics with NULL server_name (legacy rows from before this server's prefix system). */
export function getUnmigratedTopics(): { userId: number; forumGroupId: number; name: string; messageThreadId: number }[] {
  const rows = db.query<{ user_id: string; forum_group_id: number; name: string; message_thread_id: number }, []>(
    "SELECT user_id, forum_group_id, name, message_thread_id FROM topics WHERE server_name IS NULL"
  ).all();
  return rows.map(r => ({
    userId: Number(r.user_id),
    forumGroupId: r.forum_group_id,
    name: r.name,
    messageThreadId: r.message_thread_id,
  }));
}

/**
 * Mark a legacy topic as owned by this server, optionally renaming it (DB only).
 * Used during D1 migration after Telegram editForumTopic succeeds.
 */
export function migrateTopicToThisServer(userId: number, oldName: string, newName: string): void {
  db.transaction(() => {
    // If newName == oldName, just set server_name. Otherwise rename + set.
    if (newName === oldName) {
      db.query("UPDATE topics SET server_name = ? WHERE user_id = ? AND name = ? AND server_name IS NULL").run(
        SERVER_NAME, String(userId), oldName
      );
    } else {
      // Rename: handle (user_id, name) UNIQUE constraint by deleting any conflicting row first.
      db.query("DELETE FROM topics WHERE user_id = ? AND name = ?").run(String(userId), newName);
      db.query("UPDATE topics SET name = ?, server_name = ? WHERE user_id = ? AND name = ? AND server_name IS NULL").run(
        newName, SERVER_NAME, String(userId), oldName
      );
    }
  })();
}

// --- Helpers for JSON array/object columns ---

function parseGroupIds(raw: string): number[] {
  try { const arr = JSON.parse(raw); return Array.isArray(arr) ? arr : []; } catch { return []; }
}

function parseGroupTitles(raw: string): Record<string, string> {
  try { const obj = JSON.parse(raw); return typeof obj === "object" && obj !== null ? obj : {}; } catch { return {}; }
}

// --- User config ---

/** Get user's forum config (only topics owned by this server) */
export function getUserConfig(userId: number): UserForumConfig | null {
  const user = db.query<UserRow, string>("SELECT * FROM users WHERE id = ?").get(String(userId));
  if (!user) return null;

  const topicRows = db.query<TopicRow, [string, string]>(
    "SELECT * FROM topics WHERE user_id = ? AND server_name = ?"
  ).all(String(userId), SERVER_NAME);
  const topics: { [name: string]: ForumTopicInfo } = {};
  for (const row of topicRows) {
    topics[row.name] = rowToTopic(row);
  }

  return {
    forumGroupIds: parseGroupIds(user.forum_group_ids),
    forumGroupTitles: parseGroupTitles(user.forum_group_titles),
    ...(user.dm_session_id && { dmSessionId: user.dm_session_id }),
    ...(user.communicate_thread_id != null && { communicateThreadId: user.communicate_thread_id }),
    topics,
  };
}

/** Get the list of forum group IDs for a user */
export function getForumGroupIds(userId: number): number[] {
  const row = db.query<{ forum_group_ids: string }, string>(
    "SELECT forum_group_ids FROM users WHERE id = ?"
  ).get(String(userId));
  return row ? parseGroupIds(row.forum_group_ids) : [];
}

/** Check if a user has a specific forum group connected */
export function hasForumGroup(userId: number, groupId: number): boolean {
  return getForumGroupIds(userId).includes(groupId);
}

/** Add a forum group to user's group list. Returns true if newly added. */
export function addForumGroup(userId: number, groupId: number, groupTitle?: string): boolean {
  const existing = db.query<{ forum_group_ids: string; forum_group_titles: string }, string>(
    "SELECT forum_group_ids, forum_group_titles FROM users WHERE id = ?"
  ).get(String(userId));

  if (!existing) {
    const ids = JSON.stringify([groupId]);
    const titles = JSON.stringify({ [String(groupId)]: groupTitle || "" });
    db.query("INSERT INTO users (id, forum_group_ids, forum_group_titles) VALUES (?, ?, ?)").run(
      String(userId), ids, titles
    );
    return true;
  }

  const ids = parseGroupIds(existing.forum_group_ids);
  const titles = parseGroupTitles(existing.forum_group_titles);

  if (ids.includes(groupId)) {
    // Already connected — just update title
    titles[String(groupId)] = groupTitle || titles[String(groupId)] || "";
    db.query("UPDATE users SET forum_group_titles = ? WHERE id = ?").run(
      JSON.stringify(titles), String(userId)
    );
    return false;
  }

  ids.push(groupId);
  titles[String(groupId)] = groupTitle || "";
  db.query("UPDATE users SET forum_group_ids = ?, forum_group_titles = ? WHERE id = ?").run(
    JSON.stringify(ids), JSON.stringify(titles), String(userId)
  );
  logger.info({ userId, groupId, groupTitle }, "Forum group added");
  return true;
}

/** Remove a forum group from user's group list. Deletes associated topics. */
export function removeForumGroup(userId: number, groupId: number): boolean {
  const existing = db.query<{ forum_group_ids: string; forum_group_titles: string }, string>(
    "SELECT forum_group_ids, forum_group_titles FROM users WHERE id = ?"
  ).get(String(userId));
  if (!existing) return false;

  const ids = parseGroupIds(existing.forum_group_ids);
  const titles = parseGroupTitles(existing.forum_group_titles);

  const idx = ids.indexOf(groupId);
  if (idx === -1) return false;

  ids.splice(idx, 1);
  delete titles[String(groupId)];

  db.transaction(() => {
    db.query("DELETE FROM topics WHERE user_id = ? AND forum_group_id = ?").run(String(userId), groupId);
    db.query("UPDATE users SET forum_group_ids = ?, forum_group_titles = ? WHERE id = ?").run(
      JSON.stringify(ids), JSON.stringify(titles), String(userId)
    );
  })();

  logger.info({ userId, groupId }, "Forum group removed");
  _onGroupRemoveListener?.(userId, groupId);
  return true;
}

// --- Topic management ---

/** Add a topic for a user in a specific group (always tagged with this server's SERVER_NAME) */
export function addTopic(userId: number, groupId: number, name: string, messageThreadId: number, sessionId?: string, createdAt?: string) {
  // Ensure user exists
  db.query(`INSERT INTO users (id) VALUES (?) ON CONFLICT(id) DO NOTHING`).run(String(userId));

  db.query(`
    INSERT INTO topics (user_id, forum_group_id, name, message_thread_id, session_id, created_at, server_name)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, name) DO UPDATE SET
      forum_group_id = excluded.forum_group_id,
      message_thread_id = excluded.message_thread_id,
      session_id = excluded.session_id,
      created_at = excluded.created_at,
      server_name = excluded.server_name
  `).run(String(userId), groupId, name, messageThreadId, sessionId ?? null, createdAt ?? new Date().toISOString(), SERVER_NAME);
}

/** Remove a topic */
export function removeTopic(userId: number, name: string) {
  db.query("DELETE FROM topics WHERE user_id = ? AND name = ?").run(String(userId), name);
}

/** Get topic by name (this server only) */
export function getTopicByName(userId: number, name: string): ForumTopicInfo | null {
  const row = db.query<TopicRow, [string, string, string]>(
    "SELECT * FROM topics WHERE user_id = ? AND name = ? AND server_name = ?"
  ).get(String(userId), name, SERVER_NAME);
  return row ? rowToTopic(row) : null;
}

/** Get topic by thread ID (this server only) */
export function getTopicByThreadId(userId: number, threadId: number): ForumTopicInfo | null {
  const row = db.query<TopicRow, [string, number, string]>(
    "SELECT * FROM topics WHERE user_id = ? AND message_thread_id = ? AND server_name = ?"
  ).get(String(userId), threadId, SERVER_NAME);
  return row ? rowToTopic(row) : null;
}

/** Reverse lookup: find user by group ID and thread ID — only matches topics owned by this server. */
export function findUserByGroupAndThread(groupId: number, threadId: number): { userId: number; topic: ForumTopicInfo } | null {
  const row = db.query<TopicRow, [number, number, string]>(
    "SELECT * FROM topics WHERE forum_group_id = ? AND message_thread_id = ? AND server_name = ?"
  ).get(groupId, threadId, SERVER_NAME);
  if (!row) return null;
  return { userId: Number(row.user_id), topic: rowToTopic(row) };
}

/** Get session ID for a topic */
export function getSessionForTopic(userId: number, topicName: string): string | null {
  const row = db.query<{ session_id: string | null }, [string, string]>(
    "SELECT session_id FROM topics WHERE user_id = ? AND name = ?"
  ).get(String(userId), topicName);
  return row?.session_id || null;
}

/** Get cron session ID for a topic */
export function getCronSessionForTopic(userId: number, topicName: string): string | null {
  const row = db.query<{ cron_session_id: string | null }, [string, string]>(
    "SELECT cron_session_id FROM topics WHERE user_id = ? AND name = ?"
  ).get(String(userId), topicName);
  return row?.cron_session_id || null;
}

/** Set cron session ID for a topic */
export function setCronSessionForTopic(userId: number, topicName: string, sessionId: string) {
  db.query("UPDATE topics SET cron_session_id = ? WHERE user_id = ? AND name = ?").run(
    sessionId, String(userId), topicName
  );
}

/** Set session ID for a topic */
export function setSessionForTopic(userId: number, topicName: string, sessionId: string) {
  db.query("UPDATE topics SET session_id = ? WHERE user_id = ? AND name = ?").run(
    sessionId, String(userId), topicName
  );
}

/** Clear session ID for a topic */
export function clearSessionForTopic(userId: number, topicName: string) {
  db.query("UPDATE topics SET session_id = NULL WHERE user_id = ? AND name = ?").run(
    String(userId), topicName
  );
}

/** Get all topic names for a user (this server only) */
export function getTopicNames(userId: number): string[] {
  const rows = db.query<{ name: string }, [string, string]>(
    "SELECT name FROM topics WHERE user_id = ? AND server_name = ?"
  ).all(String(userId), SERVER_NAME);
  return rows.map(r => r.name);
}

/** Get all topic names for a specific group (this server only) */
export function getTopicNamesForGroup(userId: number, groupId: number): string[] {
  const rows = db.query<{ name: string }, [string, number, string]>(
    "SELECT name FROM topics WHERE user_id = ? AND forum_group_id = ? AND server_name = ?"
  ).all(String(userId), groupId, SERVER_NAME);
  return rows.map(r => r.name);
}

/** Generate a link to a forum topic */
export function getTopicLink(groupId: number, messageThreadId: number): string {
  const numericId = String(groupId).replace(/^-100/, "");
  return `https://t.me/c/${numericId}/${messageThreadId}`;
}

/** Get communicate topic thread ID */
export function getCommunicateThreadId(userId: number): number | null {
  const row = db.query<{ communicate_thread_id: number | null }, string>(
    "SELECT communicate_thread_id FROM users WHERE id = ?"
  ).get(String(userId));
  return row?.communicate_thread_id ?? null;
}

/** Clear communicate topic thread ID */
export function clearCommunicateThreadId(userId: number) {
  db.query("UPDATE users SET communicate_thread_id = NULL WHERE id = ?").run(String(userId));
}

/** Set communicate topic thread ID */
export function setCommunicateThreadId(userId: number, threadId: number) {
  db.query("UPDATE users SET communicate_thread_id = ? WHERE id = ?").run(threadId, String(userId));
}

/** Get DM session ID */
export function getDmSessionId(userId: number): string | null {
  const row = db.query<{ dm_session_id: string | null }, string>(
    "SELECT dm_session_id FROM users WHERE id = ?"
  ).get(String(userId));
  return row?.dm_session_id ?? null;
}

/** Set DM session ID — creates user if not exists */
export function setDmSessionId(userId: number, sessionId: string) {
  db.query(`
    INSERT INTO users (id, forum_group_ids, dm_session_id) VALUES (?, '[]', ?)
    ON CONFLICT(id) DO UPDATE SET dm_session_id = excluded.dm_session_id
  `).run(String(userId), sessionId);
}

/** Clear DM session ID */
export function clearDmSessionId(userId: number) {
  db.query("UPDATE users SET dm_session_id = NULL WHERE id = ?").run(String(userId));
}

/** Get topic description */
export function getTopicDescription(userId: number, topicName: string): string | null {
  const row = db.query<{ description: string | null }, [string, string]>(
    "SELECT description FROM topics WHERE user_id = ? AND name = ?"
  ).get(String(userId), topicName);
  return row?.description || null;
}

const MODEL_ALIAS: Record<string, string> = {
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

/** Get topic model (resolves aliases) */
export function getTopicModel(userId: number, topicName: string): string | null {
  const row = db.query<{ model: string | null }, [string, string]>(
    "SELECT model FROM topics WHERE user_id = ? AND name = ?"
  ).get(String(userId), topicName);
  const raw = row?.model ?? null;
  if (!raw) return null;
  return MODEL_ALIAS[raw] || raw;
}

/** Set topic model */
export function setTopicModel(userId: number, topicName: string, model: string | null): boolean {
  const result = db.query("UPDATE topics SET model = ? WHERE user_id = ? AND name = ?").run(
    model, String(userId), topicName
  );
  return result.changes > 0;
}

/** Set topic description */
export function setTopicDescription(userId: number, topicName: string, description: string): boolean {
  const result = db.query("UPDATE topics SET description = ? WHERE user_id = ? AND name = ?").run(
    description, String(userId), topicName
  );
  return result.changes > 0;
}

/** Get topic cwd */
export function getTopicCwd(userId: number, topicName: string): string | null {
  const row = db.query<{ cwd: string | null }, [string, string]>(
    "SELECT cwd FROM topics WHERE user_id = ? AND name = ?"
  ).get(String(userId), topicName);
  return row?.cwd || null;
}

/** Set topic cwd */
export function setTopicCwd(userId: number, topicName: string, cwd: string | null): boolean {
  const result = db.query("UPDATE topics SET cwd = ? WHERE user_id = ? AND name = ?").run(
    cwd, String(userId), topicName
  );
  return result.changes > 0;
}

/** Get topic effort level */
export function getTopicEffort(userId: number, topicName: string): EffortLevel | null {
  const row = db.query<{ effort: EffortLevel | null }, [string, string]>(
    "SELECT effort FROM topics WHERE user_id = ? AND name = ?"
  ).get(String(userId), topicName);
  return row?.effort ?? null;
}

/** Set topic effort level */
export function setTopicEffort(userId: number, topicName: string, effort: EffortLevel | null): boolean {
  const result = db.query("UPDATE topics SET effort = ? WHERE user_id = ? AND name = ?").run(
    effort, String(userId), topicName
  );
  return result.changes > 0;
}

/** Update topic's message_thread_id (used when recreating topics) */
export function updateTopicThreadId(userId: number, topicName: string, newThreadId: number, groupId: number) {
  db.query("UPDATE topics SET message_thread_id = ?, forum_group_id = ? WHERE user_id = ? AND name = ?").run(
    newThreadId, groupId, String(userId), topicName
  );
}

/** Get all topics for a user (this server only) */
export function getAllTopics(userId: number): ForumTopicInfo[] {
  const rows = db.query<TopicRow, [string, string]>(
    "SELECT * FROM topics WHERE user_id = ? AND server_name = ?"
  ).all(String(userId), SERVER_NAME);
  return rows.map(rowToTopic);
}

/** Get all topics for a specific group (this server only) */
export function getAllTopicsForGroup(userId: number, groupId: number): ForumTopicInfo[] {
  const rows = db.query<TopicRow, [string, number, string]>(
    "SELECT * FROM topics WHERE user_id = ? AND forum_group_id = ? AND server_name = ?"
  ).all(String(userId), groupId, SERVER_NAME);
  return rows.map(rowToTopic);
}

/** Get MCP config for a topic */
export function getTopicMcpConfig(userId: number, topicName: string): { enabled: string[] | null; extra: Record<string, unknown> } {
  const row = db.query<{ mcp_enabled: string | null; mcp_extra: string | null }, [string, string]>(
    "SELECT mcp_enabled, mcp_extra FROM topics WHERE user_id = ? AND name = ?"
  ).get(String(userId), topicName);
  return {
    enabled: row?.mcp_enabled ? JSON.parse(row.mcp_enabled) : null,
    extra: row?.mcp_extra ? JSON.parse(row.mcp_extra) : {},
  };
}

/** Set enabled MCP server names for a topic */
export function setTopicMcpEnabled(userId: number, topicName: string, enabled: string[] | null): boolean {
  const result = db.query("UPDATE topics SET mcp_enabled = ? WHERE user_id = ? AND name = ?").run(
    enabled !== null ? JSON.stringify(enabled) : null, String(userId), topicName
  );
  return result.changes > 0;
}

/** Set extra MCP server configs for a topic */
export function setTopicMcpExtra(userId: number, topicName: string, extra: Record<string, unknown>): boolean {
  const result = db.query("UPDATE topics SET mcp_extra = ? WHERE user_id = ? AND name = ?").run(
    JSON.stringify(extra), String(userId), topicName
  );
  return result.changes > 0;
}
