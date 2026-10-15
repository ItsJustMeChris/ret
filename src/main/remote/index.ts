import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { engineId, type EngineStatus, type EngineId, type ProviderId, type ProvidersSettings } from "../../shared/bridge";
import { hostKeyOf, type RemoteState } from "../../shared/remote";
import { Discovery } from "./discovery";
import { RemoteHost, cleanName, type HostCalls } from "./host";
import { HostLink, pairWithHost, type Target } from "./link";
import type { AgentMux } from "./mux";
import { RemoteStore, type PeerRecord } from "./store";

export { AgentMux, type MuxClient } from "./mux";
export type { HostCalls } from "./host";
export type { HostLink } from "./link";

export interface RemoteAccessDeps {
  userData: string;
  muxes: Record<ProviderId, AgentMux>;
  providers(): ProvidersSettings;
  calls: HostCalls;
  state(state: RemoteState): void;
  notify(title: string, body: string): void;
  /** A paired device's engines, for the window: their lines and statuses, under their engine ids. */
  engineLines(engine: EngineId, lines: string[]): void;
  engineStatus(status: EngineStatus): void;
}

/**
 * Remote access, both ways round: hosting (paired devices use this Ret's engines, files and git)
 * and using the devices this one paired with, whose engines join this window's alongside its own.
 * Each paired device keeps a link open for as long as Ret runs. Discovery finds both kinds.
 */
