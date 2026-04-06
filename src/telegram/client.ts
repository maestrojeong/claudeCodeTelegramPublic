import TelegramBot from "node-telegram-bot-api";
import { logger } from "@/core/logger";

// --- Config ---
export const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  logger.fatal("TELEGRAM_BOT_TOKEN not set. Add it to .env.local");
  process.exit(1);
}

// --- Allowed users ---
export const ADMIN_USERS: Set<number> = new Set(
  (process.env.TELEGRAM_ADMIN_USERS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
);

if (ADMIN_USERS.size === 0) {
  logger.warn("TELEGRAM_ADMIN_USERS not set. No one can use this bot.");
}

export const bot = new TelegramBot(TOKEN, { polling: true });
logger.info({ adminUsers: [...ADMIN_USERS] }, "Telegram bot started");
