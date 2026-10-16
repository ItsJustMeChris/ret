import { ristretto255, ristretto255_hasher } from "@noble/curves/ed25519.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { bytesEqual, concat, fromHex, toHex, utf8 } from "./bytes";

/**
 * Pairing: CPace (draft-irtf-cfrg-cpace) over ristretto255, keyed by the short code the host shows.
 * The client half of the desktop's src/main/remote/pake.ts, byte for byte (the remote tests run
 * the two against each other): same generator, transcript, session key and confirmation tags.
 */
const Point = ristretto255.Point;
const DST = utf8("ret-pair-v1-ristretto255");

export type PakeRole = "client" | "host";

export class Pake {
  private readonly scalar: bigint;
  /** This side's share, to send to the other. */
  readonly share: Uint8Array;

  constructor(
    code: string,
    private readonly sid: Uint8Array,
    channel: Uint8Array,
  ) {
    const generator = ristretto255_hasher.hashToCurve(lv(utf8("CPaceRistretto255"), utf8(code), channel, sid), { DST });
    this.scalar = randomScalar();
    this.share = generator.multiply(this.scalar).toBytes();
  }

  /** The session key from the other side's share. Throws on a malformed share. */
  finish(other: Uint8Array, shares: { client: Uint8Array; host: Uint8Array }): Uint8Array {
    const point = Point.fromBytes(other);
    if (point.is0()) throw new Error("Bad pairing message");
    const k = point.multiply(this.scalar);
    if (k.is0()) throw new Error("Bad pairing message");
    return sha512(lv(utf8("ret-pair-v1-isk"), this.sid, k.toBytes(), shares.client, shares.host));
  }
}

/** Key confirmation: each side proves it holds the key, with a tag that differs by role. */
export function confirmTag(key: Uint8Array, role: PakeRole): Uint8Array {
  return hmac(sha256, key, utf8(`ret-pair-v1-confirm-${role}`));
}

export const tagsEqual = bytesEqual;

/** What a pairing is bound to: the TLS session's exported key and both device ids. */
export function pairingChannel(exporter: Uint8Array, hostId: string, clientId: string): Uint8Array {
  return lv(utf8("ret-pair-v1-channel"), exporter, fromHex(hostId), fromHex(clientId));
}

export const PAIR_EXPORTER_LABEL = "EXPORTER-ret-pair-v1";

/** Length-prefixed concatenation, so no two different inputs encode the same. */
function lv(...parts: Uint8Array[]): Uint8Array {
  const out: Uint8Array[] = [];
  for (const p of parts) {
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, p.length);
    out.push(len, p);
  }
  return concat(...out);
}

function randomScalar(): bigint {
  const order = Point.Fn.ORDER;
  for (;;) {
    // 64 bytes reduced mod the group order: uniform to within 2^-250.
    const s = BigInt("0x" + toHex(randomBytes(64))) % order;
    if (s !== 0n) return s;
  }
}
