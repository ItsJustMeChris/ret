import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Worker } from "node:worker_threads";
import type { UsageActivity, UsageDay } from "../shared/protocol";

/**
 * What the agents did each day, from their transcripts on this computer: tokens by model, and
 * the prompts the user sent by hour (`ret/usage/activity`). Claude Code keeps no tally of its
 * own, so this is also its `account/usage/read`. Codex's server has daily tokens (across every
 * device) but no split by model and no prompts, so for Codex this reads its rollouts for those.
 *
 * Every API response's usage is in a transcript, subagents' included, so the sums cover the agent
 * used anywhere on this machine, not just in Ret. A first read goes through every transcript of
 * the past year (often gigabytes), so it runs on a worker thread that reports running totals as
 * it goes; later reads pick up only what was appended.
 *
 * Claude Code prunes transcripts after 30 days by default. For it, the days read are kept in a
 * history file and merged back in, so the record grows past what the transcripts still hold.
 */

const DAYS = 365;

export type UsageSource = "claude" | "codex";

type WorkerMessage = { activity: UsageActivity; done: boolean } | { error: string };

export class LocalUsage {
  private worker: Worker | null = null;
  private reading: Promise<UsageActivity> | null = null;
  private kept: Promise<Record<string, UsageDay>> | null = null;
  private written = "";

  constructor(
    private readonly source: UsageSource,
    /** The folders the transcripts are under. */
    private readonly roots: () => string[],
    /** Where days read are kept, for a source that prunes its transcripts; null to keep none. */
    private readonly historyFile: string | null,
    /** Running totals while a read is underway. */
    private readonly onProgress: (activity: UsageActivity) => void,
  ) {}

  /** Each local day of the past year, oldest first; days with nothing are left out. */
  read(): Promise<UsageActivity> {
    this.reading ??= this.readOnce().finally(() => (this.reading = null));
    return this.reading;
  }

  private async readOnce(): Promise<UsageActivity> {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - (DAYS - 1));
    const first = localDay(since);
    const kept = await this.history();
    const read = await new Promise<UsageActivity>((resolve, reject) => {
      const w = (this.worker ??= startWorker());
      const finish = (err: Error | null, activity: UsageActivity = { days: {} }) => {
        w.off("message", onMessage).off("error", finish).off("exit", onExit);
        if (!err) return resolve(activity);
        this.worker = null;
        void w.terminate();
        reject(err);
      };
      const onMessage = (m: WorkerMessage) => {
        if ("error" in m) finish(new Error(m.error));
        else if (m.done) finish(null, m.activity);
        else this.onProgress(merge(kept, m.activity.days, first));
      };
      const onExit = () => finish(new Error("The usage reader stopped"));
      w.on("message", onMessage).on("error", finish).on("exit", onExit);
      w.postMessage({ source: this.source, roots: this.roots(), since: since.getTime() });
    });
    const activity = merge(kept, read.days, first);
    if (this.historyFile) {
      Object.assign(kept, activity.days);
      await this.keep(activity);
    }
    return activity;
  }

  /** The days kept from earlier reads (none without a history file). */
  private history(): Promise<Record<string, UsageDay>> {
    this.kept ??= (async () => {
      if (!this.historyFile) return {};
      try {
        const saved = JSON.parse(await readFile(this.historyFile, "utf8")) as { days?: Record<string, UsageDay> };
        return saved.days && typeof saved.days === "object" ? saved.days : {};
      } catch {
        return {};
      }
    })();
    return this.kept;
  }

  private async keep(activity: UsageActivity) {
    const text = JSON.stringify({ days: activity.days });
    if (text === this.written) return;
    try {
      await mkdir(dirname(this.historyFile!), { recursive: true });
      await writeFile(this.historyFile!, text);
      this.written = text;
    } catch (err) {
      console.warn("Couldn't keep usage history", err);
    }
  }
}

/** Tokens per day, as `account/usage/read` buckets them. */
export function dailyBuckets(activity: UsageActivity): { startDate: string; tokens: number }[] {
  return Object.entries(activity.days)
    .filter(([, d]) => d.tokens > 0)
    .map(([startDate, d]) => ({ startDate, tokens: d.tokens }));
}

/**
 * The days from `first` on, each from whichever record saw more of it: transcripts only lose
 * what they held by being pruned, so the larger count is the more complete one.
 */
function merge(kept: Record<string, UsageDay>, read: Record<string, UsageDay>, first: string): UsageActivity {
  const days: Record<string, UsageDay> = {};
  for (const [day, d] of Object.entries(kept)) if (day >= first) days[day] = d;
  for (const [day, d] of Object.entries(read)) {
    const k = days[day];
    if (!k || d.tokens > k.tokens || (d.tokens === k.tokens && d.prompts >= k.prompts)) days[day] = d;
  }
  return { days: Object.fromEntries(Object.entries(days).sort(([a], [b]) => (a < b ? -1 : 1))) };
}

