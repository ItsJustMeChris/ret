import { bridge } from "../bridge";
import { rpc } from "../rpc/client";
import type { SandboxMode, SandboxPolicy, ServerRequest, Thread, ThreadItem, UserInput } from "../protocol";
import type { AskForApproval } from "../protocol/generated/v2";
import { useConn } from "./conn";
import { guarded } from "./toasts";
import { coveredLeft } from "../components/canvas/viewport";
import { explicitKeys, normPath, projectKeyFor, threadTitle } from "./projects";
import {
  addPendingRequest,
  emptyLive,
  enqueueNotification,
  flushNow,
  patchLive,
  removePendingRequest,
  setThreadHooks,
  turnStateFrom,
  upsertThreads,
  useThreads,
  type LiveThread,
  type ThreadSettings,
} from "./threads";
import { activeBoard, isDraft, newId, updateBoard, useUI, type AccessPreset, type CanvasWin, type FocusSplit, type UIState } from "./ui";

// ---------------------------------------------------------------------------
// Boot: wire the transport into the stores.
// ---------------------------------------------------------------------------

const SERVER_REQUESTS_WE_REFUSE = new Set(["item/tool/call", "account/chatgptAuthTokens/refresh", "attestation/generate"]);

let booted = false;
export function bootstrap() {
  if (booted) return;
  booted = true;

  bridge.codex.onStatus((codex) => useConn.setState({ codex }));
  void bridge.codex.getStatus().then((codex) => useConn.setState({ codex }));
  bridge.updater.onState((updater) => useConn.setState({ updater }));
  void bridge.updater.getState().then((updater) => useConn.setState({ updater }));

  rpc.onNotification((method, params) => {
    switch (method) {
      case "account/updated":
        void loadAccount();
        return;
      case "account/login/completed":
        useConn.setState((s) => ({
          login: params.success ? null : s.login ? { ...s.login, error: params.error ?? "Login failed" } : null,
        }));
        void loadAccount();
        return;
      case "account/rateLimits/updated":
        useConn.setState((s) => ({
          rateLimits: s.rateLimits ? { ...s.rateLimits, rateLimits: params.rateLimits ?? s.rateLimits.rateLimits } : s.rateLimits,
        }));
        return;
      case "item/started":
      case "item/completed":
        if (params?.item?.type === "userMessage" && params.item.clientId) clearOptimistic(params.threadId, params.item.clientId);
        break;
    }
    enqueueNotification(method, params);
  });

  rpc.setServerRequestHandler((req: ServerRequest) => {
    if (SERVER_REQUESTS_WE_REFUSE.has(req.method)) {
      rpc.respondError(req.id, -32601, `${req.method} is not supported by Ret`);
      return;
    }
    addPendingRequest(req);
    const threadId = (req.params as any)?.threadId;
    if (threadId && !useThreads.getState().visible[threadId]) {
      bridge.notify("Codex needs your input", threadTitle(useThreads.getState().threads[threadId]));
    }
  });

  setThreadHooks({
    onTurnCompleted: (threadId, turn) => {
      const visible = useThreads.getState().visible[threadId];
      if (!visible || !document.hasFocus()) {
        const title = threadTitle(useThreads.getState().threads[threadId]);
        bridge.notify(turn.status === "failed" ? "Turn failed" : "Codex finished", title);
      }
    },
  });

  rpc.onReady((info) => {
    useConn.setState({ info });
    // A fresh connection knows nothing about our subscriptions. Threads that were mid-turn
    // are re-fetched: the turn either died with the old process or (shared daemon) is still
    // running and gets rejoined by hydrateThread.
    const wasRunning: string[] = [];
    useThreads.setState((s) => {
      const live: Record<string, LiveThread> = {};
      for (const [id, lt] of Object.entries(s.live)) {
        if (lt.activeTurnId) wasRunning.push(id);
        live[id] = lt.activeTurnId ? { ...emptyLive() } : { ...lt, subscribed: false };
      }
      return { live, requests: {} };
    });
    void loadAccount();
    void loadModels();
    void loadConfigDefaults();
    void loadRateLimits();
    void loadThreadList().then(() => {
      const visible = useThreads.getState().visible;
      for (const id of wasRunning) if (visible[id]) void hydrateThread(id);
    });
  });

  let lastRefresh = 0;
  window.addEventListener("focus", () => {
    if (Date.now() - lastRefresh < 30_000) return;
    lastRefresh = Date.now();
    void loadThreadList();
    void loadRateLimits();
  });
}

// ---------------------------------------------------------------------------
// Account & models
// ---------------------------------------------------------------------------

