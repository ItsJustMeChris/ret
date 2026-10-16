import { bridge } from "../bridge";
import { appHasFocus, onAppFocus } from "../lib/appFocus";
import { rpcFor } from "../rpc/client";
import { PROVIDER_IDS, providerOf, type EngineId } from "@shared/bridge";
import { PROVIDERS, agentOf } from "../agents";
import { useConn } from "./conn";
import { engineName, hostEngines, useHosts } from "./hosts";
import type { Thread } from "@shared/protocol";
import { loadGoal, mergeTurns } from "./actions";
import { lineageRoot, spawnedBy, threadTitle } from "./projects";
import { upsertThreads, useThreads, type ExternalRun } from "./threads";
import { agentsUnasked, backfillLineage, listAgentsOf } from "./lineage";

/**
 * Cross-client activity: the VS Code extension and the CLI each run a private
 * app-server, so their turns never reach ours as events. They do write to the
 * shared state database, though. Read from another process, a turn that hasn't
 * ended has no `completedAt` (the server reports it as "interrupted", since it isn't
 * running *here*), while the thread's `updatedAt` keeps moving as the owner works.
 * Polling that (≈10 ms per pass) lets Ret show those threads as running,
 * live-refresh them while you watch, and notify you when they finish.
 *
 * Claude Code's engine answers the same way: a session another claude process is busy
 * with (per Claude Code's session registry) has its last turn unfinished.
 *
 * A paired device's engines are watched the same way, for the apps running on that device.
 */

const POLL_FOCUSED_MS = 3000;
const POLL_BLURRED_MS = 12_000;
const TAIL_TURNS = 3;

const lastSeen = new Map<string, number>();
let timer = 0;
let polling = false;
let started = false;

const hooked = new Set<EngineId>();

/** Engines whose threads can be seen running in other apps, and are on and connected: here and on paired devices. */
function watched(): EngineId[] {
  const local = PROVIDER_IDS.filter((p) => useConn.getState().settings?.enabled[p] !== false);
  const remote = Object.keys(useHosts.getState().hosts).flatMap(hostEngines);
  return [...local, ...remote].filter((e) => {
    if (!PROVIDERS[providerOf(e)].external) return false;
    hook(e);
    return !!rpcFor(e).info;
  });
}

const kick = () => {
  clearTimeout(timer);
  void poll();
};

/** A fresh connection to an engine: look at all of its threads again, now. */
function hook(e: EngineId) {
  if (hooked.has(e)) return;
  hooked.add(e);
  rpcFor(e).onReady(() => {
    for (const [id, owner] of Object.entries(useThreads.getState().owner)) if (owner === e) lastSeen.delete(id);
    kick();
  });
}

export function startExternalWatcher() {
  if (started) return;
  started = true;
  onAppFocus(kick);
  watched();
  // A device paired later gets its engines watched from then on.
  useHosts.subscribe(() => watched());
}

function schedule() {
  clearTimeout(timer);
  timer = window.setTimeout(() => void poll(), appHasFocus() ? POLL_FOCUSED_MS : POLL_BLURRED_MS);
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    await Promise.all(watched().map((p) => pass(p).catch((err) => console.warn(`${p}: external activity poll failed`, err))));
  } catch (err) {
    console.warn("external activity poll failed", err);
  } finally {
    polling = false;
    schedule();
  }
}

/** The most threads whose agents one pass asks about (the rest wait for the next). */
const AGENT_ASKS = 5;

/**
 * The agents of threads at work in another app, which the plain list leaves out. A thread counts
 * when it changed since its agents were last asked for, while its turn runs elsewhere or it changed
 * lately (an agent can work on after its parent's turn ends); and so does, every pass, any thread
 * one of whose agents still runs elsewhere, to see that agent through. Threads loaded here need
 * none of this: their agents' events come here.
 */
async function agentsAtWork(p: EngineId, listed: Thread[], now: number): Promise<Thread[]> {
  const st = useThreads.getState();
  const quiet = agentOf(p).externalQuietS ?? 10 * 60;
  const due: Thread[] = [];
  const seen = new Set<string>();
  const add = (t: Thread | undefined) => {
    if (t && !seen.has(t.id)) seen.add(t.id), due.push(t);
  };
  // An agent at work elsewhere is only listed (and so checked on) through its root: those go first.
  for (const id of Object.keys(st.external)) if (st.owner[id] === p && spawnedBy(st.threads[id])) add(st.threads[lineageRoot(st.threads, id, spawnedBy)]);
  for (const t of listed) {
    if (spawnedBy(t) || t.status.type !== "notLoaded" || !agentsUnasked(t)) continue;
    if (st.external[t.id] || now - t.updatedAt < quiet) add(t);
  }
  return listAgentsOf(p, due.slice(0, AGENT_ASKS));
}

