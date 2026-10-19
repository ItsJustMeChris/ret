import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  AgentCapabilities,
  AuthMethod,
  InitializeResponse,
  ListSessionsResponse,
  LoadSessionResponse,
  NewSessionResponse,
  PermissionOption,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionConfigOption,
  SessionConfigSelectOption,
  SessionInfo,
  SessionModeState,
  SessionNotification,
  SessionUpdate,
  Usage,
} from "@agentclientprotocol/sdk";
import type { EngineStatus, ProviderId } from "../../shared/bridge";
import type { Model, Thread, ThreadItem, ThreadTokenUsage, Turn, TurnPlanStep, TurnWithPlan, UserInput } from "../../shared/protocol";
import { FsService } from "../fsService";
import { gitInfo } from "../git";
import { PtyService } from "../pty";
import { AcpConnection, type AcpError } from "./connection";
import { commandLine, spawnAgent, type AcpCommand } from "./platform";
import { blockText, toPrompt, TurnBuilder, type ItemEvent } from "./translate";

export interface AcpTarget {
  command: AcpCommand;
  source: "system" | "custom";
  /** Its version, when known before it starts (an agent's `initialize` may say it instead). */
  version: string | null;
}

/** What Ret remembers about an agent's sessions that the agent itself may not. */
interface EngineState {
  archived: string[];
  /** Names given in Ret (ACP has no rename). */
  names: Record<string, string>;
  /** Fork → the thread it was forked from. */
  lineage: Record<string, string>;
  settings: Record<string, ThreadChoices>;
  /** Sessions started here: their folder and first prompt, and all an agent that can't list its sessions has. */
  known: Record<string, KnownSession>;
  /** What the agent offered last (models, effort levels, modes), for the composer before any session is open. */
  offered: Offered | null;
}

interface ThreadChoices {
  model?: string | null;
  effort?: string | null;
  plan?: boolean;
}

interface KnownSession {
  cwd: string;
  title: string | null;
  preview: string;
  createdAt: number;
  updatedAt: number;
}

/** The unstable `models` of `session/new` (Gemini CLI's), from before models were a config option. */
interface LegacyModels {
  availableModels: { modelId: string; name: string; description?: string | null }[];
  currentModelId: string;
}

interface Offered {
  config: SessionConfigOption[];
  modes: SessionModeState | null;
  models: LegacyModels | null;
  /** The model a new session starts on (the agent's default). */
  defaultModel: string | null;
  defaultEffort: string | null;
}

interface StoredTurn {
  turn: Turn;
  plan: TurnPlanStep[] | null;
}

interface LiveTurn {
  id: string;
  startedAt: number;
  builder: TurnBuilder;
  interrupted: boolean;
  /** Messages sent while it runs: each goes to the agent as the next prompt of this turn. */
  queued: UserInput[][];
  steers: number;
  /** Approvals waiting on the user. */
  requests: Set<AbortController>;
}

/** A session open in the agent's process. */
interface LiveSession {
  id: string;
  cwd: string;
  history: StoredTurn[];
  turn: LiveTurn | null;
  config: SessionConfigOption[];
  modes: SessionModeState | null;
  models: LegacyModels | null;
  /** The mode it goes back to when Plan is turned off. */
  baseMode: string | null;
  usage: ThreadTokenUsage | null;
  /** History being replayed by `session/load`. */
  replay: Replay | null;
}

const STDERR_LINES = 200;
const sec = (ms: number) => Math.floor(ms / 1000);
const emptyUsage = () => ({ totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 });

type RpcError = Error & { code?: number };
const rpcError = (message: string, code = -32000): RpcError => Object.assign(new Error(message), { code });

/** ACP's error for a session that needs its user to sign in first. */
const AUTH_REQUIRED = -32000;

/** Titles an agent gives a session before it has one ("New session - 2026-10-18T17:26:01.091Z"): not names. */
const PLACEHOLDER_TITLE = /^new (session|chat|conversation)\b/i;

/**
 * An agent that speaks the Agent Client Protocol (agentclientprotocol.com) — OpenCode, Gemini CLI,
 * Goose, Copilot… — as an app-server: the renderer drives it with the protocol it already speaks
 * to Codex. One agent process serves all of the engine's sessions; requests are answered here in
 * the main process and lines go to the renderer once per event-loop turn, like the other engines.
 */
export class AcpEngine {
  status: EngineStatus;
  private target: AcpTarget | null = null;
  private conn: AcpConnection | null = null;
  private connecting: Promise<AcpConnection> | null = null;
  private caps: AgentCapabilities = {};
  private authMethods: AuthMethod[] = [];
  private live = new Map<string, LiveSession>();
  private opening = new Map<string, Promise<LiveSession>>();
  /** What the agent's session list said last, by session. */
  private infos = new Map<string, SessionInfo>();
  private listed: { at: number; reading: Promise<void> | null } = { at: 0, reading: null };
  private outbox: string[] = [];
  private flushScheduled = false;
  private nextRequestId = 1;
  private requests = new Map<string, { method: string; params: unknown; resolve: (v: any) => void }>();
  private state: EngineState = { archived: [], names: {}, lineage: {}, settings: {}, known: {}, offered: null };
  private saveTimer: NodeJS.Timeout | null = null;
  private fs = new FsService((m, p) => this.notify(m, p));
  private pty = new PtyService((m, p) => this.notify(m, p));
  /** Names last told the renderer, so each goes out once. */
  private named = new Map<string, string>();
  private reported = new Map<string, string>();

  constructor(
    readonly provider: ProviderId,
    /** What to call the agent in messages (its settings' name, else what it calls itself). */
    private readonly label: () => string,
    private readonly stateFile: string,
    private readonly appVersion: string,
    private readonly onLines: (lines: string[]) => void,
    private readonly onStatus: (status: EngineStatus) => void,
  ) {
    this.status = { provider, state: "stopped", generation: 0, version: null, binaryPath: null, source: null, engine: "dedicated", error: null, stderrTail: [], agentName: null };
    try {
      this.state = { ...this.state, ...JSON.parse(readFileSync(stateFile, "utf8")) };
    } catch {
      /* first run */
    }
  }