export async function loadAccount() {
  try {
    const account = await rpc.request("account/read", { refreshToken: false });
    useConn.setState({ account, accountLoaded: true });
  } catch (err) {
    console.warn("account/read failed", err);
    useConn.setState({ accountLoaded: true });
  }
}

export async function loadRateLimits() {
  try {
    const rateLimits = await rpc.request("account/rateLimits/read", undefined as never);
    useConn.setState({ rateLimits });
  } catch {
    /* not available for api-key auth */
  }
}

/** Values from config.toml that new threads inherit, for showing what "no override" means. */
export async function loadConfigDefaults() {
  try {
    const res = (await rpc.request("config/read", {})) as { config?: Record<string, unknown> };
    const c = res.config ?? {};
    useConn.setState({
      defaults: {
        model: typeof c.model === "string" ? c.model : null,
        effort: typeof c.model_reasoning_effort === "string" ? c.model_reasoning_effort : null,
        serviceTier: typeof c.service_tier === "string" ? c.service_tier : null,
      },
    });
  } catch (err) {
    console.warn("config/read failed", err);
  }
}

export async function loadModels() {
  try {
    const res = await rpc.request("model/list", { limit: 100 });
    useConn.setState({ models: res.data.filter((m) => !m.hidden) });
  } catch (err) {
    console.warn("model/list failed", err);
  }
}

async function startLoginImpl(kind: "browser" | "device" = "browser") {
  const res = await rpc.request("account/login/start", kind === "browser" ? { type: "chatgpt" } : { type: "chatgptDeviceCode" });
  if (res.type === "chatgpt") {
    useConn.setState({ login: { loginId: res.loginId, kind, authUrl: res.authUrl } });
    await bridge.shell.openExternal(res.authUrl);
  } else if (res.type === "chatgptDeviceCode") {
    useConn.setState({
      login: { loginId: res.loginId, kind, verificationUrl: res.verificationUrl, userCode: res.userCode },
    });
    await bridge.shell.openExternal(res.verificationUrl);
  }
}

export async function cancelLogin() {
  const login = useConn.getState().login;
  useConn.setState({ login: null });
  if (login) await rpc.request("account/login/cancel", { loginId: login.loginId }).catch(() => {});
}

async function logoutImpl() {
  await rpc.request("account/logout", undefined as never);
  await loadAccount();
}

// ---------------------------------------------------------------------------
// Thread list & history
// ---------------------------------------------------------------------------

let listing: Promise<void> | null = null;
export function loadThreadList(): Promise<void> {
  if (listing) return listing;
  listing = (async () => {
    const all: Thread[] = [];
    let cursor: string | null = null;
    try {
      for (let page = 0; page < 20; page++) {
        const res: import("../protocol").ThreadListResponse = await rpc.request("thread/list", {
          limit: 100,
          cursor,
          sortKey: "updated_at",
          useStateDbOnly: true,
        });
        all.push(...res.data);
        cursor = res.nextCursor;
        if (!cursor) break;
        if (page === 0) upsertThreads(all); // paint the sidebar after the first page
      }
      // Replace rather than merge so archived/deleted threads disappear.
      const live = useThreads.getState().threads;
      const next: Record<string, Thread> = {};
      for (const t of all) next[t.id] = { ...t, turns: [] };
      // Keep threads we know about that the list doesn't return (ephemeral forks, brand-new threads).
      for (const [id, t] of Object.entries(live)) if (!next[id] && (t.ephemeral || Date.now() / 1000 - t.createdAt < 120)) next[id] = t;
      useThreads.setState({ threads: next, listLoaded: true });
    } catch (err) {
      console.error("thread/list failed", err);
      useThreads.setState({ listLoaded: true });
    } finally {
      listing = null;
    }
  })();
  return listing;
}

const HISTORY_PAGE = 12;

export async function hydrateThread(threadId: string) {
  if (isDraft(threadId)) return;
  const lt = useThreads.getState().live[threadId];
  if (lt?.hydrated || lt?.hydrating) return;
  patchLive(threadId, { hydrating: true, error: null });
  try {
    const res = await rpc.request("thread/turns/list", {
      threadId,
      limit: HISTORY_PAGE,
      sortDirection: "desc",
      itemsView: "full",
    });
    mergeTurns(threadId, res.data, res.nextCursor, "replace");
    const thread = useThreads.getState().threads[threadId];
    // Running somewhere (another client, or before an app-server restart)? Subscribe for live events.
    if (thread?.status.type === "active") void ensureSubscribed(threadId);
  } catch (err) {
    patchLive(threadId, { hydrating: false, error: (err as Error).message });
  }
}

