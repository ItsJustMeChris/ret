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
import { agentThread, agentThreadId, firstRunId, launchedAgent, type AgentRecord } from "./agents";
import { fileEdit, TurnDiff } from "./diff";
import { addUsage, agentMessage, apiError, breakdown } from "./history";
import { claudeEnv } from "./platform";
import {
  blocksOf,
  isAgentTool,
  isPlanTool,
  localCommandOutput,
  planText,
  planUpdate,
  resultText,
  toolItem,
  type ToolContext,
  type ToolResult,
  type ToolUse,
} from "./translate";

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
  /** A turn of the session's ended (Claude Code may have titled it meanwhile). */
  turnEnded(session: ClaudeSession): void;
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
  /** The compaction under way: its item, started and waiting for its boundary to complete it. */
  compacting?: string;
  /** What Claude Code said about a request that failed: the turn's error, unless it got past it. */
  failure?: string;
  /** What it changed in files (turn/diff/updated). */
  diff: TurnDiff;
}

/**
 * A subagent of the session, at work or done: a thread of its own (agents.ts), whose run is one
 * turn, from its prompt to its report. Resumed (sent another message), it starts another run.
 */
export interface LiveAgent {
  record: AgentRecord;
  threadId: string;
  turnId: string;
  running: boolean;
  startedAt: number;
  tools: Map<string, LiveTool>;
  /** Blocks of each API message already seen, as for the session's own turns. */
  ordinals: Map<string, number>;
  plan: TurnPlanStep[] | null;
  failure?: string;
  /** What its run changed in files. */
  diff: TurnDiff;
}

const ACTIVE: ThreadStatus = { type: "active", activeFlags: [] };
const IDLE: ThreadStatus = { type: "idle" };