  private get name() {
    return this.label() || this.status.agentName || "The agent";
  }

  // -------------------------------------------------------------------------
  // Lifecycle (driven by the main process)
  // -------------------------------------------------------------------------

  private setStatus(patch: Partial<EngineStatus>) {
    this.status = { ...this.status, ...patch };
    this.onStatus(this.status);
  }

  /** Start the agent (again) on this command: a new generation makes the renderer re-initialize. */
  async start(target: AcpTarget) {
    this.target = target;
    this.closeAll();
    this.setStatus({ state: "starting", binaryPath: [target.command.program, ...target.command.args].join(" "), source: target.source, version: target.version, error: null });
    try {
      await this.ensureConn();
      this.setStatus({ state: "running", generation: this.status.generation + 1, error: null });
    } catch (err) {
      if (this.target !== target) return;
      const e = err as NodeJS.ErrnoException;
      this.setStatus({ state: e.code === "ENOENT" ? "missing" : "error", error: e.message || String(err) });
    }
  }

  setMissing(error: string) {
    this.target = null;
    this.closeAll();
    this.setStatus({ state: "missing", error, binaryPath: null, version: null, source: null });
  }

  disable() {
    this.target = null;
    this.closeAll();
    this.setStatus({ state: "disabled", error: null });
  }

  stop() {
    this.closeAll();
    this.fs.dispose();
    this.pty.dispose();
    void this.saveNow();
  }

  /** Forget what was remembered about the agent's sessions (Settings now names another agent). */
  resetState() {
    this.state = { archived: [], names: {}, lineage: {}, settings: {}, known: {}, offered: null };
    this.infos.clear();
    this.save();
  }

  get busy() {
    return [...this.live.values()].some((s) => s.turn);
  }

  /** How to sign in to the agent in a terminal, if it says (an ACP terminal auth method). */
  loginCommand(fallback?: string[]): string | null {
    const cmd = this.target?.command;
    if (!cmd) return null;
    const terminal = this.authMethods.find((m): m is Extract<AuthMethod, { type: "terminal" }> => (m as { type?: string }).type === "terminal");
    if (terminal) return commandLine(cmd.program, [...cmd.args, ...(terminal.args ?? [])]);
    return fallback ? commandLine(cmd.program, fallback) : null;
  }

  private closeAll() {
    const conn = this.conn;
    this.conn = null;
    this.connecting = null;
    conn?.kill();
    this.dropSessions("The agent was restarted");
    for (const r of this.requests.values()) r.resolve(null);
    this.requests.clear();
  }

  /** The agent's process went away: its sessions with it (they're reopened on next use). */
  private dropSessions(reason: string) {
    for (const s of this.live.values()) {
      if (s.turn) this.finishTurn(s, s.turn, s.turn.interrupted ? "interrupted" : "failed", s.turn.interrupted ? null : reason);
      this.notify("thread/status/changed", { threadId: s.id, status: { type: "notLoaded" } });
    }
    this.live.clear();
    this.opening.clear();
  }

  private log(text: string) {
    const tail = this.status.stderrTail.concat(text.split(/\r?\n/).filter(Boolean));
    this.status = { ...this.status, stderrTail: tail.slice(-STDERR_LINES) };
  }

  /** The agent's process, started and initialized if it isn't running. */
  private ensureConn(): Promise<AcpConnection> {
    if (this.conn?.alive) return Promise.resolve(this.conn);
    const target = this.target;
    if (!target) return Promise.reject(rpcError(this.status.error ?? `${this.name} isn't set up`));
    this.connecting ??= this.connect(target).finally(() => (this.connecting = null));
    return this.connecting;
  }