export async function loadOlder(threadId: string) {
  const lt = useThreads.getState().live[threadId];
  if (!lt?.olderCursor || lt.loadingOlder) return;
  patchLive(threadId, { loadingOlder: true });
  try {
    const res = await rpc.request("thread/turns/list", {
      threadId,
      cursor: lt.olderCursor,
      limit: HISTORY_PAGE,
      sortDirection: "desc",
      itemsView: "full",
    });
    mergeTurns(threadId, res.data, res.nextCursor, "prepend");
  } catch (err) {
    patchLive(threadId, { loadingOlder: false, error: (err as Error).message });
  }
}

/**
 * Folds fetched turns into a thread's live state.
 * - replace: the newest page (initial load); live turns that arrived meanwhile are kept.
 * - prepend: an older page; goes in front.
 * - tail: a re-fetch of the newest turns (polling a thread that runs elsewhere); updates in place.
 */
export function mergeTurns(
  threadId: string,
  turnsDesc: import("../protocol").Turn[],
  cursor: string | null,
  mode: "replace" | "prepend" | "tail",
) {
  const st = useThreads.getState();
  const external = !!st.external[threadId];
  const threadActive = st.threads[threadId]?.status.type === "active" || external;
  patchLive(threadId, (prev) => {
    const asc = turnsDesc.slice().reverse();
    const turns = mode === "replace" ? {} : { ...prev.turns };
    const items: Record<string, ThreadItem> = mode === "replace" ? {} : { ...prev.items };
    const order: string[] = [];
    for (const turn of asc) {
      const live = prev.turns[turn.id];
      if (live?.status === "inProgress" && prev.activeTurnId === turn.id) {
        // Streaming events are fresher than the snapshot; keep what we already have.
        turns[turn.id] = live;
        for (const iid of live.itemIds) items[iid] = prev.items[iid];
      } else {
        if (mode === "tail" && live) for (const iid of live.itemIds) delete items[iid];
        const state = turnStateFrom(turn, live);
        // No end recorded. Another process reports such a turn as "interrupted"; it's really
        // running elsewhere (watched via polling) or was cut off (shown as unfinished).
        if (turn.completedAt == null && (turn.status === "inProgress" || turn.status === "interrupted")) {
          state.status = "inProgress";
          if (!threadActive) state.stale = true;
        }
        turns[turn.id] = state;
        for (const it of turn.items) items[it.id] = it;
      }
      order.push(turn.id);
    }
    const known = new Set(order);
    const rest = prev.turnOrder.filter((id) => !known.has(id));
    if (mode === "replace") {
      for (const id of rest) {
        turns[id] = prev.turns[id];
        for (const iid of prev.turns[id].itemIds) items[iid] = prev.items[iid];
      }
    }
    const turnOrder =
      mode === "tail" ? [...prev.turnOrder, ...order.filter((id) => !prev.turnOrder.includes(id))] : [...order, ...rest];
    // A turn running in another process is never "ours" to steer or interrupt.
    const historyActive = threadActive && !external ? asc.find((t) => t.status === "inProgress")?.id : undefined;
    return {
      turns,
      items,
      turnOrder,
      olderCursor: mode === "tail" ? prev.olderCursor : cursor,
      hydrated: true,
      hydrating: false,
      loadingOlder: false,
      activeTurnId: prev.activeTurnId ?? historyActive ?? null,
    };
  });
}

const resuming = new Map<string, Promise<void>>();
export function ensureSubscribed(threadId: string): Promise<void> {
  const lt = useThreads.getState().live[threadId];
  if (lt?.subscribed) return Promise.resolve();
  const existing = resuming.get(threadId);
  if (existing) return existing;
  const p = (async () => {
    const res = await rpc.request("thread/resume", { threadId, excludeTurns: true });
    upsertThreads([res.thread]);
    patchLive(threadId, {
      subscribed: true,
      settings: settingsFrom(res),
    });
    if (!useThreads.getState().live[threadId]?.hydrated) await hydrateThread(threadId);
  })().finally(() => resuming.delete(threadId));
  resuming.set(threadId, p);
  return p;
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

function accessOverrides(preset: AccessPreset): {
  approvalPolicy?: AskForApproval;
  sandbox?: SandboxMode;
  sandboxPolicy?: SandboxPolicy;
} {
  switch (preset) {
    case "read-only":
      return { approvalPolicy: "on-request", sandbox: "read-only", sandboxPolicy: { type: "readOnly", networkAccess: false } };
    case "auto":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      };
    case "full":
      return { approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } };
    default:
      return {};
  }
}

