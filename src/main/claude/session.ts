import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  EffortLevel,
  PermissionMode,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKRateLimitInfo,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { BackgroundTask, ThreadItem, ThreadStatus, ThreadTokenUsage, Turn, TurnPlanStep, UserInput } from "../../shared/protocol";
import { kindOf, sameTasks } from "./background";
import { agentMessage } from "./history";
import { claudeEnv } from "./platform";
import { blocksOf, isPlanTool, localCommandOutput, planText, planUpdate, toolItem, type ToolResult, type ToolUse } from "./translate";

/** How a thread runs tools: Claude Code's own permission modes ("config" = whatever the user's settings say). */
export type ClaudeAccess = "config" | "default" | "acceptEdits" | "auto" | "bypassPermissions";

export interface ThreadConfig {
  id: string;
  cwd: string;
  /** Model alias or id ("default" = Claude Code's default). */
  model: string | null;
  effort: string | null;
  /** Fast mode (the engine sets it only on a model that has it). */
  fast: boolean;
  access: ClaudeAccess;
  /** Plan mode: Claude explores and proposes a plan before changing anything. */
  plan: boolean;
  /** The session has a transcript on disk (resume it) rather than starting under this id. */
  exists: boolean;
  /** A fork not made yet: on first run, Claude Code copies `from` (through message `at`) under this id. */
  fork?: { from: string; at: string | null };
}

export interface SessionHost {
  appVersion: string;
  binary(): string | null;
  notify(method: string, params: unknown): void;
  /** Server request to the renderer; resolves with its reply, or null if the signal aborted first. */
  request(method: string, params: Record<string, unknown>, threadId: string, signal: AbortSignal): Promise<any | null>;
  rateLimit(info: SDKRateLimitInfo): void;
  log(text: string): void;
  /** The session's live state changed (status, settings); the engine refreshes its thread record. */
  changed(session: ClaudeSession): void;
}

/** A single-consumer async queue feeding the SDK's streaming input. */
class Inbox<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: ((r: IteratorResult<T>) => void) | null = null;
  private closed = false;

  push(item: T) {
    if (this.closed) return;
    if (this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w({ value: item, done: false });
    } else this.items.push(item);
  }

  close() {
    this.closed = true;
    this.waiting?.({ value: undefined as never, done: true });
    this.waiting = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((r) => (this.waiting = r));
      },
    };
  }
}

interface LiveTool {
  use: ToolUse;
  startedAt: number;
  /** A Write's target before it ran: its text, null if it didn't exist, undefined if unknown. */
  before?: string | null;
}

interface LiveTurn {
  id: string;
  startedAt: number;
  itemIds: string[];
  /** API message being streamed and its open blocks, by content index. */
  streamMsg: string | null;
  /** Blocks of each API message already seen complete, to give finished blocks their streamed ids. */
  ordinals: Map<string, number>;
  tools: Map<string, LiveTool>;
  interrupted: boolean;
  /** The turn is a /compact run: no user message, a compaction marker instead. */
  compact: boolean;
  /** The prompt is a slash command (`/cost`…), whose output is the reply. */
  command: boolean;
  plan: TurnPlanStep[] | null;
}

const IDLE_CLOSE_MS = 10 * 60_000;
const TEXT_LIMIT = 2_000_000;
const MEDIA: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

const emptyUsage = () => ({ totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 });

/**
 * One Claude Code conversation, live. Owns the `claude` process (through the Agent SDK's
 * streaming `query`) while the thread is in use, and translates what it says into the
 * app-server notifications Ret already renders: turns, items, deltas, approvals, questions.
 */
export class ClaudeSession {
  query: Query | null = null;
  private input: Inbox<SDKUserMessage> | null = null;
  turn: LiveTurn | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  /** The latest checklist, which a later turn's `update_plan` may move along without restating. */
  private lastPlan: TurnPlanStep[] | null = null;
  /** Settings the running process has (so changes are pushed only when they differ). */
  private applied: { model: string | null; effort: string | null; fast: boolean; mode: PermissionMode | null } | null = null;
  usage: ThreadTokenUsage | null = null;
  /** Model the session reports running (system/init), for the thread's settings. */
  runningModel: string | null = null;
  pendingRequests = new Set<AbortController>();
  /** Work the process runs on after the turn (background shells, subagents, monitors); it wakes the session when done. */
  background: BackgroundTask[] = [];