function localDay(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function startWorker() {
  // Started from the reader's own source: no second bundle to build and ship next to main.
  const w = new Worker(`(${reader})()`, { eval: true });
  w.unref();
  return w;
}

/**
 * The worker thread. It runs from this function's source text, so it uses nothing from outside
 * it but what it requires. Each request names the source, its transcript folders and the window's
 * first instant; it answers with running totals every so often, then the final ones.
 */
function reader() {
  const { parentPort } = require("node:worker_threads") as typeof import("node:worker_threads");
  const { open, readdir, stat } = require("node:fs/promises") as typeof import("node:fs/promises");
  const { join } = require("node:path") as typeof import("node:path");

  const CHUNK = 4 * 1024 * 1024;
  const PROGRESS_MS = 120;
  /** Claude Code lines worth parsing mention one of these: responses carry usage, prompts their origin. */
  const MARKS = [Buffer.from('"usage"'), Buffer.from('"human"')];
  /** A Codex line's type comes first: `{"timestamp":…,"type":"event_msg","payload":{"type":"token_count",…`. */
  const HEAD = 200;
  const WANTED = /"type":"(?:session_meta"|turn_context"|event_msg","payload":\{"type":"(?:task_started|token_count)")/;
  /** Codex turns that someone other than the user started. */
  const NOT_USER = /resume|tool|agent|goal|schedul|automat|hook|retry/i;

  /** One API response: its tokens and model, on the local day it happened. */
  type Response = { day: string; model: string; tokens: number };
  /** One prompt the user sent: its local day and hour. */
  type Prompt = { day: string; hour: number };
  /** What a Codex rollout has said so far that later lines depend on. */
  type Context = { meta: boolean; subagent: boolean; turn: string | null; model: string | null };
  /** What a transcript has said so far. Transcripts only grow, so later reads start at `offset`. */
  type FileScan = { size: number; offset: number; responses: Map<string, Response>; prompts: Map<string, Prompt>; context: Context };
  type Source = "claude" | "codex";

  const files = new Map<string, FileScan>();
  const pad = (n: number) => String(n).padStart(2, "0");
  const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  /**
   * Every transcript under a folder: Claude Code's sessions (`<project>/<id>.jsonl`) and their
   * subagents' (`<project>/<id>/subagents/…`); Codex's rollouts (`YYYY/MM/DD/rollout-….jsonl`).
   */
  async function transcripts(dir: string, depth = 0): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, e.name);
      if (e.isDirectory() && depth < 3) out.push(...(await transcripts(path, depth + 1)));
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(path);
    }
    return out;
  }

  /**
   * Notes what the complete lines of [from, to) say; returns where the next read starts. Only
   * lines that could matter are parsed: for Claude Code, ones that mention a mark; for Codex, ones
   * whose type is wanted, which is known from the line's start, so the rest (a long tool output,
   * often megabytes) is skipped without being held.
   */
  async function readLines(source: Source, path: string, scan: FileScan, from: number, to: number): Promise<number> {
    const fh = await open(path, "r");
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      let pos = from;
      let rest = Buffer.alloc(0);
      /** Where the unwanted line being skipped starts, or -1. */
      let skipping = -1;
      while (pos < to) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, to - pos), pos);
        if (!bytesRead) break;
        const base = pos - rest.length;
        pos += bytesRead;
        const data = rest.length ? Buffer.concat([rest, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        let start = 0;
        if (skipping !== -1) {
          const nl = data.indexOf(10);
          if (nl === -1) continue;
          skipping = -1;
          start = nl + 1;
        }
        const at = MARKS.map((m) => data.indexOf(m, start));
        for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
          let wanted = false;
          if (source === "claude") {
            for (let i = 0; i < at.length; i++) {
              if (at[i] === -1 || at[i] > nl) continue;
              wanted = true;
              at[i] = data.indexOf(MARKS[i], nl + 1);
            }
          } else wanted = WANTED.test(data.toString("latin1", start, Math.min(nl, start + HEAD)));
          if (wanted) noteLine(source, path, data.toString("utf8", start, nl), scan);
          start = nl + 1;
        }
        if (source === "codex" && data.length - start >= HEAD && !WANTED.test(data.toString("latin1", start, start + HEAD))) {
          skipping = base + start;
          rest = Buffer.alloc(0);
        } else rest = Buffer.from(data.subarray(start));
      }
      // A line still being skipped is read again from its start next time, once it's complete.
      return skipping !== -1 ? skipping : pos - rest.length;
    } finally {
      await fh.close();
    }
  }

  function noteLine(source: Source, path: string, line: string, scan: FileScan) {
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    if (!o || typeof o !== "object") return;
    if (source === "claude") noteClaude(o, scan);
    else noteCodex(o, path, scan);
  }

  function when(timestamp: unknown): Date | null {
    if (typeof timestamp !== "string") return null;
    const at = new Date(timestamp);
    return Number.isNaN(at.getTime()) ? null : at;
  }

  function noteResponse(scan: FileScan, key: string, at: Date, model: string, tokens: number) {
    if ((scan.responses.get(key)?.tokens ?? 0) < tokens) scan.responses.set(key, { day: localDay(at), model, tokens });
  }

  function noteClaude(o: any, scan: FileScan) {
    const at = when(o.timestamp);
    if (!at) return;
    if (o.type === "assistant") {
      const u = o.message?.usage;
      if (!u) return;
      const tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
      if (!tokens) return;
      // A response is stored once per content block, each line repeating its usage.
      noteResponse(scan, `${o.message.id ?? o.uuid}:${o.requestId ?? ""}`, at, typeof o.message.model === "string" ? o.message.model : "unknown", tokens);
    } else if (o.type === "user" && o.origin?.kind === "human" && !o.isSidechain && !o.isMeta) {
      scan.prompts.set(o.uuid ?? `${o.sessionId}:${o.timestamp}`, { day: localDay(at), hour: at.getHours() });
    }
  }

  function noteCodex(o: any, path: string, scan: FileScan) {
    const p = o.payload;
    const c = scan.context;
    if (!p || typeof p !== "object") return;
    if (o.type === "session_meta") {
      // The rollout's own, first; a fork also carries copies of where it came from.
      if (!c.meta) c.subagent = !!(p.source && typeof p.source === "object" && p.source.subagent);
      c.meta = true;
      return;
    }
    if (o.type === "turn_context") {
      if (typeof p.turn_id === "string") c.turn = p.turn_id;
      if (typeof p.model === "string") c.model = p.model;
      return;
    }
    const at = when(o.timestamp);
    if (!at) return;
    if (p.type === "task_started") {
      if (typeof p.turn_id === "string") c.turn = p.turn_id;
      const trigger = p.turn_attribution?.turn_trigger;
      if (c.subagent || (typeof trigger === "string" && NOT_USER.test(trigger))) return;
      scan.prompts.set(c.turn ?? `${path}:${o.timestamp}`, { day: localDay(at), hour: at.getHours() });
    } else if (p.type === "token_count") {
      const last = p.info?.last_token_usage?.total_tokens;
      const total = p.info?.total_token_usage?.total_tokens;
      if (typeof last !== "number" || !last || typeof total !== "number") return;
      // Sent again unchanged (and copied into forks), the thread's running total keeps each response's count once.
      noteResponse(scan, `${c.turn ?? path}:${total}`, at, c.model ?? "unknown", last);
    }
  }

  function totals(first: string) {
    // A resumed or forked session copies earlier lines into its new transcript; count each once.
    const responses = new Map<string, Response>();
    const prompts = new Map<string, Prompt>();
    for (const scan of files.values()) {
      for (const [key, r] of scan.responses) if (r.day >= first && (responses.get(key)?.tokens ?? 0) < r.tokens) responses.set(key, r);
      for (const [key, p] of scan.prompts) if (p.day >= first) prompts.set(key, p);
    }
    const days: Record<string, { tokens: number; models: Record<string, number>; prompts: number; hours: number[] }> = {};
    const day = (d: string) => (days[d] ??= { tokens: 0, models: {}, prompts: 0, hours: new Array(24).fill(0) });
    for (const r of responses.values()) {
      const d = day(r.day);
      d.tokens += r.tokens;
      d.models[r.model] = (d.models[r.model] ?? 0) + r.tokens;
    }
    for (const p of prompts.values()) {
      const d = day(p.day);
      d.prompts++;
      d.hours[p.hour]++;
    }
    return { days };
  }

  async function read(source: Source, roots: string[], since: number) {
    const first = localDay(new Date(since));
    const paths = (await Promise.all(roots.map((r) => transcripts(r)))).flat();
    const found = await Promise.all(paths.map(async (path) => ({ path, st: await stat(path).catch(() => null) })));
    // Untouched since before the window: nothing in it can count. Newest first, so recent days fill in first.
    const live = found.filter((f) => f.st && f.st.mtimeMs >= since).sort((a, b) => b.st!.mtimeMs - a.st!.mtimeMs);
    const seen = new Set(live.map((f) => f.path));
    for (const path of files.keys()) if (!seen.has(path)) files.delete(path);
    let posted = Date.now();
    for (const { path, st } of live) {
      const prev = files.get(path);
      if (prev?.size === st!.size) continue;
      // Shorter than last time: rewritten, so start over.
      const scan: FileScan =
        prev && st!.size > prev.size
          ? prev
          : { size: 0, offset: 0, responses: new Map(), prompts: new Map(), context: { meta: false, subagent: false, turn: null, model: null } };
      scan.offset = await readLines(source, path, scan, scan.offset, st!.size).catch(() => scan.offset);
      scan.size = st!.size;
      files.set(path, scan);
      if (Date.now() - posted > PROGRESS_MS) {
        parentPort!.postMessage({ activity: totals(first), done: false });
        posted = Date.now();
      }
    }
    parentPort!.postMessage({ activity: totals(first), done: true });
  }

  parentPort!.on("message", ({ source, roots, since }: { source: Source; roots: string[]; since: number }) => {
    read(source, roots, since).catch((err) => parentPort!.postMessage({ error: String(err?.message ?? err) }));
  });
}
