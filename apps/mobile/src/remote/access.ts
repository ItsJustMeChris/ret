import { engineId, type EngineId, type EngineStatus } from "@shared/bridge";
import { cleanName, hostKeyOf, type NearbyHost, type RemoteHost, type RemoteState } from "@shared/remote";
import { HostLink, pairWithHost, type HostRecord, type Target } from "./link";
import type { Transport } from "./transport";

/** Where the paired desktops and this phone's name are kept. */
export interface AccessStore {
  load(): Promise<{ hosts: HostRecord[]; name: string | null }>;
  save(data: { hosts: HostRecord[]; name: string }): void;
}

/** Desktop control messages from the phone: where its notices go while it's away, and whether it is. */
type Announcement = { t: "push"; token: string | null } | { t: "away"; away: boolean };

/** A Ret found on the network: a hint where a desktop might be, checked by its key on connecting. */
export interface Found {
  id: string;
  name: string;
  addresses: string[];
  port: number;
}

export interface AccessDeps {
  transport: Transport;
  /** This device's id (SHA-256 of its public key, hex). */
  deviceId: string;
  defaultName: string;
  store: AccessStore;
  /** Start looking for Rets on the network; `found` hears the whole list each time it changes. */
  discover?(found: (list: Found[]) => void): void;
  state(state: RemoteState): void;
  notify(title: string, body: string): void;
  /** A paired desktop's engines: their lines and statuses, under their engine ids ("codex@<host>"). */
  engineLines(engine: EngineId, lines: string[]): void;
  engineStatus(status: EngineStatus): void;
}

/**
 * Remote access from the phone: it never hosts, it only uses the desktops it paired with, whose
 * engines it talks to as a desktop window talks to a paired computer's (the desktop's
 * src/main/remote/index.ts, the "Paired devices" half). Each paired desktop keeps a link open
 * while the app runs.
 */
export class RemoteAccess {
  private hosts: HostRecord[] = [];
  private name = "";
  private readonly links = new Map<string, HostLink>();
  private found = new Map<string, Found>();
  private discovering = false;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  /** Undefined until the app knows (notifications not set up yet): nothing is said about it then. */
  private pushToken: string | null | undefined = undefined;
  private away = false;

  constructor(private readonly deps: AccessDeps) {}

  async init() {
    const saved = await this.deps.store.load();
    this.hosts = saved.hosts;
    this.name = saved.name ?? this.deps.defaultName;
    for (const h of this.hosts) this.startLink(h.id);
    // Paired desktops' addresses change (DHCP): keep looking for them.
    if (this.hosts.length) this.discover();
    this.changed();
  }

  state(): RemoteState {
    return {
      hosting: false,
      name: this.name,
      deviceId: this.deps.deviceId,
      port: null,
      addresses: [],
      error: null,
      pairing: null,
      pairingResult: null,
      clients: [],
      hosts: this.hosts.map((h): RemoteHost => {
        const link = this.links.get(h.id);
        return {
          id: h.id,
          key: hostKeyOf(h.id),
          name: h.name,
          pairedAt: h.pairedAt,
          lastSeen: h.lastSeen,
          address: h.address,
          port: h.port,
          online: this.found.has(h.id) || !!link?.connected,
          connected: !!link?.connected,
          platform: link?.platform ?? h.platform ?? null,
        };
      }),
      nearby: [...this.found.values()].map(
        (f): NearbyHost => ({ id: f.id, name: f.name, address: f.addresses[0], port: f.port, paired: this.hosts.some((h) => h.id === f.id) }),
      ),
    };
  }

  /** Why a paired desktop isn't connected (null when it is, or isn't known). */
  problem(hostId: string): string | null {
    return this.links.get(hostId)?.problem ?? null;
  }

