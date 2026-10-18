import { create } from "zustand";
import { hostOf, type EngineId } from "@shared/bridge";
import type {
  BackgroundTask,
  ServerRequest,
  Thread,
  ThreadItem,
  ThreadStatus,
  ThreadTokenUsage,
  Turn,
  TurnPlanStep,
  TurnWithPlan,
} from "@shared/protocol";
import type { ThreadGoal, TurnError, TurnStatus } from "@shared/protocol/generated/v2";
import { spawnedBy, type Workspace } from "./projects";

export interface TurnState {
  id: string;
  status: TurnStatus;
  itemIds: string[];
  error: TurnError | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  diff: string | null;
  plan: { explanation: string | null; steps: TurnPlanStep[] } | null;
  /** History says in progress, but it isn't running in this app-server (another client, or cut off). */
  stale?: boolean;
}

export interface ThreadSettings {
  model: string | null;
  /** "default" (standard), "priority" (Fast), "ultrafast", or null when unknown/unsupported. */
  serviceTier: string | null;
  effort: string | null;
  approvalPolicy: unknown;
  sandbox: unknown;
  cwd: string | null;
  /** Collaboration mode: "plan" (think it through, ask questions, propose a plan) or "default". */
  mode?: "plan" | "default" | null;
  /** The provider's own access choice, when it reports one (see agents.ts). */
  access?: string | null;
}

export interface LiveThread {
  /** History fetched (read-only view possible). */
  hydrated: boolean;
  hydrating: boolean;
  /** Resumed in the app-server, i.e. we receive live events and can start turns. */
  subscribed: boolean;
  turnOrder: string[];
  turns: Record<string, TurnState>;
  /** Updated in place as items arrive (see putItem): look at its entries, never at the map's identity. */
  items: Record<string, ThreadItem>;
  olderCursor: string | null;
  loadingOlder: boolean;
  activeTurnId: string | null;
  tokenUsage: ThreadTokenUsage | null;
  settings: ThreadSettings | null;
  /** When each sleep (the agent's `clock.sleep`) seen here started and ended, in ms: its item carries neither. */
  sleeps: Record<string, { startedAt: number | null; endedAt: number | null }>;
  /** What happened along the way (a retry, a warning, a failed send), oldest first: each drawn where it happened. */
  notices: ThreadNotice[];
  /** Why the thread's history couldn't be loaded (it's not hydrated); anything else is a notice. */
  error: string | null;
}

/**
 * Something that happened to a thread that isn't one of its items: the engine retrying, a warning,
 * a message that couldn't be sent. It goes in the transcript where it happened and scrolls up with
 * the rest, never pinned below it.
 */
export interface ThreadNotice {
  id: string;
  /** "warn": something it got past or worked around; "error": something that failed. */
  tone: "warn" | "error";
  text: string;
  /** The turn it happened in, or (with `at` null) the last one before it; null: before any turn. */
  turnId: string | null;
  /** How many of the turn's items had come when it happened: it's drawn after them. Null: after the turn. */
  at: number | null;
  /** Notices of one kind in one place replace each other (a retry's attempts), not stack up. */
  key?: string;
}

export interface PendingRequest {
  /** `<engine>:<id>`: request ids are only unique per engine. */
  key: string;
  engine: EngineId;
  id: number | string;
  method: ServerRequest["method"] | (string & {});
  params: any;
  threadId: string | null;
  receivedAt: number;
}

