import { PROVIDER_IDS, type ProviderId } from "@shared/bridge";
import type { TlsSocket } from "./transport";

export interface WireHandlers {
  /** A control message: one JSON object. */
  message(msg: any): void;
  /** A batch of an engine's JSON-RPC lines, passed through untouched. */
  lines(provider: ProviderId, lines: string[]): void;
  close(reason: string): void;
}

const PING_MS = 15_000;
const DEAD_MS = 45_000;
/** Once the peer is a paired device: a long thread's history is one line of many MB. */
const TRUSTED_MAX_LINE = 256 * 1024 * 1024;

/**
 * The framing between two Rets, as the desktop's (src/main/remote/wire.ts): newline-delimited
 * lines, each a JSON control message or `@a <provider> <n>` followed by n raw JSON-RPC lines.
 * Lines arrive already split (by the platform). Pings keep the connection honest: a peer silent
 * for 45 s is dropped.
 */
export class Wire {
  private batch: { provider: ProviderId; left: number; lines: string[] } | null = null;
  private closed = false;
  private lastHeard = Date.now();
  private timer: ReturnType<typeof setInterval>;

  constructor(
    readonly socket: TlsSocket,
    private readonly handlers: WireHandlers,
  ) {
    socket.onLines((lines) => this.onLines(lines));
    socket.onClose((reason) => this.close(reason));
    this.timer = setInterval(() => {
      if (Date.now() - this.lastHeard > DEAD_MS) this.close("No answer");
      else this.send({ t: "ping" });
    }, PING_MS);
  }

  /** Lift the line limit once the peer is a paired device. */
  trust() {
    this.socket.setMaxLine(TRUSTED_MAX_LINE);
  }

  /** Back from a pause (the app was in the background): the peer's silence meanwhile wasn't its fault. */
  heard() {
    this.lastHeard = Date.now();
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
    this.socket.close();
    this.handlers.close(reason);
  }

  get isClosed() {
    return this.closed;
  }

  private onLines(lines: string[]) {
    if (this.closed) return;
    this.lastHeard = Date.now();
    for (const line of lines) {
      try {
        this.onLine(line);
      } catch (err) {
        // Whatever went wrong handling one message, it mustn't take the app down.
        console.error("remote:", err);
        return this.close(`Error: ${(err as Error).message}`);
      }
      if (this.closed) return;
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
