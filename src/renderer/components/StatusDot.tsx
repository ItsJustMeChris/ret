import { memo } from "react";
import { useThreads } from "../state/threads";
import { PROVIDERS } from "../agents";

export type ThreadState = "attention" | "running" | "error" | "unread" | "idle";

/** What a thread wants from you right now, most urgent first. */
export function threadStateOf(s: ReturnType<typeof useThreads.getState>, threadId: string): ThreadState {
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
}

export function useThreadState(threadId: string): ThreadState {
  return useThreads((s) => threadStateOf(s, threadId));
}

export const STATE_LABEL: Record<ThreadState, string> = {
  attention: "Needs your input",
  running: "Working",
  error: "Error",
  unread: "New activity",
  idle: "Idle",
};

/** True when the thread's current turn is running in another process of its agent (VS Code, the CLI, a desktop app…). */
export function useRunsElsewhere(threadId: string) {
  return useThreads((s) => !!s.external[threadId]);
}

export const StatusDot = memo(function StatusDot({ threadId }: { threadId: string }) {
  const state = useThreadState(threadId);
  const elsewhere = useRunsElsewhere(threadId);
  const agent = useThreads((s) => PROVIDERS[s.owner[threadId] ?? "codex"].name);
  return (
    <span
      className={`status-dot ${state} ${elsewhere ? "elsewhere" : ""}`}
      title={elsewhere ? `Running in another ${agent} app (VS Code, the CLI…)` : STATE_LABEL[state]}
    />
  );
});
