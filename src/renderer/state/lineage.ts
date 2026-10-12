import { rpc } from "../rpc/client";
import { useThreads } from "./threads";

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
        const res = await rpc.request("thread/read", { threadId: id, includeTurns: false });
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
