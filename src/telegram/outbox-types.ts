export interface ForumTopic {
  message_thread_id: number;
  name: string;
}

export interface TelegramApiError {
  response?: { statusCode?: number };
}

// --- Session inject callback (registered by bot.ts to avoid circular dep) ---
export type SessionInjectHandler = (params: {
  userId: number;
  topicName: string;
  sessionId: string;
  prompt: string;
  messageThreadId: number;
  forumGroupId: number;
  from: string;
  depth: number;
  chain: string[];
  requestId?: string;
  contextId?: string;
  isCommand?: boolean;
}) => Promise<void>;

let _sessionInjectHandler: SessionInjectHandler | null = null;

export function onSessionInject(handler: SessionInjectHandler) {
  _sessionInjectHandler = handler;
}

export function getSessionInjectHandler(): SessionInjectHandler | null {
  return _sessionInjectHandler;
}

// --- Abort handler (registered by bot.ts to avoid circular dep) ---
export type AbortHandler = (userId: number, topicName: string) => boolean;

let _abortHandler: AbortHandler | null = null;

export function onAbortRequest(handler: AbortHandler) {
  _abortHandler = handler;
}

export function getAbortHandler(): AbortHandler | null {
  return _abortHandler;
}