export interface ThreadsState {
  threads: Record<string, Thread>;
  /** Which engine each thread lives in (an agent here, or on a paired device). */
  owner: Record<string, EngineId>;
  listLoaded: boolean;
  live: Record<string, LiveThread>;
  requests: Record<string, PendingRequest>;
  /** Threads that finished (or changed) while nobody was attending to them; cleared by attending. */
  unread: Record<string, true>;
  /** Thread ids currently mounted in a pane or canvas window (keeps them subscribed and fresh). */
  visible: Record<string, number>;
  /**
   * Thread ids the user is actually looking at: the open focus-mode pane(s), or the clicked
   * canvas window. A canvas full of windows is all "visible", but only these count as seen.
   */
  attended: Record<string, number>;
  /** Threads whose latest turn is running in a different Codex process (VS Code, CLI, another app-server). */
  external: Record<string, ExternalRun>;
  /** Work a thread left running after its turn (Claude Code's background shells, subagents, monitors), here or in another app. */
  background: Record<string, BackgroundTask[]>;
  /** Follow-ups typed while a turn runs; each is sent as its own turn when the current one ends. */
  queued: Record<string, QueuedMessage[]>;
  /** The objective a thread keeps working toward across turns (Codex's `/goal`), while it has one. */
  goals: Record<string, ThreadGoal>;
  /** Each thread's subagents, oldest first: worked out from `threads` (see indexAgents), for views that list them per thread. */
  agents: Record<string, string[]>;
  /** Named workspaces the engines keep (see agents.ts), which the sidebar groups threads by. */
  workspaces: Workspace[];
}

export interface QueuedMessage {
  id: string;
  text: string;
  attachments: import("./actions").Attachment[];
  prefs: import("./actions").TurnOverrides;
}

export interface ExternalRun {
  turnId: string;
  /** Thread updatedAt (seconds) when we last saw it change. */
  lastActivity: number;
}

export const emptyLive = (): LiveThread => ({
  hydrated: false,
  hydrating: false,
  subscribed: false,
  turnOrder: [],
  turns: {},
  items: {},
  olderCursor: null,
  loadingOlder: false,
  activeTurnId: null,
  tokenUsage: null,
  settings: null,
  sleeps: {},
  notices: [],
  error: null,
});

export const useThreads = create<ThreadsState>(() => ({
  threads: {},
  owner: {},
  listLoaded: false,
  live: {},
  requests: {},
  unread: {},
  visible: {},
  attended: {},
  external: {},
  background: {},
  queued: {},
  goals: {},
  agents: {},
  workspaces: [],
}));

export const NO_AGENTS: readonly string[] = [];

// The agents index follows `threads`, which changes on thread events, not on streamed text.
useThreads.subscribe((s, prev) => {
  if (s.threads === prev.threads) return;
  const agents = indexAgents(s.threads, s.agents);
  if (agents !== s.agents) useThreads.setState({ agents });
});

/** Subagents by the thread that spawned them. A parent whose list didn't change keeps its array, so only views of a parent that gained or lost one re-render. */
function indexAgents(threads: Record<string, Thread>, prev: Record<string, string[]>): Record<string, string[]> {
  const by = new Map<string, Thread[]>();
  for (const t of Object.values(threads)) {
    const parent = spawnedBy(t);
    if (!parent) continue;
    const list = by.get(parent);
    if (list) list.push(t);
    else by.set(parent, [t]);
  }
  let changed = Object.keys(prev).length !== by.size;
  const next: Record<string, string[]> = {};
  for (const [parent, list] of by) {
    const ids = list.sort((a, b) => a.createdAt - b.createdAt).map((t) => t.id);
    const old = prev[parent];
    if (old && old.length === ids.length && old.every((id, i) => id === ids[i])) next[parent] = old;
    else {
      next[parent] = ids;
      changed = true;
    }
  }
  return changed ? next : prev;
}

export const stripTurns = (t: Thread): Thread => (t.turns?.length ? { ...t, turns: [] } : t);

/**
 * Merge a server copy of a thread into the one we have. `thread/list` never reports fork
 * lineage (only fork/read/resume/started do), so a copy without it must not erase what we
 * already know, or forks fall out of their folders and lose their canvas links.
 */
