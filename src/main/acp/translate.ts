import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import type { ContentBlock, PlanEntry, SessionUpdate, ToolCall, ToolCallContent, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { ThreadItem, TurnPlanStep, UserInput } from "../../shared/protocol";
import { agentMessage } from "../claude/history";
import { lineDiff } from "../claude/translate";

/**
 * ACP → Ret protocol: what an agent streams in `session/update` (message and thought chunks,
 * tool calls and their updates, plans) becomes the app-server's thread items, so Ret renders an
 * ACP agent's turns like Codex's. The same builder reads a session's replayed history
 * (`session/load`) and its live turns, so a thread looks the same before and after a reload.
 */

const OUTPUT_CAP = 200_000;
const cap = (s: string) => (s.length > OUTPUT_CAP ? s.slice(-OUTPUT_CAP) : s);
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
const MEDIA: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

/** What a builder tells the renderer as it goes (a replay keeps only the end result). */
export type ItemEvent =
  | { method: "item/started" | "item/completed"; item: ThreadItem }
  | { method: "item/agentMessage/delta" | "item/reasoning/summaryTextDelta"; itemId: string; delta: string }
  | { method: "turn/plan/updated"; plan: TurnPlanStep[] };

/** A tool call as it stands after every update so far. */
type Tool = ToolCall & { startedAt: number; endedAt?: number };

/** The text of a content block (resources by name, images left out). */
export function blockText(b: ContentBlock | undefined | null): string {
  if (!b) return "";
  if (b.type === "text") return b.text;
  if (b.type === "resource_link") return `@${b.name || b.uri}`;
  if (b.type === "resource") return "text" in b.resource ? b.resource.text : "";
  return "";
}

/**
 * One turn's items, built from the agent's updates in order. Text and thought chunks run into
 * one item until something else comes between them (or the agent starts a new message).
 */
export class TurnBuilder {
  /** Items by id, in the order they first appeared. */
  readonly items = new Map<string, ThreadItem>();
  plan: TurnPlanStep[] | null = null;
  private open: { kind: "message" | "thought"; id: string; messageId: string | null } | null = null;
  private tools = new Map<string, Tool>();
  private n = 0;

  constructor(
    private readonly turnId: string,
    private readonly cwd: string,
  ) {}

  /** A user message that opens the turn (replayed history; a live turn's goes out with turn/started). */
  user(text: string, images: string[] = []): ItemEvent[] {
    const id = `${this.turnId}:user`;
    const prev = this.items.get(id);
    const content: UserInput[] = prev?.type === "userMessage" ? [...prev.content] : [];
    const last = content.at(-1);
    if (text) {
      if (last?.type === "text") content[content.length - 1] = { ...last, text: last.text + text };
      else content.push({ type: "text", text, text_elements: [] });
    }
    for (const url of images) content.push({ type: "image", url });
    const item: ThreadItem = { type: "userMessage", id, clientId: null, content };
    this.items.set(id, item);
    return [{ method: "item/completed", item }];
  }

  apply(u: SessionUpdate): ItemEvent[] {
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        return this.chunk("message", blockText(u.content), u.messageId ?? null);
      case "agent_thought_chunk":
        return this.chunk("thought", blockText(u.content), u.messageId ?? null);
      case "tool_call":
        return [...this.closeOpen(), ...this.tool({ ...u, startedAt: Date.now() })];
      case "tool_call_update":
        return [...this.closeOpen(), ...this.toolUpdate(u)];
      case "plan":
        this.plan = planSteps(u.entries);
        return [{ method: "turn/plan/updated", plan: this.plan }];
      default:
        return [];
    }
  }

  /** A permission request's tool call, which may be the first the turn hears of it. */
  toolFromRequest(call: ToolCallUpdate): ItemEvent[] {
    return [...this.closeOpen(), ...(this.tools.has(call.toolCallId) ? this.toolUpdate(call) : this.tool({ title: call.title ?? "Tool", ...stripNulls(call), toolCallId: call.toolCallId, startedAt: Date.now() }))];
  }

  item(id: string): ThreadItem | undefined {
    return this.items.get(id);
  }

  /** The turn is over: the text in progress is complete, and tools still going ended with it. */
  finish(how: "completed" | "interrupted" | "failed"): ItemEvent[] {
    const out = this.closeOpen();
    for (const t of this.tools.values()) {
      if (t.status === "completed" || t.status === "failed") continue;
      t.status = how === "completed" ? "completed" : "failed";
      t.endedAt = Date.now();
      out.push(this.emitTool(t));
    }
    return out;
  }

  private chunk(kind: "message" | "thought", text: string, messageId: string | null): ItemEvent[] {
    if (!text) return [];
    const out: ItemEvent[] = [];
    if (!this.open || this.open.kind !== kind || (messageId && this.open.messageId && messageId !== this.open.messageId)) {
      out.push(...this.closeOpen());
      const id = `${this.turnId}:${kind === "message" ? "m" : "r"}${this.n++}`;
      this.open = { kind, id, messageId };
      const item: ThreadItem = kind === "message" ? agentMessage(id, "") : { type: "reasoning", id, summary: [""], content: [] };
      this.items.set(id, item);
      out.push({ method: "item/started", item });
    }
    const id = this.open.id;
    const item = this.items.get(id)!;
    if (item.type === "agentMessage") this.items.set(id, { ...item, text: item.text + text });
    else if (item.type === "reasoning") this.items.set(id, { ...item, summary: [(item.summary[0] ?? "") + text] });
    out.push({ method: kind === "message" ? "item/agentMessage/delta" : "item/reasoning/summaryTextDelta", itemId: id, delta: text });
    return out;
  }

  private closeOpen(): ItemEvent[] {
    const open = this.open;
    this.open = null;
    const item = open && this.items.get(open.id);
    return item ? [{ method: "item/completed", item }] : [];
  }

  private tool(t: Tool): ItemEvent[] {
    this.tools.set(t.toolCallId, t);
    if (t.status === "completed" || t.status === "failed") t.endedAt = Date.now();
    return [this.emitTool(t)];
  }

  private toolUpdate(u: ToolCallUpdate): ItemEvent[] {
    const prev = this.tools.get(u.toolCallId);
    if (!prev) return this.tool({ title: u.title ?? "Tool", ...stripNulls(u), toolCallId: u.toolCallId, startedAt: Date.now() });
    const next: Tool = { ...prev, ...stripNulls(u) };
    if ((next.status === "completed" || next.status === "failed") && !prev.endedAt) next.endedAt = Date.now();
    return this.tool(next);
  }

  private emitTool(t: Tool): ItemEvent {
    const item = toolItem(t, this.cwd, t.endedAt ? t.endedAt - t.startedAt : null);
    this.items.set(item.id, item);
    return { method: t.status === "completed" || t.status === "failed" ? "item/completed" : "item/started", item };
  }
}

