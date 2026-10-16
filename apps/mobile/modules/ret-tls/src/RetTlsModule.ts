import { NativeModule, requireNativeModule } from "expo";

export interface ConnectOptions {
  host: string;
  port: number;
  /** The device id (SHA-256 of its public key, hex) the other side must have; null while pairing. */
  expect: string | null;
  timeoutMs?: number;
  /** Longest line accepted before the connection is dropped (raise it with setMaxLine once the peer is trusted). */
  maxLine?: number;
}

/** A Ret advertising itself on the network (`_ret._tcp`). Only a hint: connecting checks its key. */
export interface FoundService {
  name: string;
  id: string;
  v: string;
  address: string;
  port: number;
}

type Events = {
  onLines(e: { id: number; lines: string[] }): void;
  onClose(e: { id: number; reason: string }): void;
  onServices(e: { services: FoundService[] }): void;
};

declare class RetTlsModule extends NativeModule<Events> {
  /** This device's key (created on first use) as an uncompressed P-256 point, and its certificate once set; base64. */
  identity(): Promise<{ publicKey: string; certificate: string | null }>;
  /** ECDSA-SHA256 signature (DER) over `data` with the device key; base64 in and out. */
  sign(data: string): Promise<string>;
  setCertificate(der: string): Promise<void>;
  /** Forget the device key: this phone becomes a new device, paired with nothing. */
  resetIdentity(): Promise<void>;
  /** A TLS 1.3 connection presenting the device certificate; resolves once the handshake is done. */
  connect(options: ConnectOptions): Promise<{ id: number; peer: string }>;
  exportKeyingMaterial(id: number, label: string, length: number): Promise<string>;
  write(id: number, text: string): void;
  setMaxLine(id: number, max: number): void;
  close(id: number): void;
  startDiscovery(type: string): void;
  stopDiscovery(): void;
}

export default requireNativeModule<RetTlsModule>("RetTls");
