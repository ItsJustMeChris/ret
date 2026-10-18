import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { ThreadItem, Turn, TurnPlanStep } from "../../shared/protocol";
import type { TokenUsageBreakdown } from "../../shared/protocol/generated/v2";
import { fileEdit, TurnDiff } from "./diff";
import {
  blocksOf,
  isAgentTool,
  isInterruptMarker,
  isPrompt,
  isPlanTool,
  localCommandOutput,
  planUpdate,
  toolItem,
  userInputs,
  type ToolContext,
  type ToolUse,
} from "./translate";

/** A message as `getSessionMessages` returns it (plus the runtime fields it carries beyond its typings). */
export interface StoredMessage {
  type: "user" | "assistant" | "system";
  uuid: string;
  message?: any;
  parent_tool_use_id?: string | null;
  timestamp?: string;
  is_meta?: boolean;
  isCompactSummary?: boolean;
}

export interface HistoryTurn {
  turn: Turn;
  /** Last stored message of the turn: where a fork "through this turn" cuts the transcript. */
  lastUuid: string;
  plan: TurnPlanStep[] | null;
  /** The model that answered (the API's id, e.g. claude-sonnet-5-5), if anything did. */
  model: string | null;
  /**
   * Tools that never got a result (Claude Code was stopped or crashed mid-call), as their items
   * should read once the turn's over: failed. Only a turn still running keeps them going.
   */
  unfinished?: { index: number; item: ThreadItem }[];
  /** What the turn changed in files, as `git diff` prints it (see diff.ts), if it changed any. */
  diff: string | null;
  /** Tokens: all the turn's API calls, and its last one (the context it ended with). */
  usage: { total: TokenUsageBreakdown; last: TokenUsageBreakdown | null };
}

const seconds = (ts: string | undefined) => (ts ? Math.floor(Date.parse(ts) / 1000) || null : null);

export interface BuildOptions {
  /** The thread it is (an Agent call's sender). */
  thread?: string;
  /** Agent calls' subagents, as threads, by the call's tool_use id (see agents.ts). */
  agents?: Map<string, string>;
  /** A subagent's own transcript: every message is its own, and its first run has the id it had live. */
  agent?: { firstTurnId: string };
  /** Tools' own accounts of their results (`toolUseResult`), by tool_use id: an edit's real hunks (readEditResults). */
  structured?: Map<string, unknown>;
}

