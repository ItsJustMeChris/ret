import type { IPty } from "node-pty";
import { claudeEnv } from "./claude/platform";

interface Proc {
  pty: IPty;
  /** Output since the last flush: sent once per event-loop turn, however many pieces it came in. */
  out: string[];
}

const rpcError = (message: string, code = -32603) => Object.assign(new Error(message), { code });

/**
 * The app-server's `process/*` methods for terminals (`tty` sessions), run by Ret itself on
 * node-pty. Answered on every engine connection, so a terminal works whichever agents are on (Codex,
 * Claude Code, both), on a paired device's as well as this computer's, and keeps running while an
 * engine restarts or updates. Handles belong to the connection they were spawned on; the mux routes
 * their output to the window that asked, and ends them when it goes.
 */
export class PtyService {
  private procs = new Map<string, Proc>();
  private flushScheduled = false;

  constructor(private readonly notify: (method: string, params: unknown) => void) {}

  handles(method: string) {
    return method.startsWith("process/");
  }

  async call(method: string, p: any): Promise<unknown> {
    const handle = String(p?.processHandle ?? "");
    switch (method) {
      case "process/spawn":
        await this.spawn(handle, p);
        return {};
      case "process/writeStdin": {
        const proc = this.procs.get(handle);
        if (!proc) throw rpcError(`No process ${handle}`);
        if (typeof p.deltaBase64 === "string" && p.deltaBase64) proc.pty.write(Buffer.from(p.deltaBase64, "base64"));
        return {};
      }
      case "process/resizePty": {
        const proc = this.procs.get(handle);
        const cols = Math.floor(Number(p?.size?.cols));
        const rows = Math.floor(Number(p?.size?.rows));
        if (proc && cols > 0 && rows > 0 && cols < 10_000 && rows < 10_000) proc.pty.resize(cols, rows);
        return {};
      }
      case "process/kill":
        this.procs.get(handle)?.pty.kill();
        return {};
      default:
        throw rpcError(`${method} is not supported`, -32601);
    }
  }

  private async spawn(handle: string, p: any) {
    if (!handle) throw rpcError("processHandle is required", -32602);
    if (this.procs.has(handle)) throw rpcError(`Process ${handle} is already running`, -32602);
    if (!p.tty) throw rpcError("Only terminal (tty) processes are supported", -32602);
    const command: unknown[] = Array.isArray(p.command) ? p.command : [];
    if (!command.length || !command.every((a) => typeof a === "string")) throw rpcError("command must be a non-empty list of strings", -32602);
    // Loaded on first use: a platform without a build of it still starts, and says so here. (A
    // require, not import(): it's resolved from the app's asar, which ESM loading can't read.)
    const { spawn } = require("node-pty") as typeof import("node-pty");
    // A fresh shell's environment: Ret's own, minus what a Claude Code session that launched Ret set.
    const env = claudeEnv();
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    for (const [k, v] of Object.entries((p.env ?? {}) as Record<string, string | null>)) {
      if (v == null) delete env[k];
      else env[k] = String(v);
    }
    const [file, ...args] = command as string[];
    const pty = spawn(file, args, {
      name: env.TERM ?? "xterm-256color",
      cols: Math.max(1, Math.floor(Number(p.size?.cols) || 80)),
      rows: Math.max(1, Math.floor(Number(p.size?.rows) || 24)),
      cwd: String(p.cwd),
      env: env as Record<string, string>,
      // node-pty's own ConPTY (Windows Terminal's) rather than the system's, which leaves a
      // conhost.exe behind for every shell that exits by itself.
      useConptyDll: process.platform === "win32",
    });
    const proc: Proc = { pty, out: [] };
    this.procs.set(handle, proc);
    pty.onData((data) => {
      proc.out.push(data);
      this.scheduleFlush();
    });
    pty.onExit(({ exitCode }) => {
      if (this.procs.get(handle) !== proc) return;
      this.flush();
      this.procs.delete(handle);
      this.notify("process/exited", { processHandle: handle, exitCode, stdout: "", stdoutCapReached: false, stderr: "", stderrCapReached: false });
    });
  }

  private scheduleFlush() {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => this.flush());
  }

  private flush() {
    this.flushScheduled = false;
    for (const [handle, proc] of this.procs) {
      if (!proc.out.length) continue;
      const data = proc.out.join("");
      proc.out = [];
      this.notify("process/outputDelta", { processHandle: handle, stream: "stdout", deltaBase64: Buffer.from(data, "utf8").toString("base64"), capReached: false });
    }
  }

  /** Ret is quitting: end every terminal. */
  dispose() {
    for (const proc of this.procs.values()) {
      try {
        proc.pty.kill();
      } catch {
        /* already gone */
      }
    }
    this.procs.clear();
  }
}