async function pass(p: EngineId) {
  const res = await rpcFor(p).request("thread/list", { limit: 40, sortKey: "updated_at", useStateDbOnly: true });
  const now = Date.now() / 1000;
  if (agentOf(p).subagentThreads) {
    const listed = new Set(res.data.map((t) => t.id));
    res.data.push(...(await agentsAtWork(p, res.data, now)).filter((t) => !listed.has(t.id)));
  }
  const st = useThreads.getState();

  // Pick up new threads and metadata changes made by other clients (only touch the store if something moved).
  const changed = res.data.filter((t) => {
    const cur = st.threads[t.id];
    return !cur || cur.updatedAt !== t.updatedAt || cur.status.type !== t.status.type || cur.name !== t.name;
  });
  if (changed.length) {
    upsertThreads(p, changed);
    // The list doesn't say which of the new ones are forks; look that up.
    const fresh = changed.filter((t) => !st.threads[t.id] && !spawnedBy(t)).map((t) => t.id);
    if (fresh.length) void backfillLineage(fresh);
  }

  const checks: { thread: Thread; moved: boolean }[] = [];
  for (const t of res.data) {
    const prev = lastSeen.get(t.id);
    lastSeen.set(t.id, t.updatedAt);
    const marked = !!st.external[t.id];
    // Loaded in our own app-server (dedicated or shared daemon): live events already cover it.
    if (t.status.type !== "notLoaded") {
      if (marked) setExternal(t.id, null);
      continue;
    }
    const quiet = PROVIDERS[providerOf(p)].externalQuietS;
    if (quiet != null && now - t.updatedAt > quiet) {
      // Stopped changing: finished without us seeing it, or the other process died mid-turn.
      if (marked) setExternal(t.id, null);
      continue;
    }
    const moved = prev !== undefined && prev !== t.updatedAt;
    if (prev === undefined || moved || marked) checks.push({ thread: t, moved });
  }
  await Promise.all(checks.map(({ thread, moved }) => check(p, thread, moved)));
}

async function check(p: EngineId, t: Thread, moved: boolean) {
  const res = await rpcFor(p).request("thread/turns/list", { threadId: t.id, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
  const last = res.data[0];
  const st = useThreads.getState();
  const was = st.external[t.id];
  // Our own turn (started from Ret) is tracked by live events, not here.
  if (st.live[t.id]?.activeTurnId) return;

  if (isUnfinished(last)) {
    setExternal(t.id, { turnId: last.id, lastActivity: t.updatedAt });
    if (!was || moved) refresh(p, t.id);
  } else if (was) {
    setExternal(t.id, null);
    refresh(p, t.id);
    // A subagent finishing is its parent's news, not yours (see delegated()).
    if (spawnedBy(t)) return;
    const visible = !!useThreads.getState().visible[t.id];
    if (!useThreads.getState().attended[t.id]) {
      useThreads.setState((s) => ({ unread: { ...s.unread, [t.id]: true } }));
    }
    if (!visible || !appHasFocus()) {
      bridge.notify(last?.status === "failed" ? "Turn failed elsewhere" : `${engineName(p)} finished elsewhere`, threadTitle(t));
    }
  } else if (moved) {
    // A turn came and went between two looks (say one a background task's end woke): nothing to
    // announce, but a transcript on screen is behind, perhaps still showing it as unfinished.
    refresh(p, t.id);
  }
}

/** No end recorded: still running in whichever process owns it (or that process died). */
export function isUnfinished(turn: { status: string; completedAt: number | null } | undefined): boolean {
  return !!turn && turn.completedAt == null && (turn.status === "inProgress" || turn.status === "interrupted");
}

function setExternal(threadId: string, run: ExternalRun | null) {
  useThreads.setState((s) => {
    if (!run && !s.external[threadId]) return s;
    const external = { ...s.external };
    if (run) external[threadId] = run;
    else delete external[threadId];
    return { external };
  });
}

/** Bring a thread's transcript up to date: re-fetch the newest turns if it's on screen, else drop the stale cache. */
function refresh(p: EngineId, threadId: string) {
  const st = useThreads.getState();
  const lt = st.live[threadId];
  if (!lt?.hydrated) return;
  if (!st.visible[threadId]) {
    useThreads.setState((s) => {
      const live = { ...s.live };
      delete live[threadId];
      return { live };
    });
    return;
  }
  void rpcFor(p)
    .request("thread/turns/list", { threadId, limit: TAIL_TURNS, sortDirection: "desc", itemsView: "full" })
    .then((res) => mergeTurns(threadId, res.data, null, "tail"))
    .catch((err) => console.warn("tail refresh failed", err));
  void loadGoal(threadId);
}
