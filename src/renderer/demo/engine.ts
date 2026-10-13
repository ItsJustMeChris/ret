import type { EngineStatus, ProviderId } from "@shared/bridge";
import type { Model, RateLimitSnapshot, Thread, ThreadStatus, ThreadTokenUsage, Turn, TurnPlanStep, UserInput } from "@shared/protocol";
import { PROVIDERS } from "../agents";
import { localDay } from "../lib/format";
import { DemoFs, fromBase64, toBase64 } from "./fs";
import { Cancelled, Run, type Script } from "./driver";
import { BRANCH } from "./workspace";

/**
 * The demo's engines: one per provider, each answering the app-server JSON-RPC protocol the
 * renderer already speaks (the methods src/main/claude/engine.ts implements), over a pipe the
 * demo bridge provides. They share one World: the threads, their histories, the files, and
 * the scripted turns running in them.
 */

export interface ThreadConf {
  model: string | null;
  effort: string | null;
  plan: boolean;
  /** The provider's access choice (agents.ts): Codex presets, Claude Code permission modes. */
  access: string;
  serviceTier: string | null;
}

export interface DemoThread {
  provider: ProviderId;
  /** The thread record (its status is computed). */
  meta: Thread;
  /** Full history, oldest first; a running turn is the last one. */
  turns: Turn[];
  /** Each turn's checklist, by turn id. */
  plans: Record<string, TurnPlanStep[]>;
  conf: ThreadConf;
  usage: ThreadTokenUsage;
  /** The last turn failed: shows under Failed until the next one. */
  failed: boolean;
  run: Run | null;
  /** The client has resumed it: item-level events go out. */
  subscribed: boolean;
  /**
   * Last run in another app (the Codex or Claude Code CLI, an IDE): Ret only sees it through the
   * thread list and history, the way it watches real threads running elsewhere.
   */
  away: boolean;
  /** Where the visitor's next message in this thread goes, when the thread has a story to continue. */
  next: Script | null;
}

export interface Pending {
  id: string;
  method: string;
  params: Record<string, unknown>;
  threadId: string;
  resolve: (v: any) => void;
}

/** Picks the scripted reply to a visitor's message. */
export type Responder = (t: DemoThread, text: string, mode: "plan" | "default") => Script;

export class World {
  fs = new DemoFs();
  threads = new Map<string, DemoThread>();
  engines = {} as Record<ProviderId, DemoEngine>;
  /** Runs started once an engine first connects (the live turn, the waiting approval and question). */
  boot: Partial<Record<ProviderId, () => void>> = {};
  respond: Responder = () => async (r) => r.say("…");
  limits = {} as Record<ProviderId, { snapshot: RateLimitSnapshot; byId: Record<string, RateLimitSnapshot> }>;
  models = {} as Record<ProviderId, Model[]>;
  defaults = {} as Record<ProviderId, { model: string; effort: string }>;
  /** Tokens per day (`account/usage/read`), oldest first. */
  tokens = {} as Record<ProviderId, { startDate: string; tokens: number }[]>;

  owned(provider: ProviderId) {
    return [...this.threads.values()].filter((t) => t.provider === provider);
  }

  /** Start a scripted run in a thread's (already recorded) in-progress turn. */
  launch(t: DemoThread, turn: Turn, script: Script) {
    const engine = this.engines[t.provider];
    const run = new Run(engine, t, turn);
    t.run = run;
    void (async () => {
      let status: Turn["status"] = "completed";
      let error: string | null = null;
      try {
        await script(run);
        // Steers that arrived after the last step still get an answer.
        await run.checkpoint();
      } catch (err) {
        if (err instanceof Cancelled) status = "interrupted";
        else {
          status = "failed";
          error = (err as Error).message || String(err);
          console.error("demo: script failed", err);
        }
      }
      engine.finish(run, status, error);
    })();
    return run;
  }
}

type RpcError = Error & { code?: number };
const rpcError = (message: string, code = -32000): RpcError => Object.assign(new Error(message), { code });
const sec = () => Math.floor(Date.now() / 1000);

