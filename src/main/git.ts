import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import type { GitInfo, WorktreeResult } from "../shared/bridge";

function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout.trim());
    });
  });
}

export async function gitInfo(cwd: string): Promise<GitInfo> {
  try {
    const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
    const branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => null);
    return { isRepo: true, root, branch };
  } catch {
    return { isRepo: false, root: null, branch: null };
  }
}

function slugify(label: string) {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "fork"
  );
}

/**
 * Create an isolated git worktree for a fork so parallel experiments don't
 * stomp on each other's files. Branches from the current HEAD; uncommitted
 * changes in the source checkout are not carried over.
 */
export async function createWorktree(baseDir: string, cwd: string, label: string): Promise<WorktreeResult> {
  const info = await gitInfo(cwd);
  if (!info.isRepo || !info.root) throw new Error(`${cwd} is not inside a git repository`);
  const repoRoot = info.root;
  const id = Date.now().toString(36).slice(-5);
  const slug = `${slugify(label)}-${id}`;
  const branch = `ret/${slug}`;
  const dir = join(baseDir, basename(repoRoot), slug);
  await mkdir(join(baseDir, basename(repoRoot)), { recursive: true });
  await git(repoRoot, ["worktree", "add", "-b", branch, dir, "HEAD"]);
  // Preserve the thread's position inside the repo (e.g. a monorepo package).
  const sub = relative(resolve(repoRoot), resolve(cwd));
  const path = sub && !sub.startsWith("..") ? join(dir, sub) : dir;
  return { path, branch, repoRoot };
}
