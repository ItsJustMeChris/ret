import type { EngineId } from "@shared/bridge";
import type { Thread } from "@shared/protocol";
import { rpcFor } from "../rpc/client";
import { spawnedBy } from "./projects";
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
 * written yet, so a failed read tries again a little later. Only spawned agents are added: other
 * threads that run unannounced (reviews, compactions…) aren't the sidebar's, and aren't read again.
 */
const seeking = new Set<string>();
const notAgents = new Set<string>();

export function discoverThread(engine: EngineId, id: string | null | undefined) {
  if (!id || seeking.has(id) || notAgents.has(id) || useThreads.getState().threads[id]) return;
  flushNow(); // its thread/started may still be queued
  if (useThreads.getState().threads[id]) return;
  seeking.add(id);
  const attempt = (n: number) =>
    rpcFor(engine)
      .request("thread/read", { threadId: id, includeTurns: false })
      .then((res) => {
        seeking.delete(id);
        if (!spawnedBy(res.thread)) return void notAgents.add(id);
        known.add(id);
        upsertThreads(engine, [res.thread]);
      })
      .catch(() => {
        if (n < 3) setTimeout(() => void attempt(n + 1), 1000 * 2 ** n);
        else seeking.delete(id); // let a later event try again
      });
  void attempt(0);
}

/** Each thread's updatedAt when its agents were last asked for: unchanged since, there's nothing new to find. */
const agentsAsked = new Map<string, number>();

/** Whether a thread changed since its agents were last asked for. */
export const agentsUnasked = (t: Thread) => agentsAsked.get(t.id) !== t.updatedAt;

/** How many threads' agents are asked for at once. */
const AGENT_ASKS_AT_ONCE = 4;

/**
 * The spawned agents of `roots`, at any depth: Codex's newer agents only turn up asked for by
 * ancestor. A few roots at a time, so a long list doesn't flood the engine (or this thread).
 */
export async function listAgentsOf(engine: EngineId, roots: Thread[]): Promise<Thread[]> {
  const out: Thread[] = [];
  for (let i = 0; i < roots.length; i += AGENT_ASKS_AT_ONCE) {
    const batch = roots.slice(i, i + AGENT_ASKS_AT_ONCE);
    const found = await Promise.all(
      batch.map(async (root) => {
        agentsAsked.set(root.id, root.updatedAt);
        try {
          const res = await rpcFor(engine).request("thread/list", { limit: 100, sortKey: "updated_at", useStateDbOnly: true, ancestorThreadId: root.id });
          return res.data.filter((t) => spawnedBy(t));
        } catch {
          agentsAsked.delete(root.id);
          return [];
        }
      }),
    );
    out.push(...found.flat());
  }
  return out;
}
