import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  forkSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
  renameSession,
  resolveSettings,
  type ModelInfo,
  type SDKRateLimitInfo,
  type SDKSessionInfo,
} from "@anthropic-ai/claude-agent-sdk";
import type { EngineStatus } from "../../shared/bridge";
import type { BackgroundTask, Model, RateLimitSnapshot, Thread, TurnWithPlan } from "../../shared/protocol";
import type { RateLimitWindow } from "../../shared/protocol/generated/v2";
import { FsService } from "../fsService";
import { gitInfo } from "../git";
import { sameTasks, TranscriptBackground } from "./background";
import { buildTurns, type HistoryTurn, type StoredMessage } from "./history";
import { claudeAuthStatus, claudeConfigDir, claudeEnv } from "./platform";
import { ClaudeSession, type ClaudeAccess, type SessionHost, type ThreadConfig } from "./session";
import { TranscriptUsage } from "./usage";

export interface ClaudeTarget {
  binary: string;
  version: string | null;
  source: "system" | "custom";
}

/** What Ret remembers about Claude threads that Claude Code itself doesn't store. */
interface EngineState {
  archived: string[];
  /** Fork → the thread it was forked from. */
  lineage: Record<string, string>;
  /** Per-thread choices made in Ret (model, effort, access, plan). */
  settings: Record<string, { model?: string | null; effort?: string | null; access?: ClaudeAccess; plan?: boolean }>;
}

/** A thread Ret created that has no transcript on disk yet (a new thread, or a fork into another folder). */
interface PendingThread {
  thread: Thread;
  /** Fork into another folder: the source and the message to cut at, applied when the fork first runs. */
  fork?: { from: string; at: string | null; turns: HistoryTurn[] };
}

const STDERR_LINES = 200;
const USAGE_TTL_MS = 5 * 60_000;
const sec = (ms: number | undefined) => Math.floor((ms ?? Date.now()) / 1000);

type RpcError = Error & { code?: number };
const rpcError = (message: string, code = -32000): RpcError => Object.assign(new Error(message), { code });

/**
 * Claude Code as an app-server: speaks the same JSON-RPC protocol as `codex app-server`, so the
 * renderer drives it with the code it already has. Requests are answered here in the main
 * process; each live thread is a ClaudeSession wrapping the Agent SDK. Lines are batched to the
 * renderer once per event-loop turn, like the Codex pipe.
 */
export class ClaudeEngine {
  status: EngineStatus = {
    provider: "claude",
    state: "stopped",
    generation: 0,
    version: null,
    binaryPath: null,
    source: null,
    engine: "dedicated",
    error: null,
    stderrTail: [],
  };
  private target: ClaudeTarget | null = null;
  private sessions = new Map<string, ClaudeSession>();
  private pending = new Map<string, PendingThread>();
  private infos = new Map<string, SDKSessionInfo>();
  private historyCache = new Map<string, { stamp: string; turns: HistoryTurn[] }>();
  private outbox: string[] = [];
  private flushScheduled = false;
  private nextRequestId = 1;
  private requests = new Map<string, { method: string; params: unknown; resolve: (v: any) => void }>();
  private state: EngineState = { archived: [], lineage: {}, settings: {} };
  private saveTimer: NodeJS.Timeout | null = null;
  private fs = new FsService((m, p) => this.notify(m, p));
  private models: { at: number; list: Model[] } | null = null;
  private probing: Promise<void> | null = null;
  /** Plan usage: the 5-hour/7-day windows, plus per-model weekly buckets (Fable, Opus…) by limit id. */
  private usage: { at: number; snapshot: RateLimitSnapshot | null; byId: Record<string, RateLimitSnapshot> } | null = null;
  private elsewhere: { at: number; entries: RegistryEntry[]; reading: Promise<RegistryEntry[]> | null } = { at: 0, entries: [], reading: null };
  /** Background work of sessions running in other Claude Code processes, read from their transcripts. */
  private backgroundElsewhere = new TranscriptBackground(claudeConfigDir);
  /** What was last reported of it, per session; and whether a look is underway. */
  private reportedElsewhere = new Map<string, BackgroundTask[]>();
  private lookingElsewhere = false;
  /** Tokens per day, tallied from transcripts (`account/usage/read`); running totals go out while a read is underway. */
  private tokens = new TranscriptUsage(claudeConfigDir, (days) => this.notify("account/usage/updated", { dailyUsageBuckets: days }));
  /** Claude Code's own model entries (with what each resolves to) and the user's configured model, from the probe. */
  private modelInfos: { list: ModelInfo[]; configured: string | null } = { list: [], configured: null };
  private creating = new Map<string, Promise<ClaudeSession>>();

