import { safeStorage } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { PairedDevice } from "../../shared/remote";
import { certId, createDeviceCert } from "./cert";

export interface Identity {
  id: string;
  keyPem: string;
  certPem: string;
}

/** A device paired with this one: the clients allowed in, or the hosts this one can open. */
export interface PeerRecord extends PairedDevice {
  /** Hosts only: where to reach it, and its operating system (how its paths look). */
  address?: string;
  port?: number;
  platform?: string;
  /** Clients only: the phone's push token, if it asked to be notified while it's away (see push.ts). */
  push?: string;
}

export interface RemoteSettings {
  hosting: boolean;
  name: string;
  port: number | null;
}

interface StoredIdentity {
  certPem: string;
  /** The private key, encrypted by the OS (DPAPI / Keychain) where it can; plain PEM where it can't. */
  key: string;
  sealed: boolean;
}

/**
 * Everything remote access keeps on disk, under <userData>/remote: this device's key and
 * certificate, the devices paired either way, and the settings. The key is the only secret; the
 * peer lists hold public key hashes.
 */
export class RemoteStore {
  readonly identity: Identity;
  settings: RemoteSettings;
  clients: PeerRecord[];
  hosts: PeerRecord[];

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.identity = this.loadIdentity();
    this.settings = { hosting: false, name: defaultName(), port: null, ...this.read("settings.json", {}) };
    this.clients = this.read<PeerRecord[]>("clients.json", []);
    this.hosts = this.read<PeerRecord[]>("hosts.json", []);
  }

  saveSettings() {
    this.write("settings.json", this.settings);
  }

  saveClients() {
    this.write("clients.json", this.clients);
  }

  saveHosts() {
    this.write("hosts.json", this.hosts);
  }

  private loadIdentity(): Identity {
    const stored = this.read<StoredIdentity | null>("identity.json", null);
    if (stored) {
      try {
        const keyPem = stored.sealed ? safeStorage.decryptString(Buffer.from(stored.key, "base64")) : stored.key;
        return { id: certId(stored.certPem), keyPem, certPem: stored.certPem };
      } catch {
        // Unreadable (moved to another machine or OS account): start over as a new device.
      }
    }
    const cert = createDeviceCert();
    const sealed = safeStorage.isEncryptionAvailable();
    const key = sealed ? safeStorage.encryptString(cert.keyPem).toString("base64") : cert.keyPem;
    this.write("identity.json", { certPem: cert.certPem, key, sealed } satisfies StoredIdentity);
    return { id: certId(cert.certPem), ...cert };
  }

  private read<T>(file: string, fallback: T): T {
    try {
      return JSON.parse(readFileSync(join(this.dir, file), "utf8"));
    } catch {
      return fallback;
    }
  }

  private write(file: string, value: unknown) {
    writeFileSync(join(this.dir, file), JSON.stringify(value, null, 2));
  }
}

function defaultName(): string {
  const h = hostname().replace(/\.local$/i, "");
  return h || "This computer";
}
