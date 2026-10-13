import type { ProviderId } from "@shared/bridge";
import type { FileUpdateChange, ThreadItem } from "@shared/protocol";
import { hunk } from "./diff";

/**
 * Thread items the way each engine reports them, so scripted turns render exactly like real
 * ones: Codex's shell reads and searches, Claude Code's Read/Grep tools, edits as fileChange
 * items with unified diffs, and so on.
 */

export type Item = ThreadItem;
export type Cmd = Extract<ThreadItem, { type: "commandExecution" }>;
export type Status = "inProgress" | "completed" | "failed" | "declined";

const base = (p: string) => p.split("/").pop() ?? p;
export const abs = (cwd: string, rel: string) => (rel.startsWith("/") ? rel : `${cwd}/${rel}`);

export function userMessage(id: string, text: string, clientId: string | null = null): Item {
  return { type: "userMessage", id, clientId, content: [{ type: "text", text, text_elements: [] }] };
}

export function agentMessage(id: string, text: string, phase: "commentary" | "final_answer" | null = null): Item {
  return { type: "agentMessage", id, text, phase, memoryCitation: null, delivery: null, questions: null };
}

export function reasoning(id: string, text: string): Item {
  return { type: "reasoning", id, summary: text ? [text] : [], content: [] };
}

function command(id: string, cwd: string, cmd: string, actions: Cmd["commandActions"], output: string | null, status: Status, exitCode: number | null, durationMs: number | null): Cmd {
  return {
    type: "commandExecution",
    id,
    pluginId: null,
    scriptPath: null,
    command: cmd,
    cwd,
    processId: null,
    source: "agent",
    status,
    commandActions: actions,
    aggregatedOutput: output,
    exitCode,
    durationMs,
  };
}

/** A shell command (or Claude Code's Bash tool). */
export function run(id: string, cwd: string, cmd: string, output: string | null, opts: { exit?: number | null; ms?: number | null; status?: Status } = {}): Cmd {
  const exit = opts.exit === undefined ? 0 : opts.exit;
  const status = opts.status ?? (exit == null ? "inProgress" : exit === 0 ? "completed" : "failed");
  return command(id, cwd, cmd, [{ type: "unknown", command: cmd }], output, status, status === "inProgress" ? null : exit, opts.ms ?? null);
}

/** Reading a file: `sed -n` for Codex, the Read tool for Claude Code. */
export function read(provider: ProviderId, id: string, cwd: string, rel: string, text: string, ms = 40): Cmd {
  const path = abs(cwd, rel);
  if (provider === "claude") {
    const numbered = text
      .replace(/\n$/, "")
      .split("\n")
      .map((l, i) => `${String(i + 1).padStart(6)}\t${l}`)
      .join("\n");
    return command(id, cwd, `Read ${path}`, [{ type: "read", command: `Read ${path}`, name: base(path), path }], numbered, "completed", 0, ms);
  }
  const n = text.split("\n").length;
  const cmd = `sed -n '1,${Math.max(200, Math.ceil(n / 100) * 100)}p' ${rel}`;
  return command(id, cwd, cmd, [{ type: "read", command: cmd, name: base(path), path }], text, "completed", 0, ms);
}

/** A search: ripgrep for Codex, the Grep tool for Claude Code. */
export function search(provider: ProviderId, id: string, cwd: string, query: string, rel: string | null, output: string, ms = 60): Cmd {
  if (provider === "claude") {
    const path = rel ? abs(cwd, rel) : null;
    const cmd = `grep ${query}${path ? ` ${path}` : ""}`;
    return command(id, cwd, cmd, [{ type: "search", command: cmd, query, path }], output, "completed", 0, ms);
  }
  const cmd = `rg -n ${/\s/.test(query) ? JSON.stringify(query) : query}${rel ? ` ${rel}` : ""}`;
  return command(id, cwd, cmd, [{ type: "search", command: cmd, query, path: rel }], output, "completed", 0, ms);
}

export function listFiles(provider: ProviderId, id: string, cwd: string, rel: string, output: string): Cmd {
  const path = provider === "claude" ? abs(cwd, rel) : rel;
  const cmd = `ls ${path}`;
  return command(id, cwd, cmd, [{ type: "listFiles", command: cmd, path }], output, "completed", 0, 30);
}

export type Change = { rel: string; before: string | null; after: string | null };

/** One edit (or several files' edits at once) as a fileChange item. */
export function fileChange(id: string, cwd: string, changes: Change[], status: Status = "completed"): Item {
  const out: FileUpdateChange[] = changes.map((c) => {
    const path = abs(cwd, c.rel);
    if (c.before == null) return { path, kind: { type: "add" }, diff: c.after ?? "" };
    if (c.after == null) return { path, kind: { type: "delete" }, diff: c.before };
    return { path, kind: { type: "update", move_path: null }, diff: hunk(c.before, c.after) };
  });
  return { type: "fileChange", id, changes: out, status };
}

export function plan(id: string, text: string): Item {
  return { type: "plan", id, text };
}

export interface Question {
  header: string;
  question: string;
  options: { label: string; description: string }[];
}

/** Claude Code's AskUserQuestion, as the step it leaves in the transcript. */
export function asked(id: string, questions: Question[], answers: string[] | null, status: Status = answers ? "completed" : "inProgress"): Item {
  const text = answers
    ? `User has answered your questions: ${questions.map((q, i) => `"${q.question}"="${answers[i] ?? ""}"`).join(", ")}. You can now continue with the user's answers in mind.`
    : null;
  return {
    type: "dynamicToolCall",
    id,
    namespace: null,
    tool: questions.length > 1 ? `Asked ${questions.length} questions` : "Asked a question",
    arguments: questions.length === 1 ? questions[0].question : questions.map((q) => q.question),
    status: status === "declined" ? "failed" : status,
    contentItems: text ? [{ type: "inputText", text }] : null,
    success: answers ? true : null,
    durationMs: null,
  };
}
