import type { PendingRequest } from "./threads";
import { useThreads } from "./threads";
import { agentOf } from "../agents";
import { agentName, jobOf, spawnedBy } from "./projects";
import { unwrapCommand } from "../lib/format";
import { threadStateOf, type ThreadState } from "../components/StatusDot";
import { isPermissionAsk } from "./computerUse";

// What the Inbox lists: the sections threads fall into, and what a waiting request asks, in a line.

export type Section = "attention" | "unread" | "error" | "running";

export const SECTIONS: { key: Section; title: string; hint: string }[] = [
  { key: "attention", title: "Needs you", hint: "Waiting on an answer or an approval" },
  { key: "unread", title: "Ready to review", hint: "Finished while you were elsewhere" },
  { key: "error", title: "Failed", hint: "Stopped with an error" },
  { key: "running", title: "Working", hint: "In progress here or in another app" },
];

/** What a pending request is asking, in a line. */
export function askFor(req: PendingRequest | undefined): string | null {
  if (!req) return null;
  const p = req.params ?? {};
  switch (req.method) {
    case "item/commandExecution/requestApproval":
    case "execCommandApproval":
      return `Run ${p.command ? unwrapCommand(Array.isArray(p.command) ? p.command.join(" ") : p.command) : "a command"}?`;
    case "item/fileChange/requestApproval":
    case "applyPatchApproval":
      return "Apply these edits?";
    case "item/permissions/requestApproval":
      return "Grant extra permissions?";
    case "item/tool/requestUserInput":
      return p.questions?.[0]?.question ?? `${agentOf(req.engine).name} has a question`;
    case "mcpServer/elicitation/request":
      return isPermissionAsk(p) ? (typeof p.message === "string" ? p.message : "Allow a tool?") : `${p.serverName ?? "A tool"} needs input: ${p.message ?? ""}`;
    case "item/tool/requestApproval":
      return p.title ?? `Use ${p.tool ?? "a tool"}?`;
  }
  return "Needs your input";
}

type State = ReturnType<typeof useThreads.getState>;

/**
 * Whether a thread gets an Inbox row. A job's agents don't: what they ask shows on the thread they
 * work for (see threadStateOf), and their working, finishing or failing is that thread's business.
 * (One whose spawner isn't known stands on its own.)
 */
export function listed(s: State, id: string): boolean {
  const up = spawnedBy(s.threads[id]);
  return !up || !s.threads[up];
}

/** What each listed thread wants from you, for the Inbox. */
export function inboxStates(s: State): Record<string, ThreadState> {
  const out: Record<string, ThreadState> = {};
  for (const id of Object.keys(s.threads)) {
    if (!listed(s, id)) continue;
    const st = threadStateOf(s, id);
    if (st !== "idle") out[id] = st;
  }
  return out;
}

/** The request a thread's row shows: its own, else one an agent working for it is waiting on (that agent's thread is `threadId`). */
export function rowRequest(s: State, id: string): PendingRequest | undefined {
  let theirs: PendingRequest | undefined;
  for (const r of Object.values(s.requests)) {
    if (r.threadId === id) return r;
    if (!theirs && r.threadId && r.threadId !== id && jobOf(s.threads, r.threadId) === id) theirs = r;
  }
  return theirs;
}

/** A row's request, in a line: an agent's says who's asking. */
export function rowAsk(s: State, req: PendingRequest | undefined, id: string): string | null {
  const ask = askFor(req);
  if (!ask || !req?.threadId || req.threadId === id) return ask;
  return `${agentName(s.threads[req.threadId]) ?? "An agent"}: ${ask}`;
}

/** Counts for the title bar badge: things that want you (not ones merely working). */
export function useInboxCount(): number {
  return useThreads((s) => {
    let n = 0;
    for (const id of Object.keys(s.threads)) {
      if (!listed(s, id)) continue;
      const st = threadStateOf(s, id);
      if (st === "attention" || st === "unread" || st === "error") n++;
    }
    return n;
  });
}
