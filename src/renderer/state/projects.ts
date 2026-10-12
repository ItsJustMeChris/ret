import type { Thread } from "../protocol";
import type { ProjectConf } from "./ui";

const caseInsensitive = /win/i.test(navigator.platform);

/** Canonical project key for a filesystem path. */
export function normPath(p: string): string {
  let s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  if (caseInsensitive) s = s.toLowerCase();
  return s;
}

export function baseName(p: string): string {
  const parts = p.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

/** Codex desktop drops ad-hoc chats into ~/Documents/Codex/<date>/<slug>; fold those into one project. */
const SCRATCH = /^(.*\/documents\/codex)\/\d{4}-\d{2}-\d{2}(\/|$)/i;

export interface ThreadNode {
  thread: Thread;
  children: ThreadNode[];
  /** Most recent activity anywhere in this subtree (seconds). */
  recency: number;
  /** Number of descendants (forks, forks of forks, ...). */
  forkCount: number;
}

export interface ProjectNode {
  key: string;
  path: string;
  name: string;
  conf: ProjectConf | null;
  roots: ThreadNode[];
  threadCount: number;
  recency: number;
}

/** Longest-first keys of explicitly added projects (the only ones that capture subdirectories). */
export function explicitKeys(projects: Record<string, ProjectConf>): string[] {
  return Object.keys(projects)
    .filter((k) => projects[k].explicit)
    .sort((a, b) => b.length - a.length);
}

export const recencyOf = (t: Thread) => t.recencyAt ?? t.updatedAt ?? t.createdAt;

export function threadTitle(t: Thread | undefined): string {
  if (!t) return "New thread";
  if (t.name?.trim()) return t.name.trim();
  const first = t.preview?.split("\n").find((l) => l.trim());
  return first?.trim().slice(0, 120) || "Untitled thread";
}

export function projectKeyFor(
  thread: Thread,
  byId: Record<string, Thread>,
  confKeys: string[],
  threadProject: Record<string, string>,
): string {
  let root = thread;
  const seen = new Set<string>();
  for (;;) {
    const pinned = threadProject[root.id];
    if (pinned) return pinned;
    const parent = root.forkedFromId ? byId[root.forkedFromId] : undefined;
    if (!parent || seen.has(parent.id)) break;
    seen.add(root.id);
    root = parent;
  }
  const cwd = normPath(root.cwd);
  for (const k of confKeys) if (cwd === k || cwd.startsWith(k + "/")) return k;
  const m = SCRATCH.exec(cwd);
  return m ? m[1] : cwd;
}

/**
 * Groups threads into projects and nests forks under the thread they were
 * forked from. A thread with forks becomes a "fork group" folder in the sidebar.
 */
export function buildProjects(
  threads: Record<string, Thread>,
  projects: Record<string, ProjectConf>,
  threadProject: Record<string, string>,
): ProjectNode[] {
  const confKeys = explicitKeys(projects);
  const list = Object.values(threads);
  const keyOf = new Map<string, string>();
  for (const t of list) keyOf.set(t.id, projectKeyFor(t, threads, confKeys, threadProject));

  const nodes = new Map<string, ThreadNode>();
  for (const t of list) nodes.set(t.id, { thread: t, children: [], recency: recencyOf(t), forkCount: 0 });

  const groups = new Map<string, ThreadNode[]>();
  for (const t of list) {
    const node = nodes.get(t.id)!;
    const key = keyOf.get(t.id)!;
    const parent = t.forkedFromId ? nodes.get(t.forkedFromId) : undefined;
    if (parent && keyOf.get(parent.thread.id) === key) parent.children.push(node);
    else {
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(node);
    }
  }

  const finalize = (n: ThreadNode): void => {
    n.children.sort((a, b) => a.thread.createdAt - b.thread.createdAt);
    for (const c of n.children) {
      finalize(c);
      n.recency = Math.max(n.recency, c.recency);
      n.forkCount += 1 + c.forkCount;
    }
  };

  const out: ProjectNode[] = [];
  const keys = new Set([...groups.keys(), ...confKeys]);
  for (const key of keys) {
    const conf = projects[key] ?? null;
    if (conf?.hidden) continue;
    const roots = groups.get(key) ?? [];
    roots.forEach(finalize);
    roots.sort((a, b) => b.recency - a.recency);
    const sample = roots[0]?.thread;
    const path = conf?.path ?? (sample ? displayPathFor(key, sample.cwd) : key);
    out.push({
      key,
      path,
      name: conf?.name ?? (SCRATCH.test(normPath(sample?.cwd ?? "")) && !conf ? "Codex chats" : baseName(path)),
      conf,
      roots,
      threadCount: roots.reduce((n, r) => n + 1 + r.forkCount, 0),
      recency: roots[0]?.recency ?? (conf?.addedAt ? conf.addedAt / 1000 : 0), // addedAt is ms; recency is seconds
    });
  }

  out.sort((a, b) => {
    const pa = a.conf?.pinned ? 1 : 0;
    const pb = b.conf?.pinned ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return b.recency - a.recency;
  });
  return out;
}

/** Recover original casing for an auto-detected project from one of its threads' cwd. */
function displayPathFor(key: string, cwd: string): string {
  const norm = cwd.replace(/\\/g, "/");
  return norm.slice(0, key.length).replace(/\//g, caseInsensitive ? "\\" : "/");
}

/** All thread ids in a subtree, root first. */
export function flattenNode(n: ThreadNode, out: Thread[] = []): Thread[] {
  out.push(n.thread);
  n.children.forEach((c) => flattenNode(c, out));
  return out;
}