export function mergeThread(prev: Thread | undefined, next: Thread): Thread {
  const t = stripTurns(next);
  if (!prev) return t;
  return {
    ...prev,
    ...t,
    forkedFromId: t.forkedFromId ?? prev.forkedFromId ?? null,
    parentThreadId: t.parentThreadId ?? prev.parentThreadId ?? null,
  };
}

/**
 * Item order for a turn. Only a "full" item list is authoritative; `turn/completed` (and
 * other notifications) carry a *summary* — often just the final message — which must be
 * merged into what we've already shown, never replace it.
 */
function mergeItemIds(turn: Turn, prev?: TurnState): string[] {
  const ids = turn.items?.map((i) => i.id) ?? [];
  if (!ids.length) return prev?.itemIds ?? [];
  if (!prev?.itemIds.length || turn.itemsView === "full") return ids;
  const known = new Set(prev.itemIds);
  const added = ids.filter((id) => !known.has(id));
  return added.length ? [...prev.itemIds, ...added] : prev.itemIds;
}

/**
 * A turn's checklist as history reports it (only Ret's Claude engine does), or the one already
 * held. Unchanged steps keep the object they had, so views showing the plan don't re-render.
 */
function planFrom(steps: TurnPlanStep[] | null | undefined, prev: TurnState["plan"] | undefined): TurnState["plan"] {
  if (!steps) return prev ?? null;
  const same = prev && prev.steps.length === steps.length && prev.steps.every((s, i) => s.step === steps[i].step && s.status === steps[i].status);
  return same ? prev : { explanation: prev?.explanation ?? null, steps };
}

export function turnStateFrom(turn: TurnWithPlan, prev?: TurnState): TurnState {
  return {
    id: turn.id,
    status: turn.status,
    itemIds: mergeItemIds(turn, prev),
    error: turn.error,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
    diff: prev?.diff ?? null,
    plan: planFrom(turn.plan, prev?.plan),
  };
}

// ---------------------------------------------------------------------------
// Copy-on-write helpers. Each flush gets a fresh WeakSet so an object is copied
// at most once per frame no matter how many events touch it.
// ---------------------------------------------------------------------------
let fresh = new WeakSet<object>();
function own<T extends object>(o: T): T {
  if (fresh.has(o)) return o;
  const c = (Array.isArray(o) ? o.slice() : { ...o }) as T;
  fresh.add(c);
  return c;
}

type Draft = ThreadsState;

function liveOf(d: Draft, threadId: string): LiveThread {
  d.live = own(d.live);
  const lt = (d.live[threadId] = own(d.live[threadId] ?? emptyLive()));
  return lt;
}

function turnOf(lt: LiveThread, turnId: string): TurnState {
  lt.turns = own(lt.turns);
  let t = lt.turns[turnId];
  if (!t) {
    t = {
      id: turnId,
      status: "inProgress",
      itemIds: [],
      error: null,
      startedAt: Date.now() / 1000,
      completedAt: null,
      durationMs: null,
      diff: null,
      plan: null,
    };
    lt.turnOrder = own(lt.turnOrder);
    if (!lt.turnOrder.includes(turnId)) lt.turnOrder.push(turnId);
  }
  return (lt.turns[turnId] = own(t));
}

/**
 * A thread's items map is the one structure here updated in place, not copied: copying it for every
 * flush of a streaming reply costs over a millisecond each time for a thread with a few thousand
 * items. Its entries are still replaced, never changed, and the thread's LiveThread is new whenever
 * one is, so nothing can (or may) tell from the map's identity whether something changed.
 */
function putItem(lt: LiveThread, turnId: string, item: ThreadItem) {
  lt.items[item.id] = item;
  const turn = turnOf(lt, turnId);
  if (!turn.itemIds.includes(item.id)) {
    turn.itemIds = own(turn.itemIds);
    turn.itemIds.push(item.id);
  }
}

