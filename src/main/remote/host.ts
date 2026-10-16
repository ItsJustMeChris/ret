import { randomBytes, randomInt } from "node:crypto";
import type { AddressInfo } from "node:net";
import tls, { type TLSSocket } from "node:tls";
import { PROVIDER_IDS, type ProviderId, type ProvidersSettings } from "../../shared/bridge";
import { REMOTE_DEFAULT_PORT, REMOTE_PROTOCOL_VERSION, cleanName, hostKeyOf, type DeviceNotice } from "../../shared/remote";
import { peerId } from "./cert";
import type { AgentMux, MuxClient } from "./mux";
import { PAIR_EXPORTER_LABEL, Pake, confirmTag, pairingChannel, tagsEqual } from "./pake";
import { EXPO_TOKEN, sendExpoPush, type PushSender } from "./push";
import type { RemoteStore } from "./store";
import { Wire } from "./wire";

export { cleanName };

/** What a connected device may ask of this one beyond the engines: an allowlist, nothing generic. */
export type HostCalls = Record<string, (...args: any[]) => unknown>;

export interface HostDeps {
  store: RemoteStore;
  muxes: Record<ProviderId, AgentMux>;
  providers(): ProvidersSettings;
  calls: HostCalls;
  changed(): void;
  /** A paired device connected (shown to whoever sits at this one). */
  connected(name: string): void;
  /** How notices reach phones that are away (Expo's push service; tests pass their own). */
  push?: PushSender;
}

const PAIRING_MS = 120_000;
const HELLO_MS = 15_000;
/** Connections still to show a paired key (or pair): anyone on the network can open one. */
const MAX_UNKNOWN = 8;

/**
 * Accepts other devices: a TLS server whose clients must present a paired device key, or pair
 * with the code on show. A paired device then gets this Ret's engines (through their muxes) and
 * a few file and git calls, as if it were another window here.
 */
export class RemoteHost {
  private server: tls.Server | null = null;
  private sessions = new Set<HostSession>();
  port: number | null = null;
  error: string | null = null;
  pairing: { code: string; expiresAt: number; timer: NodeJS.Timeout; busy: HostSession | null } | null = null;
  pairingResult: { ok: boolean; message: string } | null = null;

  constructor(readonly deps: HostDeps) {}

  get id() {
    return this.deps.store.identity.id;
  }

  get name() {
    return this.deps.store.settings.name;
  }

  get running() {
    return !!this.server;
  }

