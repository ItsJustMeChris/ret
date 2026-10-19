import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

export type AcpError = Error & { code?: number; data?: unknown };

const acpError = (e: { code?: number; message?: string; data?: unknown }): AcpError =>
  Object.assign(new Error(e.message || "The agent reported an error"), { code: e.code, data: e.data });

/**
 * JSON-RPC 2.0 with an ACP agent over its stdin/stdout, one message per line. Both sides send
 * requests: Ret calls `session/*`, the agent asks for permissions (`session/request_permission`)
 * and streams `session/update` notifications.
 */
export class AcpConnection {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: AcpError) => void }>();
  private closed: string | null = null;

  constructor(
    private readonly proc: ChildProcess,
    private readonly handlers: {
      request(method: string, params: any): Promise<unknown>;
      notification(method: string, params: any): void;
      stderr(text: string): void;
      exit(reason: string): void;
    },
  ) {
    createInterface({ input: proc.stdout! }).on("line", (line) => this.receive(line));
    proc.stderr!.setEncoding("utf8");
    proc.stderr!.on("data", (d: string) => handlers.stderr(d));
    proc.stdin!.on("error", () => {});
    proc.on("error", (err) => this.close(err.message));
    proc.on("exit", (code, signal) => this.close(signal ? `The agent was stopped (${signal})` : `The agent exited (code ${code})`));
  }

  get alive() {
    return !this.closed;
  }

  request<T = any>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(acpError({ message: this.closed }));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown) {
    if (!this.closed) this.write({ jsonrpc: "2.0", method, params });
  }

  kill() {
    this.close("The agent was stopped");
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
  }

  private write(msg: object) {
    try {
      this.proc.stdin!.write(JSON.stringify(msg) + "\n");
    } catch (err) {
      this.close((err as Error).message);
    }
  }

  private receive(line: string) {
    if (!line.trim()) return;
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      // Not protocol: something the agent printed to stdout by mistake.
      this.handlers.stderr(line);
      return;
    }
    if (typeof msg?.method === "string") {
      if (msg.id === undefined || msg.id === null) return this.handlers.notification(msg.method, msg.params ?? {});
      void this.handlers.request(msg.method, msg.params ?? {}).then(
        (result) => this.write({ jsonrpc: "2.0", id: msg.id, result: result ?? null }),
        (err: AcpError) => this.write({ jsonrpc: "2.0", id: msg.id, error: { code: err?.code ?? -32603, message: String(err?.message ?? err) } }),
      );
      return;
    }
    const p = this.pending.get(msg?.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(acpError(msg.error));
    else p.resolve(msg.result);
  }

  private close(reason: string) {
    if (this.closed) return;
    this.closed = reason;
    for (const p of this.pending.values()) p.reject(acpError({ message: reason }));
    this.pending.clear();
    this.handlers.exit(reason);
  }
}
