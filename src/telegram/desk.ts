import TelegramBot from "node-telegram-bot-api";
import { join } from "path";
import { mkdirSync } from "fs";
import { bot, BOT_USERNAME, BOT_ID, ADMIN_USERS } from "@/telegram/client";
import { logger } from "@/core/logger";
import { USERS_LOG_DIR, withTopicPrefix, buildTopicSystemPrompt } from "@/core/config";
import {
  addTopic,
  getTopicByName,
  setTopicCwd,
  setTopicDescription,
  clearSessionForTopic,
  getForumGroupIds,
  getTopicDescription,
  getTopicModel,
} from "@/telegram/forum-sessions";
import { handleClaudeQuery } from "@/telegram/query-handler";
import { buildPromptFromMessage } from "@/telegram/attachments";

// --- Constants ---

/** Logical topic name for the desk (the [SERVER_NAME] prefix is added automatically). */
const DESK_TOPIC_BASE = "desk";

/** Resolved desk topic name including server prefix, e.g. "[mac1] desk". */
function deskTopicName(): string {
  return withTopicPrefix(DESK_TOPIC_BASE);
}

/** Maximum messages kept in the in-memory ring buffer per external (group, thread). */
const RING_BUFFER_SIZE = 20;

/** Per-message length cap when included in the prompt. */
const RING_MESSAGE_TRUNCATE = 500;

/** Reset desk session after this many turns. */
const DESK_RESET_TURNS = 20;

/** Reset desk session after this much idle time (no new mention). */
const DESK_RESET_IDLE_MS = 30 * 60 * 1000; // 30 minutes

// --- External message ring buffer ---
//
// Stores recent messages from supergroup topics that this bot is a member of but
// does not own (i.e. topics not registered to this server in the topics table).
// Populated by bot.ts on every supergroup message; consumed by handleExternalMention()
// when assembling the desk prompt. In-memory only — empty after restart, which is OK
// because we only need short-term context for mention answering.

interface BufferedMessage {
  fromName: string;        // sender display label
  fromId: number;          // sender telegram user id (so we can detect bot vs user)
  text: string;            // message text or caption
  ts: string;              // ISO timestamp
  replyToText?: string;    // truncated reply target text, if any
}

const externalBuffers = new Map<string, BufferedMessage[]>();

function bufferKey(groupId: number, threadId: number): string {
  return `${groupId}:${threadId}`;
}