export class RemoteAccess {
  readonly store: RemoteStore;
  private readonly host: RemoteHost;
  private readonly discovery: Discovery;
  /** Paired devices' links, by device id. */
  private readonly links = new Map<string, HostLink>();
  private stateTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: RemoteAccessDeps) {
    this.store = new RemoteStore(join(deps.userData, "remote"));
    this.discovery = new Discovery(this.store.identity.id, () => this.onFound());
    this.host = new RemoteHost({
      store: this.store,
      muxes: deps.muxes,
      providers: deps.providers,
      calls: deps.calls,
      changed: () => this.changed(),
      connected: (name) => deps.notify("Remote access", `${name} connected to this Ret.`),
    });
  }

  async init() {
    for (const h of this.store.hosts) this.startLink(h.id);
    if (this.store.settings.hosting) await this.startHosting();
    // Paired hosts' addresses can change (DHCP): keep looking for them.
    if (this.store.hosts.length) this.discovery.browse();
  }

  async shutdown() {
    for (const link of this.links.values()) link.stop();
    this.discovery.destroy();
    await this.host.stop();
  }

  state(): RemoteState {
    const s = this.store.settings;
    const connected = this.host.connected();
    return {
      hosting: s.hosting,
      name: s.name,
      deviceId: this.store.identity.id,
      port: this.host.port,
      addresses: s.hosting ? lanAddresses() : [],
      error: this.host.error,
      pairing: this.host.pairing && { code: this.host.pairing.code, expiresAt: this.host.pairing.expiresAt },
      pairingResult: this.host.pairingResult,
      clients: this.store.clients.map((c) => ({ ...c, connected: connected.has(c.id), address: connected.get(c.id) ?? null })),
      hosts: this.store.hosts.map((h) => {
        const link = this.links.get(h.id);
        return {
          id: h.id,
          key: hostKeyOf(h.id),
          name: h.name,
          pairedAt: h.pairedAt,
          lastSeen: h.lastSeen,
          address: h.address ?? "",
          port: h.port ?? 0,
          online: this.discovery.found.has(h.id) || !!link?.connected,
          connected: !!link?.connected,
          platform: link?.platform ?? h.platform ?? null,
        };
      }),
      nearby: [...this.discovery.found.values()].map((f) => ({
        id: f.id,
        name: f.name,
        address: f.addresses[0],
        port: f.port,
        paired: this.store.hosts.some((h) => h.id === f.id),
      })),
    };
  }

  /** State changes come in bursts (a connection: session, status, discovery): send one. */
  private changed() {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.deps.state(this.state());
    }, 50);
  }

  // -------------------------------------------------------------------------
  // Hosting
  // -------------------------------------------------------------------------

  async setHosting(on: boolean) {
    this.store.settings.hosting = on;
    this.store.saveSettings();
    if (on) await this.startHosting();
    else {
      this.discovery.unpublish();
      await this.host.stop();
    }
    this.changed();
    return this.state();
  }

  private async startHosting() {
    await this.host.start();
    if (this.host.port) this.discovery.publish(this.store.settings.name, this.host.port);
    this.discovery.browse();
  }

  setName(name: string) {
    this.store.settings.name = cleanName(name);
    this.store.saveSettings();
    if (this.host.running && this.host.port) this.discovery.publish(this.store.settings.name, this.host.port);
    this.changed();
    return this.state();
  }

  startPairing() {
    this.host.startPairing();
    return this.state();
  }

  stopPairing() {
    this.host.stopPairing();
    return this.state();
  }

  revoke(id: string) {
    this.host.revoke(id);
    return this.state();
  }

  broadcastProviders(settings: ProvidersSettings) {
    this.host.broadcastProviders(settings);
  }

  // -------------------------------------------------------------------------
  // Paired devices
  // -------------------------------------------------------------------------

  discover() {
    this.discovery.browse();
    this.discovery.refresh();
  }

  /** The window reloaded: each paired device's engines start over with it too. */
  resetLinks() {
    for (const link of this.links.values()) link.reset();
  }

  /** The link to the paired device with this host key (see hostKeyOf). */
  linkFor(key: string): HostLink | null {
    const h = this.store.hosts.find((x) => hostKeyOf(x.id) === key);
    return h ? (this.links.get(h.id) ?? null) : null;
  }

  async pair(to: Target, code: string) {
    const address = to.address.trim();
    const port = Number(to.port);
    if (!address || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Enter an address like 192.168.1.20:47821");
    // Picked from the nearby list: try all of that device's addresses, and only accept that device.
    const near = [...this.discovery.found.values()].find((f) => f.port === port && f.addresses.includes(address));
    const targets = near ? near.addresses.map((a) => ({ address: a, port })) : [{ address, port }];
    let paired: Awaited<ReturnType<typeof pairWithHost>>;
    try {
      paired = await pairWithHost(this.store.identity, targets, code, this.store.settings.name, near?.id ?? null);
    } catch (err) {
      const message = (err as Error).message;
      // Couldn't connect at all (as opposed to the other side saying no): say what to check.
      if (/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|timed out|no address/.test(message)) {
        throw new Error(`Couldn't reach ${near?.name ?? `${address}:${port}`}. Check that remote access is on there and both computers are on the same network. (${message})`);
      }
      throw err;
    }
    const { id, name, target } = paired;
    if (hostKeyOf(id) === hostKeyOf(this.store.identity.id)) throw new Error("That's this computer.");
    const existing = this.store.hosts.find((h) => h.id === id);
    const record: PeerRecord = { ...existing, id, name, pairedAt: Date.now(), lastSeen: Date.now(), address: target.address, port: target.port };
    this.store.hosts = existing ? this.store.hosts.map((h) => (h.id === id ? record : h)) : [...this.store.hosts, record];
    this.store.saveHosts();
    // Paired again after it turned this device away: the link it had starts over.
    const link = this.links.get(id);
    if (link) link.revive();
    else this.startLink(id);
    this.discovery.browse();
    this.changed();
    return this.state().hosts.find((h) => h.id === id)!;
  }

  forget(id: string) {
    this.stopLink(id);
    this.store.hosts = this.store.hosts.filter((h) => h.id !== id);
    this.store.saveHosts();
    this.changed();
    return this.state();
  }

  private startLink(id: string) {
    const first = this.store.hosts.find((h) => h.id === id);
    if (!first || this.links.has(id)) return;
    const key = hostKeyOf(id);
    // Forgetting the host mid-session keeps the link on the record it started with until it stops.
    const record = () => this.store.hosts.find((h) => h.id === id) ?? first;
    const targets = () => {
      const h = record();
      const f = this.discovery.found.get(id);
      const all = [{ address: h.address ?? "", port: h.port ?? 0 }, ...(f?.addresses.map((address) => ({ address, port: f.port })) ?? [])];
      return all.filter((t, i) => t.address && t.port && all.findIndex((u) => u.address === t.address && u.port === t.port) === i);
    };
    const link: HostLink = new HostLink(this.store.identity, record, targets, () => this.store.settings.name, {
      lines: (provider, lines) => this.deps.engineLines(engineId(provider, key), lines),
      status: (status) => this.deps.engineStatus(status),
      providers: () => this.changed(),
      reached: (t) => {
        const h = this.store.hosts.find((x) => x.id === id);
        if (h && (h.address !== t.address || h.port !== t.port)) {
          h.address = t.address;
          h.port = t.port;
          this.store.saveHosts();
        }
      },
      changed: () => {
        const h = this.store.hosts.find((x) => x.id === id);
        if (h && link.connected) {
          h.lastSeen = Date.now();
          if (link.hostName && link.hostName !== h.name) h.name = link.hostName;
          if (link.platform) h.platform = link.platform;
          this.store.saveHosts();
        }
        this.changed();
      },
      unpaired: (message) => {
        // It doesn't know this device any more: nothing to reconnect to until they pair again.
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

  /** Discovery found (or lost) devices: a link waiting on one tries its addresses now (the record changes only once one works). */
  private onFound() {
    for (const h of this.store.hosts) if (this.discovery.found.has(h.id)) this.links.get(h.id)?.retryNow();
    this.changed();
  }
}

/** Adapters other computers can't reach this one through: virtual machines' and containers' own networks. */
const VIRTUAL_ADAPTER = /^(vEthernet|vboxnet|VirtualBox|VMware|docker|br-|veth|virbr)/i;

/** This computer's IPv4 addresses on its networks, for typing in by hand. */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (VIRTUAL_ADAPTER.test(name)) continue;
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  }
  return out;
}