  private async connect(target: AcpTarget): Promise<AcpConnection> {
    const proc = spawnAgent(target.command, process.env);
    const conn = new AcpConnection(proc, {
      request: (method, params) => this.fromAgent(method, params),
      notification: (method, params) => {
        if (method === "session/update" && this.conn === conn) this.onUpdate(params as SessionNotification);
      },
      stderr: (text) => this.log(text),
      exit: (reason) => {
        this.log(reason);
        if (this.conn !== conn) return;
        this.conn = null;
        this.dropSessions(reason);
      },
    });
    // Spawning fails asynchronously (a missing program): say so rather than wait for initialize.
    const spawned = new Promise<never>((_, reject) => proc.once("error", reject));
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${this.name} didn't start in time`)), 60_000));
    try {
      const init = await Promise.race([
        conn.request<InitializeResponse>("initialize", {
          protocolVersion: 1,
          // Ret reads and writes files and runs commands through the agent's own tools, not for it.
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: "ret", title: "Ret", version: this.appVersion },
        }),
        spawned,
        timeout,
      ]);
      if (this.target !== target) throw new Error("The agent was restarted");
      this.caps = init.agentCapabilities ?? {};
      this.authMethods = init.authMethods ?? [];
      this.setStatus({ agentName: init.agentInfo?.title || init.agentInfo?.name || null, version: init.agentInfo?.version || target.version });
      this.conn = conn;
      return conn;
    } catch (err) {
      conn.kill();
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Transport to the renderer
  // -------------------------------------------------------------------------

  private write(msg: object) {
    this.outbox.push(JSON.stringify(msg));
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      if (!this.outbox.length) return;
      const batch = this.outbox;
      this.outbox = [];
      this.onLines(batch);
    });
  }

  private notify(method: string, params: unknown) {
    this.write({ method, params });
  }

  /** One line from the renderer: a request, a notification, or the reply to one of our requests. */
  send(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method && msg.id !== undefined) void this.dispatch(msg.id, msg.method, msg.params ?? {});
    else if (msg.id !== undefined) {
      const req = this.requests.get(String(msg.id));
      if (!req) return;
      this.requests.delete(String(msg.id));
      req.resolve(msg.error ? null : msg.result);
    }
  }

  private async dispatch(id: number | string, method: string, params: any) {
    try {
      const result = await this.call(method, params);
      this.write({ id, result: result ?? {} });
    } catch (err) {
      const e = err as RpcError;
      this.write({ id, error: { code: e.code ?? -32000, message: e.message || String(err) } });
    }
  }

  /** A server request to the renderer (an approval); resolves with its reply, or null if withdrawn. */
  private ask(method: string, params: Record<string, unknown>, threadId: string, signal: AbortSignal): Promise<any | null> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve(null);
      const id = `${this.provider}:${this.nextRequestId++}`;
      const done = (v: any) => {
        signal.removeEventListener("abort", abort);
        resolve(v);
      };
      const abort = () => {
        if (!this.requests.delete(id)) return;
        this.notify("serverRequest/resolved", { threadId, requestId: id });
        done(null);
      };
      signal.addEventListener("abort", abort);
      this.requests.set(id, { method, params, resolve: done });
      this.write({ id, method, params });
    });
  }

  // -------------------------------------------------------------------------
  // Methods
  // -------------------------------------------------------------------------

  private async call(method: string, p: any): Promise<unknown> {
    if (this.fs.handles(method)) return this.fs.call(method, p);
    if (this.pty.handles(method)) return this.pty.call(method, p);
    if (method !== "initialize" && this.status.state !== "running") throw rpcError(this.status.error ?? `${this.name} is not available`);
    switch (method) {
      case "initialize":
        // A new connection: anything still waiting on the old one is asked again.
        setImmediate(() => {
          for (const [id, r] of this.requests) this.write({ id, method: r.method, params: r.params });
        });
        return { userAgent: `${this.status.agentName ?? this.provider}/${this.status.version ?? "unknown"}`, codexHome: "", platformFamily: process.platform === "win32" ? "windows" : "unix", platformOs: process.platform };
      case "thread/list":
        return this.listThreads(p);
      case "thread/read":
        return { thread: await this.readThread(p.threadId) };
      case "thread/turns/list":
        return this.listTurns(p);
      case "thread/start":
        return this.startThread(p);
      case "thread/resume": {
        const s = await this.session(p.threadId);
        return this.settingsResponse(await this.readThread(p.threadId), s);
      }
      case "thread/unsubscribe":
        return {};
      case "thread/fork":
        return this.forkThread(p);
      case "thread/name/set": {
        const name = String(p.name ?? "").trim();
        if (name) this.state.names[p.threadId] = name;
        else delete this.state.names[p.threadId];
        this.save();
        this.notify("thread/name/updated", { threadId: p.threadId, threadName: name || this.titleOf(p.threadId) });
        return {};
      }
      case "thread/archive":
        return this.archive(p.threadId);
      case "turn/start":
        return this.startTurn(p);
      case "turn/steer": {
        const s = this.live.get(p.threadId);
        const turn = s?.turn;
        if (!s || !turn || (p.expectedTurnId && turn.id !== p.expectedTurnId)) throw rpcError("No turn is running to steer");
        // ACP takes one prompt at a time: this one goes when the agent finishes with the last.
        const item: ThreadItem = { type: "userMessage", id: `${turn.id}:user${++turn.steers}`, clientId: p.clientUserMessageId ?? null, content: p.input ?? [] };
        turn.builder.items.set(item.id, item);
        this.emit(s, turn, [{ method: "item/completed", item }]);
        turn.queued.push(p.input ?? []);
        return { turnId: turn.id };
      }
      case "turn/interrupt": {
        const s = this.live.get(p.threadId);
        if (s?.turn) this.interrupt(s, s.turn);
        return {};
      }
      case "model/list":
        return { data: this.modelList(), nextCursor: null };
      case "collaborationMode/list":
        return {
          data: this.planModeOf(this.state.offered?.modes ?? null, this.state.offered?.config ?? [])
            ? [
                { name: "Plan", mode: "plan", model: null, reasoning_effort: null },
                { name: "Default", mode: "default", model: null, reasoning_effort: null },
              ]
            : [],
        };
      case "config/read":
        return { config: { model: this.state.offered?.defaultModel ?? null, model_reasoning_effort: this.state.offered?.defaultEffort ?? null } };
      case "account/read":
        // The agent signs in for itself; Ret hears it needs to when a session says so.
        return { account: null, requiresOpenaiAuth: false, workspaceRouting: null };
      case "account/login/start":
      case "account/logout":
        throw rpcError(`Sign in and out with ${this.name} itself.`);
      default:
        throw rpcError(`${method} is not supported for ${this.name}`, -32601);
    }
  }

  // ---- threads ------------------------------------------------------------

  /** What the agent's list says about a session, else what Ret remembers of it. */
  private infoOf(id: string): { cwd: string; title: string | null; updatedAt: number; createdAt: number } | null {
    const info = this.infos.get(id);
    const known = this.state.known[id];
    if (!info && !known) return null;
    const updated = info?.updatedAt ? Date.parse(info.updatedAt) : NaN;
    return {
      cwd: info?.cwd ?? known!.cwd,
      title: info?.title ?? known?.title ?? null,
      updatedAt: Number.isFinite(updated) ? Math.max(updated, known?.updatedAt ?? 0) : (known?.updatedAt ?? 0),
      createdAt: known?.createdAt ?? (Number.isFinite(updated) ? updated : 0),
    };
  }

  private titleOf(id: string): string | null {
    const title = this.infoOf(id)?.title?.trim();
    return title && !PLACEHOLDER_TITLE.test(title) ? title : null;
  }

  private threadFrom(id: string): Thread {
    const info = this.infoOf(id)!;
    const s = this.live.get(id);
    const set = this.state.settings[id];
    return {
      id,
      environments: null,
      extra: null,
      sessionId: id,
      forkedFromId: this.state.lineage[id] ?? null,
      parentThreadId: null,
      preview: this.state.known[id]?.preview || this.titleOf(id) || "",
      ephemeral: false,
      section: null,
      sectionEnteredAt: null,
      projectId: null,
      historyMode: "paginated",
      modelProvider: this.provider,
      model: (s && this.currentModel(s)) ?? set?.model ?? null,
      reasoningEffort: set?.effort ?? null,
      createdAt: sec(info.createdAt || info.updatedAt),
      updatedAt: sec(info.updatedAt),
      recencyAt: sec(info.updatedAt),
      status: s?.turn ? { type: "active", activeFlags: [] } : s ? { type: "idle" } : { type: "notLoaded" },
      path: null,
      cwd: info.cwd,
      cliVersion: "",
      originator: this.provider,
      source: "unknown",
      canAcceptDirectInput: null,
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: this.state.names[id] ?? this.titleOf(id),
      daybreakEnabled: null,
      turns: [],
    };
  }

  /** The agent's own list of its sessions (all folders), read at most every 2 s. */
  private refreshList(): Promise<void> {
    if (!this.caps.sessionCapabilities?.list || Date.now() - this.listed.at < 2000) return Promise.resolve();
    this.listed.reading ??= (async () => {
      try {
        const conn = await this.ensureConn();
        let cursor: string | null | undefined = undefined;
        // Pages until it's all there (with a bound, for an agent that never stops paging).
        for (let page = 0; page < 50; page++) {
          const res: ListSessionsResponse = await conn.request("session/list", cursor ? { cursor } : {});
          for (const s of res.sessions ?? []) this.infos.set(s.sessionId, s);
          cursor = res.nextCursor;
          if (!cursor) break;
        }
        this.listed.at = Date.now();
      } catch (err) {
        this.log(`session/list: ${(err as Error).message}`);
      } finally {
        this.listed.reading = null;
      }
    })();
    return this.listed.reading;
  }

  private async listThreads(p: any) {
    // An ACP agent has no subagents' threads to list.
    if (p?.ancestorThreadId || p?.sourceKinds?.includes?.("subAgentThreadSpawn")) return { data: [], nextCursor: null, backwardsCursor: null };
    await this.refreshList();
    const ids = new Set([...this.infos.keys(), ...Object.keys(this.state.known)]);
    const threads = [...ids].filter((id) => !this.state.archived.includes(id)).map((id) => this.threadFrom(id));
    threads.sort((a, b) => b.updatedAt - a.updatedAt);
    const offset = Number(p.cursor ?? 0) || 0;
    const limit = Math.max(1, Number(p.limit ?? 100));
    return { data: threads.slice(offset, offset + limit), nextCursor: offset + limit < threads.length ? String(offset + limit) : null, backwardsCursor: null };
  }

  private async readThread(id: string): Promise<Thread> {
    if (!this.infoOf(id)) {
      this.listed.at = 0;
      await this.refreshList();
    }
    if (!this.infoOf(id)) throw rpcError(`No ${this.name} session ${id}`);
    return this.threadFrom(id);
  }

  /** The session, open in the agent: reopened with its history (`session/load`) on first use. */
  private session(id: string): Promise<LiveSession> {
    const s = this.live.get(id);
    if (s) return Promise.resolve(s);
    let opening = this.opening.get(id);
    if (!opening) {
      opening = this.open(id).finally(() => this.opening.delete(id));
      this.opening.set(id, opening);
    }
    return opening;
  }

  private async open(id: string): Promise<LiveSession> {
    await this.readThread(id);
    const cwd = this.infoOf(id)!.cwd;
    const conn = await this.ensureConn();
    const s = newSession(id, cwd);
    if (this.caps.loadSession) {
      // The agent replays the conversation as updates, then answers.
      s.replay = new Replay(id, cwd);
      this.live.set(id, s);
      try {
        const res = await conn.request<LoadSessionResponse>("session/load", { sessionId: id, cwd, mcpServers: [] });
        s.history = s.replay.finish();
        this.adopt(s, res, false);
      } catch (err) {
        if (this.live.get(id) === s) this.live.delete(id);
        throw rpcError(`${this.name} couldn't open this session: ${(err as Error).message}`);
      } finally {
        s.replay = null;
      }
    } else if (this.caps.sessionCapabilities?.resume) {
      // Resumed without its history: what it said before stays with the agent.
      this.live.set(id, s);
      try {
        this.adopt(s, await conn.request("session/resume", { sessionId: id, cwd, mcpServers: [] }), false);
      } catch (err) {
        this.live.delete(id);
        throw rpcError(`${this.name} couldn't open this session: ${(err as Error).message}`);
      }
    } else {
      throw rpcError(`${this.name} can't reopen its sessions after it restarts`);
    }
    this.notify("thread/status/changed", { threadId: id, status: { type: "idle" } });
    this.sessionChanged(s);
    return s;
  }

  /** A session's settings, as `session/new`, `load`, `resume` or `fork` reported them. */
  private adopt(s: LiveSession, res: Partial<NewSessionResponse> & { models?: LegacyModels | null }, fresh: boolean) {
    s.config = res.configOptions ?? [];
    s.modes = res.modes ?? null;
    s.models = res.models ?? null;
    const plan = this.planModeOf(s.modes, s.config);
    const mode = this.currentMode(s);
    s.baseMode = mode && mode !== plan ? mode : (s.modes?.availableModes.find((m) => m.id !== plan)?.id ?? null);
    const prev = this.state.offered;
    const next: Offered = {
      config: s.config,
      modes: s.modes,
      models: s.models,
      defaultModel: fresh ? this.currentModel(s) : (prev?.defaultModel ?? this.currentModel(s)),
      defaultEffort: fresh ? this.currentEffort(s) : (prev?.defaultEffort ?? this.currentEffort(s)),
    };
    const sig = (o: Offered | null) => JSON.stringify(o && [o.config.map((c) => [c.id, c.type === "select" ? flatOptions(c.options).map((x) => x.value) : null]), o.modes?.availableModes.map((m) => m.id), o.models?.availableModels.map((m) => m.modelId), o.defaultModel, o.defaultEffort]);
    if (sig(prev) === sig(next)) return;
    this.state.offered = next;
    this.save();
    // The composer reads the model list again.
    this.notify("model/list/updated", {});
  }

  private option(s: { config: SessionConfigOption[] }, category: string): Extract<SessionConfigOption, { type: "select" }> | undefined {
    return s.config.find((c): c is Extract<SessionConfigOption, { type: "select" }> => c.type === "select" && (c.category === category || c.id === category));
  }

  private currentModel(s: LiveSession): string | null {
    return this.option(s, "model")?.currentValue ?? s.models?.currentModelId ?? null;
  }

  private currentEffort(s: LiveSession): string | null {
    return this.option(s, "thought_level")?.currentValue ?? null;
  }

  private currentMode(s: LiveSession): string | null {
    return s.modes?.currentModeId ?? this.option(s, "mode")?.currentValue ?? null;
  }

  /** The agent's plan mode (OpenCode's "plan", Claude's "plan"…), if it has one. */
  private planModeOf(modes: SessionModeState | null, config: SessionConfigOption[]): string | null {
    const isPlan = (id: string, name: string) => /\bplan/i.test(id) || /\bplan/i.test(name);
    const m = modes?.availableModes.find((x) => isPlan(x.id, x.name));
    if (m) return m.id;
    const opt = this.option({ config }, "mode");
    return (opt && flatOptions(opt.options).find((o) => isPlan(o.value, o.name))?.value) ?? null;
  }

  private async startThread(p: any) {
    const cwd = String(p.cwd ?? "");
    if (!cwd) throw rpcError(`${this.name} needs a folder to work in`);
    const conn = await this.ensureConn();
    const res = await conn.request<NewSessionResponse & { models?: LegacyModels }>("session/new", { cwd, mcpServers: [] }).catch((err: AcpError) => {
      throw rpcError(this.errorText(err));
    });
    const id = res.sessionId;
    const now = Date.now();
    this.state.known[id] = { cwd, title: null, preview: "", createdAt: now, updatedAt: now };
    this.rememberSettings(id, p);
    const s = newSession(id, cwd);
    this.live.set(id, s);
    this.adopt(s, res, true);
    const thread = this.threadFrom(id);
    const git = await gitInfo(cwd).catch(() => null);
    if (git?.branch) thread.gitInfo = { sha: null, branch: git.branch, originUrl: null };
    this.notify("thread/started", { thread });
    return this.settingsResponse(thread, s);
  }

  private async forkThread(p: any) {
    if (!this.caps.sessionCapabilities?.fork) throw rpcError(`${this.name} can't fork its sessions`, -32601);
    const source = await this.session(String(p.threadId));
    if (p.lastTurnId && source.history.at(-1)?.turn.id !== p.lastTurnId) throw rpcError(`${this.name} can only fork a thread from its latest turn`);
    const cwd = p.cwd ? String(p.cwd) : source.cwd;
    const conn = await this.ensureConn();
    const res = await conn.request<NewSessionResponse & { models?: LegacyModels }>("session/fork", { sessionId: source.id, cwd, mcpServers: [] });
    const id = res.sessionId;
    const now = Date.now();
    const from = this.state.known[source.id];
    this.state.known[id] = { cwd, title: this.titleOf(source.id), preview: from?.preview ?? "", createdAt: now, updatedAt: now };
    this.state.lineage[id] = source.id;
    this.state.settings[id] = { ...this.state.settings[source.id] };
    this.save();
    const s = newSession(id, cwd);
    s.history = source.history.slice();
    this.live.set(id, s);
    this.adopt(s, res, false);
    const thread = this.threadFrom(id);
    this.notify("thread/started", { thread });
    return this.settingsResponse(thread, s);
  }

  private async archive(id: string) {
    const s = this.live.get(id);
    if (s && !s.turn && this.caps.sessionCapabilities?.close) {
      this.live.delete(id);
      void this.conn?.request("session/close", { sessionId: id }).catch(() => {});
    }
    if (!this.state.archived.includes(id)) this.state.archived.push(id);
    this.save();
    this.notify("thread/archived", { threadId: id });
    return {};
  }

  private async listTurns(p: any) {
    const s = await this.session(p.threadId);
    const turns: TurnWithPlan[] = s.history.map((t) => ({ ...t.turn, plan: t.plan }));
    if (s.turn) turns.push({ ...this.protoTurn(s.turn, "inProgress"), items: [...s.turn.builder.items.values()], itemsView: "full", plan: s.turn.builder.plan });
    const ordered = p.sortDirection !== "asc" ? turns.reverse() : turns;
    const offset = Number(p.cursor ?? 0) || 0;
    const limit = Math.max(1, Number(p.limit ?? 20));
    const page = ordered.slice(offset, offset + limit).map((t) => (p.itemsView === "notLoaded" ? { ...t, items: [], itemsView: "notLoaded" as const } : t));
    return { data: page, nextCursor: offset + limit < ordered.length ? String(offset + limit) : null, backwardsCursor: null };
  }

  private rememberSettings(threadId: string, p: any): ThreadChoices {
    const cur = { ...this.state.settings[threadId] };
    // A null model or effort keeps what the thread runs; choosing Default sends "default".
    if (p.model != null) cur.model = p.model;
    if (p.effort != null) cur.effort = p.effort;
    if (p.collaborationMode?.mode) cur.plan = p.collaborationMode.mode === "plan";
    this.state.settings[threadId] = cur;
    this.save();
    return cur;
  }

  /** Push the thread's chosen model, effort and mode into its session where they differ. */
  private async applySettings(s: LiveSession, set: ThreadChoices) {
    const conn = await this.ensureConn();
    const setOption = async (configId: string, value: string) => {
      const res = await conn.request<{ configOptions?: SessionConfigOption[] }>("session/set_config_option", { sessionId: s.id, configId, value });
      if (res?.configOptions) s.config = res.configOptions;
      else s.config = s.config.map((c) => (c.id === configId && c.type === "select" ? { ...c, currentValue: value } : c));
    };
    const model = set.model && set.model !== "default" ? set.model : null;
    if (model && model !== this.currentModel(s)) {
      const opt = this.option(s, "model");
      if (opt) await setOption(opt.id, model);
      else if (s.models) {
        await conn.request("session/set_model", { sessionId: s.id, modelId: model });
        s.models = { ...s.models, currentModelId: model };
      }
    }
    const effort = this.option(s, "thought_level");
    if (effort && set.effort && set.effort !== effort.currentValue && flatOptions(effort.options).some((o) => o.value === set.effort)) await setOption(effort.id, set.effort);
    const want = set.plan ? this.planModeOf(s.modes, s.config) : s.baseMode;
    if (want && want !== this.currentMode(s)) {
      if (s.modes) {
        await conn.request("session/set_mode", { sessionId: s.id, modeId: want });
        s.modes = { ...s.modes, currentModeId: want };
      } else {
        const opt = this.option(s, "mode");
        if (opt) await setOption(opt.id, want);
      }
    }
  }

  // ---- turns --------------------------------------------------------------

  private async startTurn(p: any) {
    const s = await this.session(p.threadId);
    if (s.turn) throw rpcError("A turn is already running");
    const set = this.rememberSettings(p.threadId, p);
    await this.applySettings(s, set).catch((err) => this.log(`settings: ${(err as Error).message}`));
    const inputs: UserInput[] = p.input ?? [];
    const id = crypto.randomUUID();
    const turn: LiveTurn = { id, startedAt: Date.now(), builder: new TurnBuilder(id, s.cwd), interrupted: false, queued: [], steers: 0, requests: new Set() };
    s.turn = turn;
    const proto = this.protoTurn(turn, "inProgress");
    this.notify("turn/started", { threadId: s.id, turn: proto });
    const user: ThreadItem = { type: "userMessage", id: `${turn.id}:user`, clientId: p.clientUserMessageId ?? null, content: inputs };
    turn.builder.items.set(user.id, user);
    this.emit(s, turn, [{ method: "item/completed", item: user }]);
    this.notify("thread/status/changed", { threadId: s.id, status: { type: "active", activeFlags: [] } });
    // A new thread's first message is its preview (and title, until the agent names it).
    const known = this.state.known[s.id];
    if (known) {
      known.updatedAt = Date.now();
      if (!known.preview) {
        known.preview = inputs.map((i) => (i.type === "text" ? i.text : "")).join(" ").trim().slice(0, 500);
        this.notify("thread/started", { thread: this.threadFrom(s.id) });
      }
      this.save();
    }
    this.prompt(s, turn, inputs);
    this.sessionChanged(s);
    return { turn: proto };
  }

  private prompt(s: LiveSession, turn: LiveTurn, inputs: UserInput[]) {
    const images = !!this.caps.promptCapabilities?.image;
    void this.ensureConn()
      .then((conn) => conn.request<PromptResponse>("session/prompt", { sessionId: s.id, prompt: toPrompt(inputs, images) }))
      .then(
        (res) => {
          if (res?.usage) this.noteTotal(s, res.usage);
          if (s.turn !== turn) return;
          const next = turn.queued.shift();
          if (next && !turn.interrupted && res.stopReason !== "cancelled") return this.prompt(s, turn, next);
          if (turn.interrupted || res.stopReason === "cancelled") return this.finishTurn(s, turn, "interrupted", null);
          if (res.stopReason === "refusal") return this.finishTurn(s, turn, "failed", `${this.name} declined to go on with this.`);
          if (res.stopReason === "max_tokens" || res.stopReason === "max_turn_requests")
            this.notify("warning", { threadId: s.id, message: res.stopReason === "max_tokens" ? `${this.name} hit its output limit.` : `${this.name} hit its limit of steps for one turn.` });
          this.finishTurn(s, turn, "completed", null);
        },
        (err: AcpError) => {
          if (s.turn !== turn) return;
          this.finishTurn(s, turn, turn.interrupted ? "interrupted" : "failed", turn.interrupted ? null : this.errorText(err));
        },
      );
  }

  private interrupt(s: LiveSession, turn: LiveTurn) {
    turn.interrupted = true;
    turn.queued = [];
    for (const c of turn.requests) c.abort();
    this.conn?.notify("session/cancel", { sessionId: s.id });
    // The agent answers the prompt with "cancelled"; one that doesn't is let go of after a while.
    setTimeout(() => {
      if (s.turn === turn) this.finishTurn(s, turn, "interrupted", null);
    }, 15_000);
  }

  /** An error from the agent, as the user should read it. */
  private errorText(err: AcpError): string {
    const msg = err?.message || String(err);
    if (err?.code === AUTH_REQUIRED && /auth/i.test(msg)) return `${msg}. Sign in to ${this.name} (Settings → ${this.name}), then try again.`;
    return msg;
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
      startedAt: sec(turn.startedAt),
      completedAt: status === "inProgress" ? null : sec(now),
      durationMs: status === "inProgress" ? null : now - turn.startedAt,
    };
  }

  private finishTurn(s: LiveSession, turn: LiveTurn, status: "completed" | "interrupted" | "failed", error: string | null) {
    if (s.turn !== turn) return;
    for (const c of turn.requests) c.abort();
    this.emit(s, turn, turn.builder.finish(status));
    s.turn = null;
    const done = this.protoTurn(turn, status, error);
    s.history.push({ turn: { ...done, items: [...turn.builder.items.values()], itemsView: "full" }, plan: turn.builder.plan });
    this.notify("turn/completed", { threadId: s.id, turn: done });
    this.notify("thread/status/changed", { threadId: s.id, status: { type: "idle" } });
    const known = this.state.known[s.id];
    if (known) {
      known.updatedAt = Date.now();
      this.save();
    }
    this.listed.at = 0;
  }

  /** What a builder made of an update, to the renderer. */
  private emit(s: LiveSession, turn: LiveTurn, events: ItemEvent[]) {
    const base = { threadId: s.id, turnId: turn.id };
    for (const ev of events) {
      if (ev.method === "item/started") this.notify(ev.method, { ...base, item: ev.item, startedAtMs: Date.now() });
      else if (ev.method === "item/completed") this.notify(ev.method, { ...base, item: ev.item, completedAtMs: Date.now() });
      else if (ev.method === "turn/plan/updated") this.notify(ev.method, { ...base, explanation: null, plan: ev.plan });
      else if (ev.method === "item/reasoning/summaryTextDelta") this.notify(ev.method, { ...base, itemId: ev.itemId, delta: ev.delta, summaryIndex: 0 });
      else if (ev.method === "item/agentMessage/delta") this.notify(ev.method, { ...base, itemId: ev.itemId, delta: ev.delta });
    }
  }

  // ---- what the agent says ------------------------------------------------

  private onUpdate(n: SessionNotification) {
    const s = this.live.get(n.sessionId);
    const u = n.update;
    if (!s || !u) return;
    switch (u.sessionUpdate) {
      case "session_info_update":
        if (u.title !== undefined) this.noteTitle(s.id, u.title ?? null);
        return;
      case "current_mode_update":
        if (s.modes) s.modes = { ...s.modes, currentModeId: u.currentModeId };
        return this.followMode(s);
      case "config_option_update":
        s.config = u.configOptions;
        return this.followMode(s);
      case "usage_update":
        return this.noteContext(s, u.used, u.size);
    }
    if (s.replay) return s.replay.apply(u);
    // The user's own message comes back from some agents: Ret already has it.
    if (u.sessionUpdate === "user_message_chunk" || !s.turn) return;
    this.emit(s, s.turn, s.turn.builder.apply(u));
  }

  /** The agent changed mode by itself (into plan, or out of it): the thread's Plan setting follows. */
  private followMode(s: LiveSession) {
    if (!s.replay) {
      const planning = !!this.currentMode(s) && this.currentMode(s) === this.planModeOf(s.modes, s.config);
      const set = this.state.settings[s.id] ?? {};
      if ((set.plan ?? false) !== planning) {
        this.state.settings[s.id] = { ...set, plan: planning };
        this.save();
      }
    }
    this.sessionChanged(s);
  }

  private noteTitle(id: string, title: string | null) {
    const known = this.state.known[id];
    if (known) {
      known.title = title;
      this.save();
    }
    const info = this.infos.get(id);
    if (info) this.infos.set(id, { ...info, title });
    const name = this.state.names[id] ?? this.titleOf(id);
    if (!name || this.named.get(id) === name) return;
    this.named.set(id, name);
    this.notify("thread/name/updated", { threadId: id, threadName: name });
  }

  /** The context in use (`usage_update`): what the ring around the composer shows. */
  private noteContext(s: LiveSession, used: number, size: number) {
    const prev = s.usage ?? { total: emptyUsage(), last: emptyUsage(), modelContextWindow: null };
    s.usage = { ...prev, last: { ...emptyUsage(), totalTokens: used, inputTokens: used }, modelContextWindow: size || prev.modelContextWindow };
    this.notify("thread/tokenUsage/updated", { threadId: s.id, turnId: s.turn?.id ?? "", tokenUsage: s.usage });
  }

  /** A prompt's tokens (`PromptResponse.usage`), added to the thread's running total. */
  private noteTotal(s: LiveSession, u: Usage) {
    const b = {
      totalTokens: u.totalTokens,
      inputTokens: u.inputTokens,
      cachedInputTokens: u.cachedReadTokens ?? 0,
      cacheWriteInputTokens: u.cachedWriteTokens ?? 0,
      outputTokens: u.outputTokens,
      reasoningOutputTokens: u.thoughtTokens ?? 0,
    };
    const prev = s.usage ?? { total: emptyUsage(), last: emptyUsage(), modelContextWindow: null };
    const total = Object.fromEntries(Object.entries(prev.total).map(([k, v]) => [k, v + (b as Record<string, number>)[k]])) as ThreadTokenUsage["total"];
    s.usage = { ...prev, total, last: prev.last.totalTokens ? prev.last : b };
    this.notify("thread/tokenUsage/updated", { threadId: s.id, turnId: s.turn?.id ?? "", tokenUsage: s.usage });
  }

  /** A request from the agent. Ret offers it no files or terminals of its own, only approvals. */
  private async fromAgent(method: string, params: any): Promise<unknown> {
    if (method === "session/request_permission") return this.permission(params as RequestPermissionRequest);
    throw Object.assign(new Error(`Ret doesn't offer ${method}`), { code: -32601 });
  }

  /**
   * The agent asks before a tool runs. Commands and edits map onto the requests Ret already
   * answers for Codex; anything else gets Ret's generic tool approval.
   */
  private async permission(p: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const s = this.live.get(p.sessionId);
    const turn = s?.turn;
    if (!s || !turn) return { outcome: { outcome: "cancelled" } };
    this.emit(s, turn, turn.builder.toolFromRequest(p.toolCall));
    const item = turn.builder.item(p.toolCall.toolCallId);
    const controller = new AbortController();
    turn.requests.add(controller);
    const base = { threadId: s.id, turnId: turn.id, itemId: p.toolCall.toolCallId, startedAtMs: Date.now() };
    let reply: any;
    try {
      if (item?.type === "commandExecution" && p.toolCall.kind === "execute") {
        reply = await this.ask(
          "item/commandExecution/requestApproval",
          { ...base, kind: "command", command: item.command, cwd: item.cwd, reason: null, commandActions: item.commandActions, environmentId: null },
          s.id,
          controller.signal,
        );
      } else if (item?.type === "fileChange") {
        reply = await this.ask("item/fileChange/requestApproval", { ...base, reason: null, grantRoot: null }, s.id, controller.signal);
      } else {
        const text = (p.toolCall.content ?? []).flatMap((c) => (c.type === "content" ? [blockText(c.content)] : [])).join("\n");
        reply = await this.ask(
          "item/tool/requestApproval",
          { ...base, tool: p.toolCall.title ?? "Tool", title: null, description: text || null, arguments: p.toolCall.rawInput ?? {}, reason: null, server: null },
          s.id,
          controller.signal,
        );
      }
    } finally {
      turn.requests.delete(controller);
    }
    const decision = reply?.decision;
    if (decision === "cancel" && s.turn === turn) this.interrupt(s, turn);
    return { outcome: chosen(p.options, decision) };
  }

  // ---- settings, models ---------------------------------------------------

  /** Thread settings as the app-server reports them on start/resume/fork. */
  private settingsResponse(thread: Thread, s: LiveSession) {
    const model = this.currentModel(s) ?? "default";
    const effort = this.currentEffort(s);
    const plan = !!this.currentMode(s) && this.currentMode(s) === this.planModeOf(s.modes, s.config);
    return {
      thread,
      model,
      modelProvider: this.provider,
      serviceTier: null,
      disabledPluginIds: [],
      cwd: s.cwd,
      runtimeWorkspaceRoots: [],
      instructionSources: [],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: { type: "dangerFullAccess" },
      activePermissionProfile: null,
      reasoningEffort: effort,
      collaborationMode: { mode: plan ? "plan" : "default", settings: { model, reasoning_effort: effort, developer_instructions: null } },
      multiAgentMode: "explicitRequestOnly",
      access: "config",
      initialTurnsPage: null,
      turnsBackwardsCursor: null,
      itemsBackwardsCursor: null,
    };
  }

  private sessionChanged(s: LiveSession) {
    if (this.live.get(s.id) !== s) return;
    const r = this.settingsResponse(this.threadFrom(s.id), s);
    const sig = JSON.stringify([r.cwd, r.model, r.reasoningEffort, r.collaborationMode.mode]);
    if (this.reported.get(s.id) === sig) return;
    this.reported.set(s.id, sig);
    this.notify("thread/settings/updated", {
      threadId: s.id,
      threadSettings: {
        disabledPluginIds: [],
        cwd: r.cwd,
        approvalPolicy: r.approvalPolicy,
        approvalsReviewer: r.approvalsReviewer,
        sandboxPolicy: r.sandbox,
        activePermissionProfile: null,
        model: r.model,
        modelProvider: this.provider,
        serviceTier: null,
        effort: r.reasoningEffort,
        summary: null,
        collaborationMode: r.collaborationMode,
        multiAgentMode: r.multiAgentMode,
        personality: null,
        access: "config",
      },
    });
  }

  /** The models the agent offered last, each with its effort levels (ACP's thought levels). */
  private modelList(): Model[] {
    const o = this.state.offered;
    if (!o) return [];
    const efforts = (() => {
      const opt = this.option(o, "thought_level");
      return opt ? flatOptions(opt.options).map((x) => ({ reasoningEffort: x.value, description: x.description || x.name })) : [];
    })();
    const opt = this.option(o, "model");
    const entries = opt
      ? flatOptions(opt.options).map((x) => ({ id: x.value, name: x.name, description: x.description ?? "" }))
      : (o.models?.availableModels ?? []).map((m) => ({ id: m.modelId, name: m.name, description: m.description ?? "" }));
    const images = !!this.caps.promptCapabilities?.image;
    return entries.map((m) => ({
      id: m.id,
      model: m.id,
      upgrade: null,
      upgradeInfo: null,
      availabilityNux: null,
      displayName: m.name,
      description: m.description,
      modelSpecialty: null,
      hidden: false,
      supportedReasoningEfforts: efforts,
      defaultReasoningEffort: o.defaultEffort ?? efforts[0]?.reasoningEffort ?? "medium",
      inputModalities: images ? ["text", "image"] : ["text"],
      supportsPersonality: false,
      multiAgentVersion: null,
      additionalSpeedTiers: [],
      serviceTiers: [],
      defaultServiceTier: null,
      availableAccessPrograms: null,
      isDefault: m.id === o.defaultModel,
    }));
  }

  private save() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => void this.saveNow(), 500);
  }

  private async saveNow() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      await mkdir(dirname(this.stateFile), { recursive: true });
      await writeFile(this.stateFile, JSON.stringify(this.state));
    } catch (err) {
      this.log(`couldn't save state: ${(err as Error).message}`);
    }
  }
}

