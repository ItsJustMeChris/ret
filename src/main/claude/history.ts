import type { ThreadItem, Turn, TurnPlanStep } from "../../shared/protocol";
import {
  blocksOf,
  isInterruptMarker,
  isPrompt,
  isPlanTool,
  localCommandOutput,
  planUpdate,
  toolItem,
  userInputs,
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
}

const seconds = (ts: string | undefined) => (ts ? Math.floor(Date.parse(ts) / 1000) || null : null);

/** Rebuilds a Claude session's transcript as protocol turns, oldest first. */
export function buildTurns(messages: StoredMessage[], cwd: string): HistoryTurn[] {
  const turns: HistoryTurn[] = [];
  const tools = new Map<string, { use: ToolUse; turn: HistoryTurn; index: number }>();
  const ordinals = new Map<string, number>();
  /** Turns whose prompt was a slash command: their command output is the reply. */
  const commands = new Set<string>();
  let cur: HistoryTurn | null = null;
  let lastPlan: TurnPlanStep[] | null = null;

  const open = (id: string, ts: string | undefined): HistoryTurn => {
    const at = seconds(ts);
    cur = {
      turn: { id, rootTurnId: null, items: [], itemsView: "full", status: "completed", error: null, startedAt: at, completedAt: at, durationMs: null },
      lastUuid: id,
      plan: null,
      model: null,
    };
    turns.push(cur);
    return cur;
  };
  const push = (t: HistoryTurn, item: ThreadItem) => t.turn.items.push(item);

  for (const m of messages) {
    if (m.parent_tool_use_id) continue; // a subagent's own transcript
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
        const t = open(m.uuid, m.timestamp);
        const inputs = userInputs(content);
        if (inputs.some((i) => i.type === "text" && i.text.trimStart().startsWith("/"))) commands.add(t.turn.id);
        push(t, { type: "userMessage", id: m.uuid, clientId: null, content: inputs });
        continue;
      }
      // Tool results complete the items their tool_use opened.
      for (const b of blocksOf(content)) {
        if (b.type !== "tool_result") continue;
        const entry = tools.get(b.tool_use_id);
        if (!entry) continue;
        const item = toolItem(entry.use, { content: b.content, isError: !!b.is_error }, { cwd });
        if (item) entry.turn.turn.items[entry.index] = item;
      }
      if (cur) touch(cur, m);
      continue;
    }

    // assistant
    const msg = m.message ?? {};
    if (msg.model === "<synthetic>" && blocksOf(msg.content).every((b) => b.type === "text" && /^No response requested\.?$/.test(String(b.text).trim()))) continue;
    const t: HistoryTurn = cur ?? open(m.uuid, m.timestamp);
    if (typeof msg.model === "string" && msg.model !== "<synthetic>") t.model = msg.model;
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
        const item = toolItem(use, undefined, { cwd });
        if (!item) continue;
        tools.set(use.id, { use, turn: t, index: t.turn.items.length });
        push(t, item);
      }
    }
    touch(t, m);
  }

  for (const t of turns) {
    const { startedAt, completedAt } = t.turn;
    t.turn.durationMs = startedAt != null && completedAt != null ? (completedAt - startedAt) * 1000 : null;
  }
  return turns;
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