  async start() {
    if (this.server) return;
    const { keyPem, certPem } = this.deps.store.identity;
    const server = tls.createServer({ key: keyPem, cert: certPem, requestCert: true, rejectUnauthorized: false, minVersion: "TLSv1.3" }, (socket) => {
      let unknown = 0;
      for (const s of this.sessions) if (!s.live) unknown++;
      if (unknown >= MAX_UNKNOWN) return socket.destroy();
      this.sessions.add(new HostSession(socket, this));
    });
    // Port scanners and the like: not worth a log line each.
    server.on("tlsClientError", () => {});
    server.on("error", (err) => {
      this.error = err.message;
      this.deps.changed();
    });
    this.server = server;
    // RET_REMOTE_BIND (e.g. 127.0.0.1) keeps a test run off the network.
    const bind = process.env.RET_REMOTE_BIND || undefined;
    const wanted = this.deps.store.settings.port;
    try {
      this.port = await listen(server, wanted ?? REMOTE_DEFAULT_PORT, bind);
      this.error = null;
    } catch (err) {
      if (wanted == null && (err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        // Something else has the usual port: take any, discovery tells others which.
        try {
          this.port = await listen(server, 0, bind);
          this.error = null;
        } catch (err2) {
          this.fail(err2 as Error);
        }
      } else this.fail(err as Error);
    }
    this.deps.changed();
  }

  private fail(err: Error) {
    this.error = `Couldn't accept connections: ${err.message}`;
    this.server?.close();
    this.server = null;
    this.port = null;
  }

  async stop() {
    this.stopPairing();
    for (const s of this.sessions) s.deny("stopped", `${this.name} stopped accepting connections.`);
    const server = this.server;
    this.server = null;
    this.port = null;
    if (server) await new Promise<void>((r) => server.close(() => r()));
    this.deps.changed();
  }

  startPairing() {
    if (!this.server) throw new Error("Turn on remote access first");
    this.stopPairing();
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const timer = setTimeout(() => {
      this.pairing = null;
      this.pairingResult = { ok: false, message: "The code expired." };
      this.deps.changed();
    }, PAIRING_MS);
    this.pairing = { code, expiresAt: Date.now() + PAIRING_MS, timer, busy: null };
    this.pairingResult = null;
    this.deps.changed();
  }

  stopPairing() {
    if (!this.pairing) return;
    clearTimeout(this.pairing.timer);
    this.pairing = null;
    this.deps.changed();
  }

  revoke(id: string) {
    const store = this.deps.store;
    store.clients = store.clients.filter((c) => c.id !== id);
    store.saveClients();
    for (const s of this.sessions) if (s.deviceId === id) s.deny("revoked", `${this.name} removed this device. Pair again to use it.`);
    this.deps.changed();
  }

  /**
   * Tell the paired phones that asked to be notified, unless they're in front right now (connected
   * and not away): they see it already. Dead tokens (the app was removed) are forgotten.
   */
  notifyDevices(notice: DeviceNotice) {
    const store = this.deps.store;
    const attending = new Set([...this.sessions].filter((s) => s.live && !s.away && s.deviceId).map((s) => s.deviceId));
    const targets = store.clients.filter((c) => c.push && !attending.has(c.id));
    if (!targets.length) return;
    const data = { threadId: notice.threadId, host: hostKeyOf(this.id) };
    const send = this.deps.push ?? sendExpoPush;
    send(targets.map((c) => ({ to: c.push!, title: notice.title, body: notice.body, data }))).then(
      (results) => {
        const gone = targets.filter((_, i) => { const r = results[i]; return !!r && !r.ok && r.gone; });
        for (const c of gone) delete c.push;
        if (gone.length) {
          store.saveClients();
          this.deps.changed();
        }
      },
      (err: Error) => console.warn("push:", err.message),
    );
  }

  /** A connected phone's push token (null: it stopped wanting notices). */
  setPush(s: HostSession, token: string | null) {
    const record = this.deps.store.clients.find((c) => c.id === s.deviceId);
    if (!record || (record.push ?? null) === token) return;
    if (token) record.push = token;
    else delete record.push;
    this.deps.store.saveClients();
    this.deps.changed();
  }

  /** Devices connected right now, with where from. */
  connected(): Map<string, string | null> {
    const out = new Map<string, string | null>();
    for (const s of this.sessions) if (s.live && s.deviceId) out.set(s.deviceId, s.address);
    return out;
  }

  broadcastProviders(settings: ProvidersSettings) {
    for (const s of this.sessions) if (s.live) s.wire.send({ t: "providers", s: settings });
  }

  // Session callbacks

  beginPairing(s: HostSession) {
    const p = this.pairing;
    if (!p || Date.now() > p.expiresAt) {
      return s.deny("not-pairing", `${this.name} isn't showing a pairing code. On ${this.name}, open Settings → Remote access and choose Pair a device.`);
    }
    if (p.busy) return s.deny("busy", `Another device is pairing with ${this.name} right now.`);
    p.busy = s;
    s.pair(p.code);
  }

  pairingFailed(s: HostSession, message: string) {
    if (this.pairing?.busy !== s) return;
    // One wrong guess burns the code: a six-digit code holds up because nobody gets a second try.
    clearTimeout(this.pairing.timer);
    this.pairing = null;
    this.pairingResult = { ok: false, message };
    this.deps.changed();
  }

  pairingSucceeded(s: HostSession) {
    if (this.pairing?.busy !== s || !s.deviceId) return false;
    clearTimeout(this.pairing.timer);
    this.pairing = null;
    const store = this.deps.store;
    store.clients = store.clients.filter((c) => c.id !== s.deviceId).concat({ id: s.deviceId, name: s.name, pairedAt: Date.now(), lastSeen: null });
    store.saveClients();
    this.pairingResult = { ok: true, message: `Paired with ${s.name}.` };
    this.deps.changed();
    return true;
  }

  sessionStarted(s: HostSession) {
    this.deps.changed();
    this.deps.connected(s.name);
  }

  sessionEnded(s: HostSession) {
    this.sessions.delete(s);
    if (this.pairing?.busy === s) this.pairing.busy = null;
    if (s.live) this.deps.changed();
  }
}

/** One connection from another device: hello, then pairing or a session. */
class HostSession {
  readonly wire: Wire;
  readonly deviceId: string | null;
  readonly address: string | null;
  name = "";
  /** In a session (paired, past hello). */
  live = false;
  /** The phone said its app went to the background: notices go to it as if it were gone. */
  away = false;
  private stage: "hello" | "pairing" | "session" | "done" = "hello";
  private clients: Partial<Record<ProviderId, MuxClient>> = {};
  private helloTimer: NodeJS.Timeout;
  private pake: Pake | null = null;
  private key: Buffer | null = null;