  constructor(
    private readonly stateFile: string,
    private readonly appVersion: string,
    private readonly onLines: (lines: string[]) => void,
    private readonly onStatus: (status: EngineStatus) => void,
  ) {
    this.host = this.makeHost();
    try {
      this.state = { ...this.state, ...JSON.parse(readFileSync(stateFile, "utf8")) };
    } catch {
      /* first run */
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle (driven by the main process)
  // -------------------------------------------------------------------------

  private setStatus(patch: Partial<EngineStatus>) {
    this.status = { ...this.status, ...patch };
    this.onStatus(this.status);
  }

  /** Point at a claude binary and (re)connect: a new generation makes the renderer re-initialize. */
  start(target: ClaudeTarget) {
    const changed = this.target?.binary !== target.binary;
    this.target = target;
    if (changed) this.closeAll();
    this.models = null;
    this.usage = null;
    this.setStatus({
      state: "running",
      generation: this.status.generation + 1,
      version: target.version,
      binaryPath: target.binary,
      source: target.source,
      error: null,
    });
  }

  /** A fresh renderer connection (page reload): same sessions, new handshake. */
  reconnect() {
    if (this.status.state === "running") this.setStatus({ generation: this.status.generation + 1 });
  }

  setVersion(version: string | null) {
    this.setStatus({ version });
  }

  setUpdate(update: EngineStatus["update"]) {
    this.setStatus({ update });
  }

  /** Stop every Claude Code process that isn't in the middle of a turn. */
  closeIdle() {
    for (const s of this.sessions.values()) if (!s.running) s.close();
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
    void this.saveNow();
  }

  get busy() {
    return [...this.sessions.values()].some((s) => s.running);
  }

  private closeAll() {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
    for (const r of this.requests.values()) r.resolve(null);
    this.requests.clear();
  }

  private log(text: string) {
    const tail = this.status.stderrTail.concat(text.split(/\r?\n/).filter(Boolean));
    this.status = { ...this.status, stderrTail: tail.slice(-STDERR_LINES) };
  }

  // -------------------------------------------------------------------------
  // Transport
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
    // Client notifications ("initialized") need nothing.
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

  private readonly host: SessionHost;

  private makeHost(): SessionHost {
    return {
    appVersion: this.appVersion,
    binary: () => this.target?.binary ?? null,
    notify: (method, params) => this.notify(method, params),
    request: (method, params, threadId, signal) =>
      new Promise((resolve) => {
        if (signal.aborted) return resolve(null);
        const id = `claude:${this.nextRequestId++}`;
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
      }),
    rateLimit: (info) => this.noteRateLimit(info),
    log: (text) => this.log(text),
    changed: (s) => this.sessionChanged(s),
    };
  }

  // -------------------------------------------------------------------------
  // Methods
  // -------------------------------------------------------------------------

  private async call(method: string, p: any): Promise<unknown> {
    if (this.fs.handles(method)) return this.fs.call(method, p);
    if (method !== "initialize" && this.status.state !== "running") throw rpcError(this.status.error ?? "Claude Code is not available");
    switch (method) {
      case "initialize":
        // A new connection: anything still waiting on the old one is asked again, and it hears what
        // runs in the background (here now; elsewhere at the next look).
        setImmediate(() => {
          for (const [id, r] of this.requests) this.write({ id, method: r.method, params: r.params });
          for (const s of this.sessions.values()) if (s.background.length) this.notify("thread/backgroundTasks/updated", { threadId: s.config.id, tasks: s.background });
        });
        this.reportedElsewhere = new Map();
        void this.probe();
        return { userAgent: `claude-code/${this.status.version ?? "unknown"}`, codexHome: "", platformFamily: process.platform === "win32" ? "windows" : "unix", platformOs: process.platform };
      case "thread/list":
        return this.listThreads(p);
      case "thread/read":
        return { thread: await this.readThread(p.threadId) };
      case "thread/turns/list":
        return this.listTurns(p);
      case "thread/start":
        return this.startThread(p);
      case "thread/resume":
        return this.resumeThread(p.threadId);
      case "thread/unsubscribe": {
        const s = this.sessions.get(p.threadId);
        if (s && !s.running) s.close();
        return {};
      }
      case "thread/fork":
        return this.forkThread(p);
      case "thread/name/set":
        await renameSession(p.threadId, String(p.name ?? ""));
        this.notify("thread/name/updated", { threadId: p.threadId, threadName: p.name });
        return {};
      case "thread/archive":
        this.sessions.get(p.threadId)?.close();
        this.sessions.delete(p.threadId);
        if (!this.state.archived.includes(p.threadId)) this.state.archived.push(p.threadId);
        this.save();
        this.notify("thread/archived", { threadId: p.threadId });
        return {};
      case "thread/compact/start": {
        const s = await this.session(p.threadId);
        await s.startTurn([], null, { compact: true });
        return {};
      }
      case "turn/start":
        return this.startTurn(p);
      case "turn/steer": {
        const s = this.sessions.get(p.threadId);
        if (!s?.running || (p.expectedTurnId && s.turn?.id !== p.expectedTurnId)) throw rpcError("No turn is running to steer");
        return { turnId: s.steer(p.input ?? [], p.clientUserMessageId ?? null) };
      }
      case "turn/interrupt":
        await this.sessions.get(p.threadId)?.interrupt();
        return {};
      case "model/list":
        return { data: await this.modelList(), nextCursor: null };
      case "collaborationMode/list":
        return {
          data: [
            { name: "Plan", mode: "plan", model: null, reasoning_effort: null },
            { name: "Default", mode: "default", model: null, reasoning_effort: null },
          ],
        };
      case "config/read": {
        const eff = await this.userSettings();
        return { config: { model: eff.model ?? null, model_reasoning_effort: eff.effortLevel ?? null } };
      }
      case "account/read":
        return this.account();
      case "account/rateLimits/read": {
        const usage = await this.rateLimits();
        if (!usage?.snapshot) throw rpcError("Plan usage isn't available for this sign-in");
        return { rateLimits: usage.snapshot, rateLimitsByLimitId: usage.byId, ordinaryUsageAllowed: null, rateLimitResetCredits: null, accountId: null, rateLimitUpsell: null };
      }
      case "account/usage/read": {
        if (p?.threadId) throw rpcError("Per-thread usage isn't available for Claude Code", -32601);
        const daily = await this.tokens.daily();
        const peak = daily.reduce((m, d) => Math.max(m, d.tokens), 0);
        return {
          summary: { lifetimeTokens: null, peakDailyTokens: daily.length ? peak : null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null },
          dailyUsageBuckets: daily,
        };
      }
      case "account/login/start":
      case "account/logout":
        throw rpcError("Sign in and out with Claude Code itself (`claude auth login`).");
      default:
        throw rpcError(`${method} is not supported for Claude Code`, -32601);
    }
  }

  // ---- threads ------------------------------------------------------------

  private threadFrom(info: SDKSessionInfo): Thread {
    const id = info.sessionId;
    const s = this.sessions.get(id);
    const set = this.state.settings[id];
    // The SDK's customTitle is the title Claude Code (or /rename, or the desktop app) gave the
    // session. Its summary falls back to the latest prompt, which isn't a name.
    const named = info.customTitle || null;
    return {
      id,
      environments: null,
      extra: null,
      sessionId: id,
      forkedFromId: this.state.lineage[id] ?? null,
      parentThreadId: null,
      preview: info.firstPrompt ?? info.summary ?? "",
      ephemeral: false,
      section: null,
      sectionEnteredAt: null,
      projectId: null,
      historyMode: "paginated",
      modelProvider: "anthropic",
      model: set?.model ?? s?.runningModel ?? null,
      reasoningEffort: set?.effort ?? null,
      createdAt: sec(info.createdAt ?? info.lastModified),
      updatedAt: sec(info.lastModified),
      recencyAt: sec(info.lastModified),
      status: s?.status ?? { type: "notLoaded" },
      path: null,
      cwd: info.cwd ?? s?.config.cwd ?? "",
      cliVersion: "",
      originator: "claude_code",
      source: "unknown",
      canAcceptDirectInput: null,
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: info.gitBranch ? { sha: null, branch: info.gitBranch, originUrl: null } : null,
      name: named ?? null,
      daybreakEnabled: null,
      turns: [],
    };
  }

  private async listThreads(p: any) {
    void this.lookElsewhere();
    const all = (await listSessions({})).filter((i) => !this.state.archived.includes(i.sessionId));
    for (const i of all) this.infos.set(i.sessionId, i);
    const ids = new Set(all.map((i) => i.sessionId));
    const threads = all.map((i) => this.threadFrom(i));
    // Threads started here that have no transcript yet.
    for (const [id, pend] of this.pending) if (!ids.has(id)) threads.push({ ...pend.thread, status: this.sessions.get(id)?.status ?? pend.thread.status });
    // Sessions busy in another Claude Code process come first, so a short page (Ret's watch for
    // work running elsewhere) includes them even when they've been quiet for hours.
    const busy = await this.busyElsewhere();
    threads.sort((a, b) => Number(busy.has(b.id)) - Number(busy.has(a.id)) || b.updatedAt - a.updatedAt);
    const offset = Number(p.cursor ?? 0) || 0;
    const limit = Math.max(1, Number(p.limit ?? 100));
    const page = threads.slice(offset, offset + limit);
    return { data: page, nextCursor: offset + limit < threads.length ? String(offset + limit) : null, backwardsCursor: null };
  }

  private async info(threadId: string): Promise<SDKSessionInfo | undefined> {
    const info = await getSessionInfo(threadId).catch(() => undefined);
    if (info) this.infos.set(threadId, info);
    return info ?? this.infos.get(threadId);
  }

  private async readThread(threadId: string): Promise<Thread> {
    const info = await this.info(threadId);
    if (info) {
      this.pending.delete(threadId);
      return this.threadFrom(info);
    }
    const pend = this.pending.get(threadId);
    if (pend) return { ...pend.thread, status: this.sessions.get(threadId)?.status ?? pend.thread.status };
    throw rpcError(`No Claude Code session ${threadId}`);
  }

  /** The session's transcript as turns (cached until the file changes). */
  private async history(threadId: string): Promise<HistoryTurn[]> {
    const pend = this.pending.get(threadId);
    const info = await this.info(threadId);
    if (!info) return pend?.fork?.turns ?? [];
    const stamp = `${info.lastModified}:${info.fileSize ?? ""}`;
    const hit = this.historyCache.get(threadId);
    if (hit?.stamp === stamp) return hit.turns;
    const messages = (await getSessionMessages(threadId, { includeSystemMessages: true })) as unknown as StoredMessage[];
    const turns = buildTurns(messages, info.cwd ?? this.sessions.get(threadId)?.config.cwd ?? "");
    this.historyCache.set(threadId, { stamp, turns });
    if (this.historyCache.size > 40) this.historyCache.delete(this.historyCache.keys().next().value!);
    return turns;
  }

  private async listTurns(p: any) {
    const turns = await this.history(p.threadId);
    const desc = p.sortDirection !== "asc";
    const ordered = desc ? turns.slice().reverse() : turns;
    const offset = Number(p.cursor ?? 0) || 0;
    const limit = Math.max(1, Number(p.limit ?? 20));
    // The transcript can't tell a turn that's still running from a finished one; the live session
    // can (ours), or the session registry (another Claude Code process busy with it).
    const live = this.sessions.get(p.threadId)?.turn?.id ?? ((await this.busyElsewhere()).has(p.threadId) ? turns.at(-1)?.turn.id : undefined);
    const page = ordered.slice(offset, offset + limit).map((t) => {
      const turn: TurnWithPlan = { ...t.turn, plan: t.plan, ...(t.turn.id === live ? { status: "inProgress" as const, completedAt: null, durationMs: null } : {}) };
      return p.itemsView === "notLoaded" ? { ...turn, items: [], itemsView: "notLoaded" as const } : turn;
    });
    return { data: page, nextCursor: offset + limit < ordered.length ? String(offset + limit) : null, backwardsCursor: null };
  }

  /**
   * Sessions another Claude Code process (the CLI, the desktop app, an IDE, another SDK app) has
   * open right now. Every running claude records itself in `<config>/sessions/<pid>.json` with its
   * session id, when it started, and whether it's busy or idle. Entries from processes that have
   * exited, and sessions Ret itself is running (live events cover those), don't count. Read at
   * most every 1.5 s.
   */
  private openElsewhere(): Promise<RegistryEntry[]> {
    if (Date.now() - this.elsewhere.at < 1500) return Promise.resolve(this.elsewhere.entries);
    this.elsewhere.reading ??= (async () => {
      const dir = join(claudeConfigDir(), "sessions");
      const entries: RegistryEntry[] = [];
      const names = await readdir(dir).catch(() => [] as string[]);
      await Promise.all(
        names
          .filter((n) => n.endsWith(".json"))
          .map(async (n) => {
            try {
              const e = JSON.parse(await readFile(join(dir, n), "utf8"));
              if (typeof e?.sessionId !== "string" || !alive(e.pid)) return;
              if (this.sessions.get(e.sessionId)?.query) return;
              entries.push({ sessionId: e.sessionId, busy: e.status === "busy", startedAt: Number(e.startedAt) || 0 });
            } catch {
              /* being rewritten, or not a session entry */
            }
          }),
      );
      this.elsewhere = { at: Date.now(), entries, reading: null };
      return entries;
    })();
    return this.elsewhere.reading;
  }

  /** Sessions another Claude Code process is busy with right now. */
  private async busyElsewhere(): Promise<Set<string>> {
    return new Set((await this.openElsewhere()).filter((e) => e.busy).map((e) => e.sessionId));
  }

  /**
   * Background work (shells, subagents, monitors) of sessions open in other Claude Code processes.
   * Their own notifications never reach Ret, so it's read from their transcripts, and changes go out
   * as `thread/backgroundTasks/updated`. Looked at with each thread list, which Ret polls to follow
   * work running elsewhere.
   */
  private async lookElsewhere() {
    if (this.lookingElsewhere) return;
    this.lookingElsewhere = true;
    try {
      const open = await this.openElsewhere();
      const found = new Map<string, BackgroundTask[]>();
      for (const e of open) {
        const tasks = await this.backgroundElsewhere.running(e.sessionId, e.startedAt).catch(() => [] as BackgroundTask[]);
        if (tasks.length) found.set(e.sessionId, tasks);
      }
      this.backgroundElsewhere.keep(new Set(open.map((e) => e.sessionId)));
      for (const [threadId, tasks] of found) {
        if (!sameTasks(this.reportedElsewhere.get(threadId) ?? [], tasks)) this.notify("thread/backgroundTasks/updated", { threadId, tasks });
      }
      // Finished, or its process exited (taking the work with it). A session Ret now runs reports its own.
      for (const threadId of this.reportedElsewhere.keys()) {
        if (!found.has(threadId) && !this.sessions.get(threadId)?.query) this.notify("thread/backgroundTasks/updated", { threadId, tasks: [] });
      }
      this.reportedElsewhere = found;
    } finally {
      this.lookingElsewhere = false;
    }
  }

  /** Thread settings as the app-server reports them on start/resume/fork. */
  private settingsResponse(thread: Thread, s: ClaudeSession) {
    return {
      thread,
      model: s.config.model ?? "default",
      modelProvider: "anthropic",
      serviceTier: null,
      disabledPluginIds: [],
      cwd: s.config.cwd,
      runtimeWorkspaceRoots: [],
      instructionSources: [],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: { type: "dangerFullAccess" },
      activePermissionProfile: null,
      reasoningEffort: s.config.effort,
      collaborationMode: { mode: s.config.plan ? "plan" : "default", settings: { model: s.config.model ?? "default", reasoning_effort: s.config.effort, developer_instructions: null } },
      multiAgentMode: "explicitRequestOnly",
      access: s.config.access,
      initialTurnsPage: null,
      turnsBackwardsCursor: null,
      itemsBackwardsCursor: null,
    };
  }

  /** The live session for a thread, created on first use with the thread's remembered settings. */
  private session(threadId: string, cwdHint?: string): Promise<ClaudeSession> {
    const existing = this.sessions.get(threadId);
    if (existing) return Promise.resolve(existing);
    // Opened twice at once (a pane mounting while a message is sent): one session, not two.
    let making = this.creating.get(threadId);
    if (!making) {
      making = this.makeSession(threadId, cwdHint).finally(() => this.creating.delete(threadId));
      this.creating.set(threadId, making);
    }
    return making;
  }

  private async makeSession(threadId: string, cwdHint?: string): Promise<ClaudeSession> {
    const info = await this.info(threadId);
    const pend = this.pending.get(threadId);
    if (!info && !pend) throw rpcError(`No Claude Code session ${threadId}`);
    const set = this.state.settings[threadId] ?? {};
    // A session Ret didn't choose a model for (started in the CLI, the desktop app…) keeps the one
    // its transcript says last answered, rather than falling back to the default.
    const model = set.model !== undefined ? set.model : info ? await this.lastModel(threadId) : null;
    const config: ThreadConfig = {
      id: threadId,
      cwd: info?.cwd ?? pend?.thread.cwd ?? cwdHint ?? "",
      model: model ?? null,
      effort: set.effort ?? null,
      access: set.access ?? "config",
      plan: set.plan ?? false,
      exists: !!info,
      ...(pend?.fork && !info ? { fork: { from: pend.fork.from, at: pend.fork.at } } : {}),
    };
    const s = new ClaudeSession(config, this.host);
    this.sessions.set(threadId, s);
    return s;
  }

  /** The model a session last ran, as its entry in Claude Code's model list ("default" when that's what Default runs). */
  private async lastModel(threadId: string): Promise<string | null> {
    const api = (await this.history(threadId).catch(() => [] as HistoryTurn[])).findLast((t) => t.model)?.model;
    if (!api) return null;
    if (!this.modelInfos.list.length) await this.modelList();
    const infos = this.modelInfos.list;
    if (!infos.length) return null;
    const strip = (m: string | undefined | null) => (m ?? "").replace(/\[1m\]$/i, "");
    const resolves = (value: string) => infos.find((i) => i.value === value)?.resolvedModel ?? (value.startsWith("claude-") ? value : undefined);
    const configured = this.modelInfos.configured;
    const runsByDefault = configured ? strip(resolves(configured) ?? resolves(strip(configured))) : strip(infos.find((i) => i.value === "default")?.resolvedModel);
    if (runsByDefault && runsByDefault === strip(api)) return null;
    return infos.find((i) => i.value !== "default" && strip(i.resolvedModel) === strip(api))?.value ?? api;
  }

  private async startThread(p: any) {
    const id = crypto.randomUUID();
    const cwd = String(p.cwd ?? "");
    const git = cwd ? await gitInfo(cwd).catch(() => null) : null;
    const now = Date.now();
    const thread = this.threadFrom({ sessionId: id, summary: "", lastModified: now, createdAt: now, cwd, gitBranch: git?.branch ?? undefined });
    thread.status = { type: "idle" };
    this.pending.set(id, { thread });
    this.rememberSettings(id, p);
    const s = await this.session(id, cwd);
    this.notify("thread/started", { thread });
    return this.settingsResponse(thread, s);
  }

  private async resumeThread(threadId: string) {
    const s = await this.session(threadId);
    const thread = await this.readThread(threadId);
    return this.settingsResponse(thread, s);
  }

  private async forkThread(p: any) {
    const sourceId = String(p.threadId);
    const source = await this.readThread(sourceId);
    const turns = await this.history(sourceId);
    const cut = p.lastTurnId ? turns.findIndex((t) => t.turn.id === p.lastTurnId) : turns.length - 1;
    const kept = cut >= 0 ? turns.slice(0, cut + 1) : turns;
    const at = kept.at(-1)?.lastUuid ?? null;
    const cwd = p.cwd ? String(p.cwd) : source.cwd;
    let id: string;
    if (cwd === source.cwd) {
      // Same folder: Claude Code copies the transcript now, so the fork is a real session at once.
      id = (await forkSession(sourceId, at ? { upToMessageId: at } : {})).sessionId;
    } else {
      // Another folder (a worktree): the fork is made when it first runs, under that folder.
      id = crypto.randomUUID();
      const now = Date.now();
      const git = await gitInfo(cwd).catch(() => null);
      const thread = this.threadFrom({ sessionId: id, summary: source.name ?? source.preview, customTitle: source.name ?? undefined, firstPrompt: source.preview, lastModified: now, createdAt: now, cwd, gitBranch: git?.branch ?? undefined });
      this.pending.set(id, { thread: { ...thread, status: { type: "idle" } }, fork: { from: sourceId, at, turns: kept } });
    }
    this.state.lineage[id] = sourceId;
    this.state.settings[id] = { ...this.state.settings[sourceId] };
    this.save();
    const s = await this.session(id, cwd);
    const thread = await this.readThread(id);
    this.notify("thread/started", { thread });
    return this.settingsResponse(thread, s);
  }

  private rememberSettings(threadId: string, p: any) {
    const cur = { ...this.state.settings[threadId] };
    if (p.model !== undefined) cur.model = p.model;
    if (p.effort !== undefined) cur.effort = p.effort;
    if (typeof p.access === "string") cur.access = p.access as ClaudeAccess;
    if (p.collaborationMode?.mode) cur.plan = p.collaborationMode.mode === "plan";
    this.state.settings[threadId] = cur;
    this.save();
    return cur;
  }

  private async startTurn(p: any) {
    const s = await this.session(p.threadId);
    const set = this.rememberSettings(p.threadId, p);
    await s.reconfigure({ model: set.model ?? null, effort: set.effort ?? null, access: set.access ?? "config", plan: set.plan ?? false });
    const turn = await s.startTurn(p.input ?? [], p.clientUserMessageId ?? null);
    this.historyCache.delete(p.threadId);
    // A new thread's first message becomes its preview (and title) right away.
    const pend = this.pending.get(p.threadId);
    if (pend && !pend.thread.preview) {
      const text = (p.input ?? []).map((i: any) => (i.type === "text" ? i.text : "")).join(" ").trim();
      if (text) {
        pend.thread = { ...pend.thread, preview: text, updatedAt: sec(Date.now()), recencyAt: sec(Date.now()) };
        this.notify("thread/started", { thread: { ...pend.thread, status: s.status } });
      }
    }
    return { turn };
  }

  /** Settings last reported per thread, so unchanged ones aren't sent again. */
  private reported = new Map<string, string>();

  /** Session status or settings changed: tell the renderer. */
  private sessionChanged(s: ClaudeSession) {
    const id = s.config.id;
    if (this.sessions.get(id) !== s) return;
    this.refreshUsage(s);
    const sig = JSON.stringify([s.config.cwd, s.config.model, s.runningModel, s.config.effort, s.config.plan, s.config.access]);
    if (this.reported.get(id) === sig) return this.settleFork(s);
    this.reported.set(id, sig);
    this.notify("thread/settings/updated", {
      threadId: id,
      threadSettings: {
        disabledPluginIds: [],
        cwd: s.config.cwd,
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "dangerFullAccess" },
        activePermissionProfile: null,
        model: s.config.model ?? "default",
        modelProvider: "anthropic",
        serviceTier: null,
        effort: s.config.effort,
        summary: null,
        collaborationMode: { mode: s.config.plan ? "plan" : "default", settings: { model: s.config.model ?? "default", reasoning_effort: s.config.effort, developer_instructions: null } },
        multiAgentMode: "explicitRequestOnly",
        personality: null,
        access: s.config.access,
      },
    });
    this.settleFork(s);
  }

  private settleFork(s: ClaudeSession) {
    const id = s.config.id;
    if (s.config.exists && this.pending.has(id)) {
      // The first turn wrote the transcript; from now on it's an ordinary session.
      void this.info(id).then((info) => info && this.pending.delete(id));
    }
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
      this.log(`claude: couldn't save state: ${(err as Error).message}`);
    }
  }

