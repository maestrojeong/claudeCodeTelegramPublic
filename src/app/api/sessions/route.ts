import { listSessions, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { USERS_LOG_DIR } from "@/core/config";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("id");

  if (sessionId) {
    // Get messages for a specific session
    try {
      const messages = await getSessionMessages(sessionId, {
        dir: USERS_LOG_DIR,
      });
      return Response.json({ messages });
    } catch {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }
  }

  // List all sessions
  try {
    const sessions = await listSessions({ dir: USERS_LOG_DIR, limit: 50 });
    // Sort by lastModified descending, filter out tiny/empty sessions
    const filtered = sessions
      .filter((s) => (s.fileSize ?? 0) > 100)
      .sort((a, b) => b.lastModified - a.lastModified);
    return Response.json({ sessions: filtered });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Failed to list sessions";
    return Response.json({ error: msg }, { status: 500 });
  }
}
