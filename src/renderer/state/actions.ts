import { bridge } from "../bridge";
import { onAppFocus } from "../lib/appFocus";
import { dropClient, rpcFor } from "../rpc/client";
import { PROVIDER_IDS, engineId, hostOf, providerOf, type EngineId, type ProviderId, type ProvidersSettings } from "@shared/bridge";
import type { ServerRequest, Thread, ThreadItem, UsageActivity, UserInput } from "@shared/protocol";
import { PROVIDERS, accessFor, agentOf, pickProvider } from "../agents";
import { dropProvider, emptyProviderConn, enabledProviders, enabledProvidersOn, patchProvider, signedIn, useConn, type ProviderConn, type TokenUsage } from "./conn";
import { guarded, toast } from "./toasts";
import { askerTitle, hostOfKey, lineageRoot, normPath, scopedKey, spawnedBy, threadTitle, type Workspace } from "./projects";
import { projectKeyNow } from "./projectTree";
import { engineName, hostEngines, hostName, hostPlatform, useHosts, watchHosts } from "./hosts";
import { fillComposer } from "./composerDrafts";
import { agentsUnasked, backfillLineage, discoverThread, lineageKnown, listAgentsOf } from "./lineage";
import { cancelTitle, isTitleThread, titleEvent, titleFromMessage } from "./titles";
import {
  addPendingRequest,
  emptyLive,
  enqueueNotification,
  flushNow,
  mergeThread,
  hostOfThread,
  delegated,
  ownerOf,
  patchLive,
  goalMark,
  removePendingRequest,
  setGoal,
  setThreadHooks,
  turnStateFrom,
  upsertThreads,
  useThreads,
  type LiveThread,
  type QueuedMessage,
  type ThreadSettings,
} from "./threads";
import { activeBoard, appId, appKind, fileId, isApp, isDraft, isFile, isThread, newId, updateBoard, useUI, type CanvasWin, type FocusSplit, type UIState, type ViewMode } from "./ui";
import { onFsChanged, useFiles } from "./files";
import { captureLive, captureTurns, noteAppRequest, screenTurnEnded } from "./computerUse";
import { turnFinished } from "./finished";

// ---------------------------------------------------------------------------
// Boot: wire the transport into the stores.
// ---------------------------------------------------------------------------

const SERVER_REQUESTS_WE_REFUSE = new Set(["item/tool/call", "account/chatgptAuthTokens/refresh", "attestation/generate"]);

let booted = false;
export function bootstrap() {
  if (booted) return;
  booted = true;

  bridge.agents.onStatus((status) => patchProvider(engineId(status.provider, status.host), { status }));
  for (const p of PROVIDER_IDS) void bridge.agents.getStatus(p).then((status) => patchProvider(p, { status }));
  bridge.agents.onSettings(applyProviderSettings);
  void bridge.agents.getSettings().then(applyProviderSettings);
  bridge.updater.onState((updater) => useConn.setState({ updater }));
  void bridge.updater.getState().then((updater) => useConn.setState({ updater }));
  bridge.appUpdate.onState((appUpdate) => useConn.setState({ appUpdate }));
  void bridge.appUpdate.getState().then((appUpdate) => useConn.setState({ appUpdate }));

  for (const p of PROVIDER_IDS) wireEngine(p);
  // Paired devices' engines join as the devices come and go.
  watchHosts((added, removed) => {
    for (const host of added) {
      for (const e of hostEngines(host)) {
        wireEngine(e);
        void bridge.agents.getStatus(e).then(
          (status) => patchProvider(e, { status }),
          () => {},
        );
      }
    }
    removed.forEach(dropHost);
  });

  setThreadHooks({
    onTurnCompleted: (threadId, turn, waiting) => {
      // Send the next queued follow-up (outside the reducer flush that called us).
      if (turn.status !== "failed") setTimeout(() => void drainQueue(threadId), 0);
      if (delegated(useThreads.getState().threads[threadId], turn)) return;
      const heading = turn.status === "failed" ? "Turn failed" : `${engineName(ownerOf(threadId))} finished`;
      // Paired phones that are away hear about this computer's own threads (theirs, they're told by their own computer).
      turnFinished(threadId, turn.id, { heading, devices: true }, waiting);
    },
  });

  let lastRefresh = 0;
  onAppFocus(() => {
    if (Date.now() - lastRefresh < 30_000) return;
    lastRefresh = Date.now();
    void loadThreadList();
    for (const p of enabledProviders()) void loadRateLimits(p);
  });

  // Threads arrive from the list, the poll for work in other apps, and live events. However one
  // comes, look at its folder soon after: a linked worktree groups with its main checkout.
  let checkoutsTimer = 0;
  useThreads.subscribe((s, prev) => {
    if (s.threads === prev.threads || checkoutsTimer) return;
    checkoutsTimer = window.setTimeout(() => {
      checkoutsTimer = 0;
      void resolveCheckouts();
    }, 300);
  });
}

/** Providers turned on or off: a disabled provider's threads leave the sidebar until it's back. */
function applyProviderSettings(settings: ProvidersSettings) {
  useConn.setState({ settings });
  const off: EngineId[] = PROVIDER_IDS.filter((p) => !settings.enabled[p]);
  if (!off.length) return;
  useThreads.setState((s) => {
    const threads = Object.fromEntries(Object.entries(s.threads).filter(([id]) => !off.includes(s.owner[id] ?? "codex")));
    return Object.keys(threads).length === Object.keys(s.threads).length ? s : { threads };
  });
}

/** A paired device was forgotten (or forgot this one): its engines and everything from them go, views included. */
function dropHost(host: string) {
  const engines = new Set<EngineId>(hostEngines(host));
  for (const e of engines) {
    dropClient(e);
    dropProvider(e);
    listed.delete(e);
  }
  const { owner } = useThreads.getState();
  const drafts = useUI.getState().drafts;
  const views = [
    ...Object.keys(owner).filter((id) => engines.has(owner[id])),
    ...Object.keys(drafts).filter((id) => hostOfKey(drafts[id].projectKey) === host),
  ];
  views.forEach(closeEverywhere);
  useThreads.setState((s) => {
    const gone = (id: string) => engines.has(s.owner[id]);
    const keep = <T,>(rec: Record<string, T>) => Object.fromEntries(Object.entries(rec).filter(([id]) => !gone(id)));
    return {
      threads: keep(s.threads),
      owner: keep(s.owner),
      live: keep(s.live),
      requests: Object.fromEntries(Object.entries(s.requests).filter(([, r]) => !engines.has(r.engine))),
      workspaces: s.workspaces.filter((w) => w.host !== host),
    };
  });
}

/**
 * Engines whose threads are listed: this computer's that are on, and paired devices' that are
 * up (or on their way, or not heard from yet).
 */
