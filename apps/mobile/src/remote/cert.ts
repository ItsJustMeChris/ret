import { sha256 } from "@noble/hashes/sha2.js";
import { concat, toHex } from "./bytes";

/**
 * This device's certificate: self-signed around its P-256 key, like the desktop's
 * (src/main/remote/cert.ts, whose DER writer this is). Nothing about it is checked but the key:
 * peers pin the hash of the public key (the device id), so the rest only has to be well-formed.
 * The key itself stays in the platform's keystore, which signs the certificate for us.
 */

/** DER SubjectPublicKeyInfo prefix for a P-256 key; its 65-byte uncompressed point follows. */
const P256_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42,
  0x00,
]);

export function spkiOf(point: Uint8Array): Uint8Array {
  if (point.length !== 65 || point[0] !== 4) throw new Error("Not an uncompressed P-256 point");
  return concat(P256_SPKI_PREFIX, point);
}

/** The device id: SHA-256 of the public key (as SubjectPublicKeyInfo DER), hex. */
export function deviceIdOf(point: Uint8Array): string {
  return toHex(sha256(spkiOf(point)));
}

/** A self-signed certificate for `point`, signed (ECDSA with SHA-256, DER) by `sign`. */
export async function buildCertificate(point: Uint8Array, sign: (tbs: Uint8Array) => Promise<Uint8Array>, serial: Uint8Array): Promise<Uint8Array> {
  const ecdsaWithSha256 = seq(oid("1.2.840.10045.4.3.2"));
  const name = seq(set(seq(oid("2.5.4.3"), tlv(0x0c, new TextEncoder().encode("Ret")))));
  const tbs = seq(
    tlv(0xa0, int(Uint8Array.of(2))), // v3
    int(serial),
    ecdsaWithSha256,
    name,
    seq(time(new Date(Date.UTC(2025, 0, 1))), time(new Date(Date.UTC(2125, 0, 1)))),
    name,
    spkiOf(point),
  );
  const signature = await sign(tbs);
  return seq(tbs, ecdsaWithSha256, tlv(0x03, concat(Uint8Array.of(0), signature)));
}

// ---------------------------------------------------------------------------
// DER
// ---------------------------------------------------------------------------

function tlv(tag: number, body: Uint8Array): Uint8Array {
  const n = body.length;
  let len: Uint8Array;
  if (n < 0x80) len = Uint8Array.of(n);
  else {
    const bytes: number[] = [];
    for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
    len = Uint8Array.from([0x80 | bytes.length, ...bytes]);
  }
  return concat(Uint8Array.of(tag), len, body);
}

const seq = (...parts: Uint8Array[]) => tlv(0x30, concat(...parts));
const set = (...parts: Uint8Array[]) => tlv(0x31, concat(...parts));

/** A non-negative INTEGER from big-endian bytes. */
function int(bytes: Uint8Array): Uint8Array {
  let b = bytes;
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  return tlv(0x02, b[0] & 0x80 ? concat(Uint8Array.of(0), b) : b);
}

function oid(dotted: string): Uint8Array {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const out = [a * 40 + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >>> 7; v > 0; v >>>= 7) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Uint8Array.from(out));
}

/** UTCTime through 2049, GeneralizedTime after (RFC 5280). */
function time(d: Date): Uint8Array {
  const s = d.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z";
  const enc = new TextEncoder();
  return d.getUTCFullYear() < 2050 ? tlv(0x17, enc.encode(s.slice(2))) : tlv(0x18, enc.encode(s));
}