  /** State changes come in bursts (a connection: welcome, statuses, discovery): send one. */
  private changed() {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.deps.state(this.state());
    }, 50);
  }

  private save() {
    this.deps.store.save({ hosts: this.hosts, name: this.name });
  }

  setName(name: string) {
    this.name = cleanName(name);
    this.save();
    this.changed();
    return this.state();
  }

  discover() {
    if (this.discovering || !this.deps.discover) return;
    this.discovering = true;
    this.deps.discover((list) => {
      this.found = new Map(list.map((f) => [f.id, f]));
      // A link waiting on a desktop tries its addresses now (the record changes only once one works).
      for (const h of this.hosts) if (this.found.has(h.id)) this.links.get(h.id)?.retryNow();
      this.changed();
    });
  }

  // -------------------------------------------------------------------------
  // The engines and calls of paired desktops, by host key
  // -------------------------------------------------------------------------

  linkFor(key: string): HostLink | null {
    const h = this.hosts.find((x) => hostKeyOf(x.id) === key);
    return h ? (this.links.get(h.id) ?? null) : null;
  }

  /** The app's JavaScript reloaded: each desktop's engines start over with it. */
  resetLinks() {
    for (const link of this.links.values()) link.reset();
  }

  /** The app came back to the front: connections may have died while it was frozen. */
  resumed() {
    for (const link of this.links.values()) link.resumed();
  }

  // -------------------------------------------------------------------------
  // Notices while away: the phone's push token, and whether its app is in front
  // -------------------------------------------------------------------------

  /** Where paired computers send notices while this phone is away (null: nowhere). */
  setPushToken(token: string | null) {
    this.pushToken = token;
    this.announceAll({ t: "push", token });
  }

  /** The app went to the background (or came back): computers notify it meanwhile. */
  setAway(away: boolean) {
    if (this.away === away) return;
    this.away = away;
    this.announceAll({ t: "away", away });
  }

  private announceAll(msg: Announcement) {
    for (const link of this.links.values()) link.control(msg);
  }

  /** What a computer that just let this phone in should know. */
  private announce(link: HostLink) {
    if (this.pushToken !== undefined) link.control({ t: "push", token: this.pushToken });
    link.control({ t: "away", away: this.away });
  }

  // -------------------------------------------------------------------------
  // Pairing
  // -------------------------------------------------------------------------

  async pair(to: Target, code: string): Promise<RemoteHost> {
    const address = to.address.trim();
    const port = Number(to.port);
    if (!address || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Enter an address like 192.168.1.20 and port 47821");
    if (!/^\d{6}$/.test(code.replace(/\D/g, ""))) throw new Error("Enter the six-digit code your computer shows");
    // Picked from the nearby list: try all of that desktop's addresses, and only accept that desktop.
    const near = [...this.found.values()].find((f) => f.port === port && f.addresses.includes(address));
    const targets = near ? near.addresses.map((a) => ({ address: a, port })) : [{ address, port }];
    let paired: Awaited<ReturnType<typeof pairWithHost>>;
    try {
      paired = await pairWithHost(this.deps.transport, this.deps.deviceId, targets, code, this.name, near?.id ?? null);
    } catch (err) {
      const message = (err as Error).message;
      // Couldn't connect at all (as opposed to the other side saying no): say what to check.
      if (/refused|unreachable|timed out|no address|No route|Network is down|cancelled/i.test(message)) {
        throw new Error(
          `Couldn't reach ${near?.name ?? `${address}:${port}`}. Check that remote access is on there and that this phone is on the same network. (${message})`,
        );
      }
      throw err;
    }
    const { id, name, target } = paired;
    if (id === this.deps.deviceId) throw new Error("That's this phone.");
    const existing = this.hosts.find((h) => h.id === id);
    const record: HostRecord = { ...existing, id, name, pairedAt: Date.now(), lastSeen: Date.now(), address: target.address, port: target.port };
    this.hosts = existing ? this.hosts.map((h) => (h.id === id ? record : h)) : [...this.hosts, record];
    this.save();
    // Paired again after it turned this phone away: the link it had starts over.
    const link = this.links.get(id);
    if (link) link.revive();
    else this.startLink(id);
    this.discover();
    this.changed();
    return this.state().hosts.find((h) => h.id === id)!;
  }

  forget(id: string) {
    this.stopLink(id);
    this.hosts = this.hosts.filter((h) => h.id !== id);
    this.save();
    this.changed();
    return this.state();
  }

  private startLink(id: string) {
    const first = this.hosts.find((h) => h.id === id);
    if (!first || this.links.has(id)) return;
    const key = hostKeyOf(id);
    // Forgetting the desktop mid-session keeps the link on the record it started with until it stops.
    const record = () => this.hosts.find((h) => h.id === id) ?? first;
    const targets = () => {
      const h = record();
      const f = this.found.get(id);
      const all = [{ address: h.address, port: h.port }, ...(f?.addresses.map((address) => ({ address, port: f.port })) ?? [])];
      return all.filter((t, i) => t.address && t.port && all.findIndex((u) => u.address === t.address && u.port === t.port) === i);
    };
    const link: HostLink = new HostLink(this.deps.transport, record, targets, () => this.name, {
      lines: (provider, lines) => this.deps.engineLines(engineId(provider, key), lines),
      status: (status) => this.deps.engineStatus(status),
      providers: () => this.changed(),
      welcome: () => this.announce(link),
      reached: (t) => {
        const h = this.hosts.find((x) => x.id === id);
        if (h && (h.address !== t.address || h.port !== t.port)) {
          h.address = t.address;
          h.port = t.port;
          this.save();
        }
      },
      changed: () => {
        const h = this.hosts.find((x) => x.id === id);
        if (h && link.connected) {
          h.lastSeen = Date.now();
          if (link.hostName && link.hostName !== h.name) h.name = link.hostName;
          if (link.platform) h.platform = link.platform;
          this.save();
        }
        this.changed();
      },
      unpaired: (message) => {
        // It doesn't know this phone any more: nothing to reconnect to until they pair again.
        this.deps.notify("Remote access", message);
        this.forget(id);
      },
    });
    this.links.set(id, link);
    link.start();
  }

  private stopLink(id: string) {
    const link = this.links.get(id);
    if (!link) return;
    this.links.delete(id);
    link.stop();
  }
}