/** A sleep's item says how long it may last, not whether it's over, so note when it starts and ends. */
function markSleep(lt: LiveThread, id: string, started: boolean) {
  lt.sleeps = own(lt.sleeps);
  lt.sleeps[id] = started ? { startedAt: Date.now(), endedAt: null } : { startedAt: lt.sleeps[id]?.startedAt ?? null, endedAt: Date.now() };
}

/** The turn is over, so any sleep still open ended with it (interrupted, or its end never arrived). */
function endSleeps(lt: LiveThread) {
  const open = Object.keys(lt.sleeps).filter((id) => lt.sleeps[id].endedAt == null);
  if (!open.length) return;
  lt.sleeps = own(lt.sleeps);
  for (const id of open) lt.sleeps[id] = { ...lt.sleeps[id], endedAt: Date.now() };
}

const MAX_NOTICES = 50;
let noticeSeq = 0;

/**
 * The thread's notices with one more, placed where things are now: after the latest item of
 * `turnId` (or of the running turn), else after the last turn. One like the last in the same place
 * (the same `key`, or the same words) takes its place, so a retry counting up stays one row.
 */
function withNotice(lt: LiveThread, tone: ThreadNotice["tone"], text: string, turnId?: string | null, key?: string): ThreadNotice[] {
  const turn = (turnId && lt.turns[turnId]) || (lt.activeTurnId ? lt.turns[lt.activeTurnId] : undefined);
  // A message still on its way has a turn of its own only until the real one starts.
  let i = lt.turnOrder.length - 1;
  while (i >= 0 && lt.turnOrder[i].startsWith("pending:")) i--;
  const place = turn ? { turnId: turn.id, at: turn.itemIds.length } : { turnId: lt.turnOrder[i] ?? null, at: null };
  const prev = lt.notices[lt.notices.length - 1];
  const same = !!prev && prev.turnId === place.turnId && prev.at === place.at && (key ? prev.key === key : !prev.key && prev.text === text && prev.tone === tone);
  const notice: ThreadNotice = { id: same ? prev.id : `notice:${++noticeSeq}`, tone, text, ...place, ...(key ? { key } : {}) };
  return same ? [...lt.notices.slice(0, -1), notice] : [...lt.notices, notice].slice(-MAX_NOTICES);
}

/** Note something that happened to a thread (a send or an interrupt that failed) in its transcript, where it happened. */
export function addNotice(threadId: string, tone: ThreadNotice["tone"], text: string) {
  patchLive(threadId, (lt) => ({ notices: withNotice(lt, tone, text) }));
}

export const NO_NOTICES: readonly ThreadNotice[] = [];

/** A thread's notices placed in or after `turnId` (null: those before any turn). */
export function noticesAt(lt: LiveThread | undefined, turnId: string | null): readonly ThreadNotice[] {
  if (!lt?.notices.length) return NO_NOTICES;
  const list = lt.notices.filter((n) => n.turnId === turnId);
  return list.length ? list : NO_NOTICES;
}

function mutItem<T extends ThreadItem["type"]>(
  lt: LiveThread,
  turnId: string,
  itemId: string,
  type: T,
  init: () => Extract<ThreadItem, { type: T }>,
): Extract<ThreadItem, { type: T }> {
  let item = lt.items[itemId] as Extract<ThreadItem, { type: T }> | undefined;
  if (!item || item.type !== type) {
    putItem(lt, turnId, init());
    item = lt.items[itemId] as Extract<ThreadItem, { type: T }>;
  }
  const copy = own(item);
  lt.items[itemId] = copy;
  return copy;
}

function setThread(d: Draft, id: string, patch: Partial<Thread>) {
  const t = d.threads[id];
  if (!t) return;
  d.threads = own(d.threads);
  d.threads[id] = { ...t, ...patch };
}

export interface Hooks {
  /** `waiting`: it ended with the thread's agents still at work (see agentsWorking). */
  onTurnCompleted?: (threadId: string, turn: Turn, waiting: boolean) => void;
}

