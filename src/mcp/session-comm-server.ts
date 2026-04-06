#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync, appendFileSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";

import { ACTIVE_QUERY_STALE_MS, USERS_LOG_DIR, loadAgentPrompt, buildTopicSystemPrompt, buildDelegateSystemPrompt } from "@/core/config";
import { ALL_FORUM_MCP_SERVER_NAMES, REQUIRED_FORUM_MCP_SERVERS } from "@/core/mcp-config";
import { createContextId, appendContext, loadContext, formatContextForPrompt } from "@/core/context-store";

import type { QueryState } from "./session-comm-utils";
import {
  SESSION_INBOX_DIR,
  userId,
  currentTopic,
  currentDepth,
  currentChain,
  MAX_DEPTH,
  MAX_MESSAGE_LENGTH,
  getTopicCwd,
  getTopicsForUser,
  writeProgress,
  clearProgress,
  cleanupFork,
  queryForkSession,
  formatForkResult,
  getMcpConfig,
  setMcpConfig,
  setCurrentTopicDescription,
} from "./session-comm-utils";

// --- Lazy-loaded agent prompts ---
let _orchPrompt: ReturnType<typeof loadAgentPrompt> | null = null;
const getOrchPrompt = () => (_orchPrompt ??= loadAgentPrompt("orchestrator-system.md"));

// --- MCP Server ---

const server = new McpServer({
  name: "session-comm",
  version: "1.0.0",
});

// --- always available ---