  // ---- account, models, usage ----------------------------------------------

  private async userSettings(): Promise<{ model?: string; effortLevel?: string }> {
    try {
      return (await resolveSettings()).effective as { model?: string; effortLevel?: string };
    } catch {
      return {};
    }
  }

  private async account() {
    const binary = this.target?.binary;
    const auth = binary ? await claudeAuthStatus(binary) : null;
    if (!auth?.loggedIn) return { account: null, requiresOpenaiAuth: true, workspaceRouting: null };
    const method = (auth.authMethod ?? "").toLowerCase();
    if (/api.?key/.test(method)) return { account: { type: "apiKey" }, requiresOpenaiAuth: false, workspaceRouting: null };
    if (auth.apiProvider && auth.apiProvider !== "firstParty") return { account: { type: "cloud", provider: auth.apiProvider }, requiresOpenaiAuth: false, workspaceRouting: null };
    return {
      account: { type: "claudeAi", email: auth.email, planType: auth.subscriptionType, organization: auth.organization },
      requiresOpenaiAuth: false,
      workspaceRouting: null,
    };
  }

  /**
   * Model list and plan usage need a running Claude Code. A short-lived one is started for
   * that, without settings, hooks or MCP servers, and without sending anything to the model.
   */
  private probe(): Promise<void> {
    const binary = this.target?.binary;
    if (!binary) return Promise.resolve();
    this.probing ??= (async () => {
      async function* nothing() {
        await new Promise(() => {});
      }
      const q = query({
        prompt: nothing(),
        options: { pathToClaudeCodeExecutable: binary, env: claudeEnv(), settingSources: [], strictMcpConfig: true, persistSession: false, stderr: (d) => this.log(d) },
      });
      try {
        const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Claude Code didn't start in time")), 30_000));
        const init = await Promise.race([q.initializationResult(), timeout]);
        const defaults = await this.userSettings();
        this.models = { at: Date.now(), list: (init.models ?? []).map((m, _, all) => modelFrom(m, defaults.effortLevel ?? null, all, defaults.model ?? null)) };
        this.modelInfos = { list: init.models ?? [], configured: defaults.model ?? null };
        try {
          const u = await Promise.race([q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), timeout]);
          this.usage = { at: Date.now(), ...usageFrom(u) };
        } catch {
          /* plan usage isn't available (API key, older CLI) */
        }
      } catch (err) {
        this.log(`claude: probe failed: ${(err as Error).message}`);
      } finally {
        q.close();
        this.probing = null;
      }
    })();
    return this.probing;
  }

  private async modelList(): Promise<Model[]> {
    if (!this.models) await this.probe();
    return this.models?.list ?? [];
  }

  private async rateLimits() {
    if (!this.usage || Date.now() - this.usage.at > USAGE_TTL_MS) {
      const live = [...this.sessions.values()].find((s) => s.query)?.query;
      try {
        if (live) await this.readUsage(live);
        else await this.probe();
      } catch {
        /* keep what we had */
      }
    }
    return this.usage;
  }

  private async readUsage(q: NonNullable<ClaudeSession["query"]>) {
    const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    this.usage = { at: Date.now(), ...usageFrom(u) };
  }

  /**
   * After a turn, re-read plan usage from the session that ran it (at most once a minute): live
   * events only cover the general and Opus/Sonnet windows, not per-model buckets like Fable.
   */
  private refreshUsage(s: ClaudeSession) {
    if (!s.query || s.running || (this.usage && Date.now() - this.usage.at < 60_000)) return;
    const at = this.usage?.at;
    this.usage = this.usage ? { ...this.usage, at: Date.now() } : null; // claim the slot
    void this.readUsage(s.query)
      .then(() => this.usage?.snapshot && this.notify("account/rateLimits/updated", { rateLimits: this.usage.snapshot, rateLimitsByLimitId: this.usage.byId }))
      .catch(() => {
        if (this.usage && at) this.usage = { ...this.usage, at };
      });
  }

  /** A live session saw its plan usage change. */
  private noteRateLimit(info: SDKRateLimitInfo) {
    if (info.utilization == null || !info.rateLimitType) return;
    const prev = this.usage?.snapshot ?? emptySnapshot();
    const byId = { ...this.usage?.byId };
    const w: RateLimitWindow = { usedPercent: info.utilization * 100, windowDurationMins: null, resetsAt: info.resetsAt ?? null };
    let next = prev;
    if (info.rateLimitType === "five_hour") next = { ...prev, primary: { ...w, windowDurationMins: 300 } };
    else if (info.rateLimitType === "seven_day") next = { ...prev, secondary: { ...w, windowDurationMins: 10_080 } };
    else if (info.rateLimitType === "seven_day_opus" || info.rateLimitType === "seven_day_sonnet") {
      const id = info.rateLimitType;
      byId[id] = bucket(id, id === "seven_day_opus" ? "Opus" : "Sonnet", { ...w, windowDurationMins: 10_080 });
    } else return;
    this.usage = { at: this.usage?.at ?? Date.now(), snapshot: next, byId };
    this.notify("account/rateLimits/updated", { rateLimits: next, rateLimitsByLimitId: byId });
  }
}

