import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { delimiter } from "node:path";
import { Duplex } from "node:stream";
import WebSocket from "ws";
import type { CodexSource, CodexStatus } from "../../shared/bridge";

export interface LaunchTarget {
  binary: string;
  pathDir: string | null;
  version: string | null;
  source: CodexSource;
  /** Attach to the shared Codex daemon via `codex app-server proxy` instead of owning a process. */
  shared?: boolean;
}

const STDERR_LINES = 200;

/**
 * Owns the `codex app-server` child process and acts as a dumb, fast pipe:
 * stdout is split into JSON-RPC lines and shipped to the renderer in batches
 * (one IPC message per event-loop turn), renderer lines go straight to stdin.
 * Protocol logic — initialize, requests, approvals — lives in the renderer.
 *
 * In shared mode the child is `codex app-server proxy`, which bridges stdio to
 * the Codex daemon's control socket. That socket speaks WebSocket, so we run a
 * ws client over the proxy's stdio and treat each message as one JSON-RPC line.
 */
export class AppServer {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ws: WebSocket | null = null;
  /** The start of a line still coming in, in the pieces it came in. */
  private partial: string[] = [];
  private outbox: string[] = [];
  private flushScheduled = false;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private crashes: number[] = [];
  private target: LaunchTarget | null = null;

  status: CodexStatus = {
    provider: "codex",
    state: "stopped",
    generation: 0,
    version: null,
    binaryPath: null,
    source: null,
    engine: "dedicated",
    error: null,
    stderrTail: [],
  };

  constructor(
    private readonly onLines: (lines: string[]) => void,
    private readonly onStatus: (status: CodexStatus) => void,
  ) {}

  private setStatus(patch: Partial<CodexStatus>) {
    this.status = { ...this.status, ...patch };
    this.onStatus(this.status);
  }

  private logStderr(text: string) {
    const tail = this.status.stderrTail.concat(text.split(/\r?\n/).filter(Boolean));
    this.status = { ...this.status, stderrTail: tail.slice(-STDERR_LINES) };
  }

  setMissing(error: string) {
    this.setStatus({ state: "missing", error, binaryPath: null, version: null, source: null });
  }

  /** Turned off in Settings: stop the process and stay down. */
  async disable() {
    this.target = null;
    await this.stop();
    this.setStatus({ state: "disabled", error: null, binaryPath: null, version: null, source: null });
  }

  start(target: LaunchTarget) {
    this.target = target;
    this.stopping = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    // Never run two: retire any process still attached (its handlers ignore it once replaced).
    if (this.child) {
      const old = this.child;
      this.child = null;
      this.ws?.terminate();
      this.ws = null;
      killTree(old.pid);
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (target.pathDir) env.PATH = `${target.pathDir}${delimiter}${env.PATH ?? env.Path ?? ""}`;
    // Ret manages updates itself; keep codex from nagging about npm/bun upgrades.
    delete env.CODEX_MANAGED_BY_NPM;
    delete env.CODEX_MANAGED_BY_BUN;

    const child = spawn(target.binary, target.shared ? ["app-server", "proxy"] : ["app-server"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child = child;
    this.partial = [];

    this.setStatus({
      state: "starting",
      generation: this.status.generation + 1,
      version: target.version,
      binaryPath: target.binary,
      source: target.source,
      engine: target.shared ? "shared" : "dedicated",
      error: null,
      stderrTail: [],
    });

    if (target.shared) this.attachWebSocket(child);
    else this.attachLines(child);

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.logStderr(chunk));

    child.on("error", (err) => {
      if (this.child === child) this.setStatus({ state: "error", error: err.message });
    });

    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.ws = null;
      if (this.stopping) {
        this.setStatus({ state: "stopped" });
        return;
      }
      const reason = `app-server exited (${signal ?? `code ${code}`})`;
      this.setStatus({ state: "error", error: reason });
      this.scheduleCrashRestart();
    });

    // stdin errors (EPIPE after a crash) are surfaced through the exit handler.
    child.stdin.on("error", () => {});
  }