/**
 * A subagent's turn: work done for the turn that spawned it, which reports back. Not something to
 * review on its own. A thread not known yet is taken for one when its turn works for another turn;
 * a known thread only by its source, since a parent woken by an agent it started gets such a turn
 * too, and that turn is its report.
 */
export function delegated(thread: Thread | undefined, turn: Turn): boolean {
  if (thread) return !!spawnedBy(thread);
  return !!turn.rootTurnId && turn.rootTurnId !== turn.id;
}

/** Background work that's agents doing part of the thread's job (not shells or monitors: a dev server can run all day). */
const AGENT_WORK = new Set<BackgroundTask["kind"]>(["agent", "workflow"]);

type Activity = Pick<ThreadsState, "threads" | "live" | "external" | "background" | "agents">;

/** A turn of the thread's own is running, here or in another app. */
export const turnRunning = (s: Activity, threadId: string): boolean =>
  !!s.live[threadId]?.activeTurnId || !!s.external[threadId] || s.threads[threadId]?.status.type === "active";

/**
 * Agents the thread started are still at it: Codex's spawned agents (and theirs), or Claude Code's
 * background agents. Its job isn't done till they are, so it's still working, with nothing to
 * report yet: their reports wake it for another turn, and that one's the news.
 */
export function agentsWorking(s: Activity, threadId: string, depth = 0): boolean {
  if (s.background[threadId]?.some((t) => AGENT_WORK.has(t.kind))) return true;
  if (depth > 8) return false;
  return (s.agents[threadId] ?? NO_AGENTS).some((id) => turnRunning(s, id) || agentsWorking(s, id, depth + 1));
}

/** The engine a thread belongs to (this computer's Codex until known: it was the only one). */
export function ownerOf(threadId: string): EngineId {
  return useThreads.getState().owner[threadId] ?? "codex";
}

/** The paired device a thread runs on; null for this computer. */
export function hostOfThread(threadId: string): string | null {
  return hostOf(ownerOf(threadId));
}