  constructor(
    private readonly socket: TLSSocket,
    private readonly host: RemoteHost,
  ) {
    this.deviceId = peerId(socket);
    this.address = socket.remoteAddress?.replace(/^::ffff:/, "") ?? null;
    this.wire = new Wire(socket, {
      message: (m) => this.onMessage(m),
      lines: (provider, lines) => this.onLines(provider, lines),
      close: () => this.onClose(),
    });
    this.helloTimer = setTimeout(() => this.stage !== "session" && this.deny("timeout", "Took too long."), HELLO_MS);
  }

  deny(code: string, message: string) {
    this.stage = "done";
    this.wire.send({ t: "denied", code, message });
    this.wire.close(message);
  }

  private onMessage(m: any) {
    if (this.stage === "hello") return this.onHello(m);
    if (this.stage === "pairing") return this.onPairing(m);
    if (this.stage === "session") return this.onSession(m);
  }

  private onHello(m: any) {
    if (m?.t !== "hello") return this.deny("protocol", "Unexpected message.");
    if (m.v !== REMOTE_PROTOCOL_VERSION) return this.deny("version", `${this.host.name} runs a different version of Ret. Update both devices.`);
    if (!this.deviceId) return this.deny("protocol", "No device key.");
    this.name = cleanName(m.name);
    if (m.mode === "pair") return this.host.beginPairing(this);
    if (m.mode !== "connect") return this.deny("protocol", "Unexpected message.");
    const store = this.host.deps.store;
    const record = store.clients.find((c) => c.id === this.deviceId);
    if (!record) return this.deny("unpaired", `This device isn't paired with ${this.host.name}.`);
    record.lastSeen = Date.now();
    if (record.name !== this.name && m.name) record.name = this.name;
    store.saveClients();
    this.start();
  }

  // Pairing: pair1 (sid) → pair2 (client share) → pair3 (host share) → pair4 (client tag) → paired (host tag).

  pair(code: string) {
    this.stage = "pairing";
    const sid = randomBytes(16);
    const exporter = this.socket.exportKeyingMaterial(32, PAIR_EXPORTER_LABEL, Buffer.alloc(0));
    this.pake = new Pake(code, sid, pairingChannel(exporter, this.host.id, this.deviceId!));
    this.wire.send({ t: "pair1", sid: sid.toString("base64") });
  }