  constructor(
    readonly config: ThreadConfig,
    private readonly host: SessionHost,
  ) {}

  /** The checklist a resumed session's transcript ended with: its next `update_plan` may build on it. */
  resumePlan(plan: TurnPlanStep[] | null) {
    this.lastPlan = plan;
  }

  get status(): ThreadStatus {
    if (this.turn) return { type: "active", activeFlags: [] };
    return this.query ? { type: "idle" } : { type: "notLoaded" };
  }

  get running() {
    return !!this.turn;
  }

  // -------------------------------------------------------------------------
  // Process lifecycle
  // -------------------------------------------------------------------------

  private permissionMode(): PermissionMode | null {
    if (this.config.plan) return "plan";
    return this.config.access === "config" ? null : this.config.access;
  }

  private open() {
    if (this.query) return;
    const binary = this.host.binary();
    if (!binary) throw new Error("Claude Code isn't installed — see Settings → Claude Code");
    const input = new Inbox<SDKUserMessage>();
    const mode = this.permissionMode();
    const model = this.config.model && this.config.model !== "default" ? this.config.model : undefined;
    const q = query({
      prompt: input,
      options: {
        pathToClaudeCodeExecutable: binary,
        cwd: this.config.cwd || undefined,
        env: { ...claudeEnv(), CLAUDE_AGENT_SDK_CLIENT_APP: `ret/${this.host.appVersion}` },
        ...(this.config.exists
          ? { resume: this.config.id }
          : this.config.fork
            ? { resume: this.config.fork.from, forkSession: true, sessionId: this.config.id, ...(this.config.fork.at ? { resumeSessionAt: this.config.fork.at } : {}) }
            : { sessionId: this.config.id }),
        ...(model ? { model } : {}),
        ...(this.config.effort ? { effort: this.config.effort as EffortLevel } : {}),
        // An Agent SDK host opts in to fast mode through its flag settings, for this session only.
        ...(this.config.fast ? { settings: { fastMode: true } } : {}),
        ...(mode ? { permissionMode: mode } : {}),
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        thinking: { type: "adaptive", display: "summarized" },
        systemPrompt: { type: "preset", preset: "claude_code" },
        tools: { type: "preset", preset: "claude_code" },
        canUseTool: this.canUseTool,
        stderr: (d: string) => this.host.log(d),
      },
    });
    this.query = q;
    this.input = input;
    this.applied = { model: model ?? null, effort: this.config.effort, fast: this.config.fast, mode };
    void this.pump(q);
    this.host.changed(this);
  }

  private async pump(q: Query) {
    try {
      for await (const msg of q) {
        if (this.query !== q) return;
        try {
          this.handle(msg);
        } catch (err) {
          this.host.log(`claude: failed to handle ${msg.type}: ${(err as Error).stack ?? err}`);
        }
      }
      if (this.query === q) this.ended(null);
    } catch (err) {
      if (this.query === q) this.ended((err as Error).message || String(err));
    }
  }

  /** The process went away (closed, crashed, or failed to start). */
  private ended(error: string | null) {
    this.query = null;
    this.input?.close();
    this.input = null;
    this.applied = null;
    this.cancelRequests();
    if (this.turn) this.finishTurn(this.turn.interrupted ? "interrupted" : "failed", error ?? "Claude Code exited");
    this.setBackground([]); // its background work went with it
    this.host.changed(this);
  }

