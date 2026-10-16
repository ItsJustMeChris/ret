import type { PendingRequest } from "./threads";
import { useThreads } from "./threads";
import { agentOf } from "../agents";
import { spawnedBy } from "./projects";
import { unwrapCommand } from "../lib/format";
import { threadStateOf } from "../components/StatusDot";
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

/** Counts for the title bar badge: things that want you (not ones merely working). */
export function useInboxCount(): number {
  return useThreads((s) => {
    let n = 0;
    for (const id of Object.keys(s.threads)) {
      const st = threadStateOf(s, id);
      if (st === "attention" || ((st === "unread" || st === "error") && !spawnedBy(s.threads[id]))) n++;
    }
    return n;
  });
}