/** Applies a single server notification to the draft state. */
function apply(d: Draft, engine: EngineId, method: string, p: any, hooks: Hooks) {
  switch (method) {
    case "thread/started": {
      const t: Thread = p.thread;
      d.threads = own(d.threads);
      d.threads[t.id] = mergeThread(d.threads[t.id], t);
      if (d.owner[t.id] !== engine) {
        d.owner = own(d.owner);
        d.owner[t.id] = engine;
      }
      break;
    }
    case "thread/status/changed": {
      setThread(d, p.threadId, { status: p.status as ThreadStatus });
      if ((p.status as ThreadStatus).type === "notLoaded" && d.live[p.threadId]) {
        liveOf(d, p.threadId).subscribed = false;
      }
      break;
    }
    case "thread/name/updated":
      setThread(d, p.threadId, { name: p.threadName ?? null });
      break;
    case "thread/backgroundTasks/updated": {
      // Ret's own (Claude Code engine): the thread's whole list, replacing the last one.
      if (!p.tasks?.length && !d.background[p.threadId]) break;
      d.background = own(d.background);
      if (p.tasks?.length) d.background[p.threadId] = p.tasks;
      else delete d.background[p.threadId];
      break;
    }
    case "thread/goal/updated":
      goalNews.set(p.threadId, (goalNews.get(p.threadId) ?? 0) + 1);
      d.goals = own(d.goals);
      d.goals[p.threadId] = p.goal;
      break;
    case "thread/goal/cleared": {
      goalNews.set(p.threadId, (goalNews.get(p.threadId) ?? 0) + 1);
      if (!d.goals[p.threadId]) break;
      d.goals = own(d.goals);
      delete d.goals[p.threadId];
      break;
    }
    case "thread/project/updated":
      setThread(d, p.threadId, { projectId: p.projectId ?? null });
      break;
    case "thread/archived":
    case "thread/deleted": {
      if (!d.threads[p.threadId]) break;
      d.threads = own(d.threads);
      delete d.threads[p.threadId];
      break;
    }
    case "thread/closed": {
      if (d.live[p.threadId]) liveOf(d, p.threadId).subscribed = false;
      break;
    }
    case "thread/tokenUsage/updated":
      liveOf(d, p.threadId).tokenUsage = p.tokenUsage;
      break;
    case "thread/settings/updated": {
      const lt = liveOf(d, p.threadId);
      const ts = p.threadSettings;
      if (ts) {
        lt.settings = {
          model: ts.model ?? null,
          effort: ts.effort ?? null,
          serviceTier: ts.serviceTier ?? null,
          approvalPolicy: ts.approvalPolicy,
          sandbox: ts.sandboxPolicy,
          cwd: ts.cwd ?? null,
          mode: ts.collaborationMode?.mode ?? null,
          access: typeof ts.access === "string" ? ts.access : null,
        };
      }
      break;
    }
    case "turn/started": {
      const lt = liveOf(d, p.threadId);
      const turn: Turn = p.turn;
      lt.turns = own(lt.turns);
      lt.turns[turn.id] = turnStateFrom(turn, lt.turns[turn.id]);
      if (!lt.turnOrder.includes(turn.id)) {
        lt.turnOrder = own(lt.turnOrder);
        lt.turnOrder.push(turn.id);
      }
      lt.activeTurnId = turn.id;
      setThread(d, p.threadId, { status: { type: "active", activeFlags: [] } });
      break;
    }
    case "turn/completed": {
      const lt = liveOf(d, p.threadId);
      const turn: Turn = p.turn;
      for (const item of turn.items ?? []) putItem(lt, turn.id, item);
      lt.turns = own(lt.turns);
      lt.turns[turn.id] = turnStateFrom(turn, lt.turns[turn.id]);
      if (!lt.turnOrder.includes(turn.id)) {
        lt.turnOrder = own(lt.turnOrder);
        lt.turnOrder.push(turn.id);
      }
      if (lt.activeTurnId === turn.id) lt.activeTurnId = null;
      endSleeps(lt);
      setThread(d, p.threadId, { updatedAt: Math.floor(Date.now() / 1000), recencyAt: Math.floor(Date.now() / 1000) });
      // A turn that ends with its agents still out isn't news yet (finished.ts marks it once they're done).
      const waiting = turn.status !== "failed" && agentsWorking(d, p.threadId);
      if (!d.attended[p.threadId] && !delegated(d.threads[p.threadId], turn) && !waiting) {
        d.unread = own(d.unread);
        d.unread[p.threadId] = true;
      }
      hooks.onTurnCompleted?.(p.threadId, turn, waiting);
      break;
    }
    case "turn/diff/updated":
      turnOf(liveOf(d, p.threadId), p.turnId).diff = p.diff;
      break;
    case "turn/plan/updated":
      turnOf(liveOf(d, p.threadId), p.turnId).plan = { explanation: p.explanation, steps: p.plan };
      break;
    case "item/started":
    case "item/completed": {
      const lt = liveOf(d, p.threadId);
      putItem(lt, p.turnId, p.item);
      if (p.item?.type === "sleep") markSleep(lt, p.item.id, method === "item/started");
      break;
    }
    case "item/agentMessage/delta": {
      const it = mutItem(liveOf(d, p.threadId), p.turnId, p.itemId, "agentMessage", () => ({
        type: "agentMessage",
        id: p.itemId,
        text: "",
        phase: null,
        memoryCitation: null,
        delivery: null,
        questions: null,
      }));
      it.text += p.delta;
      break;
    }
    case "item/plan/delta": {
      const it = mutItem(liveOf(d, p.threadId), p.turnId, p.itemId, "plan", () => ({ type: "plan", id: p.itemId, text: "" }));
      it.text += p.delta;
      break;
    }
    case "item/reasoning/summaryPartAdded":
    case "item/reasoning/summaryTextDelta":
    case "item/reasoning/textDelta": {
      const it = mutItem(liveOf(d, p.threadId), p.turnId, p.itemId, "reasoning", () => ({
        type: "reasoning",
        id: p.itemId,
        summary: [],
        content: [],
      }));
      const key = method === "item/reasoning/textDelta" ? "content" : "summary";
      const idx = (key === "content" ? p.contentIndex : p.summaryIndex) ?? 0;
      const arr = (it[key] = it[key].slice());
      while (arr.length <= idx) arr.push("");
      if (p.delta) arr[idx] += p.delta;
      break;
    }
    case "item/commandExecution/outputDelta": {
      const lt = liveOf(d, p.threadId);
      const existing = lt.items[p.itemId];
      if (!existing || existing.type !== "commandExecution") break;
      const it = mutItem(lt, p.turnId, p.itemId, "commandExecution", () => existing);
      const out = (it.aggregatedOutput ?? "") + p.delta;
      // Cap live output; the completed item carries the authoritative copy.
      it.aggregatedOutput = out.length > 200_000 ? out.slice(-200_000) : out;
      break;
    }
    case "serverRequest/resolved": {
      const key = `${engine}:${p.requestId}`;
      if (!d.requests[key]) break;
      d.requests = own(d.requests);
      delete d.requests[key];
      break;
    }
    case "error": {
      if (!p.threadId) break;
      const lt = liveOf(d, p.threadId);
      if (p.willRetry) lt.notices = withNotice(lt, "warn", `${p.error?.message ?? "Error"} — retrying…`, p.turnId, "retry");
      else if (p.turnId) turnOf(lt, p.turnId).error = p.error;
      else if (p.error?.message) lt.notices = withNotice(lt, "error", p.error.message);
      break;
    }
    case "warning": {
      // An empty one only ended a status an older Ret's Claude engine showed this way (compacting).
      if (!p.threadId || !p.message) break;
      const lt = liveOf(d, p.threadId);
      lt.notices = withNotice(lt, "warn", p.message);
      break;
    }
    case "thread/reverted": {
      // History was rewritten server-side; force a re-hydrate on next view.
      if (d.live[p.threadId]) {
        d.live = own(d.live);
        d.live[p.threadId] = { ...emptyLive(), subscribed: d.live[p.threadId].subscribed };
      }
      break;
    }
  }
}


