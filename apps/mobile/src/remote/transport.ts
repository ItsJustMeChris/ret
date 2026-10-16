// What remote access needs from the platform: TLS 1.3 connections that present this device's key
// and report (or insist on) the other side's. The app's comes from the native module
// (nativeTransport.ts); the protocol tests run the same code over Node's TLS.

export interface Target {
  address: string;
  port: number;
}

/** An open connection, already past the TLS handshake. Lines arrive whole, without their newline. */
export interface TlsSocket {
  /** The other side's device id: SHA-256 of its public key, hex. */
  readonly peer: string;
  write(text: string): void;
  close(): void;
  /** RFC 8446 exporter over this session (pairing binds to it). */
  exportKeyingMaterial(label: string, length: number): Promise<Uint8Array>;
  /** Raise the longest line accepted (a thread's history is one line of many MB). */
  setMaxLine(max: number): void;
  /** Set once, right after connecting: lines that came before are held for it. */
  onLines(cb: (lines: string[]) => void): void;
  onClose(cb: (reason: string) => void): void;
}

export interface Transport {
  /** Connect presenting this device's key; with `expect`, only to the device with that id. */
  connect(target: Target, expect: string | null, timeoutMs: number): Promise<TlsSocket>;
}

/**
 * A socket's events, held until someone listens: the platform may deliver a line in the same
 * moment the connection is handed over.
 */
export class SocketEvents {
  private held: string[][] = [];
  private closed: string | null = null;
  private linesCb: ((lines: string[]) => void) | null = null;
  private closeCb: ((reason: string) => void) | null = null;

  lines(lines: string[]) {
    if (this.closed !== null) return;
    if (this.linesCb) this.linesCb(lines);
    else this.held.push(lines);
  }

  close(reason: string) {
    if (this.closed !== null) return;
    this.closed = reason;
    if (this.closeCb) this.closeCb(reason);
  }

  onLines(cb: (lines: string[]) => void) {
    this.linesCb = cb;
    const held = this.held;
    this.held = [];
    for (const l of held) cb(l);
  }

  onClose(cb: (reason: string) => void) {
    this.closeCb = cb;
    if (this.closed !== null) cb(this.closed);
  }
}