/** Rebuilds a Claude session's (or one of its subagents') transcript as protocol turns, oldest first. */
export function buildTurns(messages: StoredMessage[], cwd: string, opts: BuildOptions = {}): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  const tools = new Map<string, { use: ToolUse; turn: HistoryTurn; index: number; at: number | null }>();
  const ordinals = new Map<string, number>();
  /** Turns whose prompt was a slash command: their command output is the reply. */
  const commands = new Set<string>();
  /** Turns a failed request ended, unless the model answers after it. */
  const failed = new Set<HistoryTurn>();
  let cur: HistoryTurn | null = null;
  let lastPlan: TurnPlanStep[] | null = null;
  /** Each turn's changes, and its API calls' usage by message (a streamed message repeats it on every block). */
  const diffs = new Map<HistoryTurn, TurnDiff>();
  const usages = new Map<HistoryTurn, Map<string, any>>();

  const open = (id: string, ts: string | undefined): HistoryTurn => {
    const at = seconds(ts);
    cur = {
      turn: { id, rootTurnId: null, items: [], itemsView: "full", status: "completed", error: null, startedAt: at, completedAt: at, durationMs: null },
      lastUuid: id,
      plan: null,
      model: null,
      diff: null,
      usage: { total: breakdown(null), last: null },
    };
    turns.push(cur);
    return cur;
  };
  const push = (t: HistoryTurn, item: ThreadItem) => t.turn.items.push(item);
  const ctx = (use: ToolUse): ToolContext => ({
    cwd,
    thread: opts.thread,
    structured: opts.structured?.get(use.id),
    ...(isAgentTool(use.name) && opts.agents?.has(use.id) ? { agent: opts.agents.get(use.id) } : {}),
  });

  for (const m of messages) {
    if (m.parent_tool_use_id && !opts.agent) continue; // a subagent's: in its own transcript
    const content = m.message?.content;

    if (m.type === "system") continue;
    if (m.type === "user" && m.isCompactSummary) {
      push(open(m.uuid, m.timestamp), { type: "contextCompaction", id: m.uuid });
      continue;
    }
    if (m.is_meta) continue;

    if (m.type === "user") {
      if (isInterruptMarker(content)) {
        if (cur) (cur as HistoryTurn).turn.status = "interrupted";
        continue;
      }
      const local = localCommandOutput(content);
      if (local) {
        // Output of a slash command the user ran; echoes of settings changes (model, effort) are dropped.
        const t = cur as HistoryTurn | null;
        if (/^Compacted\b/.test(local)) push(t ?? open(m.uuid, m.timestamp), { type: "contextCompaction", id: m.uuid });
        else if (t && commands.has(t.turn.id)) push(t, agentMessage(m.uuid, "```\n" + local + "\n```"));
        continue;
      }
      if (isPrompt(content) && !isSystemPrompt(content)) {
        const t = open(opts.agent && !turns.length ? opts.agent.firstTurnId : m.uuid, m.timestamp);
        const inputs = userInputs(content);
        if (inputs.some((i) => i.type === "text" && i.text.trimStart().startsWith("/"))) commands.add(t.turn.id);
        push(t, { type: "userMessage", id: m.uuid, clientId: null, content: inputs });
        continue;
      }
      // Tool results complete the items their tool_use opened, timed from one to the other.
      const at = ms(m.timestamp);
      for (const b of blocksOf(content)) {
        if (b.type !== "tool_result") continue;
        const entry = tools.get(b.tool_use_id);
        if (!entry) continue;
        tools.delete(b.tool_use_id);
        const durationMs = entry.at != null && at != null ? Math.max(0, at - entry.at) : null;
        const item = toolItem(entry.use, { content: b.content, isError: !!b.is_error }, { ...ctx(entry.use), durationMs });
        if (item) entry.turn.turn.items[entry.index] = item;
        const edit = !b.is_error ? fileEdit(opts.structured?.get(b.tool_use_id)) : null;
        if (edit) {
          if (!diffs.has(entry.turn)) diffs.set(entry.turn, new TurnDiff());
          diffs.get(entry.turn)!.note(edit);
        }
      }
      if (cur) touch(cur, m);
      continue;
    }

    // assistant
    const msg = m.message ?? {};
    const failure = apiError(msg);
    if (failure !== undefined) {
      // Claude Code's own message for a request that failed (an API error, a refusal, a sign-in
      // that expired) is the turn's error, as a live turn reports it, not a reply.
      if (failure) {
        const t: HistoryTurn = cur ?? open(m.uuid, m.timestamp);
        t.turn.status = "failed";
        t.turn.error = { message: failure, codexErrorInfo: null, additionalDetails: null, misalignment: null };
        failed.add(t);
        touch(t, m);
      }
      continue;
    }
    const t: HistoryTurn = cur ?? open(m.uuid, m.timestamp);
    // The model answered after all (Claude Code fell back to another one): the turn went on.
    if (failed.delete(t)) {
      t.turn.status = "completed";
      t.turn.error = null;
    }
    if (typeof msg.model === "string" && msg.model !== "<synthetic>") t.model = msg.model;
    if (msg.usage) {
      if (!usages.has(t)) usages.set(t, new Map());
      usages.get(t)!.set(String(msg.id ?? m.uuid), msg.usage);
    }
    const key = String(msg.id ?? m.uuid);
    for (const b of blocksOf(msg.content)) {
      const index = ordinals.get(key) ?? 0;
      ordinals.set(key, index + 1);
      const id = `${key}#${index}`;
      if (b.type === "text" && String(b.text ?? "").trim()) push(t, agentMessage(id, String(b.text)));
      else if (b.type === "thinking" && String(b.thinking ?? "").trim()) push(t, { type: "reasoning", id, summary: [String(b.thinking)], content: [] });
      else if (b.type === "tool_use") {
        const use: ToolUse = { id: b.id, name: b.name, input: b.input ?? {} };
        const plan = planUpdate(use, t.plan ?? lastPlan);
        if (plan) t.plan = lastPlan = plan;
        if (isPlanTool(use.name)) continue;
        const item = toolItem(use, undefined, ctx(use));
        if (!item) continue;
        tools.set(use.id, { use, turn: t, index: t.turn.items.length, at: ms(m.timestamp) });
        push(t, item);
      }
    }
    touch(t, m);
  }

  for (const t of turns) {
    const { startedAt, completedAt } = t.turn;
    t.turn.durationMs = startedAt != null && completedAt != null ? (completedAt - startedAt) * 1000 : null;
    const d = diffs.get(t);
    if (d && !d.empty) t.diff = d.text(cwd) || null;
    const calls = [...(usages.get(t)?.values() ?? [])].map(breakdown);
    if (calls.length) t.usage = { total: calls.reduce(addUsage, breakdown(null)), last: calls.at(-1)! };
  }
  for (const { use, turn, index } of tools.values()) {
    const item = toolItem(use, { content: "Not completed", isError: true }, ctx(use));
    if (item) (turn.unfinished ??= []).push({ index, item });
  }
  return turns;
}