export class DemoEngine {
  status: EngineStatus;
  private outbox: string[] = [];
  private flushTimer = 0;
  private requests = new Map<string, Pending>();
  private nextReq = 1;
  private connected = false;
  private booted = false;

  constructor(
    readonly provider: ProviderId,
    readonly world: World,
    private readonly emitLines: (lines: string[]) => void,
    status: Omit<EngineStatus, "provider">,
  ) {
    this.status = { provider, ...status };
  }

  // ---- transport ------------------------------------------------------------

  /** One line from the renderer: a request, a notification, or the answer to one of ours. */
  receive(line: string) {
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
      this.requests.delete(req.id);
      req.resolve(msg.error ? null : msg.result);
      const t = this.world.threads.get(req.threadId);
      if (t) this.statusChanged(t);
    }
  }

  /** The engine went away (turned off in Settings): the next connection re-initializes. */
  disconnect() {
    this.connected = false;
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

  private write(msg: object) {
    this.outbox.push(JSON.stringify(msg));
    if (this.flushTimer) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = 0;
      const batch = this.outbox;
      this.outbox = [];
      if (batch.length) this.emitLines(batch);
    }, 0);
  }

  notify(method: string, params: unknown) {
    if (this.connected) this.write({ method, params });
  }

  /** Item-level events only go to threads the client has resumed (like a real app-server). */
  notifyThread(t: DemoThread, method: string, params: unknown) {
    if (t.subscribed && !t.away) this.notify(method, params);
  }

  touch(t: DemoThread) {
    t.meta.updatedAt = sec();
    t.meta.recencyAt = sec();
  }

  /** A server request to the client (approval, question). Cancelling withdraws it. */
  request(t: DemoThread, method: string, params: Record<string, unknown>): { promise: Promise<any>; cancel: () => void } {
    const id = `demo-${this.provider}-${this.nextReq++}`;
    let resolve!: (v: any) => void;
    const promise = new Promise<any>((r) => (resolve = r));
    this.requests.set(id, { id, method, params, threadId: t.meta.id, resolve });
    if (this.connected) this.write({ id, method, params });
    this.statusChanged(t);
    const cancel = () => {
      if (!this.requests.delete(id)) return;
      this.notify("serverRequest/resolved", { threadId: t.meta.id, requestId: id });
      resolve(null);
      this.statusChanged(t);
    };
    return { promise, cancel };
  }

  // ---- threads --------------------------------------------------------------

  statusOf(t: DemoThread): ThreadStatus {
    if (t.away) return { type: "notLoaded" };
    if (t.run) {
      const flags = [...this.requests.values()]
        .filter((r) => r.threadId === t.meta.id)
        .map((r) => (r.method === "item/tool/requestUserInput" ? ("waitingOnUserInput" as const) : ("waitingOnApproval" as const)));
      return { type: "active", activeFlags: [...new Set(flags)] };
    }
    return t.failed ? { type: "systemError" } : { type: "idle" };
  }

  private statusChanged(t: DemoThread) {
    this.notify("thread/status/changed", { threadId: t.meta.id, status: this.statusOf(t) });
  }

  threadOut(t: DemoThread): Thread {
    return { ...t.meta, status: this.statusOf(t), turns: [] };
  }

  private get(threadId: string): DemoThread {
    const t = this.world.threads.get(threadId);
    if (!t || t.provider !== this.provider) throw rpcError(`No thread ${threadId}`);
    return t;
  }

  private settings(t: DemoThread) {
    const codex = this.provider === "codex";
    const model = t.conf.model ?? (codex ? this.world.defaults.codex.model : "default");
    const access = codexAccess(t.conf.access, t.meta.cwd);
    return {
      model,
      modelProvider: codex ? "openai" : "anthropic",
      serviceTier: t.conf.serviceTier,
      cwd: t.meta.cwd,
      approvalPolicy: codex ? access.approvalPolicy : "on-request",
      sandbox: codex ? access.sandbox : { type: "dangerFullAccess" },
      reasoningEffort: t.conf.effort,
      collaborationMode: { mode: t.conf.plan ? "plan" : "default", settings: { model, reasoning_effort: t.conf.effort, developer_instructions: null } },
      ...(codex ? {} : { access: t.conf.access }),
    };
  }

  /** What thread/start, resume and fork answer with. */
  private settingsResponse(t: DemoThread) {
    const s = this.settings(t);
    return {
      thread: this.threadOut(t),
      ...s,
      disabledPluginIds: [],
      runtimeWorkspaceRoots: [],
      instructionSources: [],
      approvalsReviewer: "user",
      activePermissionProfile: null,
      multiAgentMode: "explicitRequestOnly",
      initialTurnsPage: null,
      turnsBackwardsCursor: null,
      itemsBackwardsCursor: null,
    };
  }

  private settingsChanged(t: DemoThread) {
    const s = this.settings(t);
    this.notify("thread/settings/updated", {
      threadId: t.meta.id,
      threadSettings: {
        disabledPluginIds: [],
        cwd: s.cwd,
        approvalPolicy: s.approvalPolicy,
        approvalsReviewer: "user",
        sandboxPolicy: s.sandbox,
        activePermissionProfile: null,
        model: s.model,
        modelProvider: s.modelProvider,
        serviceTier: s.serviceTier,
        effort: s.reasoningEffort,
        summary: null,
        collaborationMode: s.collaborationMode,
        multiAgentMode: "explicitRequestOnly",
        personality: null,
        ...(this.provider === "claude" ? { access: t.conf.access } : {}),
      },
    });
  }

  /** A client resumed the thread: catch it up on the running turn, then stream to it. */
  private subscribe(t: DemoThread) {
    t.subscribed = true;
    if (t.away) return; // running in another app: Ret watches it, it doesn't join it
    const run = t.run;
    if (run) {
      this.notify("turn/started", { threadId: t.meta.id, turn: { ...run.turn, items: [], itemsView: "notLoaded" } });
      for (const item of run.turn.items) {
        const live = "status" in item && item.status === "inProgress";
        this.notify(live ? "item/started" : "item/completed", { threadId: t.meta.id, turnId: run.turn.id, item });
      }
      const plan = t.plans[run.turn.id];
      if (plan) this.notify("turn/plan/updated", { threadId: t.meta.id, turnId: run.turn.id, explanation: null, plan });
      const diff = this.provider === "codex" ? run.diff() : "";
      if (diff) this.notify("turn/diff/updated", { threadId: t.meta.id, turnId: run.turn.id, diff });
    }
    this.notify("thread/tokenUsage/updated", { threadId: t.meta.id, turnId: run?.turn.id ?? t.turns.at(-1)?.id ?? "", tokenUsage: t.usage });
  }

  // ---- turns ----------------------------------------------------------------

  private newTurn(t: DemoThread, inputs: UserInput[], clientId: string | null, compact = false): Turn {
    if (t.run) throw rpcError("A turn is already running");
    const turn: Turn = {
      id: crypto.randomUUID(),
      rootTurnId: null,
      items: compact ? [] : [{ type: "userMessage", id: crypto.randomUUID(), clientId, content: inputs }],
      itemsView: "full",
      status: "inProgress",
      error: null,
      startedAt: sec(),
      completedAt: null,
      durationMs: null,
    };
    t.turns.push(turn);
    t.failed = false;
    this.touch(t);
    this.notify("turn/started", { threadId: t.meta.id, turn: { ...turn, items: [], itemsView: "notLoaded" } });
    if (!compact) this.notify("item/completed", { threadId: t.meta.id, turnId: turn.id, item: turn.items[0], completedAtMs: Date.now() });
    return turn;
  }

  finish(run: Run, status: Turn["status"], error: string | null) {
    const t = run.t;
    const turn = run.turn;
    if (status !== "completed") run.settle();
    for (const r of [...this.requests.values()]) if (r.threadId === t.meta.id) this.requests.delete(r.id);
    const now = Date.now();
    turn.status = status;
    turn.completedAt = Math.floor(now / 1000);
    turn.durationMs = turn.startedAt != null ? now - turn.startedAt * 1000 : null;
    turn.error = error ? { message: error, codexErrorInfo: null, additionalDetails: null, misalignment: null } : null;
    if (t.run === run) t.run = null;
    this.touch(t);
    // Another app's turn ends in its history; Ret notices on its next look at the thread list.
    if (t.away) return;
    // Codex reports what the turn changed, for the +/- under it and the details panel.
    const diff = this.provider === "codex" ? run.diff() : "";
    if (diff) this.notifyThread(t, "turn/diff/updated", { threadId: t.meta.id, turnId: turn.id, diff });
    // Usage grows with every turn: the context ring in the header, the plan meters in the sidebar.
    const grow = 3000 + Math.floor(Math.random() * 9000);
    const u = t.usage;
    t.usage = {
      ...u,
      total: { ...u.total, totalTokens: u.total.totalTokens + grow * 4, inputTokens: u.total.inputTokens + grow * 3, outputTokens: u.total.outputTokens + grow, cachedInputTokens: u.total.cachedInputTokens + grow * 2 },
      last: { ...u.last, inputTokens: Math.floor(Math.min((u.modelContextWindow ?? 200_000) * 0.92, u.last.inputTokens + grow)), outputTokens: Math.floor(grow / 4) },
    };
    this.notify("thread/tokenUsage/updated", { threadId: t.meta.id, turnId: turn.id, tokenUsage: t.usage });
    const days = this.world.tokens[this.provider];
    const today = localDay(new Date());
    if (days.at(-1)?.startDate === today) days.at(-1)!.tokens += grow * 4;
    else days.push({ startDate: today, tokens: grow * 4 });
    this.notify("turn/completed", { threadId: t.meta.id, turn: { ...turn, items: [], itemsView: "notLoaded" } });
    this.statusChanged(t);
    const lim = this.world.limits[this.provider];
    if (lim?.snapshot.primary) {
      const bump = (w: RateLimitSnapshot["primary"]) => (w ? { ...w, usedPercent: Math.min(97, w.usedPercent + 0.6 + Math.random()) } : w);
      lim.snapshot = { ...lim.snapshot, primary: bump(lim.snapshot.primary), secondary: bump(lim.snapshot.secondary) };
      this.notify("account/rateLimits/updated", { rateLimits: lim.snapshot, rateLimitsByLimitId: lim.byId });
    }
  }

  // ---- methods --------------------------------------------------------------

  private async call(method: string, p: any): Promise<unknown> {
    if (method.startsWith("fs/")) return this.fsCall(method, p);
    switch (method) {
      case "initialize":
        this.connected = true;
        for (const t of this.world.owned(this.provider)) t.subscribed = false;
        // Anything still waiting on an answer is asked again on the new connection.
        setTimeout(() => {
          for (const r of this.requests.values()) this.write({ id: r.id, method: r.method, params: r.params });
        }, 120);
        if (!this.booted) {
          this.booted = true;
          this.world.boot[this.provider]?.();
        }
        return { userAgent: this.provider === "codex" ? `codex_app_server/${this.status.version}` : `claude-code/${this.status.version}`, codexHome: "/Users/you/.codex", platformFamily: "unix", platformOs: "macos" };
      case "thread/list": {
        const all = this.world
          .owned(this.provider)
          .sort((a, b) => b.meta.updatedAt - a.meta.updatedAt)
          .map((t) => this.threadOut(t));
        const offset = Number(p.cursor ?? 0) || 0;
        const limit = Math.max(1, Number(p.limit ?? 100));
        return { data: all.slice(offset, offset + limit), nextCursor: offset + limit < all.length ? String(offset + limit) : null, backwardsCursor: null };
      }
      case "thread/read": {
        const t = this.get(p.threadId);
        return { thread: { ...this.threadOut(t), turns: p.includeTurns ? t.turns : [] } };
      }
      case "thread/turns/list": {
        const t = this.get(p.threadId);
        const ordered = p.sortDirection === "asc" ? t.turns : t.turns.slice().reverse();
        const offset = Number(p.cursor ?? 0) || 0;
        const limit = Math.max(1, Number(p.limit ?? 20));
        const page = ordered.slice(offset, offset + limit).map((turn) => (p.itemsView === "notLoaded" ? { ...turn, items: [], itemsView: "notLoaded" } : turn));
        return { data: page, nextCursor: offset + limit < ordered.length ? String(offset + limit) : null, backwardsCursor: null };
      }
      case "thread/start":
        return this.startThread(p);
      case "thread/resume": {
        const t = this.get(p.threadId);
        const res = this.settingsResponse(t);
        setTimeout(() => this.subscribe(t), 0);
        return res;
      }
      case "thread/unsubscribe": {
        const t = this.get(p.threadId);
        if (!t.run) t.subscribed = false;
        return {};
      }
      case "thread/fork":
        return this.fork(p);
      case "thread/name/set": {
        const t = this.get(p.threadId);
        t.meta.name = String(p.name ?? "") || null;
        this.notify("thread/name/updated", { threadId: t.meta.id, threadName: t.meta.name });
        return {};
      }
      case "thread/archive": {
        const t = this.get(p.threadId);
        t.run?.cancel();
        this.world.threads.delete(t.meta.id);
        this.notify("thread/archived", { threadId: t.meta.id });
        return {};
      }
      case "thread/compact/start": {
        const t = this.get(p.threadId);
        const turn = this.newTurn(t, [], null, true);
        this.world.launch(t, turn, async (r) => {
          await r.sleep(1400);
          r.emit("item/completed", { type: "contextCompaction", id: r.id("compact") });
          t.usage = { ...t.usage, last: { ...t.usage.last, inputTokens: Math.floor(t.usage.last.inputTokens * 0.22) } };
        });
        return {};
      }
      case "turn/start":
        return this.startTurn(p);
      case "turn/steer": {
        const t = this.get(p.threadId);
        const run = t.run;
        if (!run || (p.expectedTurnId && run.turn.id !== p.expectedTurnId)) throw rpcError("No turn is running to steer");
        const inputs: UserInput[] = p.input ?? [];
        run.emit("item/completed", { type: "userMessage", id: crypto.randomUUID(), clientId: p.clientUserMessageId ?? null, content: inputs });
        run.steers.push(textOf(inputs));
        return { turnId: run.turn.id };
      }
      case "turn/interrupt":
        this.get(p.threadId).run?.cancel();
        return {};
      case "project/list":
        return { data: [], nextCursor: null };
      case "model/list":
        return { data: this.world.models[this.provider], nextCursor: null };
      case "collaborationMode/list":
        return {
          data: [
            { name: "Plan", mode: "plan", model: null, reasoning_effort: null },
            { name: "Default", mode: "default", model: null, reasoning_effort: null },
          ],
        };
      case "config/read": {
        const d = this.world.defaults[this.provider];
        return { config: { model: d.model, model_reasoning_effort: d.effort } };
      }
      case "account/read":
        return this.provider === "codex"
          ? { account: { type: "chatgpt", email: "you@example.com", planType: "pro" }, requiresOpenaiAuth: true, workspaceRouting: null }
          : { account: { type: "claudeAi", email: "you@example.com", planType: "max", organization: null }, requiresOpenaiAuth: false, workspaceRouting: null };
      case "account/rateLimits/read": {
        const lim = this.world.limits[this.provider];
        return { rateLimits: lim.snapshot, rateLimitsByLimitId: lim.byId, ordinaryUsageAllowed: true, rateLimitResetCredits: null, accountId: null, rateLimitUpsell: null };
      }
      case "account/usage/read": {
        const days = this.world.tokens[this.provider];
        return {
          summary: { lifetimeTokens: null, peakDailyTokens: Math.max(0, ...days.map((d) => d.tokens)), longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null },
          dailyUsageBuckets: days,
        };
      }
      case "account/login/start":
      case "account/login/cancel":
      case "account/logout":
        throw rpcError("Signing in and out isn't part of the web demo.");
      default:
        throw rpcError(`${method} isn't available in the web demo`, -32601);
    }
  }

  private startThread(p: any) {
    // Hidden side threads (Ret's title requests) have no model behind them here.
    if (p.ephemeral) throw rpcError("Ephemeral threads aren't part of the web demo.", -32601);
    const cwd = String(p.cwd ?? "");
    const id = crypto.randomUUID();
    const now = sec();
    const codex = this.provider === "codex";
    const access = codex ? (codexPresetOf(p.approvalPolicy, p.sandbox) ?? "config") : typeof p.access === "string" ? p.access : "config";
    const t: DemoThread = {
      provider: this.provider,
      meta: blankThread(this.provider, id, cwd, now, p.model ?? null),
      turns: [],
      plans: {},
      conf: { model: p.model ?? null, effort: null, plan: false, access, serviceTier: p.serviceTier ?? null },
      usage: freshUsage(codex ? 272_000 : 200_000),
      failed: false,
      run: null,
      subscribed: true,
      away: false,
      next: null,
    };
    this.world.threads.set(id, t);
    this.notify("thread/started", { thread: this.threadOut(t) });
    return this.settingsResponse(t);
  }

  private startTurn(p: any) {
    const t = this.get(p.threadId);
    const before = JSON.stringify(t.conf);
    const c = t.conf;
    if (p.model) c.model = p.model;
    if (p.effort !== undefined && p.effort !== null) c.effort = p.effort;
    if (p.serviceTier !== undefined) c.serviceTier = p.serviceTier;
    if (p.collaborationMode?.mode) {
      c.plan = p.collaborationMode.mode === "plan";
      if (p.collaborationMode.settings?.model) c.model = p.collaborationMode.settings.model;
      if (p.collaborationMode.settings?.reasoning_effort) c.effort = p.collaborationMode.settings.reasoning_effort;
    }
    if (this.provider === "claude" && typeof p.access === "string") c.access = p.access;
    if (this.provider === "codex" && (p.approvalPolicy || p.sandboxPolicy)) c.access = codexPresetOf(p.approvalPolicy, p.sandboxPolicy) ?? c.access;
    if (JSON.stringify(c) !== before) this.settingsChanged(t);

    const inputs: UserInput[] = p.input ?? [];
    const text = textOf(inputs);
    const turn = this.newTurn(t, inputs, p.clientUserMessageId ?? null);
    // A turn started here loads the thread here.
    t.away = false;
    t.subscribed = true;
    if (!t.meta.preview && text) {
      t.meta.preview = text;
      this.notify("thread/started", { thread: this.threadOut(t) });
    }
    const script = t.next ?? this.world.respond(t, text, c.plan ? "plan" : "default");
    t.next = null;
    this.world.launch(t, turn, script);
    this.statusChanged(t);
    return { turn: { ...turn, items: [], itemsView: "notLoaded" } };
  }

  private fork(p: any) {
    const src = this.get(p.threadId);
    const cut = p.lastTurnId ? src.turns.findIndex((t) => t.id === p.lastTurnId) : src.turns.length - 1;
    const kept = src.turns.slice(0, cut >= 0 ? cut + 1 : src.turns.length).filter((t) => t.status !== "inProgress");
    const id = crypto.randomUUID();
    const now = sec();
    const cwd = p.cwd ? String(p.cwd) : src.meta.cwd;
    const turns: Turn[] = JSON.parse(JSON.stringify(kept)).map((turn: Turn, i: number) => ({ ...turn, id: `${id.slice(0, 8)}-t${i + 1}` }));
    const t: DemoThread = {
      provider: this.provider,
      meta: {
        ...src.meta,
        id,
        sessionId: id,
        forkedFromId: src.meta.id,
        createdAt: now,
        updatedAt: now,
        recencyAt: now,
        cwd,
        gitInfo: { sha: null, branch: BRANCH[cwd] ?? src.meta.gitInfo?.branch ?? "main", originUrl: null },
      },
      turns,
      plans: {},
      conf: { ...src.conf, plan: false },
      usage: JSON.parse(JSON.stringify(src.usage)),
      failed: false,
      run: null,
      subscribed: true,
      away: false,
      next: null,
    };
    this.world.threads.set(id, t);
    this.notify("thread/started", { thread: this.threadOut(t) });
    return this.settingsResponse(t);
  }

  private fsCall(method: string, p: any): unknown {
    const fs = this.world.fs;
    const path = String(p.path ?? "");
    switch (method) {
      case "fs/readFile": {
        const text = fs.read(path);
        if (text == null) throw rpcError(fs.stat(path).isDir ? "Is a directory (os error 21)" : "No such file or directory (os error 2)");
        return { dataBase64: toBase64(text) };
      }
      case "fs/writeFile":
        fs.write(path, fromBase64(String(p.dataBase64 ?? "")));
        return {};
      case "fs/readDirectory": {
        const entries = fs.list(path);
        if (!entries) throw rpcError("No such file or directory (os error 2)");
        return { entries: entries.map((e) => ({ fileName: e.name, isDirectory: e.dir, isFile: !e.dir })) };
      }
      case "fs/watch":
        fs.watch(String(p.watchId), path, (changedPaths) => this.notify("fs/changed", { watchId: p.watchId, changedPaths }));
        return {};
      case "fs/unwatch":
        fs.unwatch(String(p.watchId));
        return {};
      default:
        throw rpcError(`${method} is not supported`, -32601);
    }
  }
}

