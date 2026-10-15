import { memo } from "react";
import { useThreads } from "../state/threads";
import { useThread } from "../state/useThread";
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
  // Its turn is over but work it started still runs (a background shell, subagent, monitor), and
  // the agent picks the thread up again when that's done: not idle, not dead.
  if (s.background[threadId]?.length) return "running";
  return "idle";
}

/** Background tasks keeping an otherwise finished thread busy, when that's all that's running. */
export function backgroundOnly(s: ReturnType<typeof useThreads.getState>, threadId: string): number {
  if (s.external[threadId] || s.live[threadId]?.activeTurnId || s.threads[threadId]?.status.type === "active") return 0;
  return s.background[threadId]?.length ?? 0;
}

export function useBackgroundOnly(threadId: string): number {
  return useThread(threadId, (s) => backgroundOnly(s, threadId));
}

export const backgroundLabel = (n: number) => (n === 1 ? "Waiting on background work" : `Waiting on ${n} background tasks`);

export function useThreadState(threadId: string): ThreadState {
  return useThread(threadId, (s) => threadStateOf(s, threadId));
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
  return useThread(threadId, (s) => !!s.external[threadId]);
}

export const StatusDot = memo(function StatusDot({ threadId }: { threadId: string }) {
  const state = useThreadState(threadId);
  const elsewhere = useRunsElsewhere(threadId);
  const background = useBackgroundOnly(threadId);
  const agent = useThread(threadId, (s) => PROVIDERS[s.owner[threadId] ?? "codex"].name);
  const shown = state === "running" && background > 0;
  return (
    <span
      className={`status-dot ${state} ${elsewhere ? "elsewhere" : ""} ${shown ? "background" : ""}`}
      title={elsewhere ? `Running in another ${agent} app (VS Code, the CLI…)` : shown ? backgroundLabel(background) : STATE_LABEL[state]}
    />
  );
});