const IDLE_CLOSE_MS = 10 * 60_000;
/** How an approval says it's for one of the thread's subagents rather than the thread itself. */
const SUBAGENT_ASKS = "For one of its subagents";
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
  /** Its subagents, by agent id (their task id), and by the Agent call that started each. */
  readonly agents = new Map<string, LiveAgent>();
  private agentByCall = new Map<string, LiveAgent>();
  /** Agent calls whose agent was only named by their result (its start never came): the thread it is on disk. */
  private callAgents = new Map<string, string>();

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
        // Subagents' text and thinking too, not just their tool calls: each has a transcript of its own here.
        forwardSubagentText: true,
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
    if (this.turn) this.finishTurn(this.turn.interrupted ? "interrupted" : "failed", error ?? this.turn.failure ?? "Claude Code exited");
    this.setBackground([]); // its background work went with it
    for (const a of this.agents.values()) this.agentEnded(a, "interrupted");
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
    for (const a of this.agents.values()) this.agentEnded(a, "interrupted");
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
    this.reportBackground();
    // Done with its background work: the process may now close after the usual quiet spell.
    if (!tasks.length && !this.turn && this.query) this.armIdle();
  }

  /** Its background work, less its subagents: they're threads of their own (the Dynamic Island lists them). */
  shownBackground(): BackgroundTask[] {
    return this.background.filter((t) => !this.agents.has(t.id));
  }

  private reportBackground() {
    this.host.notify("thread/backgroundTasks/updated", { threadId: this.config.id, tasks: this.shownBackground() });
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
      diff: new TurnDiff(),
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
    // Anything still marked running ended with the turn, a subagent working in its foreground too.
    for (const [id, t] of turn.tools) {
      const item = toolItem(t.use, { content: status === "interrupted" ? "Interrupted" : "Not completed", isError: true }, this.toolCtx(null, t));
      if (item) this.emitItem("item/completed", item);
      turn.tools.delete(id);
      this.agentEnded(this.agentByCall.get(id), status === "interrupted" ? "interrupted" : "failed");
    }
    this.turn = null;
    this.host.notify("turn/completed", { threadId: this.config.id, turn: this.protoTurn(turn, status, error) });
    this.host.turnEnded(this);
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
    const turn: LiveTurn = { id: crypto.randomUUID(), startedAt: Date.now(), itemIds: [], streamMsg: null, ordinals: new Map(), tools: new Map(), interrupted: false, compact: false, command: false, plan: null, diff: new TurnDiff() };
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
        if (msg.parent_tool_use_id) return; // a subagent's blocks come whole (handleAgent)
        return this.handleStream(msg.event as any);
      case "assistant":
        if (msg.parent_tool_use_id) return this.handleAgent(msg);
        return this.handleAssistant(msg.message as any);
      case "user":
        if (msg.parent_tool_use_id) return this.handleAgent(msg);
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
        this.followMode(msg.permissionMode);
        this.host.changed(this);
        return;
      case "status":
        this.followMode(msg.permissionMode);
        // Compacting shows as its item, started now (the Working row says so) and completed at its boundary, as Codex has it.
        if (msg.status === "compacting" && this.turn && !this.turn.compacting) {
          const id: string = msg.uuid ?? `${this.turn.id}:compact`;
          this.turn.compacting = id;
          this.emitItem("item/started", { type: "contextCompaction", id });
        }
        return;
      case "task_started":
        if (kindOf(msg.task_type) === "agent" || (!msg.task_type && msg.subagent_type)) this.agentStarted(msg);
        return;
      case "task_notification":
        return this.agentEnded(this.agents.get(String(msg.task_id)), msg.status === "completed" ? "completed" : msg.status === "stopped" ? "interrupted" : "failed");
      case "task_updated": {
        const st = msg.patch?.status;
        if (st === "completed" || st === "failed" || st === "killed") this.agentEnded(this.agents.get(String(msg.task_id)), st === "completed" ? "completed" : st === "killed" ? "interrupted" : "failed");
        return;
      }
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
        const id = turn.compacting ?? msg.uuid ?? `${turn.id}:compact`;
        turn.compacting = undefined;
        this.emitItem("item/completed", { type: "contextCompaction", id });
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

  /**
   * The permission mode Claude Code reports (at init, and in a status when it changes). Claude can
   * go into plan mode by itself (EnterPlanMode), and out of it: the thread's Plan setting follows,
   * so the Plan chip and "Implement this plan" say what it's doing, and the next sync pushes a mode
   * only when you change it, rather than holding it in plan mode (where every ExitPlanMode is
   * turned down again) or pulling it out.
   */
  private followMode(mode: PermissionMode | undefined) {
    if (!mode || !this.applied) return;
    const planning = mode === "plan";
    if (planning === this.config.plan) return;
    this.config.plan = planning;
    // What it runs now is what the thread asks for: nothing to push back.
    this.applied.mode = this.permissionMode();
    this.host.changed(this);
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
    // Claude Code's own message for a request that failed is the turn's error when it ends (as
    // history has it), not a reply; its "No response requested." after an interrupt says nothing.
    const failure = apiError(message);
    if (failure !== undefined) {
      if (failure) turn.failure = failure;
      return;
    }
    const key = String(message?.id ?? crypto.randomUUID());
    for (const b of blocksOf(message?.content)) {
      const index = turn.ordinals.get(key) ?? 0;
      turn.ordinals.set(key, index + 1);
      const id = `${key}#${index}`;
      if (b.type === "text") {
        const text = String(b.text ?? "");
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
      if (b.type === "tool_result") this.toolFinished(b.tool_use_id, { content: b.content, isError: !!b.is_error }, msg.tool_use_result);
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
      const error =
        turn.failure || (Array.isArray(msg.errors) && msg.errors.join("\n")) || (typeof msg.result === "string" && msg.result) || msg.subtype || "Claude Code reported an error";
      return this.finishTurn("failed", error);
    }
    // It got past a request that failed (Claude Code fell back to another model): say so.
    if (turn.failure) this.host.notify("warning", { threadId: this.config.id, message: turn.failure });
    this.finishTurn("completed", null);
  }

  /**
   * Usage: each API call's input (with cache) is the context in use; the result's totals add to
   * the thread's running total.
   */
  private noteUsage(u: any, turnTotal: boolean) {
    const b = breakdown(u);
    const input = b.inputTokens;
    const prev = this.usage ?? { total: emptyUsage(), last: emptyUsage(), modelContextWindow: null };
    if (turnTotal) {
      this.usage = { ...prev, total: addUsage(prev.total, b) };
    } else if (input > 0 && (input !== prev.last.inputTokens || b.outputTokens !== prev.last.outputTokens)) {
      this.usage = { ...prev, last: b };
    } else return;
    if (this.usage.modelContextWindow == null) this.usage = { ...this.usage, modelContextWindow: contextWindowFor(this.runningModel ?? this.config.model) };
    this.host.notify("thread/tokenUsage/updated", { threadId: this.config.id, turnId: this.turn?.id ?? "", tokenUsage: this.usage });
  }

  /**
   * What its transcript says it used, for a session opened again: the context ring and the details
   * have it before the next API call, and what this run uses adds to it.
   */
  resumeUsage(total: ThreadTokenUsage["total"], last: ThreadTokenUsage["last"] | null) {
    if (this.usage || !last) return;
    this.usage = { total, last, modelContextWindow: contextWindowFor(this.runningModel ?? this.config.model) };
    this.host.notify("thread/tokenUsage/updated", { threadId: this.config.id, turnId: "", tokenUsage: this.usage });
  }

  // -------------------------------------------------------------------------
  // Tools
  // -------------------------------------------------------------------------

  /** A tool call, in the session's turn or (`agent`) in one of its subagents' runs. */
  private toolStarted(use: ToolUse, agent?: LiveAgent) {
    const run = agent ?? this.ensureTurn();
    if (run.tools.has(use.id)) return;
    const plan = planUpdate(use, run.plan ?? (agent ? null : this.lastPlan));
    if (plan) {
      run.plan = plan;
      if (!agent) this.lastPlan = plan;
      this.host.notify("turn/plan/updated", { threadId: agent?.threadId ?? this.config.id, turnId: agent?.turnId ?? (run as LiveTurn).id, explanation: null, plan });
    }
    if (isPlanTool(use.name)) return;
    const tool: LiveTool = { use, startedAt: Date.now() };
    if (use.name === "Write" && typeof use.input.file_path === "string") tool.before = readText(use.input.file_path);
    run.tools.set(use.id, tool);
    const item = toolItem(use, undefined, this.toolCtx(agent ?? null, tool));
    if (item && item.type !== "plan") this.emitTo(agent, "item/started", item);
  }

  /** `structured`: the tool's own account of its result (`tool_use_result`), which names an Agent call's agent. */
  private toolFinished(toolUseId: string, result: ToolResult, structured?: any, agent?: LiveAgent) {
    const run = agent ?? this.turn;
    const tool = run?.tools.get(toolUseId);
    if (!run || !tool) return;
    run.tools.delete(toolUseId);
    // ExitPlanMode's plan item is posted when Claude asks to leave plan mode; post it now if it never asked.
    if (tool.use.name === "ExitPlanMode" && !agent) {
      if (!this.turn!.itemIds.includes(toolUseId)) this.emitItem("item/completed", { type: "plan", id: toolUseId, text: planText(tool.use.input, result) });
      return;
    }
    // An Agent call whose agent never said it started: its result names it, and its thread is on disk.
    if (isAgentTool(tool.use.name) && !this.agentByCall.has(toolUseId) && typeof structured?.agentId === "string")
      this.callAgents.set(toolUseId, agentThreadId(this.config.id, structured.agentId));
    const ctx = this.toolCtx(agent ?? null, tool, Date.now() - tool.startedAt, structured);
    const item = toolItem(tool.use, result, ctx);
    if (item) this.emitTo(agent, "item/completed", item);
    // What it did to a file goes into what the turn changed, which is sent whole each time, as Codex sends it.
    const edit = !result.isError ? fileEdit(structured) : null;
    if (edit) {
      run.diff.note(edit);
      const turnId = agent?.turnId ?? (run as LiveTurn).id;
      this.host.notify("turn/diff/updated", { threadId: agent?.threadId ?? this.config.id, turnId, diff: run.diff.text(ctx.cwd) });
    }
    // A subagent working in the foreground is done when its call is (one sent to the background goes on).
    const spawned = this.agentByCall.get(toolUseId);
    if (spawned && !launchedAgent(resultText(result.content))) this.agentEnded(spawned, result.isError ? "failed" : "completed");
  }

  /** How a tool call reads: where it runs, and for an Agent call, the agent it spawned. */
  private toolCtx(agent: LiveAgent | null, tool: LiveTool, durationMs?: number, structured?: unknown): ToolContext {
    return {
      cwd: agent?.record.cwd ?? this.config.cwd,
      before: tool.before,
      durationMs: durationMs ?? null,
      structured,
      thread: agent?.threadId ?? this.config.id,
      ...(isAgentTool(tool.use.name) ? { agent: this.agentByCall.get(tool.use.id)?.threadId ?? this.callAgents.get(tool.use.id) ?? null } : {}),
    };
  }

  private emitTo(agent: LiveAgent | undefined, method: "item/started" | "item/completed", item: ThreadItem) {
    if (agent) this.agentItem(agent, method, item);
    else this.emitItem(method, item);
  }

  // -------------------------------------------------------------------------
  // Subagents: threads of their own (agents.ts)
  // -------------------------------------------------------------------------

  /** The session's subagents, as the threads they are. */
  agentThreads() {
    return [...this.agents.values()].map((a) => this.agentThread(a));
  }

  private agentThread(a: LiveAgent) {
    return agentThread(a.record, this.config.cwd, a.running ? ACTIVE : IDLE);
  }

  /** The call an Agent tool use is, in the session's turn or in one of its agents' (one agent spawning another). */
  private callOf(id: string): { use: ToolUse; agent?: LiveAgent } | null {
    const own = this.turn?.tools.get(id);
    if (own) return { use: own.use };
    for (const a of this.agents.values()) {
      const t = a.tools.get(id);
      if (t) return { use: t.use, agent: a };
    }
    return null;
  }

  /** A subagent started (or, already known, was resumed): its thread, and a run in it. */
  private agentStarted(msg: any) {
    const id = String(msg.task_id);
    const call: string | null = typeof msg.tool_use_id === "string" ? msg.tool_use_id : null;
    const via = call ? this.callOf(call) : null;
    // Started by an Agent call; anything else (a SendMessage to it) resumes one that ran before.
    const spawned = !via || isAgentTool(via.use.name);
    const input = spawned ? (via?.use.input ?? {}) : {};
    const prompt: string | null = typeof msg.prompt === "string" && msg.prompt ? msg.prompt : typeof input.prompt === "string" ? input.prompt : null;
    let agent = this.agents.get(id);
    if (agent?.running) return;
    const now = Date.now();
    const nextRun = (threadId: string) => `${threadId}:${msg.run_id ?? crypto.randomUUID()}`;
    if (agent) {
      agent.turnId = nextRun(agent.threadId);
      agent.running = true;
      agent.startedAt = now;
      agent.failure = undefined;
      agent.diff = new TurnDiff();
      agent.record.updatedAt = Math.floor(now / 1000);
    } else {
      const parent = msg.parent_task_id ? this.agents.get(String(msg.parent_task_id)) : via?.agent;
      const record: AgentRecord = {
        sessionId: this.config.id,
        agentId: id,
        toolUseId: spawned ? call : null,
        parentAgentId: parent?.record.agentId ?? null,
        description: String(msg.description ?? input.description ?? ""),
        name: typeof input.name === "string" ? input.name : null,
        type: msg.subagent_type ?? (typeof input.subagent_type === "string" ? input.subagent_type : null),
        model: typeof input.model === "string" ? input.model : null,
        prompt,
        cwd: null,
        createdAt: Math.floor(now / 1000),
        updatedAt: Math.floor(now / 1000),
      };
      const threadId = agentThreadId(this.config.id, id);
      // (Resumed, its first run is in its transcript already, under that run's id.)
      const turnId = spawned ? firstRunId(threadId) : nextRun(threadId);
      agent = { record, threadId, turnId, running: true, startedAt: now, tools: new Map(), ordinals: new Map(), plan: null, diff: new TurnDiff() };
      this.agents.set(id, agent);
    }
    if (call) this.agentByCall.set(call, agent);
    this.host.notify("thread/started", { thread: this.agentThread(agent) });
    this.host.notify("turn/started", { threadId: agent.threadId, turn: this.runTurn(agent, "inProgress") });
    if (prompt) this.agentItem(agent, "item/completed", { type: "userMessage", id: `${agent.turnId}:prompt`, clientId: null, content: [{ type: "text", text: prompt, text_elements: [] }] });
    this.host.notify("thread/status/changed", { threadId: agent.threadId, status: ACTIVE });
    // The call that started it links to it now; and it's no longer just background work.
    if (call && via && spawned) {
      const tool = (via.agent ?? this.turn)?.tools.get(call);
      const item = tool && toolItem(tool.use, undefined, this.toolCtx(via.agent ?? null, tool));
      if (item) this.emitTo(via.agent, "item/started", item);
    }
    if (this.background.some((t) => t.id === id)) this.reportBackground();
  }

  /** What a subagent says and does: its tool calls and their results, and (forwarded) its text and thinking. */
  private handleAgent(msg: any) {
    const agent = this.agentByCall.get(msg.parent_tool_use_id) ?? (msg.agent_id ? this.agents.get(String(msg.agent_id)) : undefined);
    if (!agent) return;
    if (msg.type === "user") {
      for (const b of blocksOf(msg.message?.content))
        if (b.type === "tool_result") this.toolFinished(b.tool_use_id, { content: b.content, isError: !!b.is_error }, msg.tool_use_result, agent);
      return;
    }
    const message = msg.message;
    const failure = apiError(message);
    if (failure !== undefined) {
      if (failure) agent.failure = failure;
      return;
    }
    const key = String(message?.id ?? crypto.randomUUID());
    for (const b of blocksOf(message?.content)) {
      const index = agent.ordinals.get(key) ?? 0;
      agent.ordinals.set(key, index + 1);
      const id = `${key}#${index}`;
      if (b.type === "text" && String(b.text ?? "").trim()) this.agentItem(agent, "item/completed", agentMessage(id, String(b.text)));
      else if (b.type === "thinking" && String(b.thinking ?? "").trim()) this.agentItem(agent, "item/completed", { type: "reasoning", id, summary: [String(b.thinking)], content: [] });
      else if (b.type === "tool_use") this.toolStarted({ id: b.id, name: b.name, input: b.input ?? {} }, agent);
    }
  }

  /** A subagent's run ended: anything it still had going ended with it. */
  private agentEnded(agent: LiveAgent | undefined, status: "completed" | "failed" | "interrupted") {
    if (!agent?.running) return;
    agent.running = false;
    for (const [id, t] of agent.tools) {
      const item = toolItem(t.use, { content: status === "interrupted" ? "Interrupted" : "Not completed", isError: true }, this.toolCtx(agent, t));
      if (item) this.agentItem(agent, "item/completed", item);
      agent.tools.delete(id);
      this.agentEnded(this.agentByCall.get(id), status === "completed" ? "failed" : status);
    }
    agent.record.updatedAt = Math.floor(Date.now() / 1000);
    const error = status === "failed" ? (agent.failure ?? "The subagent stopped with an error") : null;
    this.host.notify("turn/completed", { threadId: agent.threadId, turn: this.runTurn(agent, status, error) });
    this.host.notify("thread/status/changed", { threadId: agent.threadId, status: IDLE });
  }

  /** Stop one of its subagents (its thread's Stop). */
  async stopAgent(agentId: string) {
    const agent = this.agents.get(agentId);
    if (!agent?.running || !this.query) return;
    await this.query.stopTask(agentId);
  }

  private runTurn(a: LiveAgent, status: Turn["status"], error: string | null = null): Turn {
    const now = Date.now();
    return {
      id: a.turnId,
      rootTurnId: null,
      items: [],
      itemsView: "notLoaded",
      status,
      error: error ? { message: error, codexErrorInfo: null, additionalDetails: null, misalignment: null } : null,
      startedAt: Math.floor(a.startedAt / 1000),
      completedAt: status === "inProgress" ? null : Math.floor(now / 1000),
      durationMs: status === "inProgress" ? null : now - a.startedAt,
    };
  }

  private agentItem(a: LiveAgent, method: "item/started" | "item/completed", item: ThreadItem) {
    const at = Date.now();
    this.host.notify(method, { threadId: a.threadId, turnId: a.turnId, item, ...(method === "item/started" ? { startedAtMs: at } : { completedAtMs: at }) });
  }

  /**
   * Claude Code asks before a tool runs (per its permission mode and rules). Commands, edits,
   * questions and plans each map onto the matching request Ret already answers for Codex;
   * anything else uses Ret's generic tool approval.
   *
   * A subagent's tool (`agentID`) is asked in the subagent's own thread, as Codex's agents ask in
   * theirs: the parent's Dynamic Island says it's waiting on you. One Ret hasn't met as a thread
   * (its start never came) is asked in the session's: its approval says whose it is, and an edit
   * gets the generic card (Claude's own prompt and the arguments), with no edit row above it.
   */
  private canUseTool: CanUseTool = async (toolName, input, opts) => {
    const use: ToolUse = { id: opts.toolUseID, name: toolName, input };
    const agent = opts.agentID ? this.agents.get(opts.agentID) : undefined;
    const sub = !!opts.agentID && !agent;
    // (A subagent in the background can ask after the session's turn is over: that opens none.)
    const turn = agent ? null : this.ensureTurn();
    if (agent) this.toolStarted(use, agent);
    else if (!sub) this.toolStarted(use);
    const controller = new AbortController();
    const abort = () => controller.abort();
    opts.signal.addEventListener("abort", abort);
    this.pendingRequests.add(controller);
    const threadId = agent?.threadId ?? this.config.id;
    const base = { threadId, turnId: agent?.turnId ?? turn!.id, itemId: opts.toolUseID, startedAtMs: Date.now() };
    const ask = (method: string, params: Record<string, unknown>) => this.host.request(method, { ...base, ...params }, threadId, controller.signal);
    try {
      if (toolName === "AskUserQuestion") return await this.askQuestions(input, ask);
      if (toolName === "ExitPlanMode" && !opts.agentID) {
        this.emitItem("item/completed", { type: "plan", id: opts.toolUseID, text: planText(input) });
        return {
          behavior: "deny",
          message: "The plan is now in front of the user, who will reply to approve or change it. Stop here and wait for their reply; don't start implementing.",
        };
      }
      const why = (r: string | null | undefined) => (sub ? (r ? `${SUBAGENT_ASKS}: ${r}` : `${SUBAGENT_ASKS}.`) : (r ?? null));
      const reason = why(opts.decisionReason ?? opts.description);
      let reply: any;
      if (toolName === "Bash" || toolName === "PowerShell") {
        const command = String(input.command ?? "");
        reply = await ask("item/commandExecution/requestApproval", { kind: "command", command, cwd: this.config.cwd, reason, commandActions: [{ type: "unknown", command }], environmentId: null });
      } else if (!sub && /^(Edit|MultiEdit|Write|NotebookEdit)$/.test(toolName)) {
        reply = await ask("item/fileChange/requestApproval", { reason, grantRoot: opts.blockedPath ?? null });
      } else {
        reply = await ask("item/tool/requestApproval", {
          tool: opts.displayName ?? toolName,
          title: opts.title ?? null,
          description: opts.description ?? null,
          arguments: input,
          reason: why(opts.decisionReason),
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
