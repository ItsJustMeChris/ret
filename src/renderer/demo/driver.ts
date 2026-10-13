import type { ThreadItem, Turn, TurnPlanStep } from "@shared/protocol";
import type { DemoEngine, DemoThread } from "./engine";
import { turnDiff } from "./diff";
import * as mk from "./items";
import type { Question } from "./items";

/** Thrown out of a script when its turn is interrupted. */
export class Cancelled extends Error {}

export type Script = (run: Run) => Promise<void>;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

/**
 * One scripted turn, live: the primitives a script uses to stream reasoning and replies, run
 * commands, edit files and ask for approval, each emitted as the notifications and requests the
 * real engines send. Every change lands in the thread's stored history first, so a transcript
 * fetched mid-turn (or after a reload) matches what streamed.
 */
export class Run {
  private cancelled = false;
  private seq = 0;
  private cancelRequest: (() => void) | null = null;
  /** Messages steered into the turn, not yet acknowledged. */
  readonly steers: string[] = [];
  plan: TurnPlanStep[] | null = null;

  constructor(
    readonly engine: DemoEngine,
    readonly t: DemoThread,
    readonly turn: Turn,
  ) {
    this.seq = turn.items.length;
    this.plan = t.plans[turn.id] ?? null;
  }

  get codex() {
    return this.t.provider === "codex";
  }
  get cwd() {
    return this.t.meta.cwd;
  }
  get threadId() {
    return this.t.meta.id;
  }
  get fs() {
    return this.engine.world.fs;
  }

  id(kind: string) {
    return `${this.turn.id}-${kind}${++this.seq}`;
  }

  async sleep(ms: number) {
    if (this.cancelled) throw new Cancelled();
    await new Promise((r) => setTimeout(r, ms));
    if (this.cancelled) throw new Cancelled();
  }

  cancel() {
    this.cancelled = true;
    this.cancelRequest?.();
  }

  // ---- item plumbing --------------------------------------------------------

  private store(item: ThreadItem) {
    const i = this.turn.items.findIndex((x) => x.id === item.id);
    if (i >= 0) this.turn.items[i] = item;
    else this.turn.items.push(item);
  }

  /** Record an item and tell the client. */
  emit(method: "item/started" | "item/completed", item: ThreadItem) {
    this.store(item);
    this.engine.touch(this.t);
    const at = Date.now();
    this.engine.notifyThread(this.t, method, { threadId: this.threadId, turnId: this.turn.id, item, ...(method === "item/started" ? { startedAtMs: at } : { completedAtMs: at }) });
  }

  private delta(method: string, params: Record<string, unknown>) {
    this.engine.notifyThread(this.t, method, { threadId: this.threadId, turnId: this.turn.id, ...params });
  }

  // ---- steps ----------------------------------------------------------------

  /** Acknowledge anything steered into the turn since the last step. */
  async checkpoint() {
    while (this.steers.length) {
      const s = this.steers.shift()!;
      await this.say(`Got it: “${clip(s.replace(/\s+/g, " "), 90)}”. Taking that into account as I go.`, "commentary", true);
    }
  }

  /** Stream a reasoning summary ("**Heading**\n\nbody" for Codex, plain thinking for Claude Code). */
  async think(text: string) {
    await this.checkpoint();
    const item = mk.reasoning(this.id("r"), "") as Extract<ThreadItem, { type: "reasoning" }>;
    this.emit("item/started", item);
    let acc = "";
    for (const chunk of chunks(text, 5)) {
      await this.sleep(26);
      acc += chunk;
      this.store({ ...item, summary: [acc] });
      this.delta("item/reasoning/summaryTextDelta", { itemId: item.id, delta: chunk, summaryIndex: 0 });
    }
    await this.sleep(220);
    this.emit("item/completed", { ...item, summary: [acc] });
  }

  /** Stream a message. Codex marks interim messages "commentary" and the last one "final_answer". */
  async say(text: string, phase: "commentary" | "final_answer" = "final_answer", skipCheckpoint = false) {
    if (!skipCheckpoint) await this.checkpoint();
    const id = this.id("m");
    const p = this.codex ? phase : null;
    this.emit("item/started", mk.agentMessage(id, "", p));
    let acc = "";
    const size = Math.max(3, Math.ceil(text.length / 260));
    try {
      for (const chunk of chunks(text, size)) {
        await this.sleep(24);
        acc += chunk;
        this.store(mk.agentMessage(id, acc, p));
        this.delta("item/agentMessage/delta", { itemId: id, delta: chunk });
      }
    } finally {
      // Cut off by an interrupt: what streamed so far stands.
      this.emit("item/completed", mk.agentMessage(id, acc, p));
    }
    await this.sleep(160);
  }