/** A session another Claude Code process has open, from its entry in the session registry. */
interface RegistryEntry {
  sessionId: string;
  busy: boolean;
  /** When that process started (ms): background work launched before then died with an earlier one. */
  startedAt: number;
}

/** Whether a process is still running (a registry entry outlives a crashed claude). */
function alive(pid: unknown): boolean {
  if (typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function emptySnapshot(): RateLimitSnapshot {
  return {
    limitId: null,
    limitName: null,
    normalModelSlug: null,
    primary: null,
    secondary: null,
    credits: null,
    individualLimit: null,
    spendControlReached: null,
    planType: null,
    rateLimitReachedType: null,
  };
}

/** One per-model usage bucket as a snapshot of its own. */
function bucket(id: string, name: string, window: RateLimitWindow): RateLimitSnapshot {
  return { ...emptySnapshot(), limitId: id, limitName: name, primary: window };
}

/**
 * `/usage` plan windows (utilization in percent, reset as an ISO time) as the app-server's
 * snapshots: the 5-hour and 7-day windows, and each per-model weekly bucket (Fable, Opus, Sonnet)
 * by its own limit id.
 */
function usageFrom(u: { rate_limits_available: boolean; rate_limits: any }): { snapshot: RateLimitSnapshot | null; byId: Record<string, RateLimitSnapshot> } {
  const rl = u.rate_limits_available ? u.rate_limits : null;
  if (!rl) return { snapshot: null, byId: {} };
  const win = (w: any, mins: number): RateLimitWindow | null =>
    w && w.utilization != null ? { usedPercent: Number(w.utilization), windowDurationMins: mins, resetsAt: w.resets_at ? Math.floor(Date.parse(w.resets_at) / 1000) : null } : null;
  const byId: Record<string, RateLimitSnapshot> = {};
  for (const m of Array.isArray(rl.model_scoped) ? rl.model_scoped : []) {
    const w = win(m, 10_080);
    if (w && m.display_name) byId[`model:${String(m.display_name).toLowerCase()}`] = bucket(`model:${String(m.display_name).toLowerCase()}`, String(m.display_name), w);
  }
  const named = new Set(Object.values(byId).map((b) => b.limitName?.toLowerCase()));
  for (const [id, name] of [["seven_day_opus", "Opus"], ["seven_day_sonnet", "Sonnet"]] as const) {
    const w = win(rl[id], 10_080);
    if (w && !named.has(name.toLowerCase())) byId[id] = bucket(id, name, w);
  }
  return { snapshot: { ...emptySnapshot(), limitId: "claude", primary: win(rl.five_hour, 300), secondary: win(rl.seven_day, 10_080) }, byId };
}

/**
 * What "Default" runs, named. Choosing it sends no model, so Claude Code uses the `model` in the
 * user's settings if there is one (the list itself is read without settings, so it can't say), and
 * otherwise its own default, which another entry in the list (or its description) names.
 */
function defaultEntry(m: ModelInfo, all: ModelInfo[], configured: string | null): { label: string; description: string } {
  if (configured) {
    const oneM = /\[1m\]$/i.test(configured);
    const base = configured.replace(/\[1m\]$/i, "");
    const hit =
      all.find((o) => o.value === configured) ??
      all.find((o) => o.value === base) ??
      all.find((o) => o.value !== "default" && o.resolvedModel?.replace(/\[1m\]$/i, "") === base);
    const name = hit && hit.value !== "default" ? hit.displayName : configured;
    const label = oneM && !/1m/i.test(name) ? `${name} · 1M` : name;
    return { label: `Default (${label})`, description: `Your Claude Code settings choose ${configured}` };
  }
  const twin = all.find((o) => o.value !== m.value && o.resolvedModel && o.resolvedModel === m.resolvedModel);
  const named = twin?.displayName ?? /\(currently (.+?)\)(?: ·|$)/.exec(m.description)?.[1] ?? /^([^·]+?) ·/.exec(m.description)?.[1];
  return { label: named ? `Default (${named.trim()})` : m.displayName, description: m.description };
}

/** Claude Code's model entry as the app-server's. */
function modelFrom(m: ModelInfo, defaultEffort: string | null, all: ModelInfo[], configured: string | null): Model {
  const entry = m.value === "default" ? defaultEntry(m, all, configured) : { label: m.displayName, description: m.description };
  const efforts = m.supportsEffort ? (m.supportedEffortLevels ?? []) : [];
  const describe: Record<string, string> = {
    low: "Fastest, for simple tasks",
    medium: "Balanced",
    high: "Thorough",
    xhigh: "Extra thorough",
    max: "Maximum effort (this session only)",
  };
  return {
    id: m.value,
    model: m.value,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: entry.label,
    description: entry.description,
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: efforts.map((e) => ({ reasoningEffort: e, description: describe[e] ?? e })),
    defaultReasoningEffort: (defaultEffort && efforts.includes(defaultEffort as never) ? defaultEffort : efforts.includes("high") ? "high" : (efforts[0] ?? "medium")) as string,
    inputModalities: ["text", "image"],
    supportsPersonality: false,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    availableAccessPrograms: null,
    isDefault: m.value === "default",
  };
}
