import { create } from "zustand";
import type {
  ServerRequest,
  Thread,
  ThreadItem,
  ThreadStatus,
  ThreadTokenUsage,
  Turn,
  TurnPlanStep,
} from "../protocol";
import type { TurnError, TurnStatus } from "../protocol/generated/v2";

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
}

export interface LiveThread {
  /** History fetched (read-only view possible). */
  hydrated: boolean;
  hydrating: boolean;
  /** Resumed in the app-server, i.e. we receive live events and can start turns. */
  subscribed: boolean;
  turnOrder: string[];
  turns: Record<string, TurnState>;
  items: Record<string, ThreadItem>;
  olderCursor: string | null;
  loadingOlder: boolean;
  activeTurnId: string | null;
  tokenUsage: ThreadTokenUsage | null;
  settings: ThreadSettings | null;
  /** Transient banner, e.g. "reconnecting… (retrying)". */
  notice: string | null;
  error: string | null;
}

export interface PendingRequest {
  key: string;
  id: number | string;
  method: ServerRequest["method"];
  params: any;
  threadId: string | null;
  receivedAt: number;
}

export interface ThreadsState {
  threads: Record<string, Thread>;
  listLoaded: boolean;
  live: Record<string, LiveThread>;
  requests: Record<string, PendingRequest>;
  unread: Record<string, true>;
  /** Thread ids currently visible in a pane or canvas window. */
  visible: Record<string, number>;
  /** Threads whose latest turn is running in a different Codex process (VS Code, CLI, another app-server). */
  external: Record<string, ExternalRun>;
  /** Follow-ups typed while a turn runs; each is sent as its own turn when the current one ends. */
  queued: Record<string, QueuedMessage[]>;
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
  notice: null,
  error: null,
});

export const useThreads = create<ThreadsState>(() => ({
  threads: {},
  listLoaded: false,
  live: {},
  requests: {},
  unread: {},
  visible: {},
  external: {},
  queued: {},
}));

export const stripTurns = (t: Thread): Thread => (t.turns?.length ? { ...t, turns: [] } : t);

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

function putItem(lt: LiveThread, turnId: string, item: ThreadItem) {
  lt.items = own(lt.items);
  lt.items[item.id] = item;
  const turn = turnOf(lt, turnId);
  if (!turn.itemIds.includes(item.id)) {
    turn.itemIds = own(turn.itemIds);
    turn.itemIds.push(item.id);
  }
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
  lt.items = own(lt.items);
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

/** Applies a single server notification to the draft state. */
function apply(d: Draft, method: string, p: any, hooks: Hooks) {
  switch (method) {
    case "thread/started": {
      const t: Thread = p.thread;
      d.threads = own(d.threads);
      d.threads[t.id] = { ...(d.threads[t.id] ?? {}), ...stripTurns(t) };
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
      lt.notice = null;
      setThread(d, p.threadId, { updatedAt: Math.floor(Date.now() / 1000), recencyAt: Math.floor(Date.now() / 1000) });
      if (!d.visible[p.threadId]) {
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
    case "item/completed":
      putItem(liveOf(d, p.threadId), p.turnId, p.item);
      break;
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
      const key = String(p.requestId);
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
// Frame-batched dispatch: notifications are queued and applied together once
// per animation frame (with a timer fallback for hidden windows), so a burst
// of token deltas across many threads costs one store update and one render.
// ---------------------------------------------------------------------------
let queue: { method: string; params: any }[] = [];
let scheduled = false;
let hooks: Hooks = {};

export function setThreadHooks(h: Hooks) {
  hooks = h;
}

function flush() {
  scheduled = false;
  if (!queue.length) return;
  const batch = queue;
  queue = [];
  fresh = new WeakSet();
  const d: Draft = { ...useThreads.getState() };
  for (const { method, params } of batch) {
    try {
      apply(d, method, params, hooks);
    } catch (err) {
      console.error("reducer failed for", method, err);
    }
  }
  useThreads.setState(d, true);
}

export function enqueueNotification(method: string, params: any) {
  queue.push({ method, params });
  if (scheduled) return;
  scheduled = true;
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    flush();
  };
  requestAnimationFrame(run);
  setTimeout(run, 48);
}

/** Apply synchronously (used before reading state that must reflect queued events). */
export function flushNow() {
  if (scheduled) flush();
}

export function addPendingRequest(req: ServerRequest) {
  const p: any = req.params;
  const threadId: string | null = p?.threadId ?? p?.conversationId ?? null;
  const key = String(req.id);
  useThreads.setState((s) => ({
    requests: { ...s.requests, [key]: { key, id: req.id, method: req.method, params: p, threadId, receivedAt: Date.now() } },
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

export function upsertThreads(list: Thread[]) {
  useThreads.setState((s) => {
    const threads = { ...s.threads };
    for (const t of list) threads[t.id] = { ...(threads[t.id] ?? {}), ...stripTurns(t) };
    return { threads };
  });
}

export function markVisible(threadId: string, delta: 1 | -1) {
  useThreads.setState((s) => {
    const visible = { ...s.visible };
    const n = (visible[threadId] ?? 0) + delta;
    if (n <= 0) delete visible[threadId];
    else visible[threadId] = n;
    if (delta === 1 && s.unread[threadId]) {
      const unread = { ...s.unread };
      delete unread[threadId];
      return { visible, unread };
    }
    return { visible };
  });
}
