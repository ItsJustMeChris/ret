import { bridge } from "../bridge";
import type { InitializeResponse, Method, ParamsOf, ResultOf, ServerRequest } from "../protocol";

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; method: string };
export type NotificationHandler = (method: string, params: any) => void;
export type ServerRequestHandler = (req: ServerRequest) => void;

/**
 * JSON-RPC client for `codex app-server`. Transport-agnostic: lines arrive
 * through the bridge (Electron IPC or WebSocket). Every time the bridge reports
 * a new process generation we fail outstanding requests and re-run the
 * initialize handshake; `onReady` listeners then rehydrate their state.
 */
class CodexClient {
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private notificationHandlers = new Set<NotificationHandler>();
  private serverRequestHandler: ServerRequestHandler | null = null;
  private readyHandlers = new Set<(info: InitializeResponse) => void>();
  private generation = -1;
  private readyPromise: Promise<InitializeResponse> | null = null;
  private resolveReady: ((v: InitializeResponse) => void) | null = null;
  info: InitializeResponse | null = null;

  constructor() {
    bridge.codex.onMessages((lines) => this.handleLines(lines));
    bridge.codex.onStatus((s) => {
      if (s.state === "running" && s.generation !== this.generation) {
        this.generation = s.generation;
        void this.handshake();
      } else if (s.state === "error" || s.state === "stopped" || s.state === "missing") {
        // Until the next process finishes its handshake, new requests wait (see `request`).
        this.info = null;
        this.failAll(new Error(s.error ?? "codex app-server is not running"));
      }
    });
    void bridge.codex.getStatus().then((s) => {
      if (s.state === "running" && this.generation !== s.generation) {
        this.generation = s.generation;
        void this.handshake();
      }
    });
  }

  /** Resolves once the current app-server process has completed `initialize`. */
  ready(): Promise<InitializeResponse> {
    if (this.info && !this.readyPromise) return Promise.resolve(this.info);
    if (!this.readyPromise) {
      this.readyPromise = new Promise((r) => (this.resolveReady = r));
    }
    return this.readyPromise;
  }

  onReady(cb: (info: InitializeResponse) => void) {
    this.readyHandlers.add(cb);
    if (this.info) cb(this.info);
    return () => this.readyHandlers.delete(cb);
  }

  private async handshake() {
    this.info = null;
    this.failAll(new Error("codex app-server restarted"));
    if (!this.readyPromise) this.readyPromise = new Promise((r) => (this.resolveReady = r));
    try {
      const info = await this.rawRequest<InitializeResponse>("initialize", {
        clientInfo: { name: "ret", title: "Ret", version: bridge.appVersion },
        capabilities: { experimentalApi: true, requestAttestation: false },
      });
      this.write({ method: "initialized" });
      this.info = info;
      this.resolveReady?.(info);
      this.readyPromise = null;
      this.resolveReady = null;
      this.readyHandlers.forEach((cb) => cb(info));
    } catch (err) {
      console.error("initialize failed", err);
    }
  }

  private write(msg: object) {
    bridge.codex.send(JSON.stringify(msg));
  }

  private rawRequest<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.write({ id, method, params });
    });
  }

  async request<M extends Method>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>> {
    if (!this.info) {
      // Ride out a restart (e.g. an update being applied), but don't hang if codex stays down.
      let timer = 0;
      const timeout = new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error("codex is not running — check Settings")), 20_000);
      });
      try {
        await Promise.race([this.ready(), timeout]);
      } finally {
        clearTimeout(timer);
      }
    }
    return this.rawRequest<ResultOf<M>>(method, params);
  }

  respond(id: number | string, result: unknown) {
    this.write({ id, result });
  }

  respondError(id: number | string, code: number, message: string) {
    this.write({ id, error: { code, message } });
  }

  onNotification(handler: NotificationHandler) {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  setServerRequestHandler(handler: ServerRequestHandler) {
    this.serverRequestHandler = handler;
  }

  private failAll(err: Error) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private handleLines(lines: string[]) {
    for (const line of lines) {
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id !== undefined && msg.method === undefined) {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new RpcError(msg.error.message ?? `${p.method} failed`, msg.error.code ?? -1, msg.error.data));
        else p.resolve(msg.result);
      } else if (msg.id !== undefined && msg.method) {
        if (this.serverRequestHandler) this.serverRequestHandler(msg as ServerRequest);
        else this.respondError(msg.id, -32601, `Unhandled request ${msg.method}`);
      } else if (msg.method) {
        for (const h of this.notificationHandlers) h(msg.method, msg.params);
      }
    }
  }
}

export const rpc = new CodexClient();