// ---------------------------------------------------------------------------

export const textOf = (inputs: UserInput[]) =>
  inputs
    .map((i) => (i.type === "text" ? i.text : ""))
    .join("\n")
    .trim();

export function freshUsage(window: number, input = 0): ThreadTokenUsage {
  const b = (inputTokens: number) => ({ totalTokens: inputTokens, inputTokens, cachedInputTokens: Math.floor(inputTokens * 0.8), cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 });
  return { total: b(input * 3), last: b(input), modelContextWindow: window };
}

export function blankThread(provider: ProviderId, id: string, cwd: string, at: number, model: string | null): Thread {
  const codex = provider === "codex";
  return {
    id,
    environments: null,
    extra: null,
    sessionId: id,
    forkedFromId: null,
    parentThreadId: null,
    preview: "",
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "paginated",
    modelProvider: codex ? "openai" : "anthropic",
    model,
    reasoningEffort: null,
    createdAt: at,
    updatedAt: at,
    recencyAt: at,
    status: { type: "idle" },
    path: null,
    cwd,
    cliVersion: codex ? "0.162.1" : "",
    originator: codex ? "ret" : "claude_code",
    source: codex ? "appServer" : "unknown",
    canAcceptDirectInput: null,
    threadSource: null,
    agentNickname: null,
    agentRole: null,
    gitInfo: BRANCH[cwd] ? { sha: null, branch: BRANCH[cwd], originUrl: null } : null,
    name: null,
    daybreakEnabled: null,
    turns: [],
  };
}

/** Codex's access presets (agents.ts) as the policies the app-server reports. */
function codexAccess(preset: string, cwd: string) {
  switch (preset) {
    case "read-only":
      return { approvalPolicy: "on-request", sandbox: { type: "readOnly", networkAccess: false } };
    case "full":
      return { approvalPolicy: "never", sandbox: { type: "dangerFullAccess" } };
    default:
      return { approvalPolicy: "on-request", sandbox: { type: "workspaceWrite", writableRoots: [cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } };
  }
}

/** The preset a thread/start or turn/start's policies amount to. */
function codexPresetOf(approvalPolicy: unknown, sandbox: unknown): string | null {
  const type = typeof sandbox === "string" ? sandbox : (sandbox as { type?: string } | null)?.type;
  if (!type && !approvalPolicy) return null;
  if (type === "danger-full-access" || type === "dangerFullAccess") return "full";
  if (type === "read-only" || type === "readOnly") return "read-only";
  if (type === "workspace-write" || type === "workspaceWrite") return "auto";
  return PROVIDERS.codex.accessOf?.(approvalPolicy, sandbox) ?? null;
}
