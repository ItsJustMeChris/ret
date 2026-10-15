import { create } from "zustand";
import type { ProviderId } from "@shared/bridge";
import type {
  BackgroundTask,
  ServerRequest,
  Thread,
  ThreadItem,
  ThreadStatus,
  ThreadTokenUsage,
  Turn,
  TurnPlanStep,
} from "@shared/protocol";
import type { TurnError, TurnStatus } from "@shared/protocol/generated/v2";
import type { Workspace } from "./projects";

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
  /** Transient banner, e.g. "reconnecting… (retrying)". */
  notice: string | null;
  error: string | null;
}

export interface PendingRequest {
  /** `<provider>:<id>`: request ids are only unique per engine. */
  key: string;
  provider: ProviderId;
  id: number | string;
  method: ServerRequest["method"] | (string & {});
  params: any;
  threadId: string | null;
  receivedAt: number;
}

export interface ThreadsState {
  threads: Record<string, Thread>;
  /** Which provider's engine each thread lives in. */
  owner: Record<string, ProviderId>;
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
  notice: null,
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
  workspaces: [],
}));

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

export function turnStateFrom(turn: Turn, prev?: TurnState): TurnState {
  return {
    id: turn.id,
    status: turn.status,
    itemIds: mergeItemIds(turn, prev),
    error: turn.error,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    durationMs: turn.durationMs,
    diff: prev?.diff ?? null,
    plan: prev?.plan ?? null,
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
  onTurnCompleted?: (threadId: string, turn: Turn) => void;
}

/** The provider a thread belongs to (Codex until known: it was the only one). */
export function ownerOf(threadId: string): ProviderId {
  return useThreads.getState().owner[threadId] ?? "codex";
}

/** Applies a single server notification to the draft state. */
function apply(d: Draft, provider: ProviderId, method: string, p: any, hooks: Hooks) {
  switch (method) {
    case "thread/started": {
      const t: Thread = p.thread;
      d.threads = own(d.threads);
      d.threads[t.id] = mergeThread(d.threads[t.id], t);
      if (d.owner[t.id] !== provider) {
        d.owner = own(d.owner);
        d.owner[t.id] = provider;
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
      lt.notice = null;
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
      lt.notice = null;
      setThread(d, p.threadId, { updatedAt: Math.floor(Date.now() / 1000), recencyAt: Math.floor(Date.now() / 1000) });
      if (!d.attended[p.threadId]) {
        d.unread = own(d.unread);
        d.unread[p.threadId] = true;
      }
      hooks.onTurnCompleted?.(p.threadId, turn);
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
      const key = `${provider}:${p.requestId}`;
      if (!d.requests[key]) break;
      d.requests = own(d.requests);
      delete d.requests[key];
      break;
    }
    case "error": {
      if (!p.threadId) break;
      const lt = liveOf(d, p.threadId);
      if (p.willRetry) lt.notice = `${p.error?.message ?? "Error"} — retrying…`;
      else if (p.turnId) turnOf(lt, p.turnId).error = p.error;
      break;
    }
    case "warning":
      if (p.threadId) liveOf(d, p.threadId).notice = p.message;
      break;
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
let queue: { provider: ProviderId; method: string; params: any }[] = [];
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
  for (const { provider, method, params } of batch) {
    try {
      apply(d, provider, method, params, hooks);
    } catch (err) {
      console.error("reducer failed for", method, err);
    }
  }
  useThreads.setState(d, true);
}

export function enqueueNotification(provider: ProviderId, method: string, params: any) {
  queue.push({ provider, method, params });
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

export function addPendingRequest(provider: ProviderId, req: ServerRequest) {
  const p: any = req.params;
  const threadId: string | null = p?.threadId ?? p?.conversationId ?? null;
  const key = `${provider}:${req.id}`;
  useThreads.setState((s) => ({
    requests: { ...s.requests, [key]: { key, provider, id: req.id, method: req.method, params: p, threadId, receivedAt: Date.now() } },
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

export function upsertThreads(provider: ProviderId, list: Thread[]) {
  useThreads.setState((s) => {
    const threads = { ...s.threads };
    const owner = { ...s.owner };
    for (const t of list) {
      threads[t.id] = mergeThread(threads[t.id], t);
      owner[t.id] = provider;
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
