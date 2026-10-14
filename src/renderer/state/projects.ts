import type { Thread } from "@shared/protocol";
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

/**
 * Desktop apps drop ad-hoc chats into folders of their own; fold each app's into one project.
 * Codex: ~/Documents/Codex/<date>/<slug>. Claude: <app data>/Claude/scratch-workspaces/…, and
 * Claude Code's own temp folders.
 */
const SCRATCH: { re: RegExp; name: string }[] = [
  { re: /^(.*\/documents\/codex)\/\d{4}-\d{2}-\d{2}(\/|$)/i, name: "Codex chats" },
  { re: /^(.*\/claude\/scratch-workspaces)(\/|$)/i, name: "Claude chats" },
  { re: /^(.*\/(?:temp|tmp)\/claude)(\/|$)/i, name: "Claude scratch" },
];

function scratchOf(cwd: string): { key: string; name: string } | null {
  for (const r of SCRATCH) {
    const m = r.re.exec(cwd);
    if (m) return { key: m[1], name: r.name };
  }
  return null;
}

export interface ThreadNode {
  thread: Thread;
  children: ThreadNode[];
  /** Most recent activity anywhere in this subtree (seconds). */
  recency: number;
  /** Forks among its descendants (forks, forks of forks, ...). */
  forkCount: number;
  /** Subagents among its descendants. */
  agentCount: number;
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

/**
 * A named set of folders an agent app keeps (the ChatGPT and Codex apps' projects). Its folder
 * names often aren't its name ("HOI4 2" for "HOI4"), and one can span several folders.
 */
export interface Workspace {
  id: string;
  name: string;
  /** The first is where its threads start. */
  roots: string[];
}

/**
 * Which project a folder belongs to. Explicitly added projects and workspace roots capture their
 * subdirectories too; a workspace's roots all lead to one project, keyed by its first root.
 */
export interface ProjectIndex {
  /** Longest first, so the innermost wins; Ret's own projects win ties. */
  dirs: { dir: string; key: string }[];
  /** Workspace id → project key, for threads their engine assigned outright. */
  byWorkspace: Record<string, string>;
  /** Project key → the workspace behind it. */
  workspaces: Map<string, Workspace>;
  /** Worktree folder → the same place in its main checkout. */
  checkouts: Record<string, string>;
}

function explicitKeys(projects: Record<string, ProjectConf>): string[] {
  return Object.keys(projects).filter((k) => projects[k].explicit);
}

export function projectIndex(projects: Record<string, ProjectConf>, workspaces: Workspace[], checkouts: Record<string, string>): ProjectIndex {
  const dirs = explicitKeys(projects).map((k) => ({ dir: k, key: k }));
  const byWorkspace: Record<string, string> = {};
  const byKey = new Map<string, Workspace>();
  for (const w of workspaces) {
    if (!w.roots.length) continue;
    const key = normPath(w.roots[0]);
    if (byKey.has(key)) continue;
    byKey.set(key, w);
    byWorkspace[w.id] = key;
    for (const r of w.roots) dirs.push({ dir: normPath(r), key });
  }
  dirs.sort((a, b) => b.dir.length - a.dir.length);
  return { dirs, byWorkspace, workspaces: byKey, checkouts };
}

export const recencyOf = (t: Thread) => t.recencyAt ?? t.updatedAt ?? t.createdAt;

/**
 * The thread that spawned this one, when it's a Codex subagent. `thread/list` leaves
 * `parentThreadId` out, but the thread's source still names its parent.
 */
export function spawnedBy(t: Thread | undefined): string | null {
  if (!t) return null;
  if (t.parentThreadId) return t.parentThreadId;
  const src = t.source as { subAgent?: { thread_spawn?: { parent_thread_id?: string } } } | string | undefined;
  return (typeof src === "object" && src?.subAgent?.thread_spawn?.parent_thread_id) || null;
}

/** The thread this one hangs under: the agent that spawned it, or the thread it was forked from. */
export const lineageParent = (t: Thread): string | null => spawnedBy(t) ?? t.forkedFromId;

/** A subagent's handle: the nickname Codex gave it, else the last part of its path (/root/pong). */
export function agentName(t: Thread | undefined, path?: string | null): string | null {
  const p = path ?? (t?.source as { subAgent?: { thread_spawn?: { agent_path?: string | null } } } | undefined)?.subAgent?.thread_spawn?.agent_path;
  return t?.agentNickname?.trim() || p?.split("/").filter(Boolean).pop() || null;
}

export function threadTitle(t: Thread | undefined): string {
  if (!t) return "New thread";
  if (t.name?.trim()) return t.name.trim();
  // A subagent that inherited its parent's history would otherwise borrow the parent's first message.
  if (spawnedBy(t)) {
    const name = agentName(t);
    if (name) return t.agentRole ? `${name} (${t.agentRole})` : name;
  }
  const first = t.preview?.split("\n").find((l) => l.trim());
  return first?.trim().slice(0, 120) || "Untitled thread";
}

export function projectKeyFor(
  thread: Thread,
  byId: Record<string, Thread>,
  index: ProjectIndex,
  threadProject: Record<string, string>,
): string {
  let root = thread;
  const seen = new Set<string>();
  for (;;) {
    const pinned = threadProject[root.id];
    if (pinned) return pinned;
    const up = lineageParent(root);
    const parent = up ? byId[up] : undefined;
    if (!parent || seen.has(parent.id)) break;
    seen.add(root.id);
    root = parent;
  }
  const assigned = root.projectId ? index.byWorkspace[root.projectId] : undefined;
  if (assigned) return assigned;
  const cwd = normPath(index.checkouts[root.cwd] ?? root.cwd);
  for (const { dir, key } of index.dirs) if (cwd === dir || cwd.startsWith(dir + "/")) return key;
  return scratchOf(cwd)?.key ?? cwd;
}

/**
 * Groups threads into projects and nests forks and subagents under the thread they came
 * from. A thread with forks or subagents becomes a group folder in the sidebar.
 */
export function buildProjects(
  threads: Record<string, Thread>,
  projects: Record<string, ProjectConf>,
  threadProject: Record<string, string>,
  workspaces: Workspace[],
  checkouts: Record<string, string>,
): ProjectNode[] {
  const index = projectIndex(projects, workspaces, checkouts);
  const list = Object.values(threads);
  const keyOf = new Map<string, string>();
  for (const t of list) keyOf.set(t.id, projectKeyFor(t, threads, index, threadProject));

  const nodes = new Map<string, ThreadNode>();
  for (const t of list) nodes.set(t.id, { thread: t, children: [], recency: recencyOf(t), forkCount: 0, agentCount: 0 });

  const groups = new Map<string, ThreadNode[]>();
  for (const t of list) {
    const node = nodes.get(t.id)!;
    const key = keyOf.get(t.id)!;
    const up = lineageParent(t);
    const parent = up ? nodes.get(up) : undefined;
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
      if (spawnedBy(c.thread)) n.agentCount++;
      else n.forkCount++;
      n.forkCount += c.forkCount;
      n.agentCount += c.agentCount;
    }
  };

  const out: ProjectNode[] = [];
  const keys = new Set([...groups.keys(), ...explicitKeys(projects)]);
  for (const key of keys) {
    const conf = projects[key] ?? null;
    if (conf?.hidden) continue;
    const roots = groups.get(key) ?? [];
    roots.forEach(finalize);
    roots.sort((a, b) => b.recency - a.recency);
    const sample = roots[0]?.thread;
    const ws = index.workspaces.get(key);
    const path = conf?.path ?? ws?.roots[0] ?? (sample ? displayPathFor(key, checkouts[sample.cwd] ?? sample.cwd) : key);
    out.push({
      key,
      path,
      name: conf?.name ?? ws?.name ?? (!conf ? scratchOf(normPath(sample?.cwd ?? ""))?.name : undefined) ?? baseName(path),
      conf,
      roots,
      threadCount: roots.reduce((n, r) => n + 1 + r.forkCount + r.agentCount, 0),
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
