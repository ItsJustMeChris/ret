import type { ProviderId } from "@shared/bridge";
import type { Turn, TurnPlanStep } from "@shared/protocol";
import * as mk from "./items";
import type { Change, Question } from "./items";

/**
 * A compact way to write a thread's past: turns of steps, each becoming the item its engine
 * would have recorded (see items.ts). Times are seconds since the epoch.
 */
export class TurnBuilder {
  readonly items: Turn["items"] = [];
  private n = 0;

  constructor(
    readonly provider: ProviderId,
    readonly cwd: string,
    private readonly prefix: string,
  ) {}

  private id() {
    return `${this.prefix}-i${++this.n}`;
  }

  user(text: string) {
    this.items.push(mk.userMessage(this.id(), text));
    return this;
  }
  think(text: string) {
    this.items.push(mk.reasoning(this.id(), text));
    return this;
  }
  read(rel: string, text: string) {
    this.items.push(mk.read(this.provider, this.id(), this.cwd, rel, text));
    return this;
  }
  search(query: string, rel: string | null, output: string) {
    this.items.push(mk.search(this.provider, this.id(), this.cwd, query, rel, output));
    return this;
  }
  list(rel: string, output: string) {
    this.items.push(mk.listFiles(this.provider, this.id(), this.cwd, rel, output));
    return this;
  }
  run(cmd: string, output: string, opts: { exit?: number; ms?: number } = {}) {
    this.items.push(mk.run(this.id(), this.cwd, cmd, output, { exit: opts.exit ?? 0, ms: opts.ms ?? 1200 }));
    return this;
  }
  say(text: string, phase: "commentary" | "final_answer" = "final_answer") {
    this.items.push(mk.agentMessage(this.id(), text, this.provider === "codex" ? phase : null));
    return this;
  }
  change(...changes: Change[]) {
    this.items.push(mk.fileChange(this.id(), this.cwd, changes));
    return this;
  }
  /** An open question (Claude Code's AskUserQuestion), still waiting when `answers` is null. */
  asked(questions: Question[], answers: string[] | null): string {
    const id = this.id();
    this.items.push(mk.asked(id, questions, answers));
    return id;
  }
}

export interface TurnSpec {
  at: number;
  /** Seconds it took; null while still running. */
  took: number | null;
  status?: Turn["status"];
  error?: string;
  plan?: [string, TurnPlanStep["status"]][];
  build: (b: TurnBuilder) => void;
}

export function buildTurns(provider: ProviderId, threadId: string, cwd: string, specs: TurnSpec[]): { turns: Turn[]; plans: Record<string, TurnPlanStep[]> } {
  const plans: Record<string, TurnPlanStep[]> = {};
  const turns = specs.map((s, i) => {
    const id = `${threadId.slice(0, 8)}-t${i + 1}`;
    const b = new TurnBuilder(provider, cwd, id);
    s.build(b);
    if (s.plan) plans[id] = s.plan.map(([step, status]) => ({ step, status }));
    const running = s.took == null;
    const turn: Turn = {
      id,
      rootTurnId: null,
      items: b.items,
      itemsView: "full",
      status: s.status ?? (running ? "inProgress" : "completed"),
      error: s.error ? { message: s.error, codexErrorInfo: null, additionalDetails: null, misalignment: null } : null,
      startedAt: s.at,
      completedAt: running ? null : s.at + (s.took ?? 0),
      durationMs: running ? null : (s.took ?? 0) * 1000,
    };
    return turn;
  });
  return { turns, plans };
}
