import { bridge } from "../bridge";
import { rpc } from "../rpc/client";
import type { Thread } from "../protocol";
import { mergeTurns } from "./actions";
import { threadTitle } from "./projects";
import { stripTurns, useThreads, type ExternalRun } from "./threads";

/**
 * Cross-client activity: the VS Code extension and the CLI each run a private
 * app-server, so their turns never reach ours as events. They do write to the
 * shared state database, though. Read from another process, a turn that hasn't
 * ended has no `completedAt` (the server reports it as "interrupted", since it isn't
 * running *here*), while the thread's `updatedAt` keeps moving as the owner works.
 * Polling that (≈10 ms per pass) lets Ret show those threads as running,
 * live-refresh them while you watch, and notify you when they finish.
 */

const POLL_FOCUSED_MS = 3000;
const POLL_BLURRED_MS = 12_000;
/** An unfinished turn counts as running elsewhere only while its thread keeps changing. */
const ACTIVE_S = 10 * 60;
const TAIL_TURNS = 3;

const lastSeen = new Map<string, number>();
let timer = 0;
let polling = false;
let started = false;

export function startExternalWatcher() {
  if (started) return;
  started = true;
  const kick = () => {
    clearTimeout(timer);
    void poll();
  };
  window.addEventListener("focus", kick);
  rpc.onReady(() => {
    lastSeen.clear();
    kick();
  });
}

function schedule() {
  clearTimeout(timer);
  timer = window.setTimeout(() => void poll(), document.hasFocus() ? POLL_FOCUSED_MS : POLL_BLURRED_MS);
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    if (rpc.info) await pass();
  } catch (err) {
    console.warn("external activity poll failed", err);
  } finally {
    polling = false;
    schedule();
  }
}

async function pass() {
  const res = await rpc.request("thread/list", { limit: 40, sortKey: "updated_at", useStateDbOnly: true });
  const now = Date.now() / 1000;
  const st = useThreads.getState();

  // Pick up new threads and metadata changes made by other clients (only touch the store if something moved).
  const changed = res.data.filter((t) => {
    const cur = st.threads[t.id];
    return !cur || cur.updatedAt !== t.updatedAt || cur.status.type !== t.status.type || cur.name !== t.name;
  });
  if (changed.length) {
    useThreads.setState((s) => {
      const threads = { ...s.threads };
      for (const t of changed) threads[t.id] = { ...(threads[t.id] ?? {}), ...stripTurns(t) };
      return { threads };
    });
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
    if (now - t.updatedAt > ACTIVE_S) {
      // Stopped changing: finished without us seeing it, or the other process died mid-turn.
      if (marked) setExternal(t.id, null);
      continue;
    }
    const moved = prev !== undefined && prev !== t.updatedAt;
    if (prev === undefined || moved || marked) checks.push({ thread: t, moved });
  }
  await Promise.all(checks.map(({ thread, moved }) => check(thread, moved)));
}

async function check(t: Thread, moved: boolean) {
  const res = await rpc.request("thread/turns/list", { threadId: t.id, limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
  const last = res.data[0];
  const st = useThreads.getState();
  const was = st.external[t.id];
  // Our own turn (started from Ret) is tracked by live events, not here.
  if (st.live[t.id]?.activeTurnId) return;

  if (isUnfinished(last)) {
    setExternal(t.id, { turnId: last.id, lastActivity: t.updatedAt });
    if (!was || moved) refresh(t.id);
  } else if (was) {
    setExternal(t.id, null);
    refresh(t.id);
    const visible = !!useThreads.getState().visible[t.id];
    if (!visible) {
      useThreads.setState((s) => ({ unread: { ...s.unread, [t.id]: true } }));
    }
    if (!visible || !document.hasFocus()) {
      bridge.notify(last?.status === "failed" ? "Turn failed elsewhere" : "Codex finished elsewhere", threadTitle(t));
    }
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
function refresh(threadId: string) {
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
  void rpc
    .request("thread/turns/list", { threadId, limit: TAIL_TURNS, sortDirection: "desc", itemsView: "full" })
    .then((res) => mergeTurns(threadId, res.data, null, "tail"))
    .catch((err) => console.warn("tail refresh failed", err));
}