export interface Attachment {
  path: string;
  name: string;
  previewUrl?: string;
}

function buildInput(text: string, attachments: Attachment[]): UserInput[] {
  const input: UserInput[] = [];
  if (text.trim()) input.push({ type: "text", text, text_elements: [] });
  for (const a of attachments) input.push({ type: "localImage", path: a.path });
  return input;
}

function addOptimistic(threadId: string, clientId: string, input: UserInput[]) {
  const turnId = `pending:${clientId}`;
  patchLive(threadId, (lt) => ({
    turnOrder: [...lt.turnOrder, turnId],
    turns: {
      ...lt.turns,
      [turnId]: { id: turnId, status: "inProgress", itemIds: [clientId], error: null, startedAt: Date.now() / 1000, completedAt: null, durationMs: null, diff: null, plan: null },
    },
    items: { ...lt.items, [clientId]: { type: "userMessage", id: clientId, clientId, content: input } },
  }));
}

function clearOptimistic(threadId: string, clientId: string) {
  const turnId = `pending:${clientId}`;
  const lt = useThreads.getState().live[threadId];
  if (!lt?.turns[turnId]) return;
  patchLive(threadId, (lt) => {
    const turns = { ...lt.turns };
    delete turns[turnId];
    const items = { ...lt.items };
    delete items[clientId];
    return { turns, items, turnOrder: lt.turnOrder.filter((id) => id !== turnId) };
  });
}

export interface TurnOverrides {
  model?: string | null;
  effort?: string | null;
  access?: AccessPreset;
  /** Service tier id: "default" (standard), "priority" (Fast), "ultrafast". Undefined keeps the thread's. */
  speed?: string;
}

/** Sends a message to a thread (starting it first if `target` is a draft). Returns the real thread id. */
export async function sendMessage(target: string, text: string, attachments: Attachment[] = [], prefs: TurnOverrides = {}): Promise<string> {
  const ui = useUI.getState();
  const access = accessOverrides(prefs.access ?? "config");
  const input = buildInput(text, attachments);
  if (!input.length) return target;

  let threadId = target;
  if (isDraft(target)) {
    const draft = ui.drafts[target];
    if (!draft) throw new Error("Draft no longer exists");
    const res = await rpc.request("thread/start", {
      cwd: draft.cwd,
      model: prefs.model ?? null,
      ...(prefs.speed ? { serviceTier: prefs.speed } : {}),
      approvalPolicy: access.approvalPolicy,
      sandbox: access.sandbox,
    });
    threadId = res.thread.id;
    upsertThreads([res.thread]);
    useThreads.setState((s) => ({
      live: {
        ...s.live,
        [threadId]: {
          ...emptyLive(),
          hydrated: true,
          subscribed: true,
          settings: settingsFrom(res),
        },
      },
    }));
    if (draft.projectKey !== normPath(draft.cwd)) {
      useUI.setState((s) => ({ threadProject: { ...s.threadProject, [threadId]: draft.projectKey } }));
    }
    replaceDraft(target, threadId);
  } else {
    await ensureSubscribed(threadId);
  }

  flushNow();
  const lt = useThreads.getState().live[threadId];
  const clientId = crypto.randomUUID();
  addOptimistic(threadId, clientId, input);
  try {
    if (lt?.activeTurnId) {
      await rpc.request("turn/steer", { threadId, input, expectedTurnId: lt.activeTurnId, clientUserMessageId: clientId });
    } else {
      await rpc.request("turn/start", {
        threadId,
        input,
        clientUserMessageId: clientId,
        model: prefs.model ?? null,
        effort: prefs.effort ?? null,
        ...(prefs.speed ? { serviceTier: prefs.speed } : {}),
        approvalPolicy: access.approvalPolicy,
        sandboxPolicy: access.sandboxPolicy,
      });
    }
  } catch (err) {
    clearOptimistic(threadId, clientId);
    patchLive(threadId, { error: (err as Error).message });
    throw err;
  }
  return threadId;
}

function settingsFrom(res: {
  model: string;
  reasoningEffort: string | null;
  serviceTier: string | null;
  approvalPolicy: unknown;
  sandbox: unknown;
  cwd: string;
}): ThreadSettings {
  return {
    model: res.model,
    effort: res.reasoningEffort,
    serviceTier: res.serviceTier,
    approvalPolicy: res.approvalPolicy,
    sandbox: res.sandbox,
    cwd: res.cwd,
  };
}

