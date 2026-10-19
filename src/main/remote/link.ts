import tls, { type TLSSocket } from "node:tls";
import { PROVIDER_IDS, type EngineStatus, type ProviderId, type ProvidersSettings } from "../../shared/bridge";
import { REMOTE_PROTOCOL_VERSION, hostKeyOf } from "../../shared/remote";
import { peerId } from "./cert";
import { cleanName } from "./host";
import { PAIR_EXPORTER_LABEL, Pake, confirmTag, pairingChannel, tagsEqual } from "./pake";
import type { Identity, PeerRecord } from "./store";
import { Wire } from "./wire";

export interface Target {
  address: string;
  port: number;
}

export interface LinkEvents {
  lines(provider: ProviderId, lines: string[]): void;
  status(status: EngineStatus): void;
  providers(settings: ProvidersSettings): void;
  /** Connected or not, or the host turned this device away for good. */
  changed(): void;
  /** The host doesn't know this device any more (revoked, or forgot it). */
  unpaired(message: string): void;
  /** Connected at this address (perhaps not the one on record). */
  reached(target: Target): void;
}

const CONNECT_TIMEOUT_MS = 8_000;
const CALL_TIMEOUT_MS = 60_000;
/** How long a call made before the connection is up (a window loading) waits for it. */
const CALL_WAIT_MS = 10_000;

/**
 * A window's connection to another device's Ret: its engines' JSON-RPC lines both ways, file and
 * git calls, and statuses re-numbered so the window's RPC clients start over whenever the
 * connection does. Reconnects until the window closes; the host must still hold the pinned key.
 */
export class HostLink {
  private wire: Wire | null = null;
  private connecting = false;
  private stopped = false;
  private fatal: string | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private fails = 0;
  private connection = 0;
  private everConnected = false;
  private lastError: string | null = null;
  private calls = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private nextCall = 1;
  private outbox: Partial<Record<ProviderId, string[]>> = {};
  private flushScheduled = false;
  private hostStatus: Partial<Record<ProviderId, EngineStatus>> = {};
  private gens = Object.fromEntries(PROVIDER_IDS.map((p) => [p, { connection: -1, hostGen: -1, local: 0 }])) as Record<
    ProviderId,
    { connection: number; hostGen: number; local: number }
  >;
  private reachedAt: Target | null = null;
  private waiting = new Set<{ resolve: () => void; reject: (e: Error) => void }>();
  connected = false;
  providers: ProvidersSettings | null = null;
  /** What the host said about itself when it last let this device in. */
  hostName: string | null = null;
  platform: string | null = null;

  constructor(
    private readonly identity: Identity,
    /** The host as currently known. */
    private readonly host: () => PeerRecord,
    /** Where it might be: the address on record, then whatever discovery saw it at. Tried together. */
    private readonly targets: () => Target[],
    private readonly myName: () => string,
    private readonly events: LinkEvents,
  ) {}

  get hostId() {
    return this.host().id;
  }

  start() {
    void this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.wire?.close("Window closed");
    this.failCalls(new Error("Window closed"));
    this.release(new Error("Window closed"));
  }

  /** Paired again after the host turned this device away: start over. */
  revive() {
    if (this.stopped || !this.fatal) return;
    this.fatal = null;
    this.lastError = null;
    this.fails = 0;
    void this.connect();
  }

  /** Try now rather than at the next retry (discovery just saw the host, say). */
  retryNow() {
    if (this.stopped || this.fatal || this.wire || this.connecting) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    void this.connect();
  }