function stripNulls<T extends object>(o: T): Partial<{ [K in keyof T]: Exclude<T[K], null> }> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as never;
}

export function planSteps(entries: PlanEntry[]): TurnPlanStep[] {
  return entries.map((e) => ({ step: e.content, status: e.status === "completed" ? "completed" : e.status === "in_progress" ? "inProgress" : "pending" }));
}

/** The text a tool's content says (its output), or failing that its raw output's. */
function toolText(t: Tool): string | null {
  const parts = (t.content ?? []).flatMap((c: ToolCallContent) => (c.type === "content" ? [blockText(c.content)] : [])).filter(Boolean);
  if (parts.length) return parts.join("\n");
  const raw = t.rawOutput as any;
  if (typeof raw === "string") return raw;
  for (const k of ["output", "stdout", "result", "content", "error"]) if (typeof raw?.[k] === "string" && raw[k]) return raw[k];
  return null;
}

const str = (v: unknown) => (typeof v === "string" && v ? v : null);

/** A tool call as the item Ret shows for that kind of tool. */
export function toolItem(t: Tool, cwd: string, durationMs: number | null): ThreadItem {
  const id = t.toolCallId;
  const input = (t.rawInput ?? {}) as Record<string, unknown>;
  const status = t.status === "completed" ? "completed" : t.status === "failed" ? "failed" : "inProgress";
  const out = toolText(t);
  const path = t.locations?.[0]?.path ?? str(input.filePath) ?? str(input.file_path) ?? str(input.path);

  const command = (command: string, commandActions: Extract<ThreadItem, { type: "commandExecution" }>["commandActions"], exitCode: number | null): ThreadItem => ({
    type: "commandExecution",
    id,
    pluginId: null,
    scriptPath: null,
    command,
    cwd: str(input.cwd) ?? str(input.workdir) ?? cwd,
    processId: null,
    source: "agent",
    status,
    commandActions,
    aggregatedOutput: out == null ? null : cap(out),
    exitCode: status === "inProgress" ? null : (exitCode ?? (status === "completed" ? 0 : 1)),
    durationMs,
  });

  switch (t.kind) {
    case "execute": {
      const cmd = str(input.command) ?? str(input.cmd) ?? (Array.isArray(input.command) ? input.command.join(" ") : null) ?? t.title;
      const raw = t.rawOutput as any;
      const exit = [raw?.exitCode, raw?.exit_code, raw?.metadata?.exit, raw?.metadata?.exitCode].find((v) => typeof v === "number") ?? null;
      return command(cmd, [{ type: "unknown", command: cmd }], exit);
    }
    case "read": {
      if (path && IMAGE_EXT.test(path)) return { type: "imageView", id, path };
      const what = path ? `Read ${path}` : t.title;
      return command(what, [{ type: "read", command: what, name: path ? basename(path) : t.title, path: path ?? "" }], null);
    }
    case "search": {
      const query = str(input.pattern) ?? str(input.query) ?? t.title;
      return command(t.title, [{ type: "search", command: t.title, query, path }], null);
    }
    case "edit":
    case "delete":
    case "move": {
      const diffs = (t.content ?? []).filter((c): c is Extract<ToolCallContent, { type: "diff" }> => c.type === "diff");
      // No diff of its own: what the call asked for (OpenCode's write and edit tools say it in their input).
      if (!diffs.length && path && t.kind === "edit") {
        const write = str(input.content);
        const from = typeof input.oldString === "string" ? input.oldString : typeof input.old_string === "string" ? input.old_string : null;
        const to = typeof input.newString === "string" ? input.newString : typeof input.new_string === "string" ? input.new_string : null;
        if (write != null) diffs.push({ type: "diff", path, oldText: null, newText: write });
        else if (from != null && to != null) diffs.push({ type: "diff", path, oldText: from, newText: to, snippet: true } as never);
      }
      if (!diffs.length) break;
      return {
        type: "fileChange",
        id,
        changes: diffs.map((d) =>
          t.kind === "delete"
            ? { path: d.path, kind: { type: "delete" }, diff: d.oldText ?? "" }
            : d.oldText == null
              ? { path: d.path, kind: { type: "add" }, diff: d.newText }
              : { path: d.path, kind: { type: "update", move_path: null }, diff: lineDiff(d.oldText, d.newText, !(d as { snippet?: boolean }).snippet) },
        ),
        status: status === "inProgress" ? "inProgress" : status,
      };
    }
    case "fetch": {
      const url = str(input.url);
      if (url) return { type: "webSearch", id, query: url, action: { type: "openPage", url }, results: null };
      const query = str(input.query) ?? t.title;
      return { type: "webSearch", id, query, action: { type: "search", query, queries: null }, results: null };
    }
  }
  return {
    type: "dynamicToolCall",
    id,
    namespace: null,
    tool: t.title || t.name || "Tool",
    arguments: (t.rawInput ?? {}) as never,
    status: status === "inProgress" ? "inProgress" : status,
    contentItems: out ? [{ type: "inputText", text: cap(out) }] : null,
    success: status === "inProgress" ? null : status === "completed",
    durationMs,
  };
}

