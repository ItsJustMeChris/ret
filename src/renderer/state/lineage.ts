import type { ProviderId } from "@shared/bridge";
import { rpcFor } from "../rpc/client";
import { flushNow, ownerOf, upsertThreads, useThreads } from "./threads";

/**
 * Fork lineage. `thread/list`, which fills the sidebar, never says which thread a fork came
 * from; `thread/read` without turns does, and costs next to nothing. So each thread's lineage
 * is read once in the background and merged in (and `mergeThread` keeps it from then on).
 */
const known = new Set<string>();
const inflight = new Set<string>();
const CONCURRENCY = 6;

export async function backfillLineage(ids: string[]): Promise<void> {
  const todo = ids.filter((id) => !known.has(id) && !inflight.has(id));
  if (!todo.length) return;
  todo.forEach((id) => inflight.add(id));
  const found: Record<string, { forkedFromId: string | null; parentThreadId: string | null }> = {};
  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const id = todo[next++];
      try {
        const res = await rpcFor(ownerOf(id)).request("thread/read", { threadId: id, includeTurns: false });
        const t = res.thread;
        if (t.forkedFromId || t.parentThreadId) found[id] = { forkedFromId: t.forkedFromId, parentThreadId: t.parentThreadId };
        known.add(id);
      } catch {
        known.add(id); // unreadable (e.g. its rollout is gone): don't keep retrying
      } finally {
        inflight.delete(id);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));

  // One store update for the lot, so the sidebar regroups once.
  if (!Object.keys(found).length) return;
  useThreads.setState((s) => {
    let threads = s.threads;
    for (const [id, l] of Object.entries(found)) {
      const t = threads[id];
      if (!t || (t.forkedFromId === l.forkedFromId && t.parentThreadId === l.parentThreadId)) continue;
      if (threads === s.threads) threads = { ...threads };
      threads[id] = { ...t, forkedFromId: l.forkedFromId ?? t.forkedFromId, parentThreadId: l.parentThreadId ?? t.parentThreadId };
    }
    return threads === s.threads ? s : { threads };
  });
}

/** Lineage that arrived with a full thread object (fork, read, resume) needs no lookup. */
export function lineageKnown(id: string) {
  known.add(id);
}

/**
 * Threads heard from before they're known. Codex announces nothing when an agent spawns a
 * subagent: the new thread's events just start arriving under its id. Read each one and add it,
 * so it shows up under its parent while it works. Right at the spawn its rollout may not be
 * written yet, so a failed read tries again a little later.
 */
const sought = new Set<string>();

export function discoverThread(provider: ProviderId, id: string | null | undefined) {
  if (!id || sought.has(id)) return;
  flushNow(); // its thread/started may still be queued
  if (useThreads.getState().threads[id]) return;
  sought.add(id);
  const attempt = (n: number) =>
    rpcFor(provider)
      .request("thread/read", { threadId: id, includeTurns: false })
      .then((res) => {
        known.add(id);
        upsertThreads(provider, [res.thread]);
      })
      .catch(() => {
        if (n < 3) setTimeout(() => void attempt(n + 1), 1000 * 2 ** n);
        else sought.delete(id); // let a later event try again
      });
  void attempt(0);
}