function senderLabel(msg: TelegramBot.Message): string {
  const u = msg.from;
  if (!u) return "unknown";
  if (u.username) return `@${u.username}`;
  return [u.first_name, u.last_name].filter(Boolean).join(" ") || `id:${u.id}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** Push a message into the ring buffer for its (group, thread) bucket. */
export function pushExternalMessage(msg: TelegramBot.Message): void {
  const groupId = msg.chat.id;
  const threadId = msg.message_thread_id;
  if (!threadId) return; // we only buffer per-topic supergroup messages

  const text = msg.text || msg.caption || "";
  if (!text && !msg.from) return;

  const key = bufferKey(groupId, threadId);
  const buf = externalBuffers.get(key) ?? [];

  const reply = msg.reply_to_message;
  const replyToText = reply
    ? truncate((reply.text || reply.caption || "").trim(), RING_MESSAGE_TRUNCATE)
    : undefined;

  buf.push({
    fromName: senderLabel(msg),
    fromId: msg.from?.id ?? 0,
    text: truncate(text.trim(), RING_MESSAGE_TRUNCATE),
    ts: new Date().toISOString(),
    ...(replyToText && { replyToText }),
  });

  // Evict oldest
  while (buf.length > RING_BUFFER_SIZE) buf.shift();
  externalBuffers.set(key, buf);
}

function getRecentMessages(groupId: number, threadId: number): BufferedMessage[] {
  return externalBuffers.get(bufferKey(groupId, threadId)) ?? [];
}

// --- Mention detection ---

/**
 * Returns true if this message contains an @mention of this bot, or is a direct
 * reply to a message authored by this bot.
 */
export function isMentionForThisBot(msg: TelegramBot.Message): boolean {
  if (!BOT_USERNAME) return false;

  // Reply to one of our messages counts as addressing us.
  if (msg.reply_to_message?.from?.id === BOT_ID) return true;

  const text = msg.text || msg.caption || "";
  if (!text) return false;

  const entities = msg.entities || msg.caption_entities || [];
  const target = `@${BOT_USERNAME.toLowerCase()}`;
  for (const ent of entities) {
    if (ent.type === "mention") {
      const mention = text.slice(ent.offset, ent.offset + ent.length).toLowerCase();
      if (mention === target) return true;
    }
    // text_mention carries a User object directly (no @username required)
    if (ent.type === "text_mention" && (ent as TelegramBot.MessageEntity & { user?: { id: number } }).user?.id === BOT_ID) {
      return true;
    }
  }
  return false;
}

// --- Desk topic lifecycle ---

/**
 * Lazy-create the desk forum topic for a user if it doesn't exist yet.
 * Picks the user's first connected forum group as the host.
 * Returns the topic record (with messageThreadId) or null if no group is connected.
 */
async function ensureDeskTopic(userId: number): Promise<{ forumGroupId: number; messageThreadId: number; name: string } | null> {
  const name = deskTopicName();

  const existing = getTopicByName(userId, name);
  if (existing) return existing;

  const groupIds = getForumGroupIds(userId);
  if (groupIds.length === 0) {
    logger.warn({ userId }, "Desk: cannot create — user has no connected forum group");
    return null;
  }
  const targetGroupId = groupIds[0];

  try {
    const result = await bot.createForumTopic(targetGroupId, name) as unknown as { message_thread_id: number };
    addTopic(userId, targetGroupId, name, result.message_thread_id);

    // Per-desk cwd, isolated from regular topics.
    const deskCwd = join(USERS_LOG_DIR, String(userId), "desk");
    mkdirSync(deskCwd, { recursive: true });
    setTopicCwd(userId, name, deskCwd);
    setTopicDescription(userId, name,
      "외부 그룹/토픽에서 이 봇이 멘션될 때 응답을 처리하는 데스크. " +
      "프롬프트에 외부 톡방 메타데이터, 최근 메시지, 멘션 메시지가 포함됨. " +
      "필요 시 ask_session으로 다른 세션을 호출 가능."
    );
    logger.info({ userId, groupId: targetGroupId, threadId: result.message_thread_id }, "Desk: topic created");
    return { forumGroupId: targetGroupId, messageThreadId: result.message_thread_id, name };
  } catch (e) {
    logger.error({ err: e, userId }, "Desk: createForumTopic failed");
    return null;
  }
}

// --- Desk session reset (in-memory) ---

interface DeskState {
  turns: number;
  lastUsedAt: number;
}

const deskStates = new Map<number, DeskState>();

/**
 * Decide whether the desk session should be reset for `userId` before processing
 * the next mention. Side-effect: clears the topic's session_id in DB if reset triggers,
 * and resets the in-memory turn counter.
 */
function maybeResetDeskSession(userId: number): void {
  const state = deskStates.get(userId);
  if (!state) return;

  const now = Date.now();
  const exceededTurns = state.turns >= DESK_RESET_TURNS;
  const exceededIdle = now - state.lastUsedAt > DESK_RESET_IDLE_MS;
  if (exceededTurns || exceededIdle) {
    clearSessionForTopic(userId, deskTopicName());
    deskStates.set(userId, { turns: 0, lastUsedAt: now });
    logger.info({ userId, turns: state.turns, exceededTurns, exceededIdle }, "Desk: session reset");
  }
}

function bumpDeskTurn(userId: number): void {
  const state = deskStates.get(userId) ?? { turns: 0, lastUsedAt: 0 };
  state.turns += 1;
  state.lastUsedAt = Date.now();
  deskStates.set(userId, state);
}

// --- Prompt assembly ---

function buildDeskPrompt(opts: {
  groupTitle: string;
  groupId: number;
  threadId: number;
  topicTitle?: string;
  recent: BufferedMessage[];
  mentionFrom: string;
  mentionText: string;
  replyToText?: string;
}): string {
  const lines: string[] = [];
  lines.push(`[외부 멘션 요청]`);
  lines.push(`톡방: ${opts.groupTitle} (id: ${opts.groupId})`);
  if (opts.topicTitle) lines.push(`토픽: ${opts.topicTitle} (thread: ${opts.threadId})`);
  else lines.push(`토픽: thread ${opts.threadId}`);
  lines.push("");
  lines.push("이 봇은 위 톡방을 직접 관리하지 않지만 멤버로 참여 중이며, 사용자가 봇을 멘션하여 도움을 요청했음.");
  lines.push("아래 컨텍스트와 멘션 메시지를 바탕으로 자연스럽게 응답할 것. 필요하면 자기 서버의 다른 세션을 ask_session으로 호출해 정보를 받아올 수 있음.");
  lines.push("");

  if (opts.recent.length > 0) {
    lines.push(`[해당 토픽 최근 메시지 (${opts.recent.length}개, 오래된 순)]`);
    for (const m of opts.recent) {
      const replyHint = m.replyToText ? ` (→ "${m.replyToText}"에 대한 reply)` : "";
      lines.push(`${m.fromName}${replyHint}: ${m.text}`);
    }
    lines.push("");
  }

  if (opts.replyToText) {
    lines.push(`[멘션이 reply한 메시지]`);
    lines.push(opts.replyToText);
    lines.push("");
  }

  lines.push(`[멘션 메시지 — ${opts.mentionFrom}]`);
  lines.push(opts.mentionText);

  return lines.join("\n");
}

// --- Public entry point ---

/**
 * Handle an external @mention received by this bot in a supergroup topic that
 * the bot does not own. Routes the work into this user's desk session, mirrors
 * the final response back to the original external topic.
 *
 * Returns true if the mention was accepted (a query was started), false if
 * skipped (no admin user, no desk topic possible, etc.).
 */
export async function handleExternalMention(msg: TelegramBot.Message): Promise<boolean> {
  // We need an admin user to attribute the desk session to. Pick the first admin —
  // for the single-user-now-but-multi-user-later setup, this is the workspace owner.
  const adminId = [...ADMIN_USERS][0];
  if (!adminId) return false;

  const desk = await ensureDeskTopic(adminId);
  if (!desk) return false;

  // Check session reset BEFORE building the prompt so a fresh session starts cleanly.
  maybeResetDeskSession(adminId);

  // Pull recent context from the ring buffer (excluding the mention message itself,
  // which is appended last by buildDeskPrompt).
  const groupId = msg.chat.id;
  const threadId = msg.message_thread_id || 0;
  const recent = getRecentMessages(groupId, threadId)
    // Drop the mention itself if it's already in the buffer
    .filter((m) => !(m.text === (msg.text || msg.caption || "").trim() && m.fromId === msg.from?.id));

  const mentionText = (await buildPromptFromMessage(msg, groupId, adminId)) || "";
  if (!mentionText.trim()) {
    logger.debug({ groupId, threadId }, "Desk: empty mention message, skipping");
    return false;
  }

  const replyToText = msg.reply_to_message
    ? truncate((msg.reply_to_message.text || msg.reply_to_message.caption || "").trim(), RING_MESSAGE_TRUNCATE)
    : undefined;

  const prompt = buildDeskPrompt({
    groupTitle: msg.chat.title || `chat ${groupId}`,
    groupId,
    threadId,
    topicTitle: (msg as TelegramBot.Message & { reply_to_message?: { forum_topic_created?: { name: string } } })
      .reply_to_message?.forum_topic_created?.name,
    recent,
    mentionFrom: senderLabel(msg),
    mentionText,
    ...(replyToText && { replyToText }),
  });

  const deskName = deskTopicName();
  bumpDeskTurn(adminId);

  // Run the query on the desk topic. The desk topic receives the full streaming flow.
  // The mirrorTo option forwards the final response to the original external topic.
  await handleClaudeQuery({
    chatId: desk.forumGroupId,
    userId: adminId,
    senderId: msg.from?.id,
    topicName: deskName,
    sessionId: getTopicByName(adminId, deskName)?.sessionId || null,
    prompt,
    messageThreadId: desk.messageThreadId,
    systemPrompt: buildTopicSystemPrompt({
      description: getTopicDescription(adminId, deskName),
    }),
    model: getTopicModel(adminId, deskName) || undefined,
    mirrorTo: { chatId: groupId, messageThreadId: threadId || undefined },
  });

  return true;
}
