import { bot } from "@/telegram/client";
import { logger } from "@/core/logger";
import type { TokenUsage } from "@/core/types";

const THRESHOLD_STEP = 500_000;

// Track highest alerted level per session (userId:topicName → level number)
// level 1 = 500K, level 2 = 1M, level 3 = 1.5M, ...
const alertedLevel = new Map<string, number>();

/**
 * Check if a single query's total token usage (input+output) crossed
 * a new 500K×n threshold for this session.
 * Alerts once per level per session lifetime.
 */
export function checkQueryUsageAlert(
  userId: number,
  topicName: string,
  usage: TokenUsage,
) {
  const totalTokens = usage.inputTokens + usage.outputTokens;
  const currentLevel = Math.floor(totalTokens / THRESHOLD_STEP);
  if (currentLevel < 1) return;

  const key = `${userId}:${topicName}`;
  const lastLevel = alertedLevel.get(key) ?? 0;
  if (currentLevel <= lastLevel) return;
  alertedLevel.set(key, currentLevel);

  const tokenK = Math.round(totalTokens / 1000);
  const msg =
    `⚠️ "${topicName}" 세션이 1회 호출에 ${tokenK}K 토큰을 사용했어요.\n\n` +
    `세션이 비대해지면 응답 품질이 떨어지고 비용이 증가합니다.\n` +
    `/del ${topicName} 후 /new ${topicName} 으로 새 세션을 시작하는 걸 추천해요.`;

  bot.sendMessage(userId, msg).catch((err) => {
    logger.warn({ userId, topicName, err: err?.message }, "query-usage-alert: Failed to send DM");
  });

  logger.info({ userId, topicName, totalTokens, level: currentLevel }, "query-usage-alert: Sent warning");
}

/** Clear alert flag for a topic (e.g. when session is reset) */
export function clearQueryUsageAlert(userId: number, topicName: string) {
  alertedLevel.delete(`${userId}:${topicName}`);
}
