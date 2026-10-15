import { Bonjour, type Browser, type Service } from "bonjour-service";
import { REMOTE_PROTOCOL_VERSION } from "../../shared/remote";
import { cleanName } from "./host";

export interface Found {
  id: string;
  name: string;
  /** Where it answered from first, then its other addresses: not all of them reach it from here. */
  addresses: string[];
  port: number;
  seenAt: number;
}

const REQUERY_MS = 60_000;

/**
 * Finding other Rets on the network with mDNS / DNS-SD (`_ret._tcp.local`), and announcing this
 * one while it accepts connections. What it finds are only hints: a device is who its key says,
 * which the connection checks, whatever name or id it advertises.
 */
export class Discovery {
  private bonjour: Bonjour | null = null;
  private published: Service | null = null;
  private browser: Browser | null = null;
  private requery: NodeJS.Timeout | null = null;
  readonly found = new Map<string, Found>();

  constructor(
    private readonly ownId: string,
    private readonly changed: () => void,
  ) {}

  private get mdns(): Bonjour {
    this.bonjour ??= new Bonjour(undefined, (err: Error) => console.warn("mdns:", err?.message ?? err));
    return this.bonjour;
  }

  publish(name: string, port: number) {
    this.unpublish();
    try {
      // The id in the instance name keeps two devices with the same name apart.
      const service = this.mdns.publish({
        name: `${name} (${this.ownId.slice(0, 6)})`,
        type: "ret",
        port,
        txt: { id: this.ownId, n: name, v: String(REMOTE_PROTOCOL_VERSION) },
      });
      service.on("error", (err: Error) => console.warn("mdns publish:", err?.message ?? err));
      this.published = service;
    } catch (err) {
      console.warn("mdns publish:", (err as Error).message);
    }
  }

  unpublish() {
    const s = this.published;
    this.published = null;
    try {
      s?.stop?.();
    } catch {
      /* already gone */
    }
  }

  browse() {
    if (this.browser) return;
    try {
      const browser = this.mdns.find({ type: "ret" });
      browser.on("up", (s) => this.add(s));
      browser.on("srv-update", (s) => this.add(s));
      browser.on("txt-update", (s) => this.add(s));
      browser.on("down", (s) => this.remove(s));
      this.browser = browser;
      this.requery = setInterval(() => browser.update(), REQUERY_MS);
    } catch (err) {
      console.warn("mdns browse:", (err as Error).message);
    }
  }

  /** Ask the network again now (Settings just opened, say). */
  refresh() {
    this.browser?.update();
  }

  destroy() {
    if (this.requery) clearInterval(this.requery);
    this.unpublish();
    this.browser?.stop();
    this.browser = null;
    this.bonjour?.destroy();
    this.bonjour = null;
  }

  private add(s: Service) {
    const id = typeof s.txt?.id === "string" ? s.txt.id.toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(id) || id === this.ownId) return;
    const addresses = addressesOf(s);
    if (!addresses.length || !s.port) return;
    this.found.set(id, { id, name: cleanName(s.txt?.n ?? s.name), addresses, port: s.port, seenAt: Date.now() });
    this.changed();
  }

  private remove(s: Service) {
    const id = typeof s.txt?.id === "string" ? s.txt.id.toLowerCase() : "";
    if (this.found.delete(id)) this.changed();
  }
}

/** The address the answer came from, then the IPv4 ones it lists (link-local IPv6 needs a scope id). */
function addressesOf(s: Service): string[] {
  const v4 = (s.addresses ?? []).filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
  const from = s.referer?.family === "IPv4" ? [s.referer.address] : [];
  return [...new Set([...from, ...v4])];
}
