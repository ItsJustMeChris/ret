import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { BackgroundTask } from "../../shared/protocol";

/** What kind of work a Claude Code task type is (`local_bash`, `local_agent`, `local_workflow`, a monitor…). */
export function kindOf(taskType: unknown): BackgroundTask["kind"] {
  const t = String(taskType ?? "").toLowerCase();
  if (t.includes("bash") || t.includes("shell")) return "shell";
  if (t.includes("agent")) return "agent";
  if (t.includes("monitor") || t.includes("watch")) return "monitor";
  if (t.includes("workflow")) return "workflow";
  return "task";
}

export function sameTasks(a: BackgroundTask[], b: BackgroundTask[]): boolean {
  return a.length === b.length && a.every((t, i) => t.id === b[i].id && t.description === b[i].description && t.kind === b[i].kind);
}

/**
 * How Claude Code words a background launch: the start of the tool result, from the tool that
 * launches that kind of task. (Anywhere else, it's output that merely quotes one, say a grep.)
 */
const LAUNCHES: { tools: RegExp; re: RegExp; kind: BackgroundTask["kind"] }[] = [
  { tools: /^(Bash|PowerShell)$/, re: /^Command running in background with ID: (\w+)/, kind: "shell" },
  { tools: /^(Bash|PowerShell)$/, re: /^Command did not complete[^\n]*?moved to the background \(ID: (\w+)\)/, kind: "shell" },
  { tools: /^(Agent|Task)$/, re: /^Async agent launched successfully[\s\S]*?agentId: (\w+)/, kind: "agent" },
  { tools: /^Monitor$/, re: /^Monitor started \(task (\w+)/, kind: "monitor" },
];
const STOPS = /^(TaskStop|KillShell|KillBash)$/;
const STOPPED = /Successfully stopped task: (\w+)/;
const NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g;
/** A notification that ends its task: a final status, or a monitor's last word. */
const ENDS = /<status>(?:completed|failed|killed|stopped)<\/status>|<event>\[Monitor (?:expired|ended|stopped)/;
/** Lines worth parsing; the rest of a transcript (most of it) is skipped unread. */
const MARKERS = ['"type":"tool_use"', "background", "Async agent launched", "Monitor started", "Successfully stopped task", "task-notification"];

interface Scan {
  path: string;
  offset: number;
  /** A last line not yet finished being written. */
  partial: string;
  running: Map<string, BackgroundTask>;
  /** Recent tool calls (tool and description), to tell what a result launched and name it. */
  uses: Map<string, { tool: string; description: string }>;
}

/**
 * Background work of Claude Code sessions running in another process (the CLI, the desktop app),
 * which only their transcripts tell: a tool result that launched a task (a background shell, an
 * async subagent, a monitor) with no `<task-notification>` (or stop) for it since. Each transcript
 * is read once in full, then only what's appended.
 */
export class TranscriptBackground {
  private scans = new Map<string, Scan>();

  constructor(private readonly configDir: () => string) {}

  /** Tasks still running in a session whose process started at `since` (ms): older ones died with their process. */
  async running(sessionId: string, since: number): Promise<BackgroundTask[]> {
    const scan = this.scans.get(sessionId) ?? (await this.start(sessionId));
    if (!scan) return [];
    await this.advance(scan);
    return [...scan.running.values()].filter((t) => t.startedAt >= since).sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Forget sessions no longer running anywhere. */
  keep(sessionIds: Set<string>) {
    for (const id of this.scans.keys()) if (!sessionIds.has(id)) this.scans.delete(id);
  }

  private async start(sessionId: string): Promise<Scan | null> {
    const projects = join(this.configDir(), "projects");
    for (const dir of await readdir(projects).catch(() => [] as string[])) {
      const path = join(projects, dir, `${sessionId}.jsonl`);
      if (await stat(path).catch(() => null)) {
        const scan: Scan = { path, offset: 0, partial: "", running: new Map(), uses: new Map() };
        this.scans.set(sessionId, scan);
        return scan;
      }
    }
    return null;
  }

  private async advance(scan: Scan) {
    const size = (await stat(scan.path).catch(() => null))?.size ?? 0;
    if (size < scan.offset) Object.assign(scan, { offset: 0, partial: "", running: new Map(), uses: new Map() }); // rewritten
    if (size === scan.offset) return;
    const file = await open(scan.path, "r");
    try {
      const buf = Buffer.alloc(size - scan.offset);
      await file.read(buf, 0, buf.length, scan.offset);
      scan.offset = size;
      const lines = (scan.partial + buf.toString("utf8")).split("\n");
      scan.partial = lines.pop() ?? "";
      for (const line of lines) if (MARKERS.some((m) => line.includes(m))) this.read(scan, line);
    } finally {
      await file.close();
    }
  }

  private read(scan: Scan, line: string) {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      return;
    }
    const at = Date.parse(e.timestamp) || Date.now();
    // A notification can be queued (the session was busy) before it's delivered: either ends the task.
    if (e.type === "queue-operation" && typeof e.content === "string") return this.notifications(scan, e.content);
    // Only Claude Code delivers notifications (as user messages); the assistant may merely quote one.
    const fromUser = e.type === "user";
    const content = e.message?.content;
    if (typeof content === "string") return fromUser ? this.notifications(scan, content) : undefined;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (b?.type === "tool_use") {
        scan.uses.set(String(b.id), { tool: String(b.name ?? ""), description: String(b.input?.description ?? b.input?.command ?? "") });
        if (scan.uses.size > 200) scan.uses.delete(scan.uses.keys().next().value!);
      } else if (b?.type === "tool_result") {
        const use = scan.uses.get(String(b.tool_use_id));
        if (!use) continue;
        const text = (typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((c: any) => c?.text ?? "").join("\n") : "").trimStart();
        const stopped = STOPS.test(use.tool) ? STOPPED.exec(text) : null;
        if (stopped) scan.running.delete(stopped[1]);
        for (const { tools, re, kind } of LAUNCHES) {
          const m = tools.test(use.tool) ? re.exec(text) : null;
          if (m) scan.running.set(m[1], { id: m[1], kind, description: use.description || "Background task", startedAt: at });
        }
      } else if (fromUser && b?.type === "text" && typeof b.text === "string") {
        this.notifications(scan, b.text);
      }
    }
  }

  private notifications(scan: Scan, text: string) {
    if (!text.includes("<task-notification>")) return;
    for (const [, body] of text.matchAll(NOTIFICATION)) {
      const id = /<task-id>(\w+)<\/task-id>/.exec(body)?.[1];
      if (id && ENDS.test(body)) scan.running.delete(id);
    }
  }
}
