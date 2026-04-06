import { readFileSync, writeFileSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { bot } from "@/telegram/client";
import {
  getUserConfig,
  getTopicByName,
  addTopic,
  getTopicLink,
  setTopicDescription,
  setTopicModel,
  setTopicEffort,
  setTopicCwd,
  setTopicMcpEnabled,
  setTopicMcpExtra,
} from "@/telegram/forum-sessions";
import { logger } from "@/core/logger";
import type { EffortLevel } from "@/core/types";
import { DM_CMD_DIR, DM_RESP_DIR } from "@/core/config";
import { ForumTopic, getSessionInjectHandler } from "@/telegram/outbox-types";
import { deleteTopicWithArchive } from "@/core/topic-lifecycle";

export { DM_CMD_DIR };

export async function flushDmCommands() {
  let files: string[];
  try {
    files = readdirSync(DM_CMD_DIR).filter((f) => f.endsWith(".jsonl"));
  } catch (e) {
    logger.warn({ err: e }, "dm-commands: Failed to read command dir");
    return;
  }

  for (const file of files) {
    const filePath = join(DM_CMD_DIR, file);
    let lines: string[];
    try {
      lines = readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);
    } catch (e) {
      logger.warn({ err: e, file }, "dm-commands: Failed to read");
      continue;
    }

    if (lines.length === 0) continue;

    const remaining: string[] = [];
    for (const line of lines) {
      try {
        const cmd = JSON.parse(line);
        if (!cmd.action || typeof cmd.action !== "string" || !cmd.requestId) {
          logger.error({ cmd }, "dm-commands: Missing action or requestId, dropping");
          continue;
        }
        const uid = Number(file.replace(".jsonl", ""));
        const config = getUserConfig(uid);
        const respFile = join(DM_RESP_DIR, `${uid}-${cmd.requestId}.json`);

        if (cmd.action === "create_topic") {
          if (!config || config.forumGroupIds.length === 0) {
            writeFileSync(respFile, JSON.stringify({ success: false, error: "No forum group linked" }));
            continue;
          }
          // Use group_id from params if specified, otherwise first group
          const targetGroupId = cmd.params.group_id ? Number(cmd.params.group_id) : config.forumGroupIds[0];
          if (!config.forumGroupIds.includes(targetGroupId)) {
            writeFileSync(respFile, JSON.stringify({ success: false, error: `Group ${targetGroupId} is not connected` }));
            continue;
          }
          try {
            const result = await bot.createForumTopic(targetGroupId, cmd.params.name) as unknown as ForumTopic;
            addTopic(uid, targetGroupId, cmd.params.name, result.message_thread_id);
            // Apply initial config if provided
            const topicName = cmd.params.name as string;
            const mcpEnabled = cmd.params.mcp_enabled as string[] | null | undefined;
            if (mcpEnabled !== undefined) {
              const required = ["session-comm", "send-file", "cron-manager"];
              const safe = mcpEnabled === null
                ? null
                : [...new Set([...mcpEnabled, ...required.filter(r => !mcpEnabled.includes(r))])];
              setTopicMcpEnabled(uid, topicName, safe);
            }
            if (cmd.params.cwd) setTopicCwd(uid, topicName, cmd.params.cwd as string);
            if (cmd.params.model && cmd.params.model !== "default") setTopicModel(uid, topicName, cmd.params.model as string);
            if (cmd.params.effort && cmd.params.effort !== "default") setTopicEffort(uid, topicName, cmd.params.effort as EffortLevel);
            const link = getTopicLink(targetGroupId, result.message_thread_id);
            writeFileSync(respFile, JSON.stringify({ success: true, link }));
          } catch (e) {
            writeFileSync(respFile, JSON.stringify({ success: false, error: e instanceof Error ? e.message : "unknown" }));
          }
        } else if (cmd.action === "delete_topic") {
          if (!config) {
            writeFileSync(respFile, JSON.stringify({ success: false, error: "No config" }));
            continue;
          }
          const topic = getTopicByName(uid, cmd.params.name);
          if (!topic) {
            writeFileSync(respFile, JSON.stringify({ success: false, error: "Topic not found" }));
            continue;
          }
          try {
            const result = await deleteTopicWithArchive({
              userId: uid,
              topicName: cmd.params.name,
              sessionId: topic.sessionId || null,
              forumGroupId: topic.forumGroupId,
              messageThreadId: topic.messageThreadId,
            });
            writeFileSync(respFile, JSON.stringify(result));
          } catch (e) {
            writeFileSync(respFile, JSON.stringify({ success: false, error: e instanceof Error ? e.message : "unknown" }));
          }
        } else if (cmd.action === "set_description") {
          const ok = setTopicDescription(uid, cmd.params.topic as string, cmd.params.description as string);
          writeFileSync(respFile, JSON.stringify({ success: ok, error: ok ? undefined : "Topic not found" }));
        } else if (cmd.action === "set_topic_cwd") {
          const cwd = cmd.params.cwd as string | null;
          const ok = setTopicCwd(uid, cmd.params.topic as string, cwd);
          writeFileSync(respFile, JSON.stringify({ success: ok, error: ok ? undefined : "Topic not found" }));
        } else if (cmd.action === "set_topic_model") {
          const model = cmd.params.model === "default" ? null : cmd.params.model as string;
          const ok = setTopicModel(uid, cmd.params.topic as string, model);
          writeFileSync(respFile, JSON.stringify({ success: ok, error: ok ? undefined : "Topic not found" }));
        } else if (cmd.action === "set_topic_effort") {
          const effort = cmd.params.effort === "default" ? null : cmd.params.effort as EffortLevel;
          const ok = setTopicEffort(uid, cmd.params.topic as string, effort);
          writeFileSync(respFile, JSON.stringify({ success: ok, error: ok ? undefined : "Topic not found" }));
        } else if (cmd.action === "set_topic_mcp_enabled") {
          const rawEnabled = cmd.params.enabled as string[] | null;
          const required = ["session-comm", "send-file", "cron-manager"];
          const safeEnabled = rawEnabled === null
            ? null
            : [...new Set([...rawEnabled, ...required.filter(r => !rawEnabled.includes(r))])];
          const ok = setTopicMcpEnabled(uid, cmd.params.topic as string, safeEnabled);
          writeFileSync(respFile, JSON.stringify({ success: ok, error: ok ? undefined : "Topic not found" }));
        } else if (cmd.action === "set_topic_mcp_extra") {
          const ok = setTopicMcpExtra(uid, cmd.params.topic as string, cmd.params.extra as Record<string, unknown>);
          writeFileSync(respFile, JSON.stringify({ success: ok, error: ok ? undefined : "Topic not found" }));
        } else {
          writeFileSync(respFile, JSON.stringify({ success: false, error: `Unknown action: ${cmd.action}` }));
        }
      } catch (e) {
        logger.warn({ err: e, file }, "dm-commands: Failed to process command");
        remaining.push(line);
      }
    }

    // Remove processed file or write back remaining
    try {
      if (remaining.length === 0) {
        unlinkSync(filePath);
      } else {
        writeFileSync(filePath, remaining.join("\n") + "\n");
      }
    } catch (e) {
      logger.warn({ err: e, file }, "dm-commands: Failed to cleanup");
    }
  }
}
