import type { EngineStatus } from "../../shared/bridge";

/** A window (here or on another device) talking JSON-RPC to an engine through the mux. */
export interface MuxClient {
  /** Lines from the engine for this client, in order. */
  deliver(lines: string[]): void;
  /** The engine's status as this client sees it (its own generation). */
  status(status: EngineStatus): void;
}

interface Attached {
  client: MuxClient;
  /** Bumped on a reset (a page reload): replies to requests from before it are dropped. */
  epoch: number;
  /** Threads this client subscribed to (thread/start, fork, resume). */
  subs: Set<string>;
}

interface Pending {
  /** Null for the mux's own requests (a shared initialize, unsubscribing for a client that left). */
  owner: Attached | null;
  epoch: number;
  /** The client's own id, as the JSON it sent. */
  id: string;
  method: string;
  threadId: string | null;
}

interface InitState {
  result?: unknown;
  inFlight: boolean;
  waiters: { owner: Attached; epoch: number; id: string }[];
  initializedSent: boolean;
}

// The shapes RpcClient writes and engines answer with, matched without parsing: a long thread's
// history comes back as one line of many MB, and most of what flows is notifications.
const REQUEST = /^\{"id":(-?\d+|"(?:[^"\\]|\\.)*"),"method":"((?:[^"\\]|\\.)*)"/;
const RESPONSE = /^\{"id":"~(\d+)"(?=,(?!"method"))/;
const MUX_ID = /^~(\d+)$/;

const SUBSCRIBES = new Set(["thread/start", "thread/fork", "thread/resume"]);

/**
 * One engine connection shared by several clients: the local window and any devices connected
 * through remote access.
 *
 * Request ids are rewritten so replies find their way back; notifications go to everyone. Server
 * requests (approvals, questions) go to everyone too: the first answer wins and the others hear
 * `serverRequest/resolved`. Codex takes one `initialize` per connection, so the mux makes it once
 * and hands later clients the cached reply, plus whatever is still waiting on an answer. Thread
 * subscriptions are counted, so one client unsubscribing doesn't cut the stream off for another.
 */
export class AgentMux {
  private clients = new Map<MuxClient, Attached>();
  private engineStatus: EngineStatus;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  /** Server requests nobody has answered yet, keyed by their id as JSON (replayed to clients that join). */
  private unanswered = new Map<string, { line: string; threadId: string | null }>();
  /** Server requests already answered (or settled by the engine): later answers are dropped. */
  private answered = new Set<string>();
  private init: InitState = freshInit();

  constructor(
    private readonly send: (line: string) => void,
    /** The engine accepts a single `initialize` per connection (Codex); Ret's own engines take one per client. */
    private readonly shareInitialize: boolean,
    initial: EngineStatus,
  ) {
    this.engineStatus = initial;
  }

  attach(client: MuxClient) {
    const a: Attached = { client, epoch: 0, subs: new Set() };
    this.clients.set(client, a);
    client.status(this.view(a));
  }

  detach(client: MuxClient) {
    const a = this.clients.get(client);
    if (!a) return;
    this.clients.delete(client);
    this.release(a);
  }

  /** The client starts over (its page reloaded): it gets a new generation and must initialize again. */
  reset(client: MuxClient) {
    const a = this.clients.get(client);
    if (!a) return;
    a.epoch++;
    this.release(a);
    client.status(this.view(a));
  }

  statusFor(client: MuxClient): EngineStatus {
    const a = this.clients.get(client);
    return a ? this.view(a) : this.engineStatus;
  }

  get clientCount() {
    return this.clients.size;
  }

  setEngineStatus(status: EngineStatus) {
    if (status.generation !== this.engineStatus.generation) {
      // A new engine connection: nothing from the old one carries over.
      this.pending.clear();
      this.unanswered.clear();
      this.answered.clear();
      this.init = freshInit();
      for (const a of this.clients.values()) a.subs.clear();
    }
    this.engineStatus = status;
    for (const a of this.clients.values()) a.client.status(this.view(a));
  }

  private view(a: Attached): EngineStatus {
    return a.epoch ? { ...this.engineStatus, generation: this.engineStatus.generation + a.epoch } : this.engineStatus;
  }

  // -------------------------------------------------------------------------
  // Client → engine
  // -------------------------------------------------------------------------

  fromClient(client: MuxClient, line: string) {
    const a = this.clients.get(client);
    if (!a) return;
    const m = REQUEST.exec(line);
    if (m) {
      const rest = line.slice(6 + m[1].length); // from the comma after the id
      return this.request(a, m[1], JSON.parse(`"${m[2]}"`), (n) => `{"id":"~${n}"${rest}`, () => JSON.parse(line).params);
    }
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    if (msg.id !== undefined && typeof msg.method === "string") {
      return this.request(a, JSON.stringify(msg.id), msg.method, (n) => JSON.stringify({ ...msg, id: `~${n}` }), () => msg.params);
    }
    if (msg.id !== undefined) return this.answer(a, msg, line);
    if (msg.method === "initialized" && this.shareInitialize) {
      if (this.init.initializedSent) return;
      this.init.initializedSent = true;
    }
    this.send(line);
  }

  private request(a: Attached, id: string, method: string, rewrite: (n: number) => string, params: () => any) {
    if (method === "initialize" && this.shareInitialize) {
      if (this.init.result !== undefined) return this.welcome(a, id, this.init.result);
      this.init.waiters.push({ owner: a, epoch: a.epoch, id });
      if (this.init.inFlight) return;
      this.init.inFlight = true;
      const n = this.nextId++;
      this.pending.set(n, { owner: null, epoch: 0, id: "", method, threadId: null });
      return this.send(rewrite(n));
    }
    let threadId: string | null = null;
    if (method === "thread/resume" || method === "thread/unsubscribe") {
      try {
        threadId = typeof params()?.threadId === "string" ? params().threadId : null;
      } catch {
        threadId = null;
      }
    }
    if (method === "thread/unsubscribe" && threadId) {
      a.subs.delete(threadId);
      if (this.heldByOthers(threadId, a)) return this.reply(a, id, { result: { status: "unsubscribed" } });
    }
    const n = this.nextId++;
    this.pending.set(n, { owner: a, epoch: a.epoch, id, method, threadId });
    this.send(rewrite(n));
  }

  /** A client's answer to a server request: the first one goes through, the others hear it's settled. */
  private answer(a: Attached, msg: any, line: string) {
    const key = JSON.stringify(msg.id);
    // Only known-answered ids are dropped: an answer to a request the mux didn't recognize still goes through.
    if (this.answered.has(key)) return;
    this.answered.add(key);
    const open = this.unanswered.get(key);
    this.unanswered.delete(key);
    this.send(line);
    if (this.clients.size < 2) return;
    const resolved = JSON.stringify({ method: "serverRequest/resolved", params: { threadId: open?.threadId ?? null, requestId: msg.id } });
    for (const b of this.clients.values()) if (b !== a) b.client.deliver([resolved]);
  }

  private reply(a: Attached, id: string, body: { result: unknown } | { error: unknown }) {
    const [key, value] = "result" in body ? ["result", body.result] : ["error", body.error];
    a.client.deliver([`{"id":${id},"${key}":${JSON.stringify(value)}}`]);
  }

  /** The shared initialize's reply, then (on its own turn) the server requests still waiting. */
  private welcome(a: Attached, id: string, result: unknown) {
    this.reply(a, id, { result });
    const waiting = [...this.unanswered.values()].map((u) => u.line);
    if (waiting.length) setImmediate(() => this.live(a) && a.client.deliver(waiting));
  }

  private heldByOthers(threadId: string, a: Attached) {
    for (const b of this.clients.values()) if (b !== a && b.subs.has(threadId)) return true;
    return false;
  }

  /** A client left or reset: unsubscribe what only it was watching. */
  private release(a: Attached) {
    for (const threadId of a.subs) {
      if (this.heldByOthers(threadId, a)) continue;
      const n = this.nextId++;
      this.pending.set(n, { owner: null, epoch: 0, id: "", method: "thread/unsubscribe", threadId });
      this.send(JSON.stringify({ id: `~${n}`, method: "thread/unsubscribe", params: { threadId } }));
    }
    a.subs.clear();
  }

  private live(a: Attached) {
    return this.clients.get(a.client) === a;
  }

  // -------------------------------------------------------------------------
  // Engine → clients
  // -------------------------------------------------------------------------

  fromEngine(lines: string[]) {
    const out = new Map<Attached, string[]>();
    const to = (a: Attached, line: string) => {
      const l = out.get(a);
      if (l) l.push(line);
      else out.set(a, [line]);
    };
    const all = (line: string) => {
      for (const a of this.clients.values()) to(a, line);
    };
    for (const line of lines) {
      const r = RESPONSE.exec(line);
      if (r) {
        this.response(Number(r[1]), line, (orig) => `{"id":${orig}${line.slice(r[0].length)}`, to);
        continue;
      }
      if (line.startsWith('{"method":"') && !line.startsWith('{"method":"serverRequest/resolved"')) {
        all(line);
        continue;
      }
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (!msg || typeof msg !== "object") continue;
      if (msg.id !== undefined && typeof msg.method === "string") {
        this.unanswered.set(JSON.stringify(msg.id), { line, threadId: typeof msg.params?.threadId === "string" ? msg.params.threadId : null });
        all(line);
      } else if (msg.id !== undefined) {
        const n = typeof msg.id === "string" ? MUX_ID.exec(msg.id) : null;
        if (n) this.response(Number(n[1]), line, (orig) => JSON.stringify({ ...msg, id: JSON.parse(orig) }), to, msg);
      } else if (typeof msg.method === "string") {
        if (msg.method === "serverRequest/resolved") {
          const key = JSON.stringify(msg.params?.requestId);
          this.unanswered.delete(key);
          this.answered.add(key);
        }
        all(line);
      }
    }
    for (const [a, l] of out) a.client.deliver(l);
  }

  private response(n: number, line: string, restore: (orig: string) => string, to: (a: Attached, line: string) => void, parsed?: any) {
    const p = this.pending.get(n);
    if (!p) return;
    this.pending.delete(n);
    const msg = () => (parsed ??= safeParse(line));
    if (!p.owner) {
      if (p.method === "initialize") this.initialized(msg());
      return;
    }
    const a = p.owner;
    if (!this.live(a) || a.epoch !== p.epoch) return;
    if (SUBSCRIBES.has(p.method) && !isError(line, parsed)) {
      const threadId = p.method === "thread/resume" ? p.threadId : msg()?.result?.thread?.id;
      if (typeof threadId === "string") a.subs.add(threadId);
    }
    to(a, restore(p.id));
  }

  private initialized(msg: any) {
    const waiters = this.init.waiters;
    this.init.waiters = [];
    this.init.inFlight = false;
    const ok = msg && msg.error === undefined && msg.result !== undefined;
    if (ok) this.init.result = msg.result;
    for (const w of waiters) {
      if (!this.live(w.owner) || w.owner.epoch !== w.epoch) continue;
      if (ok) this.welcome(w.owner, w.id, msg.result);
      else this.reply(w.owner, w.id, { error: msg?.error ?? { code: -32603, message: "initialize failed" } });
    }
  }
}

function freshInit(): InitState {
  return { inFlight: false, waiters: [], initializedSent: false };
}

function safeParse(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Whether a reply is an error, preferably without parsing it (the fast-path shape has `"result"` or `"error"` right after the id). */
function isError(line: string, parsed?: any): boolean {
  if (parsed) return parsed.error !== undefined;
  const m = RESPONSE.exec(line);
  return m ? line.startsWith(',"error"', m[0].length) : safeParse(line)?.error !== undefined;
}
