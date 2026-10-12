import { memo } from "react";
import { useThreads } from "../state/threads";

export type ThreadState = "attention" | "running" | "error" | "unread" | "idle";

export function useThreadState(threadId: string): ThreadState {
  return useThreads((s) => {
    for (const r of Object.values(s.requests)) if (r.threadId === threadId) return "attention";
    const t = s.threads[threadId];
    if (s.external[threadId]) return "running";
    if (s.live[threadId]?.activeTurnId || t?.status.type === "active") {
      const flags = t?.status.type === "active" ? t.status.activeFlags : [];
      return flags.length ? "attention" : "running";
    }
    if (t?.status.type === "systemError") return "error";
    if (s.unread[threadId]) return "unread";
    return "idle";
  });
}

const LABEL: Record<ThreadState, string> = {
  attention: "Needs your input",
  running: "Working",
  error: "Error",
  unread: "New activity",
  idle: "Idle",
};

/** True when the thread's current turn is running in another Codex process (VS Code, CLI…). */
export function useRunsElsewhere(threadId: string) {
  return useThreads((s) => !!s.external[threadId]);
}

export const StatusDot = memo(function StatusDot({ threadId }: { threadId: string }) {
  const state = useThreadState(threadId);
  const elsewhere = useRunsElsewhere(threadId);
  return (
    <span
      className={`status-dot ${state} ${elsewhere ? "elsewhere" : ""}`}
      title={elsewhere ? "Running in another Codex app (VS Code, CLI…)" : LABEL[state]}
    />
  );
});
