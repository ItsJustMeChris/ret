import type { FileUpdateChange, Model, Thread, ThreadTokenUsage } from "@shared/protocol";
import type { LiveThread, TurnState } from "../state/threads";
import { spawnedBy } from "../state/projects";
import { changeStats, compactNumber } from "./format";

/**
 * A thread's details, worked out once for the desktop's details panel (components/thread/Details)
 * and the phone's details sheet (apps/mobile thread/Details): what each section shows and says.
 */

/** The details' words, the same on both. */
export const DETAILS = {
  show: "Show details",
  hide: "Hide details",
  plan: "Plan",
  changes: "Changes",
  changesHint: "What the latest turn that edited files changed",
  subagents: "Subagents",
  context: "Context",
  contextHint: "How much of the model's context window the thread fills",
  inContext: "In context",
  allTurns: "Tokens, all turns",
  cached: "Cached input",
  reasoning: "Reasoning",
  thread: "Thread",
  agent: "Agent",
  model: "Model",
  started: "Started",
  branch: "Branch",
  folder: "Folder",
  spawnedBy: "Spawned by",
  forkedFrom: "Forked from",
  unavailable: "an unavailable thread",
  forks: "Forks",
} as const;

/** The newest turn's `pick`, going back through the thread's turns until one has it. */
function latest<T>(lt: LiveThread | undefined, pick: (t: TurnState) => T | null): T | null {
  if (!lt) return null;
  for (let i = lt.turnOrder.length - 1; i >= 0; i--) {
    const v = pick(lt.turns[lt.turnOrder[i]]);
    if (v != null) return v;
  }
  return null;
}

/** The thread's latest plan (one with steps). */
export const latestPlan = (lt: LiveThread | undefined) => latest(lt, (t) => (t.plan?.steps.length ? t.plan : null));

/** The diff of the latest turn that edited files. */
export const latestDiff = (lt: LiveThread | undefined) => latest(lt, (t) => t.diff || null);

/** "2 of 3": the plan's steps done. */
export function planProgress(plan: NonNullable<TurnState["plan"]>): string {
  return `${plan.steps.filter((s) => s.status === "completed").length} of ${plan.steps.length}`;
}

/** A turn's diff (`git diff` output) as the per-file changes the transcript shows, each opening on its own. */
export function fileChanges(diff: string): FileUpdateChange[] {
  const out: FileUpdateChange[] = [];
  for (const chunk of diff.split(/^(?=diff --git )/m)) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    if (!m) continue;
    const at = chunk.search(/^@@/m);
    const hunks = at < 0 ? "" : chunk.slice(at);
    // A new or deleted file is shown whole, as the transcript shows one.
    if (/^new file mode/m.test(chunk)) out.push({ path: m[2], kind: { type: "add" }, diff: whole(hunks, "+") });
    else if (/^deleted file mode/m.test(chunk)) out.push({ path: m[1], kind: { type: "delete" }, diff: whole(hunks, "-") });
    else out.push({ path: m[2], kind: { type: "update", move_path: m[1] === m[2] ? null : m[1] }, diff: hunks });
  }
  return out;
}

const whole = (hunks: string, sign: "+" | "-") =>
  hunks
    .split("\n")
    .filter((l) => l.startsWith(sign))
    .map((l) => l.slice(1))
    .join("\n");

/** Lines added and removed across the changes. */
export function changeTotals(changes: FileUpdateChange[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const c of changes) {
    const st = changeStats(c);
    add += st.add;
    del += st.del;
  }
  return { add, del };
}

/** How full the context window is, when the model says how big it is: tokens in it, its size, and the share (0–100). */
export function contextUse(usage: ThreadTokenUsage): { used: number; size: number; pct: number } | null {
  const size = usage.modelContextWindow;
  if (!size) return null;
  const used = usage.last.inputTokens;
  return { used, size, pct: Math.min(100, Math.round((used / size) * 100)) };
}

/**
 * "Opus 5.5 · high": the model a thread runs (as its settings say once it's open, else as its
 * record does), by the name its agent's model list gives it, and its reasoning effort.
 */
export function modelLabel(model: string | null, effort: string | null, models: readonly Model[] | undefined): string {
  const info = model ? models?.find((m) => m.id === model || m.model === model) : undefined;
  return `${info?.displayName || model || "—"}${effort ? ` · ${effort}` : ""}`;
}

/** The thread's token totals, as rows; reasoning only from an agent that counts it apart (Claude doesn't). */
export function usageRows(usage: ThreadTokenUsage): { label: string; value: string }[] {
  return [
    { label: DETAILS.allTurns, value: compactNumber(usage.total.totalTokens) },
    { label: DETAILS.cached, value: compactNumber(usage.total.cachedInputTokens) },
    ...(usage.total.reasoningOutputTokens ? [{ label: DETAILS.reasoning, value: compactNumber(usage.total.reasoningOutputTokens) }] : []),
  ];
}

/** When the thread started, as a date and a time. */
export function startedLabel(thread: Thread): string {
  return new Date(thread.createdAt * 1000).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** The thread it came from: the agent that spawned it, else the thread it was forked from. */
export function originOf(thread: Thread | undefined): { id: string; label: string } | null {
  const spawner = spawnedBy(thread);
  if (spawner) return { id: spawner, label: DETAILS.spawnedBy };
  return thread?.forkedFromId ? { id: thread.forkedFromId, label: DETAILS.forkedFrom } : null;
}

/** The thread's forks, oldest first. (A subagent starts from its parent's history too; it isn't a fork.) */
export function forksOf(threads: Record<string, Thread>, threadId: string): Thread[] {
  return Object.values(threads)
    .filter((t) => t.forkedFromId === threadId && !spawnedBy(t))
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** A fork's name, or "Fork 2" while it has its parent's. */
export function forkLabel(fork: Thread, index: number, parentName: string | null | undefined): string {
  return fork.name && fork.name !== parentName ? fork.name : `Fork ${index + 1}`;
}