/** What the user sent, as ACP content: text, images (when the agent takes them), and mentioned files as links. */
export function toPrompt(inputs: UserInput[], images: boolean): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const i of inputs) {
    if (i.type === "text") out.push({ type: "text", text: i.text });
    else if (i.type === "localImage") {
      const mimeType = MEDIA[extname(i.path).toLowerCase()];
      try {
        if (images && mimeType) out.push({ type: "image", mimeType, data: readFileSync(i.path).toString("base64") });
        else out.push({ type: "resource_link", name: basename(i.path), uri: fileUri(i.path) });
      } catch {
        out.push({ type: "text", text: `[Attached image could not be read: ${i.path}]` });
      }
    } else if (i.type === "image" && "url" in i) {
      const m = /^data:([^;]+);base64,(.*)$/.exec(i.url);
      if (m && images) out.push({ type: "image", mimeType: m[1], data: m[2] });
      else if (!m) out.push({ type: "resource_link", name: i.url, uri: i.url });
    } else if (i.type === "mention" || i.type === "skill") out.push({ type: "resource_link", name: i.name || basename(i.path), uri: fileUri(i.path) });
  }
  return out;
}

const fileUri = (path: string) => (/^[a-z][\w+.-]*:\/\//i.test(path) ? path : `file://${path.startsWith("/") ? "" : "/"}${path.replace(/\\/g, "/")}`);
