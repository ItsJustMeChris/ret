import { bridge } from "../bridge";
import type { EngineId, EngineStatus, ProviderId } from "@shared/bridge";
import { PROVIDER_IDS, engineId, providerOf } from "@shared/bridge";
import type { InitializeResponse, Method, ParamsOf, ResultOf, ServerRequest } from "@shared/protocol";

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

/** How an engine is called in messages ("Codex", "Codex on Desktop A"); the hosts store fills it in. */
let describe: (engine: EngineId) => string = (engine) => engine;
export function setEngineNames(fn: (engine: EngineId) => string) {
  describe = fn;
}

/**
 * JSON-RPC client for one engine (`codex app-server`, or an engine that speaks its protocol),
 * on this computer or a paired one. Transport-agnostic: lines arrive through the bridge
 * (Electron IPC or WebSocket). Every time the bridge reports a new engine generation we fail
 * outstanding requests and re-run the initialize handshake; `onReady` listeners then rehydrate.
 */
export class RpcClient {
  private nextId = 1;
  private pending = new Map<number | string, Pending>();
  private notificationHandlers = new Set<NotificationHandler>();
  private serverRequestHandler: ServerRequestHandler | null = null;
  private readyHandlers = new Set<(info: InitializeResponse) => void>();
  private generation = -1;
  private readyPromise: Promise<InitializeResponse> | null = null;
  private resolveReady: ((v: InitializeResponse) => void) | null = null;
  info: InitializeResponse | null = null;
  status: EngineStatus | null = null;
  private readonly unsubscribe: (() => void)[];
  private disposed = false;

  constructor(readonly engine: EngineId) {
    this.unsubscribe = [
      bridge.agents.onMessages((e, lines) => e === engine && this.handleLines(lines)),
      bridge.agents.onStatus((s) => engineId(s.provider, s.host) === engine && this.onStatus(s)),
    ];
    void bridge.agents.getStatus(engine).then(
      (s) => this.onStatus(s),
      () => {},
    );
  }

  /** Which agent it is, wherever it runs. */
  get provider(): ProviderId {
    return providerOf(this.engine);
  }

  /** The device went away (forgotten): stop listening and fail what's still waiting. */
  dispose() {
    this.disposed = true;
    this.unsubscribe.forEach((off) => off());
    this.info = null;
    this.failAll(new Error(`${describe(this.engine)} is gone`));
  }

  private onStatus(s: EngineStatus) {
    if (this.disposed) return;
    this.status = s;
    if (s.state === "running" && s.generation !== this.generation) {
      this.generation = s.generation;
      void this.handshake();
    } else if (s.state !== "running" && s.state !== "starting") {
      // Until the next process finishes its handshake, new requests wait (see `request`).
      this.info = null;
      this.failAll(new Error(s.error ?? `${describe(this.engine)} is not running`));
    }
  }

  /** Resolves once the current engine has completed `initialize`. */
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
    this.failAll(new Error(`${this.provider} restarted`));
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
      console.error(`${this.engine}: initialize failed`, err);
    }
  }

  private write(msg: object) {
    bridge.agents.send(this.engine, JSON.stringify(msg));
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
      const down = this.status && this.status.state !== "running" && this.status.state !== "starting";
      // Ride out a restart (e.g. an update being applied), but don't hang if the engine stays down.
      let timer = 0;
      const timeout = new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => reject(new Error(`${describe(this.engine)} is not running${this.engine === this.provider ? " — check Settings" : ""}`)), down ? 3_000 : 20_000);
      });
      try {
        await Promise.race([this.ready(), timeout]);
      } finally {
        clearTimeout(timer);
      }
    }
    return this.rawRequest<ResultOf<M>>(method, params);
  }

  /** A request outside the typed protocol (provider extensions, or methods Ret doesn't type). */
  call<T = unknown>(method: string, params: unknown): Promise<T> {
    return this.request(method as Method, params as never) as Promise<T>;
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

const clients = new Map<EngineId, RpcClient>(PROVIDER_IDS.map((p) => [p, new RpcClient(p)]));

/** The client for an engine: this computer's exist from the start, a paired device's once asked for. */
export function rpcFor(engine: EngineId): RpcClient {
  let c = clients.get(engine);
  if (!c) clients.set(engine, (c = new RpcClient(engine)));
  return c;
}

/** Forget a paired device's engine. */
export function dropClient(engine: EngineId) {
  clients.get(engine)?.dispose();
  clients.delete(engine);
}

/**
 * The engine that serves file access (`fs/*`) for Code mode and the file viewer, on the device
 * the files are on (`host`, or this computer): every engine does, so whichever is up there, Codex first.
 */
export function fsClient(host: string | null = null): RpcClient {
  const all = PROVIDER_IDS.map((p) => rpcFor(engineId(p, host)));
  return all.find((c) => c.info) ?? all.find((c) => c.status?.state === "running" || c.status?.state === "starting") ?? all[0];
}