export async function interrupt(threadId: string) {
  const lt = useThreads.getState().live[threadId];
  if (!lt?.activeTurnId) return;
  await rpc.request("turn/interrupt", { threadId, turnId: lt.activeTurnId }).catch((err) => patchLive(threadId, { error: err.message }));
}

export function respondToRequest(key: string, result: unknown) {
  const req = useThreads.getState().requests[key];
  if (!req) return;
  rpc.respond(req.id, result);
  removePendingRequest(key);
}

async function renameThreadImpl(threadId: string, name: string) {
  await rpc.request("thread/name/set", { threadId, name });
  useThreads.setState((s) => (s.threads[threadId] ? { threads: { ...s.threads, [threadId]: { ...s.threads[threadId], name } } } : s));
}

async function archiveThreadImpl(threadId: string) {
  await rpc.request("thread/archive", { threadId });
  closeEverywhere(threadId);
  useThreads.setState((s) => {
    const threads = { ...s.threads };
    delete threads[threadId];
    return { threads };
  });
}

async function compactThreadImpl(threadId: string) {
  await ensureSubscribed(threadId);
  await rpc.request("thread/compact/start", { threadId });
}

// ---------------------------------------------------------------------------
// Forking
// ---------------------------------------------------------------------------

export interface ForkOptions {
  /** Fork through this turn (inclusive); later turns are dropped from the fork. */
  atTurnId?: string;
  /** Give the fork its own git worktree so its file edits are isolated. */
  worktree?: boolean;
}

async function forkThreadImpl(threadId: string, opts: ForkOptions = {}): Promise<string> {
  const source = useThreads.getState().threads[threadId];
  if (!source) throw new Error("Unknown thread");
  const ui = useUI.getState();
  const confKeys = explicitKeys(ui.projects);
  const projectKey = projectKeyFor(source, useThreads.getState().threads, confKeys, ui.threadProject);

  const worktree = opts.worktree ? await bridge.git.createWorktree(source.cwd, threadTitle(source)) : undefined;
  const cwd = worktree?.path;

  const res = await rpc.request("thread/fork", {
    threadId,
    lastTurnId: opts.atTurnId ?? null,
    cwd: cwd ?? null,
    excludeTurns: true,
  });
  const fork = res.thread;
  upsertThreads([fork]);
  useThreads.setState((s) => ({
    live: { ...s.live, [fork.id]: { ...emptyLive(), subscribed: true, settings: settingsFrom(res) } },
  }));
  useUI.setState((s) => ({
    threadProject: { ...s.threadProject, [fork.id]: projectKey },
    worktrees: worktree ? { ...s.worktrees, [fork.id]: worktree } : s.worktrees,
    expanded: { ...s.expanded, [rootOf(threadId)]: true, [threadId]: true },
  }));
  void hydrateThread(fork.id);
  openThread(fork.id, { besideThread: threadId, side: true });
  return fork.id;
}

function rootOf(threadId: string): string {
  const threads = useThreads.getState().threads;
  let t = threads[threadId];
  const seen = new Set<string>();
  while (t?.forkedFromId && threads[t.forkedFromId] && !seen.has(t.id)) {
    seen.add(t.id);
    t = threads[t.forkedFromId];
  }
  return t?.id ?? threadId;
}

// ---------------------------------------------------------------------------
// Opening / closing views (focus tabs and canvas windows)
// ---------------------------------------------------------------------------

/** New draft in the same project as `fromThreadId` (or the palette if there's no context). */
export function newThreadNear(fromThreadId: string | null) {
  const ui = useUI.getState();
  if (fromThreadId && isDraft(fromThreadId)) {
    const d = ui.drafts[fromThreadId];
    if (d) newThread(d.projectKey, d.cwd);
    return;
  }
  const t = fromThreadId ? useThreads.getState().threads[fromThreadId] : undefined;
  if (!t) {
    useUI.setState({ paletteOpen: true });
    return;
  }
  const confKeys = explicitKeys(ui.projects);
  const key = projectKeyFor(t, useThreads.getState().threads, confKeys, ui.threadProject);
  newThread(key, ui.projects[key]?.path ?? t.cwd);
}

export function newThread(projectKey: string, cwd: string, opts: OpenOptions = {}) {
  const id = `draft:${newId()}`;
  useUI.setState((s) => ({ drafts: { ...s.drafts, [id]: { cwd, projectKey, createdAt: Date.now() } } }));
  openThread(id, opts);
  return id;
}