  async read(rel: string, ms = 380) {
    await this.checkpoint();
    const item = mk.read(this.t.provider, this.id("c"), this.cwd, rel, this.fs.read(mk.abs(this.cwd, rel)) ?? "");
    this.emit("item/started", { ...item, status: "inProgress", aggregatedOutput: null, exitCode: null, durationMs: null });
    await this.sleep(ms);
    this.emit("item/completed", item);
  }

  /** Search the project's files for real. */
  async search(query: string, rel: string | null = null, ms = 450) {
    await this.checkpoint();
    const root = mk.abs(this.cwd, rel ?? "").replace(/\/$/, "");
    const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const hits: string[] = [];
    for (const f of this.fs.walk(root)) {
      if (f.includes("/node_modules/")) continue;
      (this.fs.read(f) ?? "").split("\n").forEach((line, i) => {
        if (re.test(line) && hits.length < 40) hits.push(`${f.slice(this.cwd.length + 1)}:${i + 1}:${line.trim()}`);
      });
    }
    const item = mk.search(this.t.provider, this.id("c"), this.cwd, query, rel, hits.join("\n"));
    this.emit("item/started", { ...item, status: "inProgress", aggregatedOutput: null, exitCode: null });
    await this.sleep(ms);
    this.emit("item/completed", { ...item, durationMs: ms });
  }

  /** Run a command, streaming its output over `ms`. */
  async run(cmd: string, output: string, opts: { exit?: number; ms?: number; itemId?: string } = {}) {
    await this.checkpoint();
    const ms = opts.ms ?? 900;
    const exit = opts.exit ?? 0;
    const id = opts.itemId ?? this.id("c");
    this.emit("item/started", mk.run(id, this.cwd, cmd, "", { exit: null, status: "inProgress" }));
    const lines = output ? output.split(/(?<=\n)/) : [];
    const step = Math.max(40, Math.floor(ms / Math.max(1, lines.length)));
    let acc = "";
    const started = Date.now();
    try {
      for (const line of lines) {
        await this.sleep(step);
        acc += line;
        this.store(mk.run(id, this.cwd, cmd, acc, { exit: null, status: "inProgress" }));
        this.delta("item/commandExecution/outputDelta", { itemId: id, delta: line });
      }
      if (!lines.length) await this.sleep(ms);
    } catch (err) {
      this.emit("item/completed", mk.run(id, this.cwd, cmd, acc, { exit: null, status: "failed", ms: Date.now() - started }));
      throw err;
    }
    this.emit("item/completed", mk.run(id, this.cwd, cmd, output, { exit, ms: Date.now() - started }));
    await this.sleep(200);
  }

  /** Write files (null removes one): updates the disk, then shows the edit. */
  async write(changes: { rel: string; after: string | null }[], ms = 500) {
    await this.checkpoint();
    const full = changes.map((c) => ({ rel: c.rel, before: this.fs.read(mk.abs(this.cwd, c.rel)), after: c.after }));
    const id = this.id("f");
    this.emit("item/started", mk.fileChange(id, this.cwd, full, "inProgress"));
    await this.sleep(ms);
    for (const c of full) {
      const path = mk.abs(this.cwd, c.rel);
      if (c.after == null) this.fs.remove(path);
      else this.fs.write(path, c.after);
    }
    this.emit("item/completed", mk.fileChange(id, this.cwd, full));
    if (this.codex) this.engine.notifyThread(this.t, "turn/diff/updated", { threadId: this.threadId, turnId: this.turn.id, diff: this.diff() });
    await this.sleep(240);
  }

  /** Replace text in a file (no-op edits are skipped). */
  async edit(rel: string, find: string | RegExp, replace: string) {
    const cur = this.fs.read(mk.abs(this.cwd, rel)) ?? "";
    const next = cur.replace(find, replace);
    if (next !== cur) await this.write([{ rel, after: next }]);
  }

  /** Everything the turn has changed so far, as one diff. */
  diff(): string {
    return turnDiff(this.turn.items, this.cwd);
  }

