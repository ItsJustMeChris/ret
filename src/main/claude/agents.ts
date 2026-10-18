import { open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Thread, ThreadStatus } from "../../shared/protocol";

/**
 * Claude Code's subagents as threads of their own, as Codex has its spawned agents: each run of the
 * Agent tool is a thread under the session (or agent) that spawned it, so what Ret built for Codex's
 * agents (the Dynamic Island's tray, the sidebar's nesting, the details' Subagents, the agent's own
 * transcript) shows Claude's too. Live, its session reports it (session.ts); on disk, Claude Code
 * keeps each one's transcript and a meta file in a folder beside its session's transcript:
 * `<projects>/<project>/<sessionId>/subagents/agent-<agentId>.jsonl` and `.meta.json`.
 */

/** A subagent's thread id: its session's, then its agent id. */
export const agentThreadId = (sessionId: string, agentId: string) => `${sessionId}:${agentId}`;

/** The session and agent a subagent's thread id names; null for a session's own thread. */
export function agentIdsOf(threadId: string): { sessionId: string; agentId: string } | null {
  const i = threadId.indexOf(":");
  return i > 0 ? { sessionId: threadId.slice(0, i), agentId: threadId.slice(i + 1) } : null;
}

/** The id of a subagent's first run (its prompt and what it did with it), the same live and from its transcript. */
export const firstRunId = (threadId: string) => `${threadId}:run`;

export interface AgentRecord {
  sessionId: string;
  agentId: string;
  /** The Agent call that started it, in its parent's transcript. */
  toolUseId: string | null;
  /** The agent that spawned it, if one did rather than the session's main agent. */
  parentAgentId: string | null;
  description: string;
  /** The name it was given, if any (a teammate's). */
  name: string | null;
  /** Its agent type (general-purpose, Explore…). */
  type: string | null;
  model: string | null;
  prompt: string | null;
  /** Where it works, when not its session's folder (a worktree of its own). */
  cwd: string | null;
  /** Seconds. */
  createdAt: number;
  updatedAt: number;
}

/** A subagent as the thread the protocol describes. */
export function agentThread(a: AgentRecord, sessionCwd: string, status: ThreadStatus, name: string | null = null): Thread {
  const id = agentThreadId(a.sessionId, a.agentId);
  return {
    id,
    environments: null,
    extra: null,
    sessionId: a.sessionId,
    forkedFromId: null,
    parentThreadId: a.parentAgentId ? agentThreadId(a.sessionId, a.parentAgentId) : a.sessionId,
    preview: a.prompt ?? a.description,
    ephemeral: false,
    section: null,
    sectionEnteredAt: null,
    projectId: null,
    historyMode: "paginated",
    modelProvider: "anthropic",
    model: a.model,
    reasoningEffort: null,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    recencyAt: a.updatedAt,
    status,
    path: null,
    cwd: a.cwd ?? sessionCwd,
    cliVersion: "",
    originator: "claude_code",
    source: "unknown",
    // It takes its instructions from the agent that spawned it.
    canAcceptDirectInput: false,
    threadSource: null,
    agentNickname: a.name || a.description || null,
    // The everyday type goes without saying.
    agentRole: a.type && a.type !== "general-purpose" ? a.type : null,
    gitInfo: null,
    name,
    daybreakEnabled: null,
    turns: [],
  };
}

/** How long a look at the subagents on disk stands. */
const FRESH_MS = 4000;
/** Enough of a transcript's first line for the prompt it starts with. */
const HEAD_BYTES = 32 * 1024;

/** The subagents on disk, by session: every session folder's `subagents`, looked at every few seconds at most. */
export class AgentIndex {
  private at = 0;
  private reading: Promise<Map<string, AgentRecord[]>> | null = null;
  private bySession = new Map<string, AgentRecord[]>();
  /** Where each session's subagents are, to read one's transcript. */
  private dirs = new Map<string, string>();
  /** Each session's own transcript. */
  private files = new Map<string, string>();

  constructor(private readonly projects: () => string) {}

  async all(): Promise<Map<string, AgentRecord[]>> {
    if (Date.now() - this.at < FRESH_MS) return this.bySession;
    this.reading ??= this.scan().finally(() => (this.reading = null));
    return this.reading;
  }

  async of(sessionId: string): Promise<AgentRecord[]> {
    return (await this.all()).get(sessionId) ?? [];
  }

  /** A session's own transcript (looked for again if it's new since the last look). */
  async sessionFile(sessionId: string): Promise<string | null> {
    if (!this.files.has(sessionId)) {
      await this.all();
      if (!this.files.has(sessionId) && Date.now() - this.at > 500) {
        this.at = 0;
        await this.all();
      }
    }
    return this.files.get(sessionId) ?? null;
  }