/** Point a not-yet-started thread at a different project folder. */
export function retargetDraft(draftId: string, projectKey: string, cwd: string) {
  useUI.setState((s) => (s.drafts[draftId] ? { drafts: { ...s.drafts, [draftId]: { ...s.drafts[draftId], projectKey, cwd } } } : s));
}

const MAX_TABS = 14;

export interface OpenOptions {
  /** Canvas: place next to this thread's window. Focus: insert the tab after it / pair with it. */
  besideThread?: string;
  mode?: "focus" | "canvas";
  /** Focus: show beside the active tab (or besideThread) in a split instead of a new tab. */
  side?: boolean;
  /** Canvas: world position for the new window's top-left. */
  at?: { x: number; y: number };
}

export function openThread(threadId: string, opts: OpenOptions = {}) {
  const ui = useUI.getState();
  const mode = opts.mode ?? ui.mode;
  if (!isDraft(threadId)) void hydrateThread(threadId);

  if (mode === "focus") {
    useUI.setState((s) => focusOpen(s, threadId, opts));
    return;
  }

  const board = activeBoard();
  const existing = board.windows.find((w) => w.threadId === threadId);
  if (existing) {
    focusWindow(existing.id, true);
    return;
  }
  const z = Math.max(0, ...board.windows.map((w) => w.z)) + 1;
  const besideWin = opts.besideThread ? board.windows.find((w) => w.threadId === opts.besideThread) : undefined;
  const size = { w: 560, h: 640 };
  const pos = opts.at
    ? clampToView(opts.at, besideWin?.w ?? size.w, besideWin?.h ?? size.h, board.viewport)
    : besideWin
      ? freeSpot(board.windows, besideWin.x + besideWin.w + 24, besideWin.y, besideWin.w, besideWin.h)
      : freeSpotInView(board.windows, board.viewport, size.w, size.h);
  const win: CanvasWin = {
    id: newId(),
    threadId,
    x: pos.x,
    y: pos.y,
    w: besideWin?.w ?? size.w,
    h: besideWin?.h ?? size.h,
    z,
  };
  updateBoard((b) => ({ ...b, windows: [...b.windows, win] }));
  useUI.setState({ focusedWindow: win.id });
  window.dispatchEvent(new CustomEvent("ret:reveal-window", { detail: win.id }));
}

/** Focus-mode tab/split bookkeeping for opening `id`. */
function focusOpen(s: UIState, id: string, opts: OpenOptions): Partial<UIState> {
  if (opts.side) {
    const left = opts.besideThread ?? s.activeTab;
    if (left && left !== id) {
      const tabs = s.tabs.slice();
      if (!tabs.includes(left)) tabs.splice(s.activeTab ? tabs.indexOf(s.activeTab) + 1 : tabs.length, 0, left);
      const splits = { ...s.splits };
      const prev = splits[left];
      // Whatever was beside it keeps a tab of its own rather than vanishing.
      if (prev && prev.right !== id && !tabs.includes(prev.right)) tabs.splice(tabs.indexOf(left) + 1, 0, prev.right);
      splits[left] = { right: id, ratio: prev?.ratio ?? 0.5 };
      const capped = capTabs(tabs, left);
      return { tabs: capped, splits: pruneSplits(capped, splits), activeTab: left, focusedSide: "right" };
    }
  }
  if (s.tabs.includes(id)) return { activeTab: id, focusedSide: "left" };
  if (s.activeTab && s.splits[s.activeTab]?.right === id) return { focusedSide: "right" };
  const owner = Object.keys(s.splits).find((k) => s.splits[k].right === id && s.tabs.includes(k));
  if (owner) return { activeTab: owner, focusedSide: "right" };
  const tabs = s.tabs.slice();
  const anchor = opts.besideThread ?? s.activeTab;
  const at = anchor ? tabs.indexOf(anchor) : -1;
  tabs.splice(at >= 0 ? at + 1 : tabs.length, 0, id);
  const capped = capTabs(tabs, id);
  return { tabs: capped, splits: pruneSplits(capped, s.splits), activeTab: id, focusedSide: "left" };
}

/** Drop the oldest idle tabs beyond the limit (never `keep`, never one that's running). */
function capTabs(tabs: string[], keep: string): string[] {
  const out = tabs.slice();
  while (out.length > MAX_TABS) {
    const victim = out.findIndex((t) => t !== keep && !useThreads.getState().live[t]?.activeTurnId);
    out.splice(victim >= 0 ? victim : 0, 1);
  }
  return out;
}

