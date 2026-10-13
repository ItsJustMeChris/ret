import { join } from "node:path";
import { Worker } from "node:worker_threads";

/**
 * Daily token totals from Claude Code's transcripts, the answer to `account/usage/read` (Codex
 * gets it from its server; Claude Code keeps no such tally). Every API response's usage is in a
 * transcript under `<config>/projects/`, subagents' included, so the sum covers Claude Code used
 * anywhere on this machine, not just in Ret. Claude Code prunes transcripts after 30 days by
 * default, which is the window reported.
 *
 * A first read goes through every transcript (often a gigabyte or more), so it runs on a worker
 * thread that reports running totals as it goes; later reads pick up only what was appended.
 */

const DAYS = 30;

export interface DailyTokens {
  startDate: string;
  tokens: number;
}

type WorkerMessage = { days: DailyTokens[]; done: boolean } | { error: string };

export class TranscriptUsage {
  private worker: Worker | null = null;
  private reading: Promise<DailyTokens[]> | null = null;

  constructor(
    private readonly configDir: () => string,
    /** Running totals while a read is underway. */
    private readonly onProgress: (days: DailyTokens[]) => void,
  ) {}

  /** Tokens per local day over the last 30 days, oldest first; days with none are left out. */
  daily(): Promise<DailyTokens[]> {
    this.reading ??= new Promise<DailyTokens[]>((resolve, reject) => {
      const w = (this.worker ??= startWorker());
      const finish = (err: Error | null, days: DailyTokens[] = []) => {
        w.off("message", onMessage).off("error", finish).off("exit", onExit);
        if (!err) return resolve(days);
        this.worker = null;
        void w.terminate();
        reject(err);
      };
      const onMessage = (m: WorkerMessage) => {
        if ("error" in m) finish(new Error(m.error));
        else if (m.done) finish(null, m.days);
        else this.onProgress(m.days);
      };
      const onExit = () => finish(new Error("The usage reader stopped"));
      w.on("message", onMessage).on("error", finish).on("exit", onExit);
      const since = new Date();
      since.setHours(0, 0, 0, 0);
      since.setDate(since.getDate() - (DAYS - 1));
      w.postMessage({ dir: join(this.configDir(), "projects"), since: since.getTime() });
    }).finally(() => (this.reading = null));
    return this.reading;
  }
}

function startWorker() {
  // Started from the reader's own source: no second bundle to build and ship next to main.
  const w = new Worker(`(${reader})()`, { eval: true });
  w.unref();
  return w;
}

/**
 * The worker thread. It runs from this function's source text, so it uses nothing from outside
 * it but what it requires. Each request names the transcripts folder and the window's first
 * instant; it answers with running totals every so often, then the final ones.
 */
function reader() {
  const { parentPort } = require("node:worker_threads") as typeof import("node:worker_threads");
  const { open, readdir, stat } = require("node:fs/promises") as typeof import("node:fs/promises");
  const { join } = require("node:path") as typeof import("node:path");

  const CHUNK = 4 * 1024 * 1024;
  const PROGRESS_MS = 120;
  const MARK = Buffer.from('"usage"');

  /** One API response: its tokens, on the local day it happened. */
  type Response = { day: string; tokens: number };
  /** What a transcript has said so far. Transcripts only grow, so later reads start at `offset`. */
  type FileScan = { size: number; offset: number; responses: Map<string, Response> };

  const files = new Map<string, FileScan>();
  const pad = (n: number) => String(n).padStart(2, "0");
  const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  /** Every transcript: sessions (`<project>/<id>.jsonl`) and their subagents' (`<project>/<id>/subagents/…`). */
  async function transcripts(dir: string, depth = 0): Promise<string[]> {
    const out: string[] = [];
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, e.name);
      if (e.isDirectory() && depth < 3) out.push(...(await transcripts(path, depth + 1)));
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(path);
    }
    return out;
  }

  /** Records each assistant response's usage in the complete lines of [from, to); returns where the next read starts. */
  async function readUsage(path: string, from: number, to: number, responses: Map<string, Response>): Promise<number> {
    const fh = await open(path, "r");
    try {
      const buf = Buffer.allocUnsafe(CHUNK);
      let pos = from;
      let rest = Buffer.alloc(0);
      while (pos < to) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, to - pos), pos);
        if (!bytesRead) break;
        pos += bytesRead;
        const data = rest.length ? Buffer.concat([rest, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        let start = 0;
        // Only lines that mention usage are worth parsing.
        let mark = data.indexOf(MARK);
        for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
          if (mark !== -1 && mark < nl) {
            noteLine(data.toString("utf8", start, nl), responses);
            mark = data.indexOf(MARK, nl + 1);
          }
          start = nl + 1;
        }
        rest = Buffer.from(data.subarray(start));
      }
      return pos - rest.length;
    } finally {
      await fh.close();
    }
  }

  function noteLine(line: string, responses: Map<string, Response>) {
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    const u = o?.message?.usage;
    if (o.type !== "assistant" || !u || typeof o.timestamp !== "string") return;
    const tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0);
    const at = new Date(o.timestamp);
    if (!tokens || Number.isNaN(at.getTime())) return;
    // A response is stored once per content block, each line repeating its usage.
    const key = `${o.message.id ?? o.uuid}:${o.requestId ?? ""}`;
    if ((responses.get(key)?.tokens ?? 0) < tokens) responses.set(key, { day: localDay(at), tokens });
  }

  function totals(first: string) {
    // A resumed or forked session copies earlier responses into its new transcript; count each once.
    const responses = new Map<string, Response>();
    for (const scan of files.values())
      for (const [key, r] of scan.responses) if (r.day >= first && (responses.get(key)?.tokens ?? 0) < r.tokens) responses.set(key, r);
    const days = new Map<string, number>();
    for (const r of responses.values()) days.set(r.day, (days.get(r.day) ?? 0) + r.tokens);
    return [...days].sort(([a], [b]) => (a < b ? -1 : 1)).map(([startDate, tokens]) => ({ startDate, tokens }));
  }

  async function read(dir: string, since: number) {
    const first = localDay(new Date(since));
    const found = await Promise.all((await transcripts(dir)).map(async (path) => ({ path, st: await stat(path).catch(() => null) })));
    // Untouched since before the window: nothing in it can count. Newest first, so recent days fill in first.
    const live = found.filter((f) => f.st && f.st.mtimeMs >= since).sort((a, b) => b.st!.mtimeMs - a.st!.mtimeMs);
    const seen = new Set(live.map((f) => f.path));
    for (const path of files.keys()) if (!seen.has(path)) files.delete(path);
    let posted = Date.now();
    for (const { path, st } of live) {
      const prev = files.get(path);
      if (prev?.size === st!.size) continue;
      // Shorter than last time: rewritten, so start over.
      const scan = prev && st!.size > prev.size ? prev : { size: 0, offset: 0, responses: new Map<string, Response>() };
      scan.offset = await readUsage(path, scan.offset, st!.size, scan.responses).catch(() => scan.offset);
      scan.size = st!.size;
      files.set(path, scan);
      if (Date.now() - posted > PROGRESS_MS) {
        parentPort!.postMessage({ days: totals(first), done: false });
        posted = Date.now();
      }
    }
    parentPort!.postMessage({ days: totals(first), done: true });
  }

  parentPort!.on("message", ({ dir, since }: { dir: string; since: number }) => {
    read(dir, since).catch((err) => parentPort!.postMessage({ error: String(err?.message ?? err) }));
  });
}