// ---------------------------------------------------------------------------
// Frame-batched dispatch: notifications are queued and applied together on an
// animation frame (with a timer fallback for hidden windows), so a burst of
// token deltas across many threads costs one store update and one render. At
// most ~30 a second: text streams just as smoothly, and a fast display doesn't
// spend every one of its frames rendering it.
// ---------------------------------------------------------------------------
const FLUSH_EVERY = 32;
let queue: { engine: EngineId; method: string; params: any }[] = [];
let scheduled = false;
let lastFlush = 0;
let hooks: Hooks = {};

export function setThreadHooks(h: Hooks) {
  hooks = h;
}

function flush() {
  scheduled = false;
  lastFlush = performance.now();
  if (!queue.length) return;
  const batch = queue;
  queue = [];
  fresh = new WeakSet();
  const d: Draft = { ...useThreads.getState() };
  for (const { engine, method, params } of batch) {
    try {
      apply(d, engine, method, params, hooks);
    } catch (err) {
      console.error("reducer failed for", method, err);
    }
  }
  useThreads.setState(d, true);
}

export function enqueueNotification(engine: EngineId, method: string, params: any) {
  queue.push({ engine, method, params });
  if (scheduled) return;
  scheduled = true;
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    flush();
  };
  const onFrame = () => {
    if (done) return;
    if (performance.now() - lastFlush < FLUSH_EVERY) requestAnimationFrame(onFrame);
    else run();
  };
  requestAnimationFrame(onFrame);
  setTimeout(run, 48);
}