/** A turn as it reads once it's over: tools that never got a result, failed (as a live turn ends them). */
export function settledTurn(t: HistoryTurn): Turn {
  if (!t.unfinished?.length) return t.turn;
  const items = t.turn.items.slice();
  for (const u of t.unfinished) items[u.index] = u.item;
  return { ...t.turn, items };
}

/**
 * A message Claude Code wrote itself rather than the model (`<synthetic>`): its text when it's
 * about a request that failed (an API error, a refusal, a sign-in that expired), "" when it says
 * nothing (its "No response requested." after an interrupt), undefined for the model's own.
 */
export function apiError(msg: any): string | undefined {
  if (msg?.model !== "<synthetic>") return undefined;
  const text = blocksOf(msg.content)
    .map((b) => (b.type === "text" ? String(b.text ?? "") : ""))
    .join("\n")
    .trim();
  return /^No response requested\.?$/.test(text) ? "" : text;
}

const ms = (ts: string | undefined) => (ts ? Date.parse(ts) || null : null);

/**
 * An API call's usage, as the protocol counts it: its input with what it read from and wrote to the
 * cache is the context in use (shared with live sessions, so a reload reads the same).
 */
export function breakdown(u: any): TokenUsageBreakdown {
  const input = (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
  const output = u?.output_tokens ?? 0;
  return {
    inputTokens: input,
    cachedInputTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteInputTokens: u?.cache_creation_input_tokens ?? 0,
    outputTokens: output,
    // Claude doesn't count its thinking apart from its output.
    reasoningOutputTokens: 0,
    totalTokens: input + output,
  };
}

export function addUsage(a: TokenUsageBreakdown, b: TokenUsageBreakdown): TokenUsageBreakdown {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningOutputTokens: a.reasoningOutputTokens + b.reasoningOutputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

/**
 * Edits' and writes' own accounts of what they did (`toolUseResult`: the file before, the real
 * hunks), by tool_use id, from the raw transcript: the SDK's reader leaves them out. Only the lines
 * that carry one are parsed.
 */
export async function readEditResults(path: string): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"structuredPatch"')) continue;
    try {
      const m = JSON.parse(line);
      const id = blocksOf(m?.message?.content).find((b) => b.type === "tool_result")?.tool_use_id;
      if (typeof id === "string" && m.toolUseResult && typeof m.toolUseResult === "object") out.set(id, m.toolUseResult);
    } catch {
      /* a line being written */
    }
  }
  return out;
}

function touch(t: HistoryTurn, m: StoredMessage) {
  t.lastUuid = m.uuid;
  const at = seconds(m.timestamp);
  if (at != null) t.turn.completedAt = at;
}

/** Messages the harness injects as "user" turns (background task results, reminders): not the user's words. */
function isSystemPrompt(content: unknown): boolean {
  const text = blocksOf(content)
    .map((b) => (b.type === "text" ? String(b.text ?? "") : ""))
    .join("")
    .trimStart();
  return /^<(task-notification|system-reminder|agent-message|cross-session-message)\b/.test(text);
}

export function agentMessage(id: string, text: string): ThreadItem {
  return { type: "agentMessage", id, text, phase: null, memoryCitation: null, delivery: null, questions: null };
}