  /** Dedicated mode: newline-delimited JSON over stdio. */
  private attachLines(child: ChildProcessWithoutNullStreams) {
    // stdin is buffered, so the renderer can start its handshake as soon as the process exists.
    child.on("spawn", () => {
      if (this.child === child && this.status.state === "starting") this.setStatus({ state: "running" });
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.child !== child) return; // late output from a replaced process
      // Only the new chunk is searched for line ends: a long thread's history comes as one line of
      // many megabytes, in 64 KB chunks, and searching all of it again for each chunk took seconds,
      // in which nothing else got through to the window.
      let start = 0;
      let nl: number;
      while ((nl = chunk.indexOf("\n", start)) !== -1) {
        const end = chunk.slice(start, nl);
        const line = (this.partial.length ? this.partial.join("") + end : end).trimEnd();
        this.partial = [];
        if (line) this.outbox.push(line);
        start = nl + 1;
      }
      if (start < chunk.length) this.partial.push(start ? chunk.slice(start) : chunk);
      this.scheduleFlush();
    });
  }

  /** Shared mode: WebSocket frames over the proxy's stdio. */
  private attachWebSocket(child: ChildProcessWithoutNullStreams) {
    const socket = Duplex.from({ readable: child.stdout, writable: child.stdin }) as Duplex & Record<string, unknown>;
    // ws/http treat the stream as a net.Socket; these knobs are meaningless over a pipe.
    for (const m of ["setNoDelay", "setKeepAlive", "setTimeout", "ref", "unref"]) socket[m] = () => socket;
    const ws = new WebSocket("ws://localhost/", {
      createConnection: () => socket as never,
      perMessageDeflate: false,
      maxPayload: 256 * 1024 * 1024,
      handshakeTimeout: 20_000,
    });
    this.ws = ws;
    ws.on("open", () => this.ws === ws && this.setStatus({ state: "running" }));
    ws.on("message", (data) => {
      if (this.ws !== ws) return;
      this.outbox.push(data.toString());
      this.scheduleFlush();
    });
    ws.on("error", (err) => this.logStderr(`ws: ${err.message}`));
    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      // Daemon went away: drop the proxy so the exit handler reconnects.
      if (!this.stopping) killTree(child.pid);
    });
  }

  private scheduleCrashRestart() {
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < 60_000).concat(now);
    if (this.crashes.length > 4 || !this.target) return; // crash loop: wait for a manual restart
    const delay = 400 * 2 ** (this.crashes.length - 1);
    this.restartTimer = setTimeout(() => this.target && this.start(this.target), delay);
  }

  private scheduleFlush() {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      if (!this.outbox.length) return;
      const batch = this.outbox;
      this.outbox = [];
      this.onLines(batch);
    });
  }

  send(line: string) {
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) this.ws.send(line.trimEnd());
      return;
    }
    if (!this.child || this.child.stdin.destroyed) return;
    this.child.stdin.write(line.endsWith("\n") ? line : line + "\n");
  }

  /** Graceful stop: close stdin so codex can tear down MCP servers/shells, then force the tree. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    const child = this.child;
    const ws = this.ws;
    this.ws = null;
    ws?.terminate();
    if (!child) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(force);
        resolve();
      };
      child.once("exit", done);
      const force = setTimeout(() => {
        killTree(child.pid);
        setTimeout(resolve, 500);
      }, 2000);
      try {
        child.stdin.end();
      } catch {
        killTree(child.pid);
      }
    });
    this.child = null;
  }

  async restart(target?: LaunchTarget) {
    await this.stop();
    const next = target ?? this.target;
    if (next) this.start(next);
  }
}

function killTree(pid: number | undefined) {
  if (!pid) return;
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
  } else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}
