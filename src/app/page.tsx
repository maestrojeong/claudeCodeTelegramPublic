"use client";

import { useState, useEffect, useCallback } from "react";

interface LogEntry {
  timestamp: string;
  userId: number;
  sessionId: string | null;
  session: string;
  prompt: string;
  response: string;
}

function formatTime(ts: string) {
  const d = new Date(ts);
  return d.toLocaleString("ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function truncate(s: string, len: number) {
  return s.length > len ? s.slice(0, len) + "..." : s;
}

export default function Dashboard() {
  const [allLogs, setAllLogs] = useState<LogEntry[]>([]);
  const [userIds, setUserIds] = useState<number[]>([]);
  const [sessionMap, setSessionMap] = useState<Record<string, unknown>>({});
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null);
  const [loading, setLoading] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/logs");
      const data = await res.json();
      setAllLogs(data.logs || []);
      setUserIds(data.userIds || []);
      setSessionMap(data.sessionMap || {});
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Derived: sessions for selected user
  const userSessions = selectedUser
    ? [...new Set(allLogs.filter((l) => String(l.userId) === selectedUser).map((l) => l.session).filter(Boolean))]
    : [];

  // Derived: logs for current view
  const filteredLogs = allLogs.filter((l) => {
    if (selectedUser && String(l.userId) !== selectedUser) return false;
    if (selectedSession && l.session !== selectedSession) return false;
    return true;
  });

  // Breadcrumb navigation
  function goToUsers() {
    setSelectedUser(null);
    setSelectedSession(null);
  }
  function goToUser(uid: string) {
    setSelectedUser(uid);
    setSelectedSession(null);
  }


  return (
    <div className="min-h-screen bg-[#0e1621] text-white">
      {/* Header */}
      <header className="bg-[#17212b] border-b border-[#101921] px-6 py-4">
        <div className="flex items-center justify-between max-w-6xl mx-auto">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-[#5288c1] flex items-center justify-center font-bold text-sm">
              CC
            </div>
            <div>
              <h1 className="font-semibold text-lg">Claude Code Dashboard</h1>
              <p className="text-xs text-[#6d7f8f]">Telegram Bot Logs & Sessions</p>
            </div>
          </div>
          <button
            onClick={loadData}
            className="px-3 py-1.5 rounded bg-[#242f3d] hover:bg-[#2b3945] text-sm transition"
          >
            Refresh
          </button>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-4">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-sm mb-4">
          <button
            onClick={goToUsers}
            className={`transition ${!selectedUser ? "text-white font-medium" : "text-[#5288c1] hover:text-[#7ab0e0]"}`}
          >
            Users
          </button>
          {selectedUser && (
            <>
              <span className="text-[#4b5d6b]">/</span>
              <button
                onClick={() => goToUser(selectedUser)}
                className={`transition ${!selectedSession ? "text-white font-medium" : "text-[#5288c1] hover:text-[#7ab0e0]"}`}
              >
                User {selectedUser}
              </button>
            </>
          )}
          {selectedSession && (
            <>
              <span className="text-[#4b5d6b]">/</span>
              <span className="text-white font-medium">
                {selectedSession}
              </span>
            </>
          )}
        </div>

        {loading ? (
          <div className="flex justify-center py-12">
            <div className="w-6 h-6 border-2 border-[#5288c1] border-t-transparent rounded-full animate-spin" />
          </div>
        ) : !selectedUser ? (
          /* === User List === */
          <div className="grid gap-3">
            {userIds.length === 0 ? (
              <p className="text-center text-[#4b5d6b] py-12">No users yet</p>
            ) : (
              userIds.map((uid) => {
                const userLogs = allLogs.filter((l) => l.userId === uid);
                const sessions = [...new Set(userLogs.map((l) => l.session).filter(Boolean))];
                const lastLog = userLogs[0];
                return (
                  <button
                    key={uid}
                    onClick={() => goToUser(String(uid))}
                    className="bg-[#17212b] rounded-lg px-5 py-4 hover:bg-[#1e2c3a] transition text-left"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-[#2b5278] flex items-center justify-center text-sm font-mono">
                          {String(uid).slice(-4)}
                        </div>
                        <div>
                          <div className="text-sm font-medium">User {uid}</div>
                          <div className="text-xs text-[#6d7f8f] mt-0.5">
                            {sessions.length} topics / {userLogs.length} messages
                          </div>
                        </div>
                      </div>
                      <div className="text-xs text-[#4b5d6b] text-right">
                        {lastLog && formatTime(lastLog.timestamp)}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        ) : !selectedSession ? (
          /* === Session List for User === */
          <div className="space-y-3">
            {userSessions.length === 0 ? (
              <p className="text-center text-[#4b5d6b] py-12">No topics for this user</p>
            ) : (
              userSessions.map((session) => {
                const sessionLogs = allLogs.filter(
                  (l) => String(l.userId) === selectedUser && l.session === session
                );
                const lastLog = sessionLogs[0];
                return (
                  <button
                    key={session}
                    onClick={() => setSelectedSession(session)}
                    className="w-full bg-[#17212b] rounded-lg px-5 py-4 hover:bg-[#1e2c3a] transition text-left"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-[#5288c1]">{session}</span>
                        </div>
                        <div className="text-xs text-[#aab4be] mt-1 truncate">
                          {lastLog ? truncate(lastLog.prompt, 80) : ""}
                        </div>
                        <div className="text-xs text-[#4b5d6b] mt-1">
                          {sessionLogs.length} messages
                        </div>
                      </div>
                      <div className="text-xs text-[#4b5d6b] text-right shrink-0">
                        {lastLog && formatTime(lastLog.timestamp)}
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        ) : (
          /* === Log List for Session === */
          <div className="space-y-2">
            {filteredLogs.length === 0 ? (
              <p className="text-center text-[#4b5d6b] py-12">No logs</p>
            ) : (
              filteredLogs.map((log, i) => (
                <button
                  key={i}
                  onClick={() => setSelectedLog(log)}
                  className="w-full bg-[#17212b] rounded-lg px-4 py-3 hover:bg-[#1e2c3a] transition text-left"
                >
                  <div className="flex items-start gap-3">
                    <div className="text-xs text-[#4b5d6b] shrink-0 w-32 pt-0.5">
                      {formatTime(log.timestamp)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-sm truncate">{truncate(log.prompt, 100)}</div>
                      <div className="text-xs text-[#6d7f8f] mt-1 truncate">
                        {truncate(log.response || "(no response)", 120)}
                      </div>
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {/* Log Detail Modal */}
      {selectedLog && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
          onClick={() => setSelectedLog(null)}
        >
          <div
            className="bg-[#17212b] rounded-xl max-w-2xl w-full max-h-[80vh] overflow-y-auto p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex justify-between items-start mb-4">
              <div className="text-xs text-[#6d7f8f]">
                {formatTime(selectedLog.timestamp)} | User {selectedLog.userId} | {selectedLog.session || "-"}
              </div>
              <button
                onClick={() => setSelectedLog(null)}
                className="text-[#6d7f8f] hover:text-white transition p-1"
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <div className="text-xs font-semibold text-[#5288c1] mb-1">Prompt</div>
                <div className="bg-[#0e1621] rounded-lg px-4 py-3 text-sm whitespace-pre-wrap break-words">
                  {selectedLog.prompt}
                </div>
              </div>
              <div>
                <div className="text-xs font-semibold text-[#5288c1] mb-1">Response</div>
                <div className="bg-[#0e1621] rounded-lg px-4 py-3 text-sm whitespace-pre-wrap break-words text-[#aab4be]">
                  {selectedLog.response || "(no text response)"}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
