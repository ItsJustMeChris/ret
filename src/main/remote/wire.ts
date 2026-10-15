import type { TLSSocket } from "node:tls";
import { PROVIDER_IDS, type ProviderId } from "../../shared/bridge";

export interface WireHandlers {
  /** A control message: one JSON object. */
  message(msg: any): void;
  /** A batch of an engine's JSON-RPC lines, passed through untouched. */
  lines(provider: ProviderId, lines: string[]): void;
  close(reason: string): void;
}

const PING_MS = 15_000;
const DEAD_MS = 45_000;

/**
 * Framing for a connection between two Rets: newline-delimited, like the engines' own pipes.
 * A line is either a JSON control message or `@a <provider> <n>`, followed by n raw JSON-RPC
 * lines, so agent traffic crosses without being re-encoded. Pings keep NATs and sleeping
 * laptops honest: a peer silent for 45 s is dropped.
 */
export class Wire {
  private partial: string[] = [];
  private partialLength = 0;
  private batch: { provider: ProviderId; left: number; lines: string[] } | null = null;
  private closed = false;
  private lastHeard = Date.now();
  private timer: NodeJS.Timeout;

  constructor(
    readonly socket: TLSSocket,
    private readonly handlers: WireHandlers,
    /** The longest line accepted. Small until the peer is known: anyone on the network can connect. */
    private maxLine = 64 * 1024,
  ) {
    socket.setEncoding("utf8");
    socket.setNoDelay(true);
    socket.setKeepAlive(true, PING_MS);
    socket.on("data", (chunk: string) => this.onData(chunk));
    socket.on("error", (err) => this.close(err.message));
    socket.on("close", () => this.close("Connection closed"));
    this.timer = setInterval(() => {
      if (Date.now() - this.lastHeard > DEAD_MS) this.close("No answer");
      else this.send({ t: "ping" });
    }, PING_MS);
  }

  /** Lift the line limit once the peer is a paired device (a long thread's history is one line of many MB). */
  trust() {
    this.maxLine = 256 * 1024 * 1024;
  }

  send(msg: object) {
    if (this.closed) return;
    this.socket.write(JSON.stringify(msg) + "\n");
  }

  sendLines(provider: ProviderId, lines: string[]) {
    if (this.closed) return;
    // A raw newline would break the framing; JSON never has one, so such a line is junk anyway.
    const ok = lines.filter((l) => l && !l.includes("\n"));
    if (ok.length) this.socket.write(`@a ${provider} ${ok.length}\n${ok.join("\n")}\n`);
  }

  close(reason = "Closed") {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    this.socket.end();
    // Give a goodbye message a moment to flush, then make sure the socket is gone.
    setTimeout(() => this.socket.destroy(), 1000).unref();
    this.handlers.close(reason);
  }

  get isClosed() {
    return this.closed;
  }

  private onData(chunk: string) {
    if (this.closed) return;
    this.lastHeard = Date.now();
    // Only the new chunk is searched for line ends (see AppServer: history lines are huge).
    let start = 0;
    let nl: number;
    while ((nl = chunk.indexOf("\n", start)) !== -1) {
      const end = chunk.slice(start, nl);
      const line = this.partial.length ? this.partial.join("") + end : end;
      this.partial = [];
      this.partialLength = 0;
      start = nl + 1;
      if (line.length > this.maxLine) return this.close("Message too long");
      try {
        this.onLine(line);
      } catch (err) {
        // Whatever went wrong handling one peer's message, it mustn't take the main process down.
        console.error("remote:", err);
        return this.close(`Error: ${(err as Error).message}`);
      }
      if (this.closed) return;
    }
    if (start < chunk.length) {
      const rest = start ? chunk.slice(start) : chunk;
      this.partial.push(rest);
      this.partialLength += rest.length;
      if (this.partialLength > this.maxLine) this.close("Message too long");
    }
  }

  private onLine(line: string) {
    const b = this.batch;
    if (b) {
      b.lines.push(line);
      if (--b.left === 0) {
        this.batch = null;
        this.handlers.lines(b.provider, b.lines);
      }
      return;
    }
    if (!line) return;
    if (line.startsWith("@a ")) {
      const [, provider, count] = line.split(" ");
      const n = Number(count);
      if (!PROVIDER_IDS.includes(provider as ProviderId) || !Number.isInteger(n) || n < 1) return this.close("Bad frame");
      this.batch = { provider: provider as ProviderId, left: n, lines: [] };
      return;
    }
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return this.close("Bad frame");
    }
    if (msg?.t === "ping") this.send({ t: "pong" });
    else if (msg?.t !== "pong") this.handlers.message(msg);
  }
}
