/**
 * 마이그레이션 스크립트: forum-sessions.json → logs/sessions.db
 * 실행: bun run scripts/migrate-sessions.ts
 */

import { Database } from "bun:sqlite";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const LOG_DIR = join(process.cwd(), "logs");
const SESSION_FILE = join(LOG_DIR, "forum-sessions.json");
const DB_PATH = join(LOG_DIR, "sessions.db");

if (!existsSync(SESSION_FILE)) {
  console.error("forum-sessions.json not found");
  process.exit(1);
}

if (existsSync(DB_PATH)) {
  console.log("sessions.db already exists — skipping schema creation, upserting data");
}

const data = JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
const db = new Database(DB_PATH, { create: true });

db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = OFF"); // OFF during bulk import
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    forum_group_id INTEGER NOT NULL DEFAULT 0,
    forum_group_title TEXT,
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
    system_prompt_extra TEXT,
    model TEXT,
    privacy_mode INTEGER NOT NULL DEFAULT 0,
    effort TEXT CHECK (effort IN ('low', 'medium', 'high', 'max')),
    PRIMARY KEY (user_id, name),
    UNIQUE (forum_group_id, message_thread_id)
  );

  CREATE INDEX IF NOT EXISTS idx_topics_lookup ON topics(forum_group_id, message_thread_id);
`);

const insertUser = db.prepare(`
  INSERT OR REPLACE INTO users (id, forum_group_id, forum_group_title, dm_session_id, communicate_thread_id)
  VALUES (?, ?, ?, ?, ?)
`);

const insertTopic = db.prepare(`
  INSERT OR REPLACE INTO topics
    (user_id, forum_group_id, name, message_thread_id, session_id, cron_session_id,
     created_at, system_prompt_extra, model, privacy_mode, effort)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const migrate = db.transaction(() => {
  for (const [userId, config] of Object.entries(data) as [string, any][]) {
    insertUser.run(
      userId,
      config.forumGroupId ?? 0,
      config.forumGroupTitle ?? null,
      config.dmSessionId ?? null,
      config.communicateThreadId ?? null,
    );

    for (const [, topic] of Object.entries(config.topics ?? {}) as [string, any][]) {
      insertTopic.run(
        userId,
        config.forumGroupId ?? 0,
        topic.name,
        topic.messageThreadId,
        topic.sessionId || null,
        topic.cronSessionId ?? null,
        topic.createdAt,
        topic.systemPromptExtra ?? null,
        topic.model ?? null,
        topic.privacyMode ? 1 : 0,
        topic.effort ?? null,
      );
    }
  }
});

migrate();

db.exec("PRAGMA foreign_keys = ON");

// 검증
const userCount = (db.query("SELECT COUNT(*) as n FROM users").get() as any).n;
const topicCount = (db.query("SELECT COUNT(*) as n FROM topics").get() as any).n;
console.log(`✅ 마이그레이션 완료`);
console.log(`   users  : ${userCount}`);
console.log(`   topics : ${topicCount}`);

// 샘플 출력
const sample = db.query(`
  SELECT u.id, u.forum_group_title, t.name, t.session_id
  FROM users u LEFT JOIN topics t ON t.user_id = u.id
  LIMIT 5
`).all();
console.log("\n샘플:");
for (const row of sample) {
  console.log("  ", row);
}