  private onPairing(m: any) {
    const pake = this.pake!;
    try {
      if (m?.t === "pair2" && !this.key) {
        const share = bytes(m.y, 32);
        this.key = pake.finish(share, { client: share, host: pake.share });
        this.wire.send({ t: "pair3", y: Buffer.from(pake.share).toString("base64") });
        return;
      }
      if (m?.t === "pair4" && this.key) {
        if (!tagsEqual(bytes(m.tag, 32), confirmTag(this.key, "client"))) {
          const message = `That code wasn't right. Start pairing again on ${this.host.name} for a new one.`;
          this.host.pairingFailed(this, `${this.name} tried a wrong code. Start again for a new one.`);
          return this.deny("wrong-code", message);
        }
        if (!this.host.pairingSucceeded(this)) return this.deny("not-pairing", "The pairing code expired.");
        this.stage = "done";
        this.wire.send({ t: "paired", tag: confirmTag(this.key, "host").toString("base64"), id: this.host.id, name: this.host.name });
        this.wire.close("Paired");
        return;
      }
    } catch {
      /* malformed: below */
    }
    this.host.pairingFailed(this, `Pairing with ${this.name || "a device"} failed.`);
    this.deny("protocol", "Pairing failed.");
  }

  // Session

  private start() {
    this.stage = "session";
    this.live = true;
    clearTimeout(this.helloTimer);
    this.wire.trust();
    this.wire.send({
      t: "welcome",
      v: REMOTE_PROTOCOL_VERSION,
      id: this.host.id,
      name: this.host.name,
      platform: process.platform,
      providers: this.host.deps.providers(),
    });
    for (const provider of PROVIDER_IDS) {
      const client: MuxClient = {
        deliver: (lines) => this.wire.sendLines(provider, lines),
        status: (s) => this.wire.send({ t: "status", p: provider, s }),
      };
      this.clients[provider] = client;
      this.host.deps.muxes[provider].attach(client);
    }
    this.host.sessionStarted(this);
  }

  private onSession(m: any) {
    if (m?.t === "call") void this.call(m);
    else if (m?.t === "push") {
      const token = typeof m.token === "string" && EXPO_TOKEN.test(m.token) ? m.token : null;
      if (token || m.token === null) this.host.setPush(this, token);
    } else if (m?.t === "away") this.away = m.away === true;
    else if (m?.t === "reset") {
      // The window on the other end reloaded: it starts over with each engine.
      for (const p of PROVIDER_IDS) this.host.deps.muxes[p].reset(this.clients[p]!);
    }
  }

  private async call(m: any) {
    if (typeof m.id !== "number") return;
    const calls = this.host.deps.calls;
    const fn = typeof m.m === "string" && Object.hasOwn(calls, m.m) ? calls[m.m] : null;
    if (!fn) return this.wire.send({ t: "ret", id: m.id, e: `${m.m} isn't available from another device` });
    try {
      const v = await fn(...(Array.isArray(m.a) ? m.a : []));
      this.wire.send({ t: "ret", id: m.id, v: v ?? null });
    } catch (err) {
      this.wire.send({ t: "ret", id: m.id, e: (err as Error).message || String(err) });
    }
  }

  private onLines(provider: ProviderId, lines: string[]) {
    if (this.stage !== "session") return this.wire.close("Bad frame");
    const mux = this.host.deps.muxes[provider];
    const client = this.clients[provider]!;
    for (const line of lines) mux.fromClient(client, line);
  }

  private onClose() {
    clearTimeout(this.helloTimer);
    for (const p of PROVIDER_IDS) {
      const c = this.clients[p];
      if (c) this.host.deps.muxes[p].detach(c);
    }
    this.host.sessionEnded(this);
    this.live = false;
  }
}

function bytes(b64: unknown, length: number): Buffer {
  const b = Buffer.from(String(b64 ?? ""), "base64");
  if (b.length !== length) throw new Error("Bad length");
  return b;
}

function listen(server: tls.Server, port: number, host?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve((server.address() as AddressInfo).port);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}