function pruneSplits(tabs: string[], splits: Record<string, FocusSplit>): Record<string, FocusSplit> {
  const keys = Object.keys(splits).filter((k) => tabs.includes(k));
  return keys.length === Object.keys(splits).length ? splits : Object.fromEntries(keys.map((k) => [k, splits[k]]));
}

/** Close one side of the active split. Closing the left promotes the right into the tab. */
export function closePane(side: "left" | "right") {
  useUI.setState((s) => {
    const left = s.activeTab;
    const sp = left ? s.splits[left] : undefined;
    if (!left || !sp) return s;
    const splits = { ...s.splits };
    delete splits[left];
    if (side === "right") return { splits, focusedSide: "left" };
    const tabs = s.tabs.map((t) => (t === left ? sp.right : t)).filter((t, i, all) => all.indexOf(t) === i);
    return { tabs, splits, activeTab: sp.right, focusedSide: "left" };
  });
  gcDrafts();
}

export function setSplitRatio(left: string, ratio: number) {
  useUI.setState((s) => (s.splits[left] ? { splits: { ...s.splits, [left]: { ...s.splits[left], ratio } } } : s));
}

/** Keep a window placed at a pointer position fully inside the visible canvas when it fits. */
function clampToView(at: { x: number; y: number }, w: number, h: number, vp: { x: number; y: number; zoom: number }) {
  const el = document.querySelector(".canvas-viewport");
  const left = (coveredLeft() - vp.x) / vp.zoom + 16;
  const top = -vp.y / vp.zoom + 16;
  const right = ((el?.clientWidth ?? 1200) - vp.x) / vp.zoom - 16;
  const bottom = ((el?.clientHeight ?? 800) - vp.y) / vp.zoom - 16;
  return {
    x: Math.max(left, Math.min(at.x, right - w)),
    y: Math.max(top, Math.min(at.y, bottom - h)),
  };
}

function overlaps(a: { x: number; y: number; w: number; h: number }, wins: CanvasWin[]) {
  return wins.some((b) => a.x < b.x + b.w + 12 && a.x + a.w + 12 > b.x && a.y < b.y + b.h + 12 && a.y + a.h + 12 > b.y);
}

function freeSpot(wins: CanvasWin[], x: number, y: number, w: number, h: number) {
  let cand = { x, y, w, h };
  for (let i = 0; i < 60 && overlaps(cand, wins); i++) cand = { ...cand, y: cand.y + 48, x: cand.x + (i % 6 === 5 ? w + 24 : 0) };
  return { x: cand.x, y: cand.y };
}

function freeSpotInView(wins: CanvasWin[], vp: { x: number; y: number; zoom: number }, w: number, h: number) {
  const el = document.querySelector(".canvas-viewport");
  const vw = ((el?.clientWidth ?? 1200) - coveredLeft()) / vp.zoom;
  const vh = (el?.clientHeight ?? 800) / vp.zoom;
  // Start right of the pinned sidebar, which floats over the canvas.
  const ox = (coveredLeft() - vp.x) / vp.zoom;
  const oy = -vp.y / vp.zoom;
  for (let y = oy + 24; y + h <= oy + vh + h * 0.5; y += 40) {
    for (let x = ox + 24; x + w <= ox + vw; x += 40) {
      if (!overlaps({ x, y, w, h }, wins)) return { x, y };
    }
  }
  // Viewport is full: place to the right of everything.
  const right = Math.max(ox, ...wins.map((b) => b.x + b.w)) + 24;
  return { x: right, y: oy + 24 };
}

export function focusWindow(winId: string, reveal = false) {
  const board = activeBoard();
  const top = Math.max(0, ...board.windows.map((w) => w.z));
  const win = board.windows.find((w) => w.id === winId);
  if (!win) return;
  if (win.z !== top) updateBoard((b) => ({ ...b, windows: b.windows.map((w) => (w.id === winId ? { ...w, z: top + 1 } : w)) }));
  useUI.setState({ focusedWindow: winId });
  if (reveal) window.dispatchEvent(new CustomEvent("ret:reveal-window", { detail: winId }));
}

export function closeWindow(winId: string) {
  updateBoard((b) => ({ ...b, windows: b.windows.filter((w) => w.id !== winId) }));
  useUI.setState((s) => ({ focusedWindow: s.focusedWindow === winId ? null : s.focusedWindow }));
  gcDrafts();
}

export function closeTab(threadId: string) {
  useUI.setState((s) => {
    const idx = s.tabs.indexOf(threadId);
    if (idx < 0) return s;
    const tabs = s.tabs.filter((t) => t !== threadId);
    const activeTab = s.activeTab === threadId ? (tabs[idx] ?? tabs[idx - 1] ?? null) : s.activeTab;
    const splits = { ...s.splits };
    delete splits[threadId];
    return { tabs, activeTab, splits, focusedSide: s.activeTab === threadId ? "left" : s.focusedSide };
  });
  gcDrafts();
}