server.tool(
  "list_sessions",
  "List all available Claude sessions (forum topics) for inter-session communication.",
  {},
  async () => {
    const topics = getTopicsForUser();
    const entries = Object.entries(topics)
      .filter(([name]) => name !== currentTopic)
      .map(([name, t]) => {
        const status = t.sessionId ? `active (${t.sessionId.slice(0, 8)})` : "no session";
        const cron = t.cronSessionId ? ` | cron: active` : "";
        const inChain = currentChain.includes(name) ? " (체인 내 존재)" : "";
        const desc = t.description ? `\n    description: ${t.description.slice(0, 80)}${t.description.length > 80 ? "..." : ""}` : "";
        return `- ${name}: ${status}${cron}${inChain}${desc}`;
      });

    if (entries.length === 0) {
      return {
        content: [{ type: "text" as const, text: "No other sessions available." }],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Current session: ${currentTopic}\nDepth: ${currentDepth}/${MAX_DEPTH} | Chain: ${currentChain.join(" → ")}\n\nAvailable sessions:\n${entries.join("\n")}`,
        },
      ],
    };
  }
);

server.tool(
  "configure_mcp",
  `Configure MCP servers for the current topic. Changes take effect on the next session start.\n` +
  `Available default servers: ${ALL_FORUM_MCP_SERVER_NAMES.join(", ")}\n` +
  `- enabled: whitelist of servers to load (null = restore all defaults). Required servers always included: ${REQUIRED_FORUM_MCP_SERVERS.join(", ")}\n` +
  `- extra: custom server configs to add on top (key = server name, value = { command, args } or { type: "sse", url })`,
  {
    enabled: z.array(z.string()).nullable().optional().describe(
      `Servers to enable. null = all defaults, [] = none, or list specific names e.g. ["session-comm","cron-manager","send-file"]`
    ),
    extra: z.record(z.string(), z.any()).optional().describe(
      `Custom MCP server configs to add (e.g. { "slack": { command: "bun", args: ["run", "/path/to/server.ts"] } })`
    ),
  },
  async ({ enabled, extra }) => {
    if (!currentTopic || !userId) {
      return { content: [{ type: "text" as const, text: "Error: No current topic." }], isError: true };
    }
    if (enabled !== null && enabled !== undefined) {
      const missing = (REQUIRED_FORUM_MCP_SERVERS as readonly string[]).filter(r => !enabled.includes(r));
      if (missing.length > 0) {
        return { content: [{ type: "text" as const, text: `Error: 필수 서버는 비활성화할 수 없음: ${missing.join(", ")}` }], isError: true };
      }
    }
    try {
      setMcpConfig(enabled, extra as Record<string, unknown> | undefined);
      const current = getMcpConfig();
      const active = current.enabled !== null
        ? current.enabled
        : [...ALL_FORUM_MCP_SERVER_NAMES];
      const lines = [
        `MCP 설정 저장됨 (다음 세션부터 적용)`,
        ``,
        `활성 서버: ${active.length > 0 ? active.join(", ") : "없음"}`,
        `추가 서버: ${Object.keys(current.extra).length > 0 ? Object.keys(current.extra).join(", ") : "없음"}`,
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
    }
  }
);

server.tool(
  "get_mcp_config",
  "Get the current MCP server configuration for this topic.",
  {},
  async () => {
    const config = getMcpConfig();
    const active = config.enabled !== null ? config.enabled : [...ALL_FORUM_MCP_SERVER_NAMES];
    const lines = [
      `현재 토픽: ${currentTopic}`,
      ``,
      `활성 서버: ${active.join(", ")}`,
      `설정 방식: ${config.enabled !== null ? "whitelist" : "기본값 (전체)"}`,
      `추가 서버: ${Object.keys(config.extra).length > 0 ? Object.keys(config.extra).join(", ") : "없음"}`,
      ``,
      `전체 기본 서버 목록: ${ALL_FORUM_MCP_SERVER_NAMES.join(", ")}`,
    ];
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  }
);

server.tool(
  "ask_cron",
  "Ask a question to this topic's cron session. The cron session has context from scheduled tasks (e.g. news scraping, monitoring). Use this when the user asks about data or results from cron jobs running in this topic.",
  {
    message: z.string().describe("Question or message to send to the cron session"),
  },
  async ({ message }) => {
    if (!currentTopic) {
      return {
        content: [{ type: "text" as const, text: "Error: No current topic detected." }],
        isError: true,
      };
    }

    const topics = getTopicsForUser();
    const self = topics[currentTopic];

    if (!self?.cronSessionId) {
      return {
        content: [{
          type: "text" as const,
          text: `Error: No cron session found for topic "${currentTopic}". A cron job needs to run at least once to create a cron session.`,
        }],
        isError: true,
      };
    }

    const prompt = `[${currentTopic} 유저 세션에서 온 질문]\n${message}\n\n위 질문에 대해, 크론 작업에서 수집/처리한 데이터를 바탕으로 답변해주세요.`;

    let cronForkId: string | undefined;
    try {
      const { forkSession } = await import("@anthropic-ai/claude-agent-sdk");
      const forkResult = await forkSession(self.cronSessionId, {
        dir: getTopicCwd(),
        title: `cron-query: ${currentTopic}`,
      });
      cronForkId = forkResult.sessionId;

      const queryResult = await queryForkSession(prompt, cronForkId, undefined, undefined, undefined, writeProgress);

      return {
        content: [{
          type: "text" as const,
          text: formatForkResult(`${currentTopic}:cron`, queryResult),
        }],
      };
    } catch (err) {
      const e = err as { message?: string };
      return {
        content: [{
          type: "text" as const,
          text: `Error communicating with cron session: ${e?.message || "Unknown error"}`,
        }],
        isError: true,
      };
    } finally {
      clearProgress();
      if (cronForkId) cleanupFork(cronForkId);
    }
  }
);

// --- depth=0 only: top-level session tools ---

if (currentDepth === 0) {
  server.tool(
    "ask_session",
    "Ask another Claude session (forum topic) a question. The reply will be automatically injected back into your session when ready — no polling needed. Use context_id to continue a previous conversation without resending full context.",
    {
      to: z.string().describe("Target session/topic name (e.g. '회의록', '신건')"),
      message: z.string().describe("Message to send to the target session"),
      context_id: z.string().optional().describe("Context ID from a previous ask_session exchange. Omit for new conversations."),
    },
    async ({ to, message, context_id }) => {
      if (message.length > MAX_MESSAGE_LENGTH) {
        return {
          content: [{ type: "text" as const, text: `Error: message too long (${message.length} chars, max ${MAX_MESSAGE_LENGTH})` }],
          isError: true,
        };
      }

      const topics = getTopicsForUser();
      const target = topics[to];

      if (!target) {
        const available = Object.keys(topics).filter((n) => n !== currentTopic);
        return {
          content: [{ type: "text" as const, text: `Error: Session "${to}" not found.\nAvailable sessions: ${available.join(", ") || "none"}` }],
          isError: true,
        };
      }

      if (!target.sessionId) {
        return {
          content: [{ type: "text" as const, text: `Error: Session "${to}" has no active session ID. The user needs to send a message there first.` }],
          isError: true,
        };
      }

      if (currentChain.includes(to)) {
        return {
          content: [{ type: "text" as const, text: `Error: "${to}"는 이미 체인에 포함됨. 순환 호출 불가.\n체인: ${currentChain.join(" → ")}` }],
          isError: true,
        };
      }

      const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const newChain = [...currentChain, to];
      const contextId = context_id || createContextId();

      try {
        const inboxDir = join(SESSION_INBOX_DIR, userId);
        mkdirSync(inboxDir, { recursive: true });
        const inboxFile = join(inboxDir, `${to}.jsonl`);
        const entry = {
          requestId,
          from: currentTopic,
          message,
          contextId,
          depth: currentDepth + 1,
          maxDepth: MAX_DEPTH,
          chain: newChain,
          timestamp: new Date().toISOString(),
        };
        appendFileSync(inboxFile, JSON.stringify(entry) + "\n");
      } catch (err) {
        const e = err as { message?: string };
        return {
          content: [{ type: "text" as const, text: `Error: "${to}" 세션에 메시지 전송 실패: ${e?.message || "Unknown"}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: `메시지를 "${to}" 세션에 전송했습니다. (chain: ${newChain.join(" → ")})\n\ncontext_id: ${contextId}\nrequest_id: ${requestId}\n\n응답은 이 세션에 자동으로 주입됩니다. 다음 ask_session에 context_id를 전달하면 이전 대화를 이어갈 수 있습니다.`,
        }],
      };
    }
  );

  server.tool(
    "peek_session",
    "Check which sessions are currently running a query (busy) vs idle. Useful before abort_session or orchestrate.",
    {},
    async () => {
      const topics = getTopicsForUser();
      const topicNames = Object.keys(topics);
      const activeQueriesDir = join(USERS_LOG_DIR, userId, "active-queries");

      // Read own query state for consistent display
      const selfStateFile = join(activeQueriesDir, `${currentTopic}.json`);
      let selfLabel = `${currentTopic} (자신 — 실행 중)`;
      try {
        const selfState = JSON.parse(readFileSync(selfStateFile, "utf-8")) as QueryState;
        const selfElapsed = Date.now() - new Date(selfState.since).getTime();
        const selfMins = Math.floor(selfElapsed / 60000);
        const selfSecs = Math.floor((selfElapsed % 60000) / 1000);
        const selfTimeStr = selfMins > 0 ? `${selfMins}분 ${selfSecs}초` : `${selfSecs}초`;
        const selfTaskStr = selfState.task ? ` | ${selfState.task}` : "";
        selfLabel = `${currentTopic} (자신 — ${selfTimeStr}${selfTaskStr})`;
      } catch { /* file absent or unreadable — fallback to default label */ }
      const running: string[] = [selfLabel];
      const idle: string[] = [];

      for (const name of topicNames) {
        if (name === currentTopic) continue;
        const stateFile = join(activeQueriesDir, `${name}.json`);
        let isRunning = false;
        if (existsSync(stateFile)) {
          try {
            const state = JSON.parse(readFileSync(stateFile, "utf-8")) as QueryState;
            const elapsed = Date.now() - new Date(state.since).getTime();
            if (elapsed <= ACTIVE_QUERY_STALE_MS) {
              const mins = Math.floor(elapsed / 60000);
              const secs = Math.floor((elapsed % 60000) / 1000);
              const timeStr = mins > 0 ? `${mins}분 ${secs}초` : `${secs}초`;
              const taskStr = state.task ? ` | ${state.task}` : "";
              running.push(`${name} (${timeStr}${taskStr})`);
              isRunning = true;
            }
          } catch { /* stale or corrupt, treat as idle */ }
        }
        if (!isRunning) idle.push(name);
      }

      const runningHeader = `실행 중 (${running.length}):\n${running.map(r => `  ${r}`).join("\n")}`;
      const lines = [
        `현재 세션 상태`,
        ``,
        runningHeader,
        `유휴 (${idle.length}): ${idle.join(", ") || "없음"}`,
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );

  server.tool(
    "set_description",
    "Set a description for the current session. Acts as a system prompt addition and routing hint for other sessions using list_sessions. Call this once at session start based on the topic's CLAUDE.md.",
    {
      description: z.string().describe("What this session specializes in (e.g. 'UE5 graphics development, shader optimization')"),
    },
    async ({ description }) => {
      try {
        setCurrentTopicDescription(description);
        return {
          content: [{ type: "text" as const, text: `Description set for "${currentTopic}".` }],
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "abort_session",
    "Abort the currently running query in another session. Use peek_session first to confirm it is busy.",
    {
      target: z.string().describe("Target session/topic name to abort"),
    },
    async ({ target }) => {
      const topics = getTopicsForUser();
      if (!topics[target]) {
        const available = Object.keys(topics).filter((n) => n !== currentTopic);
        return {
          content: [{ type: "text" as const, text: `Error: Session "${target}" not found.\nAvailable: ${available.join(", ") || "none"}` }],
          isError: true,
        };
      }

      if (target === currentTopic) {
        return {
          content: [{ type: "text" as const, text: `Error: 자기 자신은 abort할 수 없습니다.` }],
          isError: true,
        };
      }

      try {
        const inboxDir = join(SESSION_INBOX_DIR, userId);
        mkdirSync(inboxDir, { recursive: true });
        appendFileSync(join(inboxDir, `${target}.jsonl`), JSON.stringify({ type: "abort", timestamp: new Date().toISOString() }) + "\n");
      } catch (err) {
        const e = err as { message?: string };
        return {
          content: [{ type: "text" as const, text: `Error: abort 신호 전송 실패: ${e?.message || "Unknown"}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: `"${target}" 세션에 abort 신호를 보냈습니다. 실행 중인 쿼리가 있으면 중단됩니다.` }],
      };
    }
  );

  server.tool(
    "command_session",
    "Send a one-way command to another Claude session (forum topic). The command appears as a visible message in the target topic and is processed at depth=1 — the receiving session cannot use command_session in response. No reply is sent back.",
    {
      to: z.string().describe("Target session/topic name (e.g. '회의록', '신건')"),
      message: z.string().describe("Command to send to the target session"),
    },
    async ({ to, message }) => {
      if (message.length > MAX_MESSAGE_LENGTH) {
        return {
          content: [{ type: "text" as const, text: `Error: message too long (${message.length} chars, max ${MAX_MESSAGE_LENGTH})` }],
          isError: true,
        };
      }

      const topics = getTopicsForUser();
      const target = topics[to];

      if (!target) {
        const available = Object.keys(topics).filter((n) => n !== currentTopic);
        return {
          content: [{ type: "text" as const, text: `Error: Session "${to}" not found.\nAvailable sessions: ${available.join(", ") || "none"}` }],
          isError: true,
        };
      }

      if (!target.sessionId) {
        return {
          content: [{ type: "text" as const, text: `Error: Session "${to}" has no active session ID. The user needs to send a message there first.` }],
          isError: true,
        };
      }

      try {
        const inboxDir = join(SESSION_INBOX_DIR, userId);
        mkdirSync(inboxDir, { recursive: true });
        const inboxFile = join(inboxDir, `${to}.jsonl`);
        const entry = {
          from: currentTopic,
          message,
          command: true,
          timestamp: new Date().toISOString(),
        };
        appendFileSync(inboxFile, JSON.stringify(entry) + "\n");
      } catch (err) {
        const e = err as { message?: string };
        return {
          content: [{ type: "text" as const, text: `Error: "${to}" 세션에 명령 전송 실패: ${e?.message || "Unknown"}` }],
          isError: true,
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: `명령을 "${to}" 세션에 전송했습니다. 해당 토픽에 메시지로 표시되고 Claude가 처리합니다.`,
        }],
      };
    }
  );

  server.tool(
    "abort_orchestrate",
    "Abort an ongoing orchestrate in another session. Use peek_session to confirm the session is busy with an orchestrate.",
    {
      target: z.string().describe("Topic name whose orchestrate to abort"),
    },
    async ({ target }) => {
      const topics = getTopicsForUser();
      if (!topics[target]) {
        const available = Object.keys(topics).filter((n) => n !== currentTopic);
        return {
          content: [{ type: "text" as const, text: `Error: Session "${target}" not found.\nAvailable: ${available.join(", ") || "none"}` }],
          isError: true,
        };
      }
      try {
        const inboxDir = join(SESSION_INBOX_DIR, userId);
        mkdirSync(inboxDir, { recursive: true });
        // .orch is a plain signal file polled directly by the orchestrate tool (MCP-internal IPC)
        writeFileSync(join(inboxDir, `${target}.orch`), new Date().toISOString());
      } catch (err) {
        const e = err as { message?: string };
        return {
          content: [{ type: "text" as const, text: `Error: abort 신호 전송 실패: ${e?.message || "Unknown"}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: `"${target}" 세션의 orchestrate에 abort 신호를 보냈습니다.` }],
      };
    }
  );

  server.tool(
    "orchestrate",
    "Enter orchestrator mode: forks your own session and runs a complex task. " +
    "The orchestrator can use delegate_to_session to synchronously assign work to other sessions, " +
    "chain multiple sessions, and synthesize results. Use this when you need to " +
    "coordinate work across multiple sessions and get results back immediately.",
    {
      task: z.string().describe("Task to perform — describe what to do and which sessions to query"),
    },
    async ({ task }) => {
      if (!currentTopic) {
        return { content: [{ type: "text" as const, text: "Error: No current topic." }], isError: true };
      }

      const topics = getTopicsForUser();
      const self = topics[currentTopic];

      if (!self?.sessionId) {
        return { content: [{ type: "text" as const, text: "Error: No active session to fork." }], isError: true };
      }

      // Build orchestrator system prompt with current session list
      const sessionList = Object.entries(topics)
        .filter(([name]) => name !== currentTopic)
        .map(([name, t]) => `- ${name}${t.description ? `: ${t.description}` : ""}`)
        .join("\n") || "(no other sessions available)";
      const orchSystemPrompt = getOrchPrompt().prompt.replace("{{SESSION_LIST}}", sessionList);

      // Abort controller + signal file polling (polled internally; abort_orchestrate writes .orch to session-inbox)
      const orchAbortController = new AbortController();
      const orchSignalFile = join(SESSION_INBOX_DIR, userId, `${currentTopic}.orch`);
      const pollInterval = setInterval(() => {
        if (existsSync(orchSignalFile)) {
          try { unlinkSync(orchSignalFile); } catch {}
          orchAbortController.abort();
        }
      }, 1000);

      let orchForkId: string | undefined;
      try {
        const { forkSession } = await import("@anthropic-ai/claude-agent-sdk");

        const result = await forkSession(self.sessionId, {
          dir: getTopicCwd(),
          title: `orchestrator: ${currentTopic}`,
        });
        orchForkId = result.sessionId;

        const orchForkResult = await queryForkSession(task, orchForkId, currentTopic, currentDepth + 1, currentChain, writeProgress, orchAbortController, orchSystemPrompt);

        if (orchAbortController.signal.aborted) {
          return { content: [{ type: "text" as const, text: "Orchestrate가 중단되었습니다." }] };
        }
        return { content: [{ type: "text" as const, text: formatForkResult("orchestrator", orchForkResult) }] };
      } catch (err) {
        if (orchAbortController.signal.aborted) {
          return { content: [{ type: "text" as const, text: "Orchestrate가 중단되었습니다." }] };
        }
        const e = err as { message?: string };
        return {
          content: [{ type: "text" as const, text: `Error: orchestrate 실패: ${e?.message || "Unknown"}` }],
          isError: true,
        };
      } finally {
        clearInterval(pollInterval);
        try { if (existsSync(orchSignalFile)) unlinkSync(orchSignalFile); } catch {}
        clearProgress();
        if (orchForkId) cleanupFork(orchForkId);
      }
    }
  );
}

// --- depth>0 only: fork session tools ---

if (currentDepth > 0) {
  server.tool(
    "delegate_to_session",
    "Delegate work to another session synchronously by forking it. Returns the response directly. Use context_id to continue a previous conversation.",
    {
      to: z.string().describe("Target session/topic name"),
      message: z.string().describe("Message to send"),
      context_id: z.string().optional().describe("Context ID from a previous exchange. Omit for new conversations."),
    },
    async ({ to, message, context_id }) => {
      if (message.length > MAX_MESSAGE_LENGTH) {
        return { content: [{ type: "text" as const, text: `Error: message too long (${message.length} chars, max ${MAX_MESSAGE_LENGTH})` }], isError: true };
      }

      const topics = getTopicsForUser();
      const target = topics[to];

      if (!target) {
        const available = Object.keys(topics).filter((n) => n !== currentTopic);
        return { content: [{ type: "text" as const, text: `Error: Session "${to}" not found.\nAvailable: ${available.join(", ") || "none"}` }], isError: true };
      }

      if (currentChain.includes(to)) {
        return { content: [{ type: "text" as const, text: `Error: "${to}"는 이미 체인에 포함됨. 순환 호출 불가.\n체인: ${currentChain.join(" → ")}` }], isError: true };
      }

      if (currentDepth >= MAX_DEPTH) {
        return { content: [{ type: "text" as const, text: `Error: 최대 깊이(${MAX_DEPTH}) 도달.\n체인: ${currentChain.join(" → ")}` }], isError: true };
      }

      const newChain = [...currentChain, to];
      const contextId = context_id || createContextId();
      const uid = Number(userId);

      // Build B's delegate system prompt (delegation context + description + memory)
      const targetSystemPrompt = buildDelegateSystemPrompt({
        from: currentTopic,
        description: target.description,
      });

      // Load previous context and prepend to prompt
      const contextPrefix = context_id && !isNaN(uid)
        ? formatContextForPrompt(loadContext(uid, contextId))
        : "";
      const prompt = `${contextPrefix}[${currentTopic} 세션에서 온 메시지 (chain: ${newChain.join(" → ")})]\n${message}\n\n위 메시지에 응답해주세요.`;

      // Save outgoing message to context
      if (!isNaN(uid)) {
        appendContext(uid, contextId, { role: currentTopic, content: message, ts: new Date().toISOString() });
      }

      let forkId: string | undefined;
      try {
        if (target.sessionId) {
          try {
            const { forkSession } = await import("@anthropic-ai/claude-agent-sdk");
            const result = await forkSession(target.sessionId, {
              dir: getTopicCwd(),
              title: `chain: ${currentTopic} → ${to}`,
            });
            forkId = result.sessionId;
          } catch {
            // Fall through — run without resume
          }
        }

        const qForkResult = await queryForkSession(prompt, forkId, to, currentDepth + 1, newChain, writeProgress, undefined, targetSystemPrompt);

        // Save response to context
        if (!isNaN(uid) && qForkResult) {
          const responseText = typeof qForkResult === "string" ? qForkResult : JSON.stringify(qForkResult);
          appendContext(uid, contextId, { role: to, content: responseText, ts: new Date().toISOString() });
        }

        const result = formatForkResult(to, qForkResult);
        return { content: [{ type: "text" as const, text: `${result}\n\ncontext_id: ${contextId}` }] };
      } catch (err) {
        const e = err as { message?: string };
        return {
          content: [{ type: "text" as const, text: `Error: ${to} 세션 쿼리 실패: ${e?.message || "Unknown"}` }],
          isError: true,
        };
      } finally {
        if (forkId) cleanupFork(forkId);
      }
    }
  );
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