/** Apply synchronously (used before reading state that must reflect queued events). */
export function flushNow() {
  if (scheduled) flush();
}

export function addPendingRequest(engine: EngineId, req: ServerRequest) {
  const p: any = req.params;
  const threadId: string | null = p?.threadId ?? p?.conversationId ?? null;
  const key = `${engine}:${req.id}`;
  useThreads.setState((s) => ({
    requests: { ...s.requests, [key]: { key, engine, id: req.id, method: req.method, params: p, threadId, receivedAt: Date.now() } },
  }));
}

export function removePendingRequest(key: string) {
  useThreads.setState((s) => {
    if (!s.requests[key]) return s;
    const requests = { ...s.requests };
    delete requests[key];
    return { requests };
  });
}

export function patchLive(threadId: string, patch: Partial<LiveThread> | ((lt: LiveThread) => Partial<LiveThread>)) {
  flushNow();
  useThreads.setState((s) => {
    const prev = s.live[threadId] ?? emptyLive();
    const next = { ...prev, ...(typeof patch === "function" ? patch(prev) : patch) };
    return { live: { ...s.live, [threadId]: next } };
  });
}

/** How many goal events each thread has had: a fetch answered after one of them is out of date. */
const goalNews = new Map<string, number>();

/** Where a thread's goal events are at (taken before asking for the goal; see setGoal). */
export function goalMark(threadId: string): number {
  flushNow();
  return goalNews.get(threadId) ?? 0;
}

/**
 * Record a thread's goal as fetched (null: it has none). With `mark` (goalMark when it was asked
 * for), the answer is dropped if a goal event came in since: that event is newer.
 */
export function setGoal(threadId: string, goal: ThreadGoal | null, mark?: number) {
  const cur = useThreads.getState().goals[threadId];
  if (!goal && !cur) return;
  if (goal && cur && sameGoal(goal, cur)) return;
  if (mark !== undefined && goalMark(threadId) !== mark) return;
  useThreads.setState((s) => {
    const goals = { ...s.goals };
    if (goal) goals[threadId] = goal;
    else delete goals[threadId];
    return { goals };
  });
}

const sameGoal = (a: ThreadGoal, b: ThreadGoal) =>
  a.updatedAt === b.updatedAt && a.status === b.status && a.objective === b.objective && a.tokensUsed === b.tokensUsed && a.timeUsedSeconds === b.timeUsedSeconds;

export function upsertThreads(engine: EngineId, list: Thread[]) {
  useThreads.setState((s) => {
    const threads = { ...s.threads };
    const owner = { ...s.owner };
    for (const t of list) {
      threads[t.id] = mergeThread(threads[t.id], t);
      owner[t.id] = engine;
    }
    return { threads, owner };
  });
}

const bump = (counts: Record<string, number>, id: string, delta: 1 | -1) => {
  const next = { ...counts };
  const n = (next[id] ?? 0) + delta;
  if (n <= 0) delete next[id];
  else next[id] = n;
  return next;
};

export function markVisible(threadId: string, delta: 1 | -1) {
  useThreads.setState((s) => ({ visible: bump(s.visible, threadId, delta) }));
}

/** The user started (+1) or stopped (-1) looking at a thread; looking at it marks it seen. */
export function markAttended(threadId: string, delta: 1 | -1) {
  useThreads.setState((s) => {
    const attended = bump(s.attended, threadId, delta);
    if (delta === 1 && s.unread[threadId]) {
      const unread = { ...s.unread };
      delete unread[threadId];
      return { attended, unread };
    }
    return { attended };
  });
}

/** Clear a thread's "new activity" mark. */
export function markSeen(threadId: string) {
  useThreads.setState((s) => {
    if (!s.unread[threadId]) return s;
    const unread = { ...s.unread };
    delete unread[threadId];
    return { unread };
  });
}