  close() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const q = this.query;
    if (!q) return;
    this.query = null;
    this.input?.close();
    this.input = null;
    this.applied = null;
    this.cancelRequests();
    if (this.turn) this.finishTurn("interrupted", null);
    try {
      q.close();
    } catch {
      /* already gone */
    }
    this.setBackground([]);
    this.host.changed(this);
  }

  private cancelRequests() {
    for (const c of this.pendingRequests) c.abort();
    this.pendingRequests.clear();
  }

  /** Close the process after a quiet spell, but never while it runs background work (that would end it). */
  private armIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.turn && !this.background.length) this.close();
    }, IDLE_CLOSE_MS);
  }

  /**
   * Claude Code's full set of live background tasks (`background_tasks_changed`, a level signal:
   * replace, don't pair start/end events). Housekeeping ("ambient") tasks aren't work to show.
   */
  private setBackground(tasks: BackgroundTask[]) {
    if (sameTasks(this.background, tasks)) return;
    this.background = tasks;
    this.host.notify("thread/backgroundTasks/updated", { threadId: this.config.id, tasks });
    // Done with its background work: the process may now close after the usual quiet spell.
    if (!tasks.length && !this.turn && this.query) this.armIdle();
  }

  /** Push changed model / effort / speed / permission mode into the running process. */
  private async sync() {
    const q = this.query;
    if (!q || !this.applied) return;
    const model = this.config.model && this.config.model !== "default" ? this.config.model : null;
    const mode = this.permissionMode();
    // Fast mode goes off before a model change and on after one, so it's never on a model without it.
    const setFast = async () => {
      if (this.config.fast === this.applied!.fast) return;
      await q.applyFlagSettings({ fastMode: this.config.fast });
      this.applied!.fast = this.config.fast;
    };
    if (!this.config.fast) await setFast();
    if (model !== this.applied.model) {
      await q.setModel(model ?? undefined);
      this.applied.model = model;
    }
    await setFast();
    if (this.config.effort !== this.applied.effort) {
      await q.applyFlagSettings({ effortLevel: (this.config.effort ?? null) as never });
      this.applied.effort = this.config.effort;
    }
    if (mode !== this.applied.mode) {
      await q.setPermissionMode(mode ?? "default");
      this.applied.mode = mode;
    }
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  async startTurn(inputs: UserInput[], clientId: string | null, opts: { compact?: boolean } = {}): Promise<Turn> {
    if (this.turn) throw new Error("A turn is already running");
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.open();
    await this.sync().catch((err) => this.host.log(`claude: settings: ${err.message}`));
    const id = crypto.randomUUID();
    const turn: LiveTurn = {
      id,
      startedAt: Date.now(),
      itemIds: [],
      streamMsg: null,
      ordinals: new Map(),
      tools: new Map(),
      interrupted: false,
      compact: !!opts.compact,
      command: !opts.compact && inputs.some((i) => i.type === "text" && i.text.trimStart().startsWith("/")),
      plan: null,
    };
    this.turn = turn;
    const proto = this.protoTurn(turn, "inProgress");
    this.host.notify("turn/started", { threadId: this.config.id, turn: proto });
    if (!opts.compact) this.emitItem("item/completed", { type: "userMessage", id, clientId, content: inputs });
    this.host.notify("thread/status/changed", { threadId: this.config.id, status: this.status });
    this.host.changed(this);
    this.input!.push({
      type: "user",
      message: { role: "user", content: opts.compact ? "/compact" : toContent(inputs) },
      parent_tool_use_id: null,
      uuid: id as never,
    });
    this.config.exists = true;
    this.config.fork = undefined;
    return proto;
  }

  /** Add a message to the running turn (Claude takes it at its next step). */
  steer(inputs: UserInput[], clientId: string | null): string {
    const turn = this.turn;
    if (!turn || !this.input) throw new Error("No turn is running");
    const id = crypto.randomUUID();
    this.emitItem("item/completed", { type: "userMessage", id, clientId, content: inputs });
    this.input.push({ type: "user", message: { role: "user", content: toContent(inputs) }, parent_tool_use_id: null, uuid: id as never, priority: "next" });
    return turn.id;
  }

  async interrupt() {
    const turn = this.turn;
    if (!turn || !this.query) return;
    turn.interrupted = true;
    this.cancelRequests();
    try {
      await this.query.interrupt();
    } catch (err) {
      this.host.log(`claude: interrupt: ${(err as Error).message}`);
      this.close();
    }
  }

  /** Apply new settings now if a process is running (otherwise they're used when it opens). */
  async reconfigure(patch: Partial<Pick<ThreadConfig, "model" | "effort" | "fast" | "access" | "plan" | "cwd">>) {
    Object.assign(this.config, patch);
    await this.sync().catch((err) => this.host.log(`claude: settings: ${err.message}`));
    this.host.changed(this);
  }

  private protoTurn(turn: LiveTurn, status: Turn["status"], error: string | null = null): Turn {
    const now = Date.now();
    return {
      id: turn.id,
      rootTurnId: null,
      items: [],
      itemsView: "notLoaded",
      status,
      error: error ? { message: error, codexErrorInfo: null, additionalDetails: null, misalignment: null } : null,
      startedAt: Math.floor(turn.startedAt / 1000),
      completedAt: status === "inProgress" ? null : Math.floor(now / 1000),
      durationMs: status === "inProgress" ? null : now - turn.startedAt,
    };
  }

  private finishTurn(status: Turn["status"], error: string | null) {
    const turn = this.turn;
    if (!turn) return;
    // Anything still marked running ended with the turn.
    for (const [id, t] of turn.tools) {
      const item = toolItem(t.use, { content: status === "interrupted" ? "Interrupted" : "Not completed", isError: true }, { cwd: this.config.cwd, before: t.before });
      if (item) this.emitItem("item/completed", item);
      turn.tools.delete(id);
    }
    this.turn = null;
    this.host.notify("turn/completed", { threadId: this.config.id, turn: this.protoTurn(turn, status, error) });
    this.host.notify("thread/status/changed", { threadId: this.config.id, status: this.status });
    this.host.changed(this);
    if (this.query) this.armIdle();
  }

  private emitItem(method: "item/started" | "item/completed", item: ThreadItem) {
    const turn = this.turn;
    if (!turn) return;
    if (!turn.itemIds.includes(item.id)) turn.itemIds.push(item.id);
    const at = Date.now();
    this.host.notify(method, { threadId: this.config.id, turnId: turn.id, item, ...(method === "item/started" ? { startedAtMs: at } : { completedAtMs: at }) });
  }

  /** Output that arrives with no turn open (a queued message Claude picked up on its own) gets one. */
  private ensureTurn(): LiveTurn {
    if (this.turn) return this.turn;
    const turn: LiveTurn = { id: crypto.randomUUID(), startedAt: Date.now(), itemIds: [], streamMsg: null, ordinals: new Map(), tools: new Map(), interrupted: false, compact: false, command: false, plan: null };
    this.turn = turn;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.host.notify("turn/started", { threadId: this.config.id, turn: this.protoTurn(turn, "inProgress") });
    this.host.notify("thread/status/changed", { threadId: this.config.id, status: this.status });
    return turn;
  }

  // -------------------------------------------------------------------------
  // SDK stream → protocol
  // -------------------------------------------------------------------------

  private handle(msg: SDKMessage) {
    switch (msg.type) {
      case "system":
        return this.handleSystem(msg as any);
      case "stream_event":
        if (msg.parent_tool_use_id) return;
        return this.handleStream(msg.event as any);
      case "assistant":
        if (msg.parent_tool_use_id) return;
        return this.handleAssistant(msg.message as any);
      case "user":
        if (msg.parent_tool_use_id) return;
        return this.handleUser(msg as any);
      case "result":
        return this.handleResult(msg as any);
      case "rate_limit_event":
        return this.host.rateLimit((msg as any).rate_limit_info);
      default:
        return;
    }
  }

  private handleSystem(msg: any) {
    switch (msg.subtype) {
      case "init":
        this.runningModel = msg.model ?? null;
        this.host.changed(this);
        return;
      case "status":
        if (this.turn) this.host.notify("warning", { threadId: this.config.id, message: msg.status === "compacting" ? "Compacting context…" : "" });
        return;
      case "background_tasks_changed": {
        const started = new Map(this.background.map((t) => [t.id, t.startedAt]));
        const tasks: BackgroundTask[] = (msg.tasks ?? [])
          .filter((t: any) => !t.ambient)
          .map((t: any) => ({ id: String(t.task_id), kind: kindOf(t.task_type), description: String(t.description ?? ""), startedAt: started.get(String(t.task_id)) ?? Date.now() }));
        this.setBackground(tasks);
        return;
      }
      case "compact_boundary": {
        const turn = this.ensureTurn();
        this.emitItem("item/completed", { type: "contextCompaction", id: msg.uuid ?? `${turn.id}:compact` });
        return;
      }
      case "api_retry":
        if (this.turn) {
          const what = msg.error_status ? `API error ${msg.error_status}` : "Connection problem";
          this.host.notify("error", {
            threadId: this.config.id,
            turnId: this.turn.id,
            willRetry: true,
            error: { message: `${what} (attempt ${msg.attempt} of ${msg.max_retries})`, codexErrorInfo: null, additionalDetails: null, misalignment: null },
          });
        }
        return;
    }
  }

  private handleStream(ev: any) {
    const turn = this.ensureTurn();
    switch (ev.type) {
      case "message_start":
        turn.streamMsg = ev.message?.id ?? null;
        if (ev.message?.usage) this.noteUsage(ev.message.usage, false);
        return;
      case "content_block_start": {
        if (!turn.streamMsg) return;
        const id = `${turn.streamMsg}#${ev.index}`;
        const b = ev.content_block;
        if (b?.type === "text") this.emitItem("item/started", agentMessage(id, ""));
        else if (b?.type === "thinking") this.emitItem("item/started", { type: "reasoning", id, summary: [], content: [] });
        return;
      }
      case "content_block_delta": {
        if (!turn.streamMsg) return;
        const itemId = `${turn.streamMsg}#${ev.index}`;
        const d = ev.delta;
        if (d?.type === "text_delta" && d.text) this.host.notify("item/agentMessage/delta", { threadId: this.config.id, turnId: turn.id, itemId, delta: d.text });
        else if (d?.type === "thinking_delta" && d.thinking)
          this.host.notify("item/reasoning/summaryTextDelta", { threadId: this.config.id, turnId: turn.id, itemId, delta: d.thinking, summaryIndex: 0 });
        return;
      }
    }
  }

  private handleAssistant(message: any) {
    const turn = this.ensureTurn();
    const key = String(message?.id ?? crypto.randomUUID());
    for (const b of blocksOf(message?.content)) {
      const index = turn.ordinals.get(key) ?? 0;
      turn.ordinals.set(key, index + 1);
      const id = `${key}#${index}`;
      if (b.type === "text") {
        const text = String(b.text ?? "");
        if (message.model === "<synthetic>" && /^No response requested\.?$/.test(text.trim())) continue;
        if (text.trim() || turn.itemIds.includes(id)) this.emitItem("item/completed", agentMessage(id, text));
      } else if (b.type === "thinking") {
        this.emitItem("item/completed", { type: "reasoning", id, summary: b.thinking ? [String(b.thinking)] : [], content: [] });
      } else if (b.type === "tool_use") {
        this.toolStarted({ id: b.id, name: b.name, input: b.input ?? {} });
      }
    }
    if (message?.usage) this.noteUsage(message.usage, false);
  }

  private handleUser(msg: any) {
    const content = msg.message?.content;
    const local = localCommandOutput(content);
    if (local) {
      // Only a slash command the user sent (or /compact) has output to show. Settings changes made
      // through the SDK (setModel…) echo one too ("Set model to …"), between turns: never a turn.
      const turn = this.turn;
      if (!turn || !(turn.command || turn.compact)) return;
      if (/^Compacted\b/.test(local)) this.emitItem("item/completed", { type: "contextCompaction", id: msg.uuid ?? `${turn.id}:compacted` });
      else this.emitItem("item/completed", agentMessage(msg.uuid ?? crypto.randomUUID(), "```\n" + local + "\n```"));
      return;
    }
    for (const b of blocksOf(content)) {
      if (b.type === "tool_result") this.toolFinished(b.tool_use_id, { content: b.content, isError: !!b.is_error });
    }
  }

  private handleResult(msg: any) {
    if (msg.modelUsage) {
      const windows = Object.values(msg.modelUsage as Record<string, any>).map((u) => u?.contextWindow).filter((n): n is number => typeof n === "number");
      if (windows.length && this.usage) this.usage = { ...this.usage, modelContextWindow: Math.max(...windows) };
    }
    if (msg.usage) this.noteUsage(msg.usage, true);
    const turn = this.turn;
    if (!turn) return;
    if (turn.interrupted) return this.finishTurn("interrupted", null);
    if (msg.is_error || msg.subtype !== "success") {
      const error = (Array.isArray(msg.errors) && msg.errors.join("\n")) || (typeof msg.result === "string" && msg.result) || msg.subtype || "Claude Code reported an error";
      return this.finishTurn("failed", error);
    }
    this.finishTurn("completed", null);
  }

  /**
   * Usage: each API call's input (with cache) is the context in use; the result's totals add to
   * the thread's running total.
   */
  private noteUsage(u: any, turnTotal: boolean) {
    const input = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const b = {
      inputTokens: input,
      cachedInputTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteInputTokens: u.cache_creation_input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      reasoningOutputTokens: 0,
      totalTokens: input + (u.output_tokens ?? 0),
    };
    const prev = this.usage ?? { total: emptyUsage(), last: emptyUsage(), modelContextWindow: null };
    if (turnTotal) {
      const t = prev.total;
      this.usage = {
        ...prev,
        total: {
          inputTokens: t.inputTokens + b.inputTokens,
          cachedInputTokens: t.cachedInputTokens + b.cachedInputTokens,
          cacheWriteInputTokens: t.cacheWriteInputTokens + b.cacheWriteInputTokens,
          outputTokens: t.outputTokens + b.outputTokens,
          reasoningOutputTokens: 0,
          totalTokens: t.totalTokens + b.totalTokens,
        },
      };
    } else if (input > 0 && (input !== prev.last.inputTokens || b.outputTokens !== prev.last.outputTokens)) {
      this.usage = { ...prev, last: b };
    } else return;
    if (this.usage.modelContextWindow == null) this.usage = { ...this.usage, modelContextWindow: contextWindowFor(this.runningModel ?? this.config.model) };
    this.host.notify("thread/tokenUsage/updated", { threadId: this.config.id, turnId: this.turn?.id ?? "", tokenUsage: this.usage });
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  private toolStarted(use: ToolUse) {
    const turn = this.ensureTurn();
    if (turn.tools.has(use.id)) return;
    const plan = planUpdate(use, turn.plan ?? this.lastPlan);
    if (plan) {
      turn.plan = this.lastPlan = plan;
      this.host.notify("turn/plan/updated", { threadId: this.config.id, turnId: turn.id, explanation: null, plan });
    }
    if (isPlanTool(use.name)) return;
    const tool: LiveTool = { use, startedAt: Date.now() };
    if (use.name === "Write" && typeof use.input.file_path === "string") tool.before = readText(use.input.file_path);
    turn.tools.set(use.id, tool);
    const item = toolItem(use, undefined, { cwd: this.config.cwd, before: tool.before });
    if (item && item.type !== "plan") this.emitItem("item/started", item);
  }

  private toolFinished(toolUseId: string, result: ToolResult) {
    const turn = this.turn;
    const tool = turn?.tools.get(toolUseId);
    if (!turn || !tool) return;
    turn.tools.delete(toolUseId);
    // ExitPlanMode's plan item is posted when Claude asks to leave plan mode; post it now if it never asked.
    if (tool.use.name === "ExitPlanMode") {
      if (!turn.itemIds.includes(toolUseId)) this.emitItem("item/completed", { type: "plan", id: toolUseId, text: planText(tool.use.input, result) });
      return;
    }
    const item = toolItem(tool.use, result, { cwd: this.config.cwd, before: tool.before, durationMs: Date.now() - tool.startedAt });
    if (item) this.emitItem("item/completed", item);
  }

  /**
   * Claude Code asks before a tool runs (per its permission mode and rules). Commands, edits,
   * questions and plans each map onto the matching request Ret already answers for Codex;
   * anything else uses Ret's generic tool approval.
   */
  private canUseTool: CanUseTool = async (toolName, input, opts) => {
    const turn = this.ensureTurn();
    const use: ToolUse = { id: opts.toolUseID, name: toolName, input };
    this.toolStarted(use);
    const controller = new AbortController();
    const abort = () => controller.abort();
    opts.signal.addEventListener("abort", abort);
    this.pendingRequests.add(controller);
    const base = { threadId: this.config.id, turnId: turn.id, itemId: opts.toolUseID, startedAtMs: Date.now() };
    const ask = (method: string, params: Record<string, unknown>) => this.host.request(method, { ...base, ...params }, this.config.id, controller.signal);
    try {
      if (toolName === "AskUserQuestion") return await this.askQuestions(input, ask);
      if (toolName === "ExitPlanMode") {
        this.emitItem("item/completed", { type: "plan", id: opts.toolUseID, text: planText(input) });
        return {
          behavior: "deny",
          message: "The plan is now in front of the user, who will reply to approve or change it. Stop here and wait for their reply; don't start implementing.",
        };
      }
      const reason = opts.decisionReason ?? opts.description ?? null;
      let reply: any;
      if (toolName === "Bash" || toolName === "PowerShell") {
        const command = String(input.command ?? "");
        reply = await ask("item/commandExecution/requestApproval", { kind: "command", command, cwd: this.config.cwd, reason, commandActions: [{ type: "unknown", command }], environmentId: null });
      } else if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(toolName)) {
        reply = await ask("item/fileChange/requestApproval", { reason, grantRoot: opts.blockedPath ?? null });
      } else {
        reply = await ask("item/tool/requestApproval", {
          tool: opts.displayName ?? toolName,
          title: opts.title ?? null,
          description: opts.description ?? null,
          arguments: input,
          reason: opts.decisionReason ?? null,
          server: opts.mcpServer?.name ?? null,
        });
      }
      return decide(reply?.decision, input, opts.suggestions);
    } finally {
      opts.signal.removeEventListener("abort", abort);
      this.pendingRequests.delete(controller);
    }
  };

  private async askQuestions(input: Record<string, any>, ask: (m: string, p: Record<string, unknown>) => Promise<any>): Promise<PermissionResult> {
    const qs: any[] = Array.isArray(input.questions) ? input.questions : [];
    const reply = await ask("item/tool/requestUserInput", {
      isBlocking: true,
      autoResolutionMs: null,
      questions: qs.map((q, i) => ({
        id: String(i),
        header: String(q.header ?? ""),
        question: String(q.question ?? ""),
        isOther: true,
        isSecret: false,
        options: Array.isArray(q.options) ? q.options.map((o: any) => ({ label: String(o.label ?? ""), description: String(o.description ?? "") })) : null,
      })),
    });
    if (!reply) return { behavior: "deny", message: "The question was withdrawn.", interrupt: true };
    const answers: Record<string, string> = {};
    qs.forEach((q, i) => {
      const a: string[] = reply.answers?.[String(i)]?.answers ?? [];
      if (a.length) answers[String(q.question)] = a.join(", ");
    });
    if (!Object.keys(answers).length) return { behavior: "deny", message: "The user skipped these questions. Carry on with your best judgment." };
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }
}

