import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";

/**
 * Pairing: CPace (draft-irtf-cfrg-cpace) over ristretto255, keyed by the short code the host shows.
 *
 * Both sides derive a generator from the code and the channel they're on, swap one point each, and
 * end up with the same key only if they used the same code on the same channel. Unlike hashing the
 * code, nothing that crosses the wire lets an attacker test guesses offline: each run is one guess,
 * and the host burns the code after a single failure. The channel binds the TLS session (exporter)
 * and both device keys, so a pairing that succeeds also proves who holds which key.
 */
const Point = ristretto255.Point;
const DST = "ret-pair-v1-ristretto255";

export type PakeRole = "client" | "host";

export class Pake {
  private readonly scalar: bigint;
  /** This side's share, to send to the other. */
  readonly share: Uint8Array;

  constructor(
    code: string,
    private readonly sid: Buffer,
    channel: Buffer,
  ) {
    const generator = ristretto255_hasher.hashToCurve(lv(Buffer.from("CPaceRistretto255"), Buffer.from(code, "utf8"), channel, sid), { DST });
    this.scalar = randomScalar();
    this.share = generator.multiply(this.scalar).toBytes();
  }

  /**
   * The session key from the other side's share. `client` and `host` are the two shares in
   * that order (one of them this side's own). Throws on a malformed share.
   */
  finish(other: Uint8Array, shares: { client: Uint8Array; host: Uint8Array }): Buffer {
    const point = Point.fromBytes(other);
    if (point.is0()) throw new Error("Bad pairing message");
    const k = point.multiply(this.scalar);
    if (k.is0()) throw new Error("Bad pairing message");
    return createHash("sha512")
      .update(lv(Buffer.from("ret-pair-v1-isk"), this.sid, Buffer.from(k.toBytes()), Buffer.from(shares.client), Buffer.from(shares.host)))
      .digest();
  }
}

/** Key confirmation: each side proves it holds the key, with a tag that differs by role. */
export function confirmTag(key: Buffer, role: PakeRole): Buffer {
  return createHmac("sha256", key).update(`ret-pair-v1-confirm-${role}`).digest();
}

export function tagsEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * What a pairing is bound to: this TLS session's exported key and both device ids. The exporter
 * alone doesn't cover the client's certificate (TLS 1.3 sends it after the exporter is fixed),
 * hence the ids.
 */
export function pairingChannel(exporter: Buffer, hostId: string, clientId: string): Buffer {
  return lv(Buffer.from("ret-pair-v1-channel"), exporter, Buffer.from(hostId, "hex"), Buffer.from(clientId, "hex"));
}

export const PAIR_EXPORTER_LABEL = "EXPORTER-ret-pair-v1";

/** Length-prefixed concatenation, so no two different inputs encode the same. */
function lv(...parts: Buffer[]): Buffer {
  const out: Buffer[] = [];
  for (const p of parts) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(p.length);
    out.push(len, p);
  }
  return Buffer.concat(out);
}

function randomScalar(): bigint {
  const order = Point.Fn.ORDER;
  for (;;) {
    // 64 bytes reduced mod the group order: uniform to within 2^-250.
    const s = BigInt("0x" + randomBytes(64).toString("hex")) % order;
    if (s !== 0n) return s;
  }
}