function newSession(id: string, cwd: string): LiveSession {
  return { id, cwd, history: [], turn: null, config: [], modes: null, models: null, baseMode: null, usage: null, replay: null };
}

/** A select option's choices, out of their groups if it has them. */
function flatOptions(options: Extract<SessionConfigOption, { type: "select" }>["options"]): SessionConfigSelectOption[] {
  return (options as any[]).flatMap((o) => (Array.isArray(o?.options) ? o.options : [o]));
}

/** One of Ret's approval answers, as the agent's permission option of that kind. */
function chosen(options: PermissionOption[], decision: unknown): RequestPermissionResponse["outcome"] {
  const of = (...kinds: PermissionOption["kind"][]) => kinds.map((k) => options.find((o) => o.kind === k)).find(Boolean);
  const pick =
    decision === "accept" ? of("allow_once", "allow_always") : decision === "acceptForSession" ? of("allow_always", "allow_once") : decision === "decline" ? of("reject_once", "reject_always") : undefined;
  return pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" };
}

/**
 * A session's history as `session/load` replays it: each run of user message chunks opens a
 * turn, and what the agent said and did after it fills the turn. Turn ids follow their order, so
 * they're the same each time the session is opened.
 */
class Replay {
  private turns: { id: string; builder: TurnBuilder }[] = [];
  private userOpen = false;

  constructor(
    private readonly sessionId: string,
    private readonly cwd: string,
  ) {}

  private turn(): { id: string; builder: TurnBuilder } {
    const id = `${this.sessionId}:t${this.turns.length}`;
    const t = { id, builder: new TurnBuilder(id, this.cwd) };
    this.turns.push(t);
    return t;
  }

  apply(u: SessionUpdate) {
    if (u.sessionUpdate === "user_message_chunk") {
      const t = this.userOpen ? this.turns.at(-1)! : this.turn();
      this.userOpen = true;
      const c = u.content;
      t.builder.user(c.type === "image" ? "" : blockText(c), c.type === "image" ? [`data:${c.mimeType};base64,${c.data}`] : []);
      return;
    }
    const t = this.turns.at(-1) ?? this.turn();
    if (t.builder.apply(u).length) this.userOpen = false;
  }

  finish(): StoredTurn[] {
    return this.turns.map(({ id, builder }) => {
      builder.finish("completed");
      return {
        turn: { id, rootTurnId: null, items: [...builder.items.values()], itemsView: "full", status: "completed", error: null, startedAt: null, completedAt: null, durationMs: null },
        plan: builder.plan,
      };
    });
  }
}
