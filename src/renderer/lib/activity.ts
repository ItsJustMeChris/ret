import type { ThreadItem } from "@shared/protocol";
import { appKey, appLabel, computerUseOf, type ComputerUse } from "../state/computerUse";

// How a turn's steps fold up in a transcript: which items are "activity" (grouped into one row),
// and the one line that sums a group up.

/** Items that render as compact "activity" rows and can be grouped. */
export function isActivity(item: ThreadItem | undefined): boolean {
  if (!item) return false;
  switch (item.type) {
    case "commandExecution":
    case "mcpToolCall":
    case "dynamicToolCall":
    case "webSearch":
    case "imageView":
    case "collabAgentToolCall":
    case "subAgentActivity":
    case "functionCallOutput":
    case "sleep":
    case "reasoning":
      return true;
    default:
      return false;
  }
}

/**
 * `known`: what the live session learned about each item's computer-use step (see useScreen), in
 * step with `items`; `host`: the paired device the thread runs on, whose apps those are.
 */
export function activitySummary(items: ThreadItem[], known?: readonly (ComputerUse | undefined)[], host: string | null = null): string {
  let reads = 0;
  let searches = 0;
  let cmds = 0;
  let tools = 0;
  let web = 0;
  let waits = 0;
  let agents = 0;
  const apps = new Map<string, ComputerUse>();
  items.forEach((it, i) => {
    const use = known?.[i] ?? computerUseOf(it);
    if (use) {
      apps.set(appKey(use), use);
      return;
    }
    if (it.type === "commandExecution") {
      const t = it.commandActions?.[0]?.type;
      if (t === "read") reads += it.commandActions.length;
      else if (t === "search" || t === "listFiles") searches++;
      else cmds++;
    } else if (it.type === "collabAgentToolCall" && it.tool === "wait") waits++;
    else if (it.type === "mcpToolCall" || it.type === "dynamicToolCall" || it.type === "collabAgentToolCall") tools++;
    else if (it.type === "webSearch") web++;
    else if (it.type === "sleep") waits++;
    else if (it.type === "subAgentActivity" && it.kind === "started") agents++;
  });
  // Steps that never said which app count with the ones that did.
  if (apps.size > 1) apps.delete("computer");
  const parts: string[] = [];
  if (apps.size) parts.push(`used ${listOf([...new Set([...apps.values()].map((u) => appLabel(u, null, host)))])}`);
  if (reads) parts.push(`read ${reads} ${reads === 1 ? "file" : "files"}`);
  if (searches) parts.push(`${searches} ${searches === 1 ? "search" : "searches"}`);
  if (cmds) parts.push(`ran ${cmds} ${cmds === 1 ? "command" : "commands"}`);
  if (tools) parts.push(`${tools} tool ${tools === 1 ? "call" : "calls"}`);
  if (web) parts.push(`${web} web ${web === 1 ? "lookup" : "lookups"}`);
  if (agents) parts.push(`started ${agents} ${agents === 1 ? "agent" : "agents"}`);
  if (waits) parts.push(waits === 1 ? "waited" : `waited ${waits} times`);
  const s = parts.join(", ") || "thought";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const listOf = (names: string[]) => (names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);
