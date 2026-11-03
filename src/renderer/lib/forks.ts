import type { Thread } from "@shared/protocol";
import { spawnedBy, threadTitle, type ThreadNode } from "../state/projects";

/**
 * Forks, the same on the desktop (the sidebar, a thread's header and turns, its details) and the
 * phone (apps/mobile: the projects list, a thread's header and turns, its details sheet): their
 * words, and how they're numbered and named.
 */

export const FORK = {
  button: "Fork",
  conversation: "Fork conversation",
  worktree: "Fork into new worktree",
  here: "Fork from here",
  hereHint: "Fork the conversation from this point",
  /** The thread a group of forks came from, listed first inside it. */
  original: "Original",
} as const;

/** Forks are numbered in the order they were made; subagents go by their own names. */
export function forkNumbers(children: ThreadNode[]): [ThreadNode, number | undefined][] {
  let n = 0;
  return children.map((c) => [c, spawnedBy(c.thread) ? undefined : ++n]);
}

/** Fork `n`'s title: its own name, or "Fork 2" while it still has the one it inherited from its parent. */
export function forkTitle(fork: Thread, n: number, parentName: string | null | undefined): string {
  return fork.name && fork.name !== parentName ? threadTitle(fork) : `Fork ${n}`;
}