  /** The turn's checklist (Codex's update_plan, Claude Code's TodoWrite). */
  setPlan(steps: [string, TurnPlanStep["status"]][]) {
    this.plan = steps.map(([step, status]) => ({ step, status }));
    this.t.plans[this.turn.id] = this.plan;
    this.engine.notifyThread(this.t, "turn/plan/updated", { threadId: this.threadId, turnId: this.turn.id, explanation: null, plan: this.plan });
  }

  /** Mark plan steps done up to `index`, and that one in progress. */
  progress(index: number) {
    if (!this.plan) return;
    this.setPlan(this.plan.map((s, i) => [s.step, i < index ? "completed" : i === index ? "inProgress" : "pending"]));
  }

  /** Ask before running a command. Resolves with the decision ("accept", "acceptForSession", "decline"). */
  async approve(cmd: string, reason: string, itemId = this.id("c")): Promise<string> {
    await this.checkpoint();
    if (!this.codex) this.emit("item/started", mk.run(itemId, this.cwd, cmd, null, { exit: null, status: "inProgress" }));
    const reply = await this.ask_("item/commandExecution/requestApproval", {
      itemId,
      startedAtMs: Date.now(),
      kind: "command",
      command: cmd,
      cwd: this.cwd,
      reason,
      commandActions: [{ type: "unknown", command: cmd }],
      environmentId: null,
      ...(this.codex ? { proposedExecpolicyAmendment: cmd.split(" ").slice(0, 2) } : {}),
    });
    const d = reply?.decision;
    if (d === "cancel" || reply == null) {
      this.cancelled = true;
      throw new Cancelled();
    }
    return typeof d === "string" ? d : "accept";
  }

  /** Ask the user (Claude Code's AskUserQuestion / Codex's request_user_input). Null when skipped. */
  async ask(questions: Question[], itemId = this.id("q")): Promise<string[] | null> {
    await this.checkpoint();
    if (!this.codex && !this.turn.items.some((i) => i.id === itemId)) this.emit("item/started", mk.asked(itemId, questions, null));
    const reply = await this.ask_("item/tool/requestUserInput", {
      itemId,
      isBlocking: true,
      autoResolutionMs: null,
      questions: questions.map((q, i) => ({
        id: String(i),
        header: q.header,
        question: q.question,
        isOther: true,
        isSecret: false,
        options: q.options,
      })),
    });
    if (reply == null) {
      this.cancelled = true;
      throw new Cancelled();
    }
    const answers = questions.map((_, i) => ((reply.answers?.[String(i)]?.answers ?? []) as string[]).join(", "));
    const any = answers.some((a) => a.trim());
    if (!this.codex) this.emit("item/completed", mk.asked(itemId, questions, any ? answers : questions.map(() => "(skipped)")));
    await this.sleep(300);
    return any ? answers : null;
  }

  private async ask_(method: string, params: Record<string, unknown>): Promise<any> {
    const req = this.engine.request(this.t, method, { threadId: this.threadId, turnId: this.turn.id, ...params });
    this.cancelRequest = req.cancel;
    try {
      return await req.promise;
    } finally {
      this.cancelRequest = null;
    }
  }

  /** A plan proposed in Plan mode, with "Implement this plan" under it. */
  async proposePlan(text: string) {
    await this.checkpoint();
    const id = this.id("p");
    if (!this.codex) {
      await this.sleep(300);
      this.emit("item/completed", mk.plan(id, text));
      return;
    }
    this.emit("item/started", mk.plan(id, ""));
    let acc = "";
    for (const chunk of chunks(text, Math.max(4, Math.ceil(text.length / 220)))) {
      await this.sleep(24);
      acc += chunk;
      this.store(mk.plan(id, acc));
      this.delta("item/plan/delta", { itemId: id, delta: chunk });
    }
    this.emit("item/completed", mk.plan(id, text));
  }

  /** Close out anything still running when the turn ends early. */
  settle() {
    for (const item of this.turn.items) {
      if (item.type === "commandExecution" && item.status === "inProgress") this.emit("item/completed", { ...item, status: "failed", exitCode: null });
      else if (item.type === "fileChange" && item.status === "inProgress") this.emit("item/completed", { ...item, status: "failed" });
      else if (item.type === "dynamicToolCall" && item.status === "inProgress") this.emit("item/completed", { ...item, status: "failed", success: false });
    }
  }
}

/** Split text into small pieces for streaming, preferring to break after spaces. */
function chunks(text: string, size: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(text.length, i + size + Math.floor(Math.random() * size));
    const space = text.indexOf(" ", end);
    if (space > 0 && space - end < 4) end = space + 1;
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}