/** A reply from one of Ret's approval cards, as Claude Code's permission result. */
function decide(decision: unknown, input: Record<string, unknown>, suggestions: PermissionUpdate[] | undefined): PermissionResult {
  if (decision === "accept") return { behavior: "allow", updatedInput: input };
  if (decision === "acceptForSession") {
    // Remember it for this session only, never in the user's settings files.
    const updatedPermissions = (suggestions ?? []).map((s) => ({ ...s, destination: "session" }) as PermissionUpdate);
    return { behavior: "allow", updatedInput: input, updatedPermissions };
  }
  if (decision === "cancel") return { behavior: "deny", message: "The user stopped the turn.", interrupt: true };
  if (decision == null) return { behavior: "deny", message: "The request was withdrawn.", interrupt: true };
  return { behavior: "deny", message: "The user declined this. Don't retry it; ask what they'd like instead if you're unsure." };
}

/** UserInput (text + local images) as Anthropic message content. */
function toContent(inputs: UserInput[]): any[] {
  const content: any[] = [];
  for (const i of inputs) {
    if (i.type === "text") content.push({ type: "text", text: i.text });
    else if (i.type === "localImage") {
      const media = MEDIA[extname(i.path).toLowerCase()];
      try {
        if (media) content.push({ type: "image", source: { type: "base64", media_type: media, data: readFileSync(i.path).toString("base64") } });
        else content.push({ type: "text", text: `[Attached file: ${i.path}]` });
      } catch {
        content.push({ type: "text", text: `[Attached image could not be read: ${i.path}]` });
      }
    } else if (i.type === "image" && "url" in i) {
      const m = /^data:([^;]+);base64,(.*)$/.exec(i.url);
      if (m) content.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
      else content.push({ type: "image", source: { type: "url", url: i.url } });
    } else if (i.type === "mention" || i.type === "skill") content.push({ type: "text", text: `@${i.path}` });
  }
  return content;
}

function readText(path: string): string | null | undefined {
  try {
    if (statSync(path).size > TEXT_LIMIT) return undefined;
    return readFileSync(path, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
  }
}

/** Context window by model alias, until a result reports the real one. */
function contextWindowFor(model: string | null): number {
  return model && /\[1m\]|1m/i.test(model) ? 1_000_000 : 200_000;
}