  send(provider: ProviderId, line: string) {
    if (!this.connected) return; // the window's RPC client starts over once the link is back
    (this.outbox[provider] ??= []).push(line);
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      const out = this.outbox;
      this.outbox = {};
      for (const p of PROVIDER_IDS) if (out[p]?.length) this.wire?.sendLines(p, out[p]!);
    });
  }

  async call<T = any>(method: string, ...args: unknown[]): Promise<T> {
    if (!this.connected) await this.whenConnected();
    const wire = this.wire;
    if (!this.connected || !wire) throw new Error(`Not connected to ${this.host().name}`);
    const id = this.nextCall++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error(`${this.host().name} didn't answer`));
      }, CALL_TIMEOUT_MS);
      this.calls.set(id, { resolve, reject, timer });
      wire.send({ t: "call", id, m: method, a: args });
    });
  }

  /** Wait (a little) for the connection: a window asks for git and file info as soon as it loads. */
  private whenConnected(): Promise<void> {
    if (this.stopped || this.fatal) return Promise.reject(new Error(this.fatal ?? `Not connected to ${this.host().name}`));
    return new Promise((resolve, reject) => {
      const w = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e: Error) => {
          clearTimeout(timer);
          reject(e);
        },
      };
      const timer = setTimeout(() => {
        this.waiting.delete(w);
        reject(new Error(`Not connected to ${this.host().name}`));
      }, CALL_WAIT_MS);
      this.waiting.add(w);
    });
  }

  private release(err?: Error) {
    const waiting = [...this.waiting];
    this.waiting.clear();
    for (const w of waiting) err ? w.reject(err) : w.resolve();
  }

  /** The window reloaded: the host's engines start over with it (replies to the old page's requests are dropped there). */
  reset() {
    if (this.connected) this.wire?.send({ t: "reset" });
  }

  /** An engine's status as the window should see it: under the host's key, numbered by this link. */
  status(provider: ProviderId): EngineStatus {
    const g = this.gens[provider];
    const host = hostKeyOf(this.host().id);
    const base = this.hostStatus[provider] ?? placeholder(provider);
    if (this.connected && this.hostStatus[provider]) return { ...base, host, generation: g.local };
    // Connected, and the device says nothing of it: a Ret from before it had this agent.
    if (this.connected && this.providers && this.providers.enabled?.[provider] === undefined) return { ...base, host, state: "disabled", error: null, generation: g.local };
    const name = this.host().name;
    const error = this.fatal ?? (this.everConnected ? `Lost the connection to ${name}. Reconnecting…` : this.lastError);
    return { ...base, host, state: this.fatal || this.lastError || this.everConnected ? "error" : "starting", error, generation: g.local };
  }

  private async connect() {
    if (this.stopped || this.fatal || this.connecting) return;
    this.connecting = true;
    const host = this.host();
    let socket: TLSSocket;
    let target: Target;
    try {
      ({ socket, target } = await openFirst(this.targets(), this.identity, host.id));
    } catch (err) {
      this.connecting = false;
      return this.failed(`Can't reach ${host.name} (${(err as Error).message}). Retrying…`);
    }
    this.connecting = false;
    if (this.stopped) return void socket.destroy();
    this.reachedAt = target;
    const wire: Wire = new Wire(socket, {
      message: (m) => this.onMessage(wire, m),
      lines: (provider, lines) => this.wire === wire && this.connected && this.events.lines(provider, lines),
      close: (reason) => this.onClose(wire, reason),
    });
    this.wire = wire;
    wire.send({ t: "hello", v: REMOTE_PROTOCOL_VERSION, mode: "connect", name: this.myName() });
  }

  private onMessage(wire: Wire, m: any) {
    if (this.wire !== wire) return;
    switch (m?.t) {
      case "welcome":
        this.connected = true;
        this.everConnected = true;
        this.connection++;
        this.fails = 0;
        this.lastError = null;
        wire.trust();
        if (typeof m.name === "string") this.hostName = cleanName(m.name);
        if (typeof m.platform === "string") this.platform = m.platform;
        if (m.providers) {
          this.providers = m.providers;
          this.events.providers(m.providers);
        }
        if (this.reachedAt) this.events.reached(this.reachedAt);
        this.events.changed();
        this.release();
        break;
      case "status":
        if (PROVIDER_IDS.includes(m.p) && m.s) this.setHostStatus(m.p, m.s);
        break;
      case "providers":
        this.providers = m.s;
        this.events.providers(m.s);
        break;
      case "ret": {
        const c = this.calls.get(m.id);
        if (!c) break;
        this.calls.delete(m.id);
        clearTimeout(c.timer);
        if (m.e !== undefined) c.reject(new Error(String(m.e)));
        else c.resolve(m.v);
        break;
      }
      case "denied": {
        const message = String(m.message ?? "Turned away.");
        if (m.code === "unpaired" || m.code === "revoked" || m.code === "version") {
          this.fatal = message;
          this.release(new Error(message));
          if (m.code !== "version") this.events.unpaired(message);
        } else this.lastError = message;
        break;
      }
    }
  }

  private setHostStatus(provider: ProviderId, s: EngineStatus) {
    const g = this.gens[provider];
    if (g.connection !== this.connection || g.hostGen !== s.generation) {
      g.connection = this.connection;
      g.hostGen = s.generation;
      g.local++;
    }
    this.hostStatus[provider] = s;
    this.events.status(this.status(provider));
  }

  private onClose(wire: Wire, reason: string) {
    if (this.wire !== wire) return;
    this.wire = null;
    const was = this.connected;
    this.connected = false;
    this.outbox = {};
    this.failCalls(new Error(`Lost the connection to ${this.host().name}`));
    if (!was && !this.fatal && !this.lastError) this.lastError = `${this.host().name} closed the connection (${reason}). Retrying…`;
    this.emitStatuses();
    this.events.changed();
    this.scheduleRetry();
  }

  private failed(message: string) {
    this.lastError = this.everConnected ? null : message;
    this.emitStatuses();
    this.scheduleRetry();
  }

  private scheduleRetry() {
    if (this.stopped || this.fatal) return;
    const delay = Math.min(1000 * 2 ** this.fails++, 15_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private emitStatuses() {
    for (const p of PROVIDER_IDS) this.events.status(this.status(p));
  }

  private failCalls(err: Error) {
    for (const c of this.calls.values()) {
      clearTimeout(c.timer);
      c.reject(err);
    }
    this.calls.clear();
  }
}

/**
 * Pair with the device at one of `targets` (the same device's addresses), using the code it
 * shows. Resolves to its id and name, which the caller pins: from then on that key is the only
 * one accepted as this host. `expect` is the id it advertised, if found by discovery.
 */
export async function pairWithHost(
  identity: Identity,
  targets: Target[],
  code: string,
  myName: string,
  expect: string | null,
): Promise<{ id: string; name: string; target: Target }> {
  const { socket, target, id: hostId } = await openFirst(targets, identity, expect);
  const exporter = socket.exportKeyingMaterial(32, PAIR_EXPORTER_LABEL, Buffer.alloc(0));
  return new Promise((resolve, reject) => {
    let pake: Pake | null = null;
    let key: Buffer | null = null;
    let settled = false;
    const done = (err: Error | null, value?: { id: string; name: string; target: Target }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wire.close(err ? err.message : "Paired");
      if (err) reject(err);
      else resolve(value!);
    };
    const timer = setTimeout(() => done(new Error("The other device didn't answer")), 30_000);
    const wire = new Wire(socket, {
      message: (m) => {
        try {
          if (m?.t === "denied") return done(new Error(String(m.message ?? "Pairing was refused")));
          if (m?.t === "pair1" && !pake) {
            const sid = Buffer.from(String(m.sid), "base64");
            if (sid.length !== 16) throw new Error("Bad pairing message");
            pake = new Pake(code.replace(/\D/g, ""), sid, pairingChannel(exporter, hostId, identity.id));
            return wire.send({ t: "pair2", y: Buffer.from(pake.share).toString("base64") });
          }
          if (m?.t === "pair3" && pake && !key) {
            const share = Buffer.from(String(m.y), "base64");
            key = pake.finish(share, { client: pake.share, host: share });
            return wire.send({ t: "pair4", tag: confirmTag(key, "client").toString("base64") });
          }
          if (m?.t === "paired" && key) {
            // The host proves it knew the code too; without this a stranger could pose as it.
            if (m.id !== hostId || !tagsEqual(Buffer.from(String(m.tag), "base64"), confirmTag(key, "host"))) throw new Error("The other device failed the pairing check");
            return done(null, { id: hostId, name: cleanName(m.name), target });
          }
          throw new Error("Unexpected reply while pairing");
        } catch (err) {
          done(err as Error);
        }
      },
      lines: () => done(new Error("Unexpected reply while pairing")),
      close: (reason) => done(new Error(reason === "Connection closed" ? "The other device closed the connection" : reason)),
    });
    wire.send({ t: "hello", v: REMOTE_PROTOCOL_VERSION, mode: "pair", name: myName });
  });
}

/**
 * Connect to whichever of `targets` answers first, as the device `expect` (any device when null):
 * a computer has several addresses (Wi-Fi, Ethernet, VPN and virtual adapters) and only some are
 * reachable from here.
 */
function openFirst(targets: Target[], identity: Identity, expect: string | null): Promise<{ socket: TLSSocket; target: Target; id: string }> {
  return new Promise((resolve, reject) => {
    if (!targets.length) return reject(new Error("no address"));
    let left = targets.length;
    let won = false;
    const errors: string[] = [];
    const lost = (why: string) => {
      errors.push(why);
      if (--left === 0 && !won) reject(new Error(errors.join("; ")));
    };
    for (const t of targets) {
      openTls(t, identity).then(
        (socket) => {
          const id = peerId(socket);
          if (won || !id || (expect && id !== expect)) {
            socket.destroy();
            return lost(`${t.address}: ${won ? "slower" : "a different device"}`);
          }
          won = true;
          resolve({ socket, target: t, id });
        },
        (err: Error) => lost(`${t.address}: ${err.message}`),
      );
    }
  });
}

/** A TLS connection presenting this device's key; the caller checks the other side's. */
function openTls(target: Target, identity: Identity): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: target.address,
      port: target.port,
      key: identity.keyPem,
      cert: identity.certPem,
      // Self-signed on both sides: trust comes from the pinned key, checked by the caller.
      rejectUnauthorized: false,
      minVersion: "TLSv1.3",
    });
    const timer = setTimeout(() => fail(new Error("timed out")), CONNECT_TIMEOUT_MS);
    const fail = (err: Error) => {
      clearTimeout(timer);
      socket.removeListener("secureConnect", ok);
      socket.destroy();
      reject(err);
    };
    const ok = () => {
      clearTimeout(timer);
      socket.removeListener("error", fail);
      resolve(socket);
    };
    socket.once("secureConnect", ok);
    socket.once("error", fail);
  });
}

function placeholder(provider: ProviderId): EngineStatus {
  return { provider, state: "starting", generation: 0, version: null, binaryPath: null, source: null, engine: "dedicated", error: null, stderrTail: [] };
}