  /** A subagent's transcript, if it has one. */
  async transcript(sessionId: string, agentId: string): Promise<string | null> {
    if (!this.dirs.has(sessionId)) await this.all();
    const dir = this.dirs.get(sessionId);
    return dir ? join(dir, `agent-${agentId}.jsonl`) : null;
  }

  private async scan(): Promise<Map<string, AgentRecord[]>> {
    const root = this.projects();
    const out = new Map<string, AgentRecord[]>();
    const dirs = new Map<string, string>();
    const files = new Map<string, string>();
    for (const project of await readdir(root).catch(() => [] as string[])) {
      const entries = await readdir(join(root, project), { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith(".jsonl")) files.set(e.name.slice(0, -6), join(root, project, e.name));
        if (!e.isDirectory()) continue;
        const dir = join(root, project, e.name, "subagents");
        const names = await readdir(dir).catch(() => null);
        if (!names) continue;
        dirs.set(e.name, dir);
        const ids = new Set(names.map((n) => /^agent-(.+?)\.(?:jsonl|meta\.json)$/.exec(n)?.[1]).filter((id): id is string => !!id));
        const records = (await Promise.all([...ids].map((id) => readAgent(dir, e.name, id, names.includes(`agent-${id}.meta.json`))))).filter(
          (r): r is AgentRecord => !!r,
        );
        if (records.length) out.set(e.name, records);
      }
    }
    this.bySession = out;
    this.dirs = dirs;
    this.files = files;
    this.at = Date.now();
    return out;
  }
}

async function readAgent(dir: string, sessionId: string, agentId: string, hasMeta: boolean): Promise<AgentRecord | null> {
  const log = join(dir, `agent-${agentId}.jsonl`);
  const none: Record<string, any> = {};
  const [meta, st, head] = await Promise.all([
    hasMeta ? readFile(join(dir, `agent-${agentId}.meta.json`), "utf8").then((t) => JSON.parse(t) as Record<string, any>, () => none) : none,
    stat(log).catch(() => null),
    firstLine(log),
  ]);
  if (!st) return null;
  const prompt = promptOf(head);
  return {
    sessionId,
    agentId,
    toolUseId: typeof meta.toolUseId === "string" ? meta.toolUseId : null,
    parentAgentId: typeof meta.parentAgentId === "string" ? meta.parentAgentId : null,
    description: String(meta.description ?? "") || (prompt?.split("\n").find((l) => l.trim())?.trim().slice(0, 80) ?? "Subagent"),
    name: typeof meta.name === "string" ? meta.name : null,
    type: typeof meta.agentType === "string" ? meta.agentType : null,
    model: typeof meta.model === "string" ? meta.model : null,
    prompt,
    cwd: typeof meta.worktreePath === "string" ? meta.worktreePath : null,
    createdAt: Math.floor((st.birthtimeMs || st.mtimeMs) / 1000),
    updatedAt: Math.floor(st.mtimeMs / 1000),
  };
}

async function firstLine(path: string): Promise<string | null> {
  const f = await open(path, "r").catch(() => null);
  if (!f) return null;
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await f.read(buf, 0, HEAD_BYTES, 0);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    const nl = text.indexOf("\n");
    return nl >= 0 ? text.slice(0, nl) : text;
  } finally {
    await f.close();
  }
}

/** The prompt a subagent's transcript starts with (cut short if its first line is longer than was read). */
function promptOf(line: string | null): string | null {
  if (!line) return null;
  try {
    const m = JSON.parse(line);
    const c = m?.message?.content;
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => (b?.type === "text" ? String(b.text ?? "") : "")).join("") : "";
    return text.trim() || null;
  } catch {
    const m = /"content":"((?:[^"\\]|\\.){1,2000})/.exec(line);
    if (!m) return null;
    try {
      return JSON.parse(`"${m[1].replace(/\\$/, "")}"`) || null;
    } catch {
      return null;
    }
  }
}

/** What an Agent call's result says, for people: the agent's report, without the notes Claude Code adds for the model. */
export function agentReport(text: string | null): string | null {
  if (!text) return null;
  const report = text
    .replace(/<usage>[\s\S]*?<\/usage>/g, "")
    .replace(/^agentId: \S+ \([^\n]*\)\s*$/gm, "")
    .trim();
  return report || null;
}

/** The agent an async launch started ("Async agent launched successfully … agentId: …"), if this result is one. */
export function launchedAgent(text: string | null): string | null {
  return (text && /^Async agent launched successfully[\s\S]*?agentId: (\w+)/.exec(text)?.[1]) || null;
}
