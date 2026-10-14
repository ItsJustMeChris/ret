import { basename } from "node:path";
import type { ThreadItem, TurnPlanStep, UserInput } from "../../shared/protocol";

/**
 * Claude Code → Ret protocol: the content blocks of Claude's messages become the app-server's
 * thread items, so every view in Ret renders them exactly like Codex's. Shared by live turns
 * (session.ts) and history (history.ts), so a transcript looks the same before and after reload.
 */

export type Block = { type: string; [k: string]: any };

export interface ToolUse {
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface ToolResult {
  content: unknown;
  isError: boolean;
}

export interface ToolContext {
  cwd: string;
  /** File contents before a Write ran (live turns only), for a real diff instead of "whole file". */
  before?: string | null;
  durationMs?: number | null;
}

const OUTPUT_CAP = 200_000;
const cap = (s: string) => (s.length > OUTPUT_CAP ? s.slice(-OUTPUT_CAP) : s);

export function blocksOf(content: unknown): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content.filter((b) => b && typeof b === "object") as Block[]) : [];
}

/** Text of a tool result (string, or text blocks). */
export function resultText(content: unknown): string {
  return blocksOf(content)
    .map((b) => (b.type === "text" ? String(b.text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

const DECLINED = /user doesn't want to proceed|user (?:declined|rejected|denied)|permission (?:to use .* )?(?:was )?denied|tool use was rejected/i;

function statusOf(result: ToolResult | undefined): "inProgress" | "completed" | "failed" | "declined" {
  if (!result) return "inProgress";
  if (!result.isError) return "completed";
  return DECLINED.test(resultText(result.content)) ? "declined" : "failed";
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** MCP tool names are `mcp__<server>__<tool>`. */
export function mcpName(name: string): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1], tool: m[2] } : null;
}

/** Claude desktop's task list tool, which its sessions keep in place of TodoWrite. */
const CCD_PLAN = "mcp__ccd_turn__update_plan";
/** Closes a Claude desktop turn, checking off the step still in progress. */
const CCD_WRAP_UP = "mcp__ccd_turn__wrap_up";

/** Tools whose only job is the turn's checklist. */
export function isPlanTool(name: string): boolean {
  return name === "TodoWrite" || name === CCD_PLAN;
}

/** Tools that drive Ret's own UI rather than appearing as items. */
export function isUiTool(name: string): boolean {
  return isPlanTool(name) || name === "EnterPlanMode";
}

/** The turn's checklist after this tool call, given the one before it; null if the call leaves it be. */
export function planUpdate(use: ToolUse, prev: TurnPlanStep[] | null): TurnPlanStep[] | null {
  if (use.name === "TodoWrite") return todoPlan(use.input);
  if (use.name === CCD_PLAN) return ccdPlan(use.input, prev);
  if (use.name === CCD_WRAP_UP && prev?.some((s) => s.status === "inProgress"))
    return prev.map((s) => (s.status === "inProgress" ? { ...s, status: "completed" } : s));
  return null;
}

/**
 * Claude desktop's `update_plan`: the whole list (`items`), or a move along the current one —
 * `advance` finishes the step in progress and starts the next pending one; `done`/`start` name
 * steps by 1-based number.
 */
export function ccdPlan(input: Record<string, any>, prev: TurnPlanStep[] | null): TurnPlanStep[] | null {
  if (Array.isArray(input?.items)) {
    return input.items.map((t: any) => ({
      step: String(t?.content ?? ""),
      status: t?.status === "completed" ? "completed" : t?.status === "in_progress" ? "inProgress" : "pending",
    }));
  }
  if (!prev) return null;
  const steps = prev.map((s) => ({ ...s }));
  if (input?.advance === true) {
    const at = steps.findIndex((s) => s.status === "inProgress");
    for (const s of steps) if (s.status === "inProgress") s.status = "completed";
    const next = steps.findIndex((s, i) => i > at && s.status === "pending");
    if (next >= 0) steps[next].status = "inProgress";
  }
  for (const n of Array.isArray(input?.done) ? input.done : []) if (steps[n - 1]) steps[n - 1].status = "completed";
  if (typeof input?.start === "number" && steps[input.start - 1]) {
    for (const s of steps) if (s.status === "inProgress") s.status = "pending";
    steps[input.start - 1].status = "inProgress";
  }
  return steps;
}

/** A TodoWrite list as the turn's plan checklist. */
export function todoPlan(input: Record<string, any>): TurnPlanStep[] | null {
  if (!Array.isArray(input?.todos)) return null;
  return input.todos.map((t: any) => ({
    step: String(t.status === "in_progress" ? (t.activeForm ?? t.content) : (t.content ?? "")),
    status: t.status === "completed" ? "completed" : t.status === "in_progress" ? "inProgress" : "pending",
  }));
}

/** The plan text Claude presents with ExitPlanMode. */
export function planText(input: Record<string, any>, result?: ToolResult): string {
  if (typeof input?.plan === "string" && input.plan.trim()) return input.plan;
  return result ? resultText(result.content) : "";
}

export function toolItem(use: ToolUse, result: ToolResult | undefined, ctx: ToolContext): ThreadItem | null {
  const { id, name } = use;
  const input = use.input ?? {};
  const status = statusOf(result);
  const out = result ? resultText(result.content) : null;
  const done = status === "inProgress" ? "inProgress" : status === "declined" ? "failed" : status;

  if (isUiTool(name)) return null;
  if (name === "ExitPlanMode") return { type: "plan", id, text: planText(input, result) };

  if (name === "Bash" || name === "PowerShell") {
    const command = String(input.command ?? "");
    let exitCode: number | null = null;
    let output = out;
    if (result) {
      const m = out ? /^Exit code (-?\d+)\s*\n?/.exec(out) : null;
      exitCode = m ? Number(m[1]) : result.isError ? 1 : 0;
      if (m && output) output = output.slice(m[0].length);
    }
    return {
      type: "commandExecution",
      id,
      pluginId: null,
      scriptPath: null,
      command,
      cwd: ctx.cwd,
      processId: null,
      source: "agent",
      status,
      commandActions: [{ type: "unknown", command }],
      aggregatedOutput: output == null ? null : cap(output),
      exitCode,
      durationMs: ctx.durationMs ?? null,
    };
  }

  if (name === "Read" && typeof input.file_path === "string") {
    if (IMAGE_EXT.test(input.file_path)) return { type: "imageView", id, path: input.file_path };
    return readLike(id, `Read ${input.file_path}`, [{ type: "read", command: `Read ${input.file_path}`, name: basename(input.file_path), path: input.file_path }], status, out, ctx);
  }
  if (name === "Grep" || name === "Glob") {
    const pattern = String(input.pattern ?? "");
    const path = typeof input.path === "string" ? input.path : null;
    const command = `${name.toLowerCase()} ${pattern}${path ? ` ${path}` : ""}`;
    return readLike(id, command, [{ type: "search", command, query: pattern, path }], status, out, ctx);
  }
  if (name === "LS") {
    const path = typeof input.path === "string" ? input.path : null;
    return readLike(id, `ls ${path ?? ""}`, [{ type: "listFiles", command: `ls ${path ?? ""}`, path }], status, out, ctx);
  }

  if (name === "Edit" || name === "MultiEdit" || name === "Write" || name === "NotebookEdit") {
    const path = String(input.file_path ?? input.notebook_path ?? "");
    let diff: string;
    let kind: "add" | "update" = "update";
    if (name === "Edit") diff = lineDiff(String(input.old_string ?? ""), String(input.new_string ?? ""));
    else if (name === "MultiEdit") diff = (input.edits ?? []).map((e: any) => lineDiff(String(e.old_string ?? ""), String(e.new_string ?? ""))).join("\n");
    else if (name === "NotebookEdit") diff = lineDiff("", String(input.new_source ?? ""));
    else {
      // A Write is a new file if it didn't exist before it ran (live), or Claude Code said it created it.
      const content = String(input.content ?? "");
      const created = ctx.before === null || (ctx.before === undefined && (!result || (!!out && /created/i.test(out))));
      if (typeof ctx.before === "string") diff = lineDiff(ctx.before, content, true);
      else if (created) {
        kind = "add";
        diff = content;
      } else diff = lineDiff("", content);
    }
    return {
      type: "fileChange",
      id,
      changes: [{ path, kind: kind === "add" ? { type: "add" } : { type: "update", move_path: null }, diff }],
      status,
    };
  }

  if (name === "WebSearch") {
    const query = String(input.query ?? "");
    return { type: "webSearch", id, query, action: { type: "search", query, queries: null }, results: null };
  }
  if (name === "WebFetch") {
    const url = String(input.url ?? "");
    return { type: "webSearch", id, query: url, action: { type: "openPage", url }, results: null };
  }

  const mcp = mcpName(name);
  if (mcp) {
    return {
      type: "mcpToolCall",
      id,
      server: mcp.server,
      tool: mcp.tool,
      status: done,
      arguments: input,
      appContext: null,
      mcpAppUi: null,
      pluginId: null,
      readOnlyHint: null,
      result: result && !result.isError ? { content: blocksOf(result.content), structuredContent: null, _meta: null } : null,
      error: result?.isError ? { message: out || "Failed" } : null,
      durationMs: ctx.durationMs ?? null,
    };
  }

  if (name === "AskUserQuestion") {
    const questions: string[] = Array.isArray(input.questions) ? input.questions.map((q: any) => String(q.question ?? "")) : [];
    return {
      type: "dynamicToolCall",
      id,
      namespace: null,
      tool: questions.length > 1 ? `Asked ${questions.length} questions` : "Asked a question",
      arguments: questions.length === 1 ? questions[0] : questions,
      status: done,
      contentItems: out ? [{ type: "inputText", text: out }] : null,
      success: result ? !result.isError : null,
      durationMs: ctx.durationMs ?? null,
    };
  }

  const label = name === "Agent" || name === "Task" ? `Agent${input.subagent_type ? ` (${input.subagent_type})` : ""}${input.description ? ` · ${input.description}` : ""}` : name;
  return {
    type: "dynamicToolCall",
    id,
    namespace: null,
    tool: label,
    arguments: name === "Agent" || name === "Task" ? (input.prompt ?? input) : input,
    status: done,
    contentItems: out ? [{ type: "inputText", text: cap(out) }] : null,
    success: result ? !result.isError : null,
    durationMs: ctx.durationMs ?? null,
  };
}

function readLike(
  id: string,
  command: string,
  commandActions: Extract<ThreadItem, { type: "commandExecution" }>["commandActions"],
  status: "inProgress" | "completed" | "failed" | "declined",
  out: string | null,
  ctx: ToolContext,
): ThreadItem {
  return {
    type: "commandExecution",
    id,
    pluginId: null,
    scriptPath: null,
    command,
    cwd: ctx.cwd,
    processId: null,
    source: "agent",
    status,
    commandActions,
    aggregatedOutput: out == null ? null : cap(out),
    exitCode: status === "inProgress" ? null : status === "completed" ? 0 : 1,
    durationMs: ctx.durationMs ?? null,
  };
}

/**
 * Unified diff of two texts (one hunk, minimal line edit script). `fullFile` marks a whole-file
 * comparison, so the hunk header carries real line numbers; an Edit's snippet has none to give.
 */
export function lineDiff(a: string, b: string, fullFile = false): string {
  const lines = (s: string) => (s === "" ? [] : s.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));
  const A = lines(a);
  const B = lines(b);
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const ctx = fullFile ? 3 : Infinity;
  const head = Math.max(0, pre - ctx);
  const midA = A.slice(pre, A.length - suf);
  const midB = B.slice(pre, B.length - suf);
  const body: string[] = [];
  for (const l of A.slice(head, pre)) body.push(` ${l}`);
  body.push(...editScript(midA, midB));
  for (const l of A.slice(A.length - suf, Math.min(A.length, A.length - suf + ctx))) body.push(` ${l}`);
  const oldLen = body.filter((l) => l[0] !== "+").length;
  const newLen = body.filter((l) => l[0] !== "-").length;
  const start = fullFile ? head + 1 : 1;
  return `@@ -${start},${oldLen} +${start},${newLen} @@\n${body.join("\n")}`;
}

/** LCS-based line edit script; big inputs fall back to remove-all/add-all. */
function editScript(A: string[], B: string[]): string[] {
  if (!A.length) return B.map((l) => `+${l}`);
  if (!B.length) return A.map((l) => `-${l}`);
  if (A.length * B.length > 4_000_000) return [...A.map((l) => `-${l}`), ...B.map((l) => `+${l}`)];
  const n = A.length;
  const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push(` ${A[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(`-${A[i++]}`);
    else out.push(`+${B[j++]}`);
  }
  while (i < n) out.push(`-${A[i++]}`);
  while (j < m) out.push(`+${B[j++]}`);
  return out;
}

const WRAPPERS = /<(?:command-message|command-name|command-args|local-command-stdout|local-command-stderr|system-reminder)>[\s\S]*?<\/(?:command-message|command-name|command-args|local-command-stdout|local-command-stderr|system-reminder)>/g;

/** What the user typed, for a user message (slash commands keep their `/name args`). */
export function userText(text: string): string {
  const cmd = /<command-name>([\s\S]*?)<\/command-name>/.exec(text);
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
    return `${cmd[1].trim()}${args ? ` ${args}` : ""}`;
  }
  return text.replace(WRAPPERS, "").trim();
}

/** A user message's content as the protocol's inputs (images become data: URLs). */
export function userInputs(content: unknown): UserInput[] {
  const inputs: UserInput[] = [];
  for (const b of blocksOf(content)) {
    if (b.type === "text") {
      const text = userText(String(b.text ?? ""));
      if (text) inputs.push({ type: "text", text, text_elements: [] });
    } else if (b.type === "image" && b.source?.type === "base64") {
      inputs.push({ type: "image", url: `data:${b.source.media_type};base64,${b.source.data}` });
    } else if (b.type === "image" && b.source?.type === "url") {
      inputs.push({ type: "image", url: b.source.url });
    }
  }
  return inputs;
}

/** Real prompts start turns; tool results, meta notes and interruption markers don't. */
export function isPrompt(content: unknown): boolean {
  const blocks = blocksOf(content);
  if (!blocks.length || blocks.some((b) => b.type === "tool_result")) return false;
  const text = blocks.map((b) => (b.type === "text" ? String(b.text ?? "") : "")).join("");
  if (INTERRUPTED.test(text.trim())) return false;
  if (/^<local-command-(stdout|stderr|caveat)>/.test(text.trim())) return false;
  return blocks.some((b) => b.type === "image") || !!userText(text);
}

export const INTERRUPTED = /^\[Request interrupted by user(?: for tool use)?\]$/;

export function isInterruptMarker(content: unknown): boolean {
  return blocksOf(content).some((b) => b.type === "text" && INTERRUPTED.test(String(b.text ?? "").trim()));
}

/** Output of a local slash command (`/cost`, `/context`…), shown as a reply. */
export function localCommandOutput(content: unknown): string | null {
  const text = blocksOf(content)
    .map((b) => (b.type === "text" ? String(b.text ?? "") : ""))
    .join("");
  const m = /^<local-command-(?:stdout|stderr)>([\s\S]*?)<\/local-command-(?:stdout|stderr)>$/.exec(text.trim());
  return m ? m[1].trim() || null : null;
}
