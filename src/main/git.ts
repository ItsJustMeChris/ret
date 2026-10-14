import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
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

/** Whether the nearest `.git` at or above `dir` is a file: a linked worktree's (or a submodule's). */
async function inLinkedCheckout(dir: string): Promise<boolean> {
  for (let d = resolve(dir); ; d = dirname(d)) {
    const s = await stat(join(d, ".git")).catch(() => null);
    if (s) return s.isFile();
    if (dirname(d) === d) return false;
  }
}

/**
 * The same place in a linked worktree's main checkout, or null for any other folder. Asks git
 * for the shared git dir the way the Codex app does, so its worktrees group the same way here.
 */
async function mainCheckout(cwd: string): Promise<string | null> {
  if (!(await inLinkedCheckout(cwd))) return null;
  try {
    const [top, common] = (await git(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"])).split("\n");
    if (basename(common) !== ".git") return null; // a submodule, or a bare repo's worktree
    const main = dirname(common);
    if (resolve(main) === resolve(top)) return null;
    const sub = relative(top, cwd);
    return sub && !sub.startsWith("..") ? join(main, sub) : main;
  } catch {
    return null;
  }
}

/** Main checkouts for those of `cwds` that are linked worktrees; the rest are left out. */
export async function mainCheckouts(cwds: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    cwds.map(async (cwd) => {
      const main = await mainCheckout(cwd);
      if (main) out[cwd] = main;
    }),
  );
  return out;
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