export function listedEngines(): EngineId[] {
  const conn = useConn.getState();
  const remote = Object.keys(useHosts.getState().hosts)
    .flatMap(hostEngines)
    .filter((e) => {
      const st = conn.providers[e]?.status?.state;
      return st === undefined || st === "running" || st === "starting";
    });
  return [...enabledProviders(conn), ...remote];
}

/** Connect one engine (this computer's or a paired device's) to the stores. */
function wireEngine(p: EngineId) {
  const rpc = rpcFor(p);
  rpc.onNotification((method, params) => {
    if (titleEvent(method, params)) return; // a hidden title thread's, not one of ours
    switch (method) {
      case "account/updated":
        void loadAccount(p);
        return;
      case "account/login/completed":
        patchProvider(p, (c) => ({
          login: params.success ? null : c.login ? { ...c.login, error: params.error ?? "Login failed" } : null,
        }));
        void loadAccount(p);
        return;
      case "account/rateLimits/updated":
        // Engines that track several limits (Claude's per-model buckets) send them all along.
        patchProvider(p, (c) => ({
          rateLimits: c.rateLimits
            ? {
                ...c.rateLimits,
                rateLimits: params.rateLimits ?? c.rateLimits.rateLimits,
                rateLimitsByLimitId: params.rateLimitsByLimitId ?? c.rateLimits.rateLimitsByLimitId,
              }
            : params.rateLimits
              ? { rateLimits: params.rateLimits, rateLimitsByLimitId: params.rateLimitsByLimitId ?? null, ordinaryUsageAllowed: null, rateLimitResetCredits: null, accountId: null, rateLimitUpsell: null }
              : null,
        }));
        return;
      case "account/usage/updated":
        // Running totals from a read that's still going: the charts fill in as they come. Only
        // for a read we're waiting on, whose answer ends the loading state.
        if (usageReads.has(p))
          patchUsage(p, {
            ...(params.dailyUsageBuckets ? { days: usageDays(params.dailyUsageBuckets) } : {}),
            ...(params.activity ? { activity: params.activity as UsageActivity } : {}),
          });
        return;
      case "fs/changed":
        onFsChanged(params);
        return;
      case "project/changed":
        void loadWorkspaces(p);
        return;
      case "turn/started":
        if (agentOf(p).subagentThreads) discoverThread(p, params?.threadId);
        break;
      case "item/started":
      case "item/completed":
        if (agentOf(p).subagentThreads && method === "item/started") {
          if (params?.item?.type === "subAgentActivity") discoverThread(p, params.item.agentThreadId);
          if (params?.item?.type === "collabAgentToolCall") for (const id of params.item.receiverThreadIds ?? []) discoverThread(p, id);
        }
        if (params?.item?.type === "userMessage" && params.item.clientId) clearOptimistic(params.threadId, params.item.clientId);
        if (method === "item/completed" && params?.item?.type === "userMessage") titleFromMessage(p, params.threadId, params.item);
        // Computer-use steps leave their screenshots with the screens (see computerUse).
        if (params?.item?.type === "mcpToolCall") {
          const item = captureLive(params.threadId, params.turnId, params.item);
          if (item !== params.item) params = { ...params, item };
        }
        break;
      case "turn/completed":
        if (params?.turn?.items?.length) {
          const [turn] = captureTurns(params.threadId, [params.turn]);
          if (turn !== params.turn) params = { ...params, turn };
        }
        if (params?.turn?.id) screenTurnEnded(params.threadId, params.turn.id);
        break;
    }
    enqueueNotification(p, method, params);
  });

  rpc.setServerRequestHandler((req: ServerRequest) => {
    if (SERVER_REQUESTS_WE_REFUSE.has(req.method)) {
      rpc.respondError(req.id, -32601, `${req.method} is not supported by Ret`);
      return;
    }
    const threadId = (req.params as any)?.threadId;
    if (threadId && isTitleThread(threadId)) {
      rpc.respondError(req.id, -32601, "A title thread can't ask for anything");
      return;
    }
    addPendingRequest(p, req);
    if (req.method === "mcpServer/elicitation/request") noteAppRequest(req.params.threadId, req.params.turnId ?? "", req.params);
    if (threadId && !useThreads.getState().visible[threadId]) {
      bridge.notify(`${engineName(p)} needs your input`, askerTitle(useThreads.getState().threads, threadId));
    }
    if (threadId && !hostOf(p)) {
      bridge.remoteAccess.notifyDevices({ title: `${engineName(p)} needs your input`, body: askerTitle(useThreads.getState().threads, threadId), threadId });
    }
  });

  rpc.onReady((info) => {
    patchProvider(p, { info });
    goalsOff.delete(p);
    // A fresh connection knows nothing about our subscriptions. Threads that were mid-turn
    // are re-fetched: the turn either died with the old process or (shared daemon, Claude
    // sessions) is still running and gets rejoined by hydrateThread.
    const wasRunning: string[] = [];
    useThreads.setState((s) => {
      const live: Record<string, LiveThread> = { ...s.live };
      for (const [id, lt] of Object.entries(s.live)) {
        if ((s.owner[id] ?? "codex") !== p) continue;
        if (lt.activeTurnId) wasRunning.push(id);
        live[id] = lt.activeTurnId ? { ...emptyLive() } : { ...lt, subscribed: false };
      }
      const requests = Object.fromEntries(Object.entries(s.requests).filter(([, r]) => r.engine !== p));
      // The engine tells a new connection what still runs in the background.
      const background = Object.fromEntries(Object.entries(s.background).filter(([id]) => (s.owner[id] ?? "codex") !== p));
      return { live, requests, background };
    });
    void loadAccount(p);
    void loadModels(p);
    void loadConfigDefaults(p);
    void loadRateLimits(p);
    void loadThreadList(p).then(() => {
      const { visible, owner, live } = useThreads.getState();
      for (const id of wasRunning) if (visible[id]) void hydrateThread(id);
      // A view that couldn't load its thread before this engine was up (a paired device's, still connecting) tries again.
      for (const id of Object.keys(visible)) {
        if (owner[id] === p && live[id]?.error && !live[id]?.hydrated && !wasRunning.includes(id)) void hydrateThread(id);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Account & models
// ---------------------------------------------------------------------------

export async function loadAccount(p: EngineId) {
  try {
    const account = (await rpcFor(p).request("account/read", { refreshToken: false })) as ProviderConn["account"];
    patchProvider(p, { account, accountLoaded: true });
  } catch (err) {
    console.warn(`${p}: account/read failed`, err);
    patchProvider(p, { accountLoaded: true });
  }
}

export async function loadRateLimits(p: EngineId) {
  try {
    const rateLimits = await rpcFor(p).request("account/rateLimits/read", undefined as never);
    patchProvider(p, { rateLimits });
  } catch {
    /* not available for api-key auth */
  }
}

/** `account/usage/read` buckets as day → tokens. Typed as bigint (ts-rs), but JSON brings numbers. */
function usageDays(buckets: { startDate: string; tokens: number | bigint }[] | null | undefined): Record<string, number> {
  const days: Record<string, number> = {};
  for (const b of buckets ?? []) days[b.startDate] = Number(b.tokens);
  return days;
}

/** Streaks as the provider keeps them, when it does (Codex). */
function usageStreaks(s: { currentStreakDays: number | bigint | null; longestStreakDays: number | bigint | null } | null | undefined): TokenUsage["streaks"] {
  if (s?.currentStreakDays == null && s?.longestStreakDays == null) return null;
  return { current: Number(s.currentStreakDays ?? 0), longest: Number(s.longestStreakDays ?? 0) };
}

function patchUsage(p: EngineId, patch: Partial<TokenUsage>) {
  patchProvider(p, (c) => ({ tokenUsage: { ...(c.tokenUsage ?? { at: 0, loading: true, days: {}, streaks: null, activity: null }), ...patch } }));
}

/** Engines with a usage read in flight. */
const usageReads = new Set<EngineId>();

/**
 * Tokens per day and what each day held (models, prompts), for the home screen. Reads again
 * once what's held is older than `maxAgeMs`. Each part shows as it arrives; engines that take a
 * while (transcripts to read) send running totals meanwhile.
 */
export async function loadTokenUsage(p: EngineId, maxAgeMs = 0) {
  const held = useConn.getState().providers[p]?.tokenUsage;
  if (usageReads.has(p) || (held && Date.now() - held.at < maxAgeMs)) return;
  usageReads.add(p);
  patchUsage(p, { loading: true });
  const rpc = rpcFor(p);
  const reads = await Promise.allSettled([
    rpc.request("account/usage/read", {}).then((res) => patchUsage(p, { days: usageDays(res.dailyUsageBuckets), streaks: usageStreaks(res.summary) })),
    // Ret's own; an engine that doesn't know it (an older Ret on a paired device) just has no activity.
    rpc.call<UsageActivity>("ret/usage/activity", {}).then((activity) => patchUsage(p, { activity })),
  ]);
  usageReads.delete(p);
  // Neither is available for this engine or sign-in.
  if (reads.every((r) => r.status === "rejected")) patchProvider(p, { tokenUsage: held?.at ? { ...held, loading: false } : null });
  else patchUsage(p, { at: Date.now(), loading: false });
}

/** Values from the provider's own config that new threads inherit, for showing what "no override" means. */
export async function loadConfigDefaults(p: EngineId) {
  try {
    const res = (await rpcFor(p).request("config/read", {})) as { config?: Record<string, unknown> };
    const c = res.config ?? {};
    patchProvider(p, {
      defaults: {
        model: typeof c.model === "string" ? c.model : null,
        effort: typeof c.model_reasoning_effort === "string" ? c.model_reasoning_effort : null,
        serviceTier: typeof c.service_tier === "string" ? c.service_tier : null,
      },
    });
  } catch (err) {
    console.warn(`${p}: config/read failed`, err);
  }
}

export async function loadModels(p: EngineId) {
  try {
    const res = await rpcFor(p).request("model/list", { limit: 100 });
    patchProvider(p, { models: res.data.filter((m) => !m.hidden) });
  } catch (err) {
    console.warn(`${p}: model/list failed`, err);
  }
  try {
    const res = (await rpcFor(p).request("collaborationMode/list", {})) as { data: ProviderConn["modes"] };
    patchProvider(p, { modes: res.data });
  } catch {
    /* an engine without collaboration modes */
  }
}

/**
 * Sign in. Codex signs in inside Ret (ChatGPT in the browser, or a device code); other
 * providers sign in with their own CLI in a terminal, and Ret watches for it to finish.
 */
async function startLoginImpl(p: ProviderId, kind: "browser" | "device" = "browser") {
  if (!PROVIDERS[p].inAppLogin) {
    await bridge.agents.openLogin(p);
    patchProvider(p, { login: { loginId: "terminal", kind: "terminal" } });
    void watchTerminalLogin(p);
    return;
  }
  const res = await rpcFor(p).request("account/login/start", kind === "browser" ? { type: "chatgpt" } : { type: "chatgptDeviceCode" });
  if (res.type === "chatgpt") {
    patchProvider(p, { login: { loginId: res.loginId, kind, authUrl: res.authUrl } });
    await bridge.shell.openExternal(res.authUrl);
  } else if (res.type === "chatgptDeviceCode") {
    patchProvider(p, { login: { loginId: res.loginId, kind, verificationUrl: res.verificationUrl, userCode: res.userCode } });
    await bridge.shell.openExternal(res.verificationUrl);
  }
}

/** Poll until the provider's CLI reports a sign-in (or the flow is cancelled, or it gives up). */
async function watchTerminalLogin(p: ProviderId) {
  const until = Date.now() + 5 * 60_000;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 3000));
    if (useConn.getState().providers[p].login?.kind !== "terminal") return;
    await loadAccount(p);
    if (signedIn(useConn.getState().providers[p])) {
      patchProvider(p, { login: null });
      void loadModels(p);
      void loadRateLimits(p);
      return;
    }
  }
  patchProvider(p, (c) => ({
    login: c.login?.kind === "terminal" ? { ...c.login, error: "Still not signed in. Finish in the terminal, then check again." } : c.login,
  }));
}

export async function cancelLogin(p: ProviderId) {
  const login = useConn.getState().providers[p].login;
  patchProvider(p, { login: null });
  if (login && login.kind !== "terminal") await rpcFor(p).request("account/login/cancel", { loginId: login.loginId }).catch(() => {});
}

async function logoutImpl(p: ProviderId) {
  await rpcFor(p).request("account/logout", undefined as never);
  await loadAccount(p);
}

// ---------------------------------------------------------------------------
// Thread list & history
// ---------------------------------------------------------------------------

const listing = new Map<EngineId, Promise<void>>();
/** Engines whose thread list has loaded (or failed) at least once: their threads' owners are known. */
const listed = new Set<EngineId>();
const ownerWaiters = new Set<() => void>();
const wakeOwnerWaiters = () => {
  for (const w of [...ownerWaiters]) w();
};
useThreads.subscribe((s, prev) => {
  if (s.owner !== prev.owner) wakeOwnerWaiters();
});
// Paired devices turning up, or their engines coming up or failing, settle who owns what too.
useHosts.subscribe(wakeOwnerWaiters);
useConn.subscribe((s, prev) => {
  if (s.providers !== prev.providers) wakeOwnerWaiters();
});

/**
 * The provider a thread lives in. A thread restored from the last session (a tab, a canvas window)
 * can ask before the thread lists say who owns it; then this waits for them rather than guessing.
 */
export async function ownerFor(threadId: string): Promise<EngineId> {
  const known = () => useThreads.getState().owner[threadId];
  // Paired devices are known a moment after start, and their lists after they connect.
  const settled = () => !!known() || (useHosts.getState().loaded && listedEngines().every((p) => listed.has(p)));
  if (!settled()) {
    await new Promise<void>((resolve) => {
      const timer = window.setTimeout(done, 30_000);
      function done() {
        ownerWaiters.delete(check);
        clearTimeout(timer);
        resolve();
      }
      function check() {
        if (settled()) done();
      }
      ownerWaiters.add(check);
    });
  }
  return known() ?? "codex";
}
/** Refresh the thread list from every engine (or just `only`), and the workspaces that group it. */
export function loadThreadList(only?: EngineId): Promise<void> {
  const ps = only ? [only] : listedEngines();
  for (const p of ps) void loadWorkspaces(p);
  return Promise.all(ps.map(listProvider)).then(() => {});
}

/** Folders already asked about this session, worktree or not. */
const askedCheckouts = new Set<string>();

/**
 * Find the threads running in linked git worktrees, so they group with their main checkout. Each
 * device is asked about its own folders; a paired device's are recorded under its key.
 */
async function resolveCheckouts() {
  const known = useUI.getState().checkouts;
  const { threads, owner } = useThreads.getState();
  const byHost = new Map<string | null, Set<string>>();
  for (const t of Object.values(threads)) {
    const host = hostOf(owner[t.id] ?? "codex");
    const key = scopedKey(host, t.cwd);
    if (!t.cwd || known[key] || askedCheckouts.has(key)) continue;
    askedCheckouts.add(key);
    let set = byHost.get(host);
    if (!set) byHost.set(host, (set = new Set()));
    set.add(t.cwd);
  }
  await Promise.all(
    [...byHost].map(async ([host, cwds]) => {
      const found = await bridge.git.mainCheckouts([...cwds], host).catch(() => ({}) as Record<string, string>);
      const scoped = Object.fromEntries(Object.entries(found).map(([dir, main]) => [scopedKey(host, dir), main]));
      if (Object.keys(scoped).length) useUI.setState((s) => ({ checkouts: { ...s.checkouts, ...scoped } }));
    }),
  );
}

/**
 * The engine's named workspaces (the ChatGPT and Codex apps' projects). Their apps run engines
 * of their own, so a change made there only shows up on the next refresh.
 */
async function loadWorkspaces(p: EngineId) {
  if (!PROVIDERS[providerOf(p)].workspaces) return;
  const host = hostOf(p);
  try {
    const all: Workspace[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page++) {
      const res: import("@shared/protocol/generated/v2").ProjectListResponse = await rpcFor(p).request("project/list", { cursor, limit: 100 });
      all.push(...res.data.map((w) => ({ id: w.id, name: w.name, roots: w.roots.map((r) => r.path), ...(host ? { host } : {}) })));
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    // Each device's workspaces replace only that device's.
    const cur = useThreads.getState().workspaces;
    const mine = cur.filter((w) => (w.host ?? null) === host);
    if (JSON.stringify(mine) !== JSON.stringify(all)) useThreads.setState({ workspaces: [...cur.filter((w) => (w.host ?? null) !== host), ...all] });
  } catch (err) {
    console.warn(`${p}: project/list failed`, err);
  }
}

/** How many of the latest threads to ask for their agents by ancestor (see listSubagents). */
const AGENT_PARENTS = 30;

/**
 * Spawned agents, which a plain `thread/list` leaves out. Asking by source finds the older kind;
 * the newer kind (agents with a path, like /root/pong) only turns up when asked for by ancestor, so
 * the latest threads are asked, those that changed since they last were. Older threads' agents
 * appear when the thread is opened (mergeTurns). Only agents whose parent is known too: one on its
 * own, cut off from what it was doing, is just noise.
 */
async function listSubagents(p: EngineId, parents: Thread[]): Promise<Thread[]> {
  const agents: Thread[] = [];
  let cursor: string | null = null;
  try {
    for (let page = 0; page < 10; page++) {
      const res: import("@shared/protocol").ThreadListResponse = await rpcFor(p).request("thread/list", {
        limit: 100,
        cursor,
        sortKey: "updated_at",
        useStateDbOnly: true,
        sourceKinds: ["subAgentThreadSpawn"],
      });
      agents.push(...res.data);
      cursor = res.nextCursor;
      if (!cursor) break;
    }
  } catch (err) {
    console.warn(`${p}: couldn't list subagents`, err);
  }
  const recent = parents
    .filter((t) => !spawnedBy(t) && agentsUnasked(t))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, AGENT_PARENTS);
  const seen = new Set(agents.map((t) => t.id));
  for (const t of await listAgentsOf(p, recent)) if (!seen.has(t.id)) seen.add(t.id), agents.push(t);
  const known = new Set([...parents.map((t) => t.id), ...Object.keys(useThreads.getState().threads)]);
  // Agents spawn agents: keep adding while a pass finds more whose parent is in.
  const out: Thread[] = [];
  let rest = agents;
  for (let added = true; added; ) {
    added = false;
    rest = rest.filter((t) => {
      if (!known.has(spawnedBy(t)!)) return true;
      known.add(t.id);
      out.push(t);
      added = true;
      return false;
    });
  }
  return out;
}

function listProvider(p: EngineId): Promise<void> {
  const inflight = listing.get(p);
  if (inflight) return inflight;
  const run = (async () => {
    const all: Thread[] = [];
    let cursor: string | null = null;
    try {
      for (let page = 0; page < 20; page++) {
        const res: import("@shared/protocol").ThreadListResponse = await rpcFor(p).request("thread/list", {
          limit: 100,
          cursor,
          sortKey: "updated_at",
          useStateDbOnly: true,
        });
        all.push(...res.data);
        cursor = res.nextCursor;
        if (!cursor) break;
        if (page === 0) upsertThreads(p, all); // paint the sidebar after the first page
      }
      // Replace this provider's threads rather than merge, so archived/deleted ones disappear.
      const st = useThreads.getState();
      const mine = (id: string) => (st.owner[id] ?? "codex") === p;
      const next: Record<string, Thread> = {};
      const owner = { ...st.owner };
      for (const [id, t] of Object.entries(st.threads)) if (!mine(id)) next[id] = t;
      for (const t of all) {
        next[t.id] = mergeThread(st.threads[t.id], { ...t, turns: [] });
        owner[t.id] = p;
      }
      // Keep threads we know about that the list doesn't return (ephemeral forks, brand-new threads),
      // and agents met by opening an older thread, which the list only finds for the latest ones.
      for (const [id, t] of Object.entries(st.threads)) {
        if (next[id] || !mine(id)) continue;
        const parent = spawnedBy(t);
        if (t.ephemeral || Date.now() / 1000 - t.createdAt < 120 || (parent && next[parent])) next[id] = t;
      }
      useThreads.setState({ threads: next, owner, listLoaded: true });
      // The list leaves out fork lineage; fill it in so forks nest and link to their parents.
      // (A subagent's source already names its parent.)
      void backfillLineage(all.filter((t) => !spawnedBy(t)).map((t) => t.id));
      // Then the agents, which take a few more lists: the sidebar shows what it has meanwhile.
      if (agentOf(p).subagentThreads) {
        void listSubagents(p, all).then((agents) => {
          if (agents.length) upsertThreads(p, agents);
        });
      }
    } catch (err) {
      console.error(`${p}: thread/list failed`, err);
      useThreads.setState({ listLoaded: true });
    } finally {
      listing.delete(p);
      listed.add(p);
      for (const w of [...ownerWaiters]) w();
    }
  })();
  listing.set(p, run);
  return run;
}

const HISTORY_PAGE = 12;

export async function hydrateThread(threadId: string) {
  if (!isThread(threadId)) return;
  const lt = useThreads.getState().live[threadId];
  if (lt?.hydrated || lt?.hydrating) return;
  patchLive(threadId, { hydrating: true, error: null });
  try {
    const res = await rpcFor(await ownerFor(threadId)).request("thread/turns/list", {
      threadId,
      limit: HISTORY_PAGE,
      sortDirection: "desc",
      itemsView: "full",
    });
    mergeTurns(threadId, res.data, res.nextCursor, "replace");
    void loadGoal(threadId);
    // Resume it in its engine: that's what reports the thread's own settings (model, effort, speed,
    // access, Plan) for the composer, and subscribes to live events if it's running here. Not while
    // another app is running it: watching it is all Ret does then.
    if (!useThreads.getState().external[threadId]) void ensureSubscribed(threadId).catch(() => {});
  } catch (err) {
    patchLive(threadId, { hydrating: false, error: (err as Error).message });
  }
}

export async function loadOlder(threadId: string) {
  const lt = useThreads.getState().live[threadId];
  if (!lt?.olderCursor || lt.loadingOlder) return;
  patchLive(threadId, { loadingOlder: true });
  try {
    const res = await rpcFor(await ownerFor(threadId)).request("thread/turns/list", {
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
  turnsDesc: import("@shared/protocol").Turn[],
  cursor: string | null,
  mode: "replace" | "prepend" | "tail",
) {
  // Computer-use steps leave their screenshots with the screens, in one update for the lot.
  turnsDesc = captureTurns(threadId, turnsDesc);
  const st = useThreads.getState();
  const external = !!st.external[threadId];
  const threadActive = st.threads[threadId]?.status.type === "active" || external;
  // Agents it started that the sidebar hasn't met (Codex lists its newer agents only by parent).
  const owner = st.owner[threadId] ?? "codex";
  if (agentOf(owner).subagentThreads) {
    const unknown = new Set<string>();
    for (const t of turnsDesc) for (const it of t.items ?? []) if (it.type === "subAgentActivity" && !st.threads[it.agentThreadId]) unknown.add(it.agentThreadId);
    for (const id of unknown) discoverThread(owner, id);
  }
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
    const p = await ownerFor(threadId);
    const res = await rpcFor(p).request("thread/resume", { threadId, excludeTurns: true });
    upsertThreads(p, [res.thread]);
    patchLive(threadId, {
      subscribed: true,
      settings: settingsFrom(res),
    });
    if (!useThreads.getState().live[threadId]?.hydrated) await hydrateThread(threadId);
  })().finally(() => resuming.delete(threadId));
  resuming.set(threadId, p);
  return p;
}

/** Engines that said they have no goals this connection (the feature off in their config): not asked again until they reconnect. */
const goalsOff = new Set<EngineId>();

/**
 * Fetch a thread's goal. Live events keep it current while the thread runs here; one running in
 * another app only changes on disk, so that's re-read whenever its transcript is.
 */
export async function loadGoal(threadId: string) {
  const p = await ownerFor(threadId);
  if (!agentOf(p).goals || goalsOff.has(p)) return;
  const mark = goalMark(threadId);
  try {
    const res = await rpcFor(p).request("thread/goal/get", { threadId });
    setGoal(threadId, res.goal, mark);
  } catch (err) {
    if (/disabled|not enabled|unknown variant/i.test((err as Error).message)) goalsOff.add(p);
    else console.warn("goal fetch failed", err);
  }
}

// Changing a goal acts on the thread in its engine, so it's loaded there first: a goal resumed on a
// thread that isn't would only be saved, with nothing to pick it up.
async function setGoalStatusImpl(threadId: string, status: "active" | "paused") {
  await ensureSubscribed(threadId);
  const res = await rpcFor(ownerOf(threadId)).request("thread/goal/set", { threadId, status, origin: "user" });
  setGoal(threadId, res.goal);
}

async function clearGoalImpl(threadId: string) {
  await ensureSubscribed(threadId);
  await rpcFor(ownerOf(threadId)).request("thread/goal/clear", { threadId, origin: "user" });
  setGoal(threadId, null);
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------

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
  /** One of the provider's access options (see agents.ts). Undefined keeps the thread's. */
  access?: string;
  /** Service tier id: "default" (standard), "priority" (Fast), "ultrafast". Undefined keeps the thread's. */
  speed?: string;
  /** Collaboration mode: "plan" thinks it through, asks questions, and proposes a plan first. Undefined keeps the thread's. */
  mode?: "plan" | "default";
}

/**
 * The collaboration mode to send with a turn. A mode carries its own model and effort (and wins
 * over the turn's), so it gets the ones you picked, or the mode's suggestions, or the thread's.
 */
function collaborationFor(threadId: string, engine: EngineId, prefs: TurnOverrides) {
  if (!prefs.mode) return undefined;
  const conn = useConn.getState().providers[engine] ?? emptyProviderConn();
  const preset = conn.modes.find((m) => m.mode === prefs.mode);
  const live = useThreads.getState().live[threadId]?.settings;
  const model =
    prefs.model ?? preset?.model ?? live?.model ?? useThreads.getState().threads[threadId]?.model ?? conn.defaults.model ?? conn.models.find((m) => m.isDefault)?.model;
  if (!model) return undefined;
  const effort = prefs.effort ?? preset?.reasoning_effort ?? live?.effort ?? null;
  return { mode: prefs.mode, settings: { model, reasoning_effort: effort as never, developer_instructions: null } };
}

/** Sends a message to a thread (starting it first if `target` is a draft). Returns the real thread id. */
/**
 * Sends a message to a thread (starting it first if `target` is a draft). Returns the real thread id.
 * While one of our turns is running:
 * - "steer" injects it into that turn — unless the turn is already writing its final answer, where
 *   Codex drops late steers; then it goes out as the next turn the moment the summary finishes;
 * - "queue" / "auto" hold it and send it as the next turn once the current one ends.
 */
export async function sendMessage(
  target: string,
  text: string,
  attachments: Attachment[] = [],
  prefs: TurnOverrides = {},
  how: "auto" | "steer" | "queue" = "auto",
): Promise<string> {
  const ui = useUI.getState();
  const input = buildInput(text, attachments);
  if (!input.length) return target;

  if (!isDraft(target)) {
    flushNow();
    const live = useThreads.getState().live[target];
    if (live?.activeTurnId) {
      const finishing = how === "steer" && isWritingFinalAnswer(live);
      if (how !== "steer" || finishing) {
        enqueueMessage(target, { id: crypto.randomUUID(), text, attachments, prefs });
        return target;
      }
    }
  }

  let threadId = target;
  const provider = isDraft(target) ? draftEngine(target) : await ownerFor(target);
  const agent = PROVIDERS[providerOf(provider)];
  const access = prefs.access ? accessFor(providerOf(provider), prefs.access) : undefined;
  if (isDraft(target)) {
    const draft = ui.drafts[target];
    if (!draft) throw new Error("Draft no longer exists");
    const res = await rpcFor(provider).request("thread/start", {
      cwd: draft.cwd,
      model: prefs.model ?? null,
      ...(prefs.speed ? { serviceTier: prefs.speed } : {}),
      ...agent.threadAccess(access ?? "config"),
    });
    threadId = res.thread.id;
    upsertThreads(provider, [res.thread]);
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
    const host = hostOfKey(draft.projectKey);
    if (draft.projectKey !== scopedKey(host, normPath(draft.cwd, hostPlatform(host)))) {
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
    const collaboration = collaborationFor(threadId, provider, prefs);
    const start = () =>
      rpcFor(provider).request("turn/start", {
        threadId,
        input,
        clientUserMessageId: clientId,
        model: prefs.model ?? null,
        effort: prefs.effort ?? null,
        ...(prefs.speed ? { serviceTier: prefs.speed } : {}),
        ...(collaboration ? { collaborationMode: collaboration } : {}),
        ...(access ? agent.turnAccess(access) : {}),
      });
    if (lt?.activeTurnId && how === "steer") {
      const expected = lt.activeTurnId;
      try {
        await rpcFor(provider).request("turn/steer", { threadId, input, expectedTurnId: expected, clientUserMessageId: clientId });
      } catch (err) {
        // Sent just as the turn finished: steering has nothing to join, so start a new turn instead.
        flushNow();
        if (useThreads.getState().live[threadId]?.activeTurnId === expected) throw err;
        await start();
      }
    } else {
      await start();
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
  collaborationMode?: { mode: "plan" | "default" } | null;
}): ThreadSettings {
  return {
    model: res.model,
    effort: res.reasoningEffort,
    serviceTier: res.serviceTier,
    approvalPolicy: res.approvalPolicy,
    sandbox: res.sandbox,
    cwd: res.cwd,
    mode: res.collaborationMode?.mode ?? null,
    access: typeof (res as unknown as { access?: unknown }).access === "string" ? (res as unknown as { access: string }).access : null,
  };
}

/** The agent a draft will start its thread with (of those on the device its project is on). */
export function draftProvider(draftId: string): ProviderId {
  const ui = useUI.getState();
  const draft = ui.drafts[draftId];
  return pickProvider(enabledProvidersOn(draft ? hostOfKey(draft.projectKey) : null), draft?.provider, ui.lastAgent);
}

/** The engine a draft will start its thread in: its agent, on its project's device. */
export function draftEngine(draftId: string): EngineId {
  const draft = useUI.getState().drafts[draftId];
  return engineId(draftProvider(draftId), draft ? hostOfKey(draft.projectKey) : null);
}

/**
 * True once the running turn has started streaming its final answer (a steer then goes unanswered).
 * An async question is phased as a final answer too, but the turn carries on after it.
 */
export function isWritingFinalAnswer(lt: LiveThread): boolean {
  const turn = lt.activeTurnId ? lt.turns[lt.activeTurnId] : undefined;
  const last = turn ? lt.items[turn.itemIds[turn.itemIds.length - 1]] : undefined;
  return last?.type === "agentMessage" && last.phase === "final_answer" && last.delivery !== "async";
}

function enqueueMessage(threadId: string, msg: QueuedMessage) {
  useThreads.setState((s) => ({ queued: { ...s.queued, [threadId]: [...(s.queued[threadId] ?? []), msg] } }));
}

function takeQueued(threadId: string, id?: string): QueuedMessage | undefined {
  const list = useThreads.getState().queued[threadId] ?? [];
  const msg = id ? list.find((m) => m.id === id) : list[0];
  if (!msg) return undefined;
  useThreads.setState((s) => {
    const rest = (s.queued[threadId] ?? []).filter((m) => m.id !== msg.id);
    const queued = { ...s.queued };
    if (rest.length) queued[threadId] = rest;
    else delete queued[threadId];
    return { queued };
  });
  return msg;
}

/** Start the next queued follow-up if the thread is idle. */
async function drainQueue(threadId: string) {
  flushNow();
  if (useThreads.getState().live[threadId]?.activeTurnId) return;
  const msg = takeQueued(threadId);
  if (!msg) return;
  try {
    await sendMessage(threadId, msg.text, msg.attachments, msg.prefs);
  } catch (err) {
    enqueueMessage(threadId, msg); // keep it; the error is already shown on the thread
    toast(`Couldn't send queued message: ${(err as Error).message}`, "error");
  }
}

/** Queued message actions: send it into the running turn now, drop it, or take it back to edit. */
export function steerQueued(threadId: string, id: string) {
  const msg = takeQueued(threadId, id);
  if (msg) void sendMessage(threadId, msg.text, msg.attachments, msg.prefs, "steer").catch((err) => toast(err.message, "error"));
}

export function discardQueued(threadId: string, id: string) {
  takeQueued(threadId, id);
}

export function editQueued(threadId: string, id: string) {
  const msg = takeQueued(threadId, id);
  if (msg) fillComposer(threadId, msg.text, { focus: true });
}

/** Re-send a message that reached a turn too late to be answered, as a fresh turn. */
export function resendUnanswered(threadId: string, item: Extract<ThreadItem, { type: "userMessage" }>) {
  const text = item.content.map((c) => (c.type === "text" ? c.text : "")).join("\n").trim();
  const attachments: Attachment[] = item.content.flatMap((c) =>
    c.type === "localImage" ? [{ path: c.path, name: c.path.split(/[\\/]/).pop() ?? "image" }] : [],
  );
  void sendMessage(threadId, text, attachments).catch((err) => toast(`Couldn't send: ${err.message}`, "error"));
}

export async function interrupt(threadId: string) {
  const lt = useThreads.getState().live[threadId];
  if (!lt?.activeTurnId) return;
  await rpcFor(ownerOf(threadId)).request("turn/interrupt", { threadId, turnId: lt.activeTurnId }).catch((err) => patchLive(threadId, { error: err.message }));
}

export function respondToRequest(key: string, result: unknown) {
  const req = useThreads.getState().requests[key];
  if (!req) return;
  rpcFor(req.engine).respond(req.id, result);
  removePendingRequest(key);
}

async function renameThreadImpl(threadId: string, name: string) {
  cancelTitle(threadId);
  await rpcFor(ownerOf(threadId)).request("thread/name/set", { threadId, name });
  useThreads.setState((s) => (s.threads[threadId] ? { threads: { ...s.threads, [threadId]: { ...s.threads[threadId], name } } } : s));
}

async function archiveThreadImpl(threadId: string) {
  await rpcFor(ownerOf(threadId)).request("thread/archive", { threadId });
  closeEverywhere(threadId);
  useThreads.setState((s) => {
    const threads = { ...s.threads };
    delete threads[threadId];
    return { threads };
  });
}

async function compactThreadImpl(threadId: string) {
  await ensureSubscribed(threadId);
  await rpcFor(ownerOf(threadId)).request("thread/compact/start", { threadId });
}

// ---------------------------------------------------------------------------
// Forking
// ---------------------------------------------------------------------------

export interface ForkOptions {
  /** Fork through this turn (inclusive); later turns are dropped from the fork. */
  atTurnId?: string;
  /** Give the fork its own git worktree so its file edits are isolated. */
  worktree?: boolean;
  /** Start the fork's composer with this text (focused, ready to keep typing). */
  prompt?: string;
}

async function forkThreadImpl(threadId: string, opts: ForkOptions = {}): Promise<string> {
  const source = useThreads.getState().threads[threadId];
  if (!source) throw new Error("Unknown thread");
  const projectKey = projectKeyNow(source);

  const worktree = opts.worktree ? await bridge.git.createWorktree(source.cwd, threadTitle(source), hostOfThread(threadId)) : undefined;
  const cwd = worktree?.path;

  const provider = ownerOf(threadId);
  const res = await rpcFor(provider).request("thread/fork", {
    threadId,
    lastTurnId: opts.atTurnId ?? null,
    cwd: cwd ?? null,
    excludeTurns: true,
    // A fork carries the thread's goal, but waits for you to say something before working on it.
    ...(agentOf(provider).goals ? { deferGoalContinuation: true } : {}),
  });
  const fork = res.thread;
  lineageKnown(fork.id);
  upsertThreads(provider, [fork]);
  useThreads.setState((s) => ({
    live: { ...s.live, [fork.id]: { ...emptyLive(), subscribed: true, settings: settingsFrom(res) } },
  }));
  useUI.setState((s) => ({
    threadProject: { ...s.threadProject, [fork.id]: projectKey },
    worktrees: worktree ? { ...s.worktrees, [fork.id]: worktree } : s.worktrees,
    expanded: { ...s.expanded, [rootOf(threadId)]: true, [threadId]: true },
  }));
  void hydrateThread(fork.id);
  if (opts.prompt) fillComposer(fork.id, opts.prompt, { focus: true });
  openThread(fork.id, { besideThread: threadId, side: true });
  return fork.id;
}

function rootOf(threadId: string): string {
  return lineageRoot(useThreads.getState().threads, threadId);
}

// ---------------------------------------------------------------------------
// Opening / closing views (focus tabs and canvas windows)
// ---------------------------------------------------------------------------

/** New draft in the same project as `fromThreadId` (or the palette if there's no context). */
export function newThreadNear(fromThreadId: string | null) {
  const ui = useUI.getState();
  if (fromThreadId && isDraft(fromThreadId)) {
    const d = ui.drafts[fromThreadId];
    if (d) newThread(d.projectKey, d.cwd, { provider: d.provider });
    return;
  }
  const t = fromThreadId ? useThreads.getState().threads[fromThreadId] : undefined;
  if (!t) {
    useUI.setState({ paletteOpen: true });
    return;
  }
  const key = projectKeyNow(t);
  newThread(key, ui.projects[key]?.path ?? t.cwd, { provider: providerOf(ownerOf(t.id)) });
}

/**
 * A new, not-yet-started thread, on the device `projectKey` is on. Its provider defaults to
 * Settings' choice; the composer can change it.
 */
export function newThread(projectKey: string, cwd: string, opts: OpenOptions & { provider?: ProviderId } = {}) {
  const id = `draft:${newId()}`;
  const provider = opts.provider;
  useUI.setState((s) => ({ drafts: { ...s.drafts, [id]: { cwd, projectKey, createdAt: Date.now(), ...(provider ? { provider } : {}) } } }));
  openThread(id, opts);
  return id;
}

/** Switch a draft to another provider (before its first message). */
export function setDraftProvider(draftId: string, provider: ProviderId) {
  useUI.setState((s) => (s.drafts[draftId] ? { drafts: { ...s.drafts, [draftId]: { ...s.drafts[draftId], provider } } } : s));
}

/** Point a not-yet-started thread at a different project folder. */
export function retargetDraft(draftId: string, projectKey: string, cwd: string) {
  useUI.setState((s) => (s.drafts[draftId] ? { drafts: { ...s.drafts, [draftId]: { ...s.drafts[draftId], projectKey, cwd } } } : s));
}

const MAX_TABS = 14;

export interface OpenOptions {
  /** Canvas: place next to this thread's window. Focus: insert the tab after it / pair with it. */
  besideThread?: string;
  mode?: ViewMode;
  /** Focus: show beside the active tab (or besideThread) in a split instead of a new tab. */
  side?: boolean;
  /** Canvas: world position for the new window's top-left. */
  at?: { x: number; y: number };
}

/**
 * Open a file as its own view next to the thread it came from: the other side of a split in
 * Focus mode, a window beside the thread's on the canvas. Already open: brought forward and
 * taken to `line`.
 */
export function openFile(path: string, opts: { line?: number; col?: number; from?: string | null; host?: string | null } = {}) {
  // On the device it came from: the thread's, unless said otherwise.
  const host = opts.host !== undefined ? opts.host : opts.from && !isFile(opts.from) && !isDraft(opts.from) ? hostOfThread(opts.from) : null;
  // One view per file, however the path was written (C:/a/b vs C:\a\b).
  const norm = hostPlatform(host) === "win32" ? path.replace(/\//g, "\\") : path;
  const id = fileId(norm, host);
  useFiles.setState((s) => ({ targets: { ...s.targets, [id]: { line: opts.line, col: opts.col, n: (s.targets[id]?.n ?? 0) + 1 } } }));
  const ui = useUI.getState();
  const from = opts.from && !isFile(opts.from) ? opts.from : undefined;
  // Code mode is where files live; opening one from the inbox goes there too.
  if (ui.mode === "code" || ui.mode === "inbox") {
    useUI.setState((st) => ({
      mode: "code",
      code: { ...st.code, tabs: st.code.tabs.includes(id) ? st.code.tabs : [...st.code.tabs, id], active: id, chat: from ?? st.code.chat },
    }));
    return;
  }
  if (ui.mode === "canvas") {
    const codeWin = activeBoard().windows.find((w) => w.threadId === appId("code"));
    if (codeWin) {
      useUI.setState((st) => ({ code: { ...st.code, tabs: st.code.tabs.includes(id) ? st.code.tabs : [...st.code.tabs, id], active: id, chat: from ?? st.code.chat } }));
      focusWindow(codeWin.id, true);
      return;
    }
    openThread(id, { besideThread: from });
    return;
  }
  // Already showing (as a tab or beside something): go to it rather than rearranging the view.
  const shownBeside = Object.entries(ui.splits).find(([left, sp]) => sp.right === id && ui.tabs.includes(left))?.[0];
  if (ui.tabs.includes(id) || shownBeside) {
    openThread(id);
    return;
  }
  openThread(id, { side: true, besideThread: from ?? (ui.activeTab && !isFile(ui.activeTab) ? ui.activeTab : undefined) });
}

export function openThread(threadId: string, opts: OpenOptions = {}) {
  const ui = useUI.getState();
  const mode = opts.mode ?? ui.mode;
  void hydrateThread(threadId);

  // Code mode: a thread goes in the chat column (a file goes in an editor tab).
  if (mode === "code") {
    if (isFile(threadId)) {
      useUI.setState((s) => ({ code: { ...s.code, tabs: s.code.tabs.includes(threadId) ? s.code.tabs : [...s.code.tabs, threadId], active: threadId } }));
    } else {
      useUI.setState((s) => ({ code: { ...s.code, chat: threadId, project: null } }));
    }
    return;
  }
  // Inbox mode: show it in the reading pane.
  if (mode === "inbox" && !isFile(threadId)) {
    useUI.setState((s) => ({ inbox: { ...s.inbox, selected: threadId } }));
    return;
  }

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
  const size = isApp(threadId) ? (appKind(threadId) === "code" ? { w: 1240, h: 760 } : { w: 980, h: 680 }) : { w: 560, h: 640 };
  const pos = opts.at
    ? clampToView(opts.at, isApp(threadId) ? size.w : (besideWin?.w ?? size.w), isApp(threadId) ? size.h : (besideWin?.h ?? size.h), board.viewport)
    : besideWin
      ? freeSpot(board.windows, besideWin.x + besideWin.w + 24, besideWin.y, besideWin.w, besideWin.h)
      : freeSpotInView(board.windows, board.viewport, size.w, size.h);
  const win: CanvasWin = {
    id: newId(),
    threadId,
    x: pos.x,
    y: pos.y,
    w: isApp(threadId) ? size.w : (besideWin?.w ?? size.w),
    h: isApp(threadId) ? size.h : (besideWin?.h ?? size.h),
    z,
  };
  updateBoard((b) => ({ ...b, windows: [...b.windows, win] }));
  useUI.setState({ focusedWindow: win.id });
  window.dispatchEvent(new CustomEvent("ret:reveal-window", { detail: win.id }));
}

/** Close a file tab in Code mode (its unsaved edits are kept for when it's reopened). */
export function closeCodeTab(id: string) {
  useUI.setState((s) => {
    const i = s.code.tabs.indexOf(id);
    if (i < 0) return s;
    const tabs = s.code.tabs.filter((t) => t !== id);
    const active = s.code.active === id ? (tabs[Math.min(i, tabs.length - 1)] ?? null) : s.code.active;
    return { code: { ...s.code, tabs, active } };
  });
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
      // Whatever was beside it keeps a tab of its own rather than vanishing; except a file being
      // swapped for another file, which just takes its place (like a preview tab).
      const swappingFiles = prev && isFile(prev.right) && isFile(id);
      if (prev && prev.right !== id && !swappingFiles && !tabs.includes(prev.right)) tabs.splice(tabs.indexOf(left) + 1, 0, prev.right);
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
  const left = -vp.x / vp.zoom + 16;
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
  const vw = (el?.clientWidth ?? 1200) / vp.zoom;
  const vh = (el?.clientHeight ?? 800) / vp.zoom;
  const ox = -vp.x / vp.zoom;
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

/** Add a project folder: on this computer (picked), or on a paired device (typed: no file dialog reaches it). */
export async function addProject(path?: string, host: string | null = null) {
  const picked =
    path ??
    (host
      ? await (await import("../components/ui/Dialog")).promptText({
          title: `Add a project on ${hostName(host)}`,
          label: "Folder path",
          placeholder: `A full path on ${hostName(host)}`,
          confirmLabel: "Add",
        })
      : await bridge.dialog.pickFolder());
  if (!picked?.trim()) return null;
  const key = scopedKey(host, normPath(picked.trim(), hostPlatform(host)));
  useUI.setState((s) => ({
    projects: { ...s.projects, [key]: { ...(s.projects[key] ?? {}), path: picked.trim(), addedAt: Date.now(), hidden: false, explicit: true } },
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
        // A parent whose agents still work isn't done: they report back to it.
        const working = (a: string) => !!st.live[a]?.activeTurnId || !!st.external[a] || st.threads[a]?.status.type === "active";
        const busy = lt?.activeTurnId || Object.values(st.requests).some((r) => r.threadId === id) || (st.agents[id] ?? []).some(working);
        if (st.visible[id] || !lt || busy) return;
        if (lt.subscribed) void rpcFor(ownerOf(id)).request("thread/unsubscribe", { threadId: id }).catch(() => {});
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
export const setGoalStatus = guarded("Couldn't update the goal", setGoalStatusImpl);
export const clearGoal = guarded("Couldn't clear the goal", clearGoalImpl);