function closeEverywhere(threadId: string) {
  closeTab(threadId);
  useUI.setState((s) => ({
    boards: s.boards.map((b) => ({ ...b, windows: b.windows.filter((w) => w.threadId !== threadId) })),
    splits: Object.fromEntries(Object.entries(s.splits).filter(([, v]) => v.right !== threadId)),
  }));
}

function replaceDraft(draftId: string, threadId: string) {
  useUI.setState((s) => {
    const drafts = { ...s.drafts };
    delete drafts[draftId];
    return {
      drafts,
      tabs: s.tabs.map((t) => (t === draftId ? threadId : t)),
      activeTab: s.activeTab === draftId ? threadId : s.activeTab,
      splits: Object.fromEntries(
        Object.entries(s.splits).map(([k, v]) => [k === draftId ? threadId : k, v.right === draftId ? { ...v, right: threadId } : v]),
      ),
      boards: s.boards.map((b) => ({ ...b, windows: b.windows.map((w) => (w.threadId === draftId ? { ...w, threadId } : w)) })),
    };
  });
}

function gcDrafts() {
  useUI.setState((s) => {
    const used = new Set([
      ...s.tabs,
      ...Object.values(s.splits).map((v) => v.right),
      ...s.boards.flatMap((b) => b.windows.map((w) => w.threadId)),
    ]);
    const drafts = Object.fromEntries(Object.entries(s.drafts).filter(([id]) => used.has(id)));
    return Object.keys(drafts).length === Object.keys(s.drafts).length ? s : { drafts };
  });
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function addProject(path?: string) {
  const picked = path ?? (await bridge.dialog.pickFolder());
  if (!picked) return null;
  const key = normPath(picked);
  useUI.setState((s) => ({
    projects: { ...s.projects, [key]: { ...(s.projects[key] ?? {}), path: picked, addedAt: Date.now(), hidden: false, explicit: true } },
  }));
  return key;
}

export function updateProject(key: string, patch: Partial<import("./ui").ProjectConf>, fallbackPath: string) {
  useUI.setState((s) => ({
    projects: {
      ...s.projects,
      [key]: { ...(s.projects[key] ?? { path: fallbackPath, addedAt: Date.now() }), ...patch },
    },
  }));
}

// ---------------------------------------------------------------------------
// Idle eviction: free app-server resources and renderer memory for threads nobody is looking at.
// ---------------------------------------------------------------------------

const unsubscribeTimers = new Map<string, number>();
const IDLE_UNSUBSCRIBE_MS = 3 * 60_000;

useThreads.subscribe((s, prev) => {
  if (s.visible === prev.visible) return;
  for (const id of Object.keys(prev.visible)) {
    if (s.visible[id] || unsubscribeTimers.has(id)) continue;
    unsubscribeTimers.set(
      id,
      window.setTimeout(() => {
        unsubscribeTimers.delete(id);
        const st = useThreads.getState();
        const lt = st.live[id];
        const busy = lt?.activeTurnId || Object.values(st.requests).some((r) => r.threadId === id);
        if (st.visible[id] || !lt || busy) return;
        if (lt.subscribed) void rpc.request("thread/unsubscribe", { threadId: id }).catch(() => {});
        // Drop the cached transcript too; reopening re-fetches it in one page.
        useThreads.setState((cur) => {
          if (cur.visible[id] || !cur.live[id]) return cur;
          const live = { ...cur.live };
          delete live[id];
          return { live };
        });
      }, IDLE_UNSUBSCRIBE_MS),
    );
  }
  for (const id of Object.keys(s.visible)) {
    const t = unsubscribeTimers.get(id);
    if (t) {
      clearTimeout(t);
      unsubscribeTimers.delete(id);
    }
  }
});

// ---------------------------------------------------------------------------
// User-triggered actions: failures surface as toasts rather than vanishing.
// ---------------------------------------------------------------------------

export const startLogin = guarded("Sign-in failed", startLoginImpl);
export const logout = guarded("Sign-out failed", logoutImpl);
export const renameThread = guarded("Couldn't rename thread", renameThreadImpl);
export const archiveThread = guarded("Couldn't archive thread", archiveThreadImpl);
export const compactThread = guarded("Couldn't compact context", compactThreadImpl);
export const forkThread = guarded("Couldn't fork thread", forkThreadImpl);
