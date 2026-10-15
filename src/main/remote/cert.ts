import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import type { TLSSocket } from "node:tls";

/**
 * A device's TLS identity: an ECDSA P-256 key and a self-signed certificate around it.
 *
 * Nothing about the certificate is checked but its key. Peers pin the hash of the public key
 * (the device id), so the name, dates and signature only need to be well-formed enough for TLS
 * to carry them. Node can't make certificates, hence the small DER writer below.
 */
export interface DeviceCert {
  keyPem: string;
  certPem: string;
}

export function createDeviceCert(): DeviceCert {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const ecdsaWithSha256 = seq(oid("1.2.840.10045.4.3.2"));
  const name = seq(set(seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from("Ret")))));
  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))), // v3
    int(randomBytes(16)),
    ecdsaWithSha256,
    name,
    seq(time(new Date(Date.UTC(2025, 0, 1))), time(new Date(Date.UTC(2125, 0, 1)))),
    name,
    spki,
  );
  const signature = sign("sha256", tbs, privateKey);
  const der = seq(tbs, ecdsaWithSha256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return {
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    certPem: `-----BEGIN CERTIFICATE-----\n${der.toString("base64").replace(/.{64}/g, "$&\n").trimEnd()}\n-----END CERTIFICATE-----\n`,
  };
}

/** The device id: SHA-256 of the public key, hex. */
export function keyId(key: KeyObject): string {
  return createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
}

export function certId(certPem: string): string {
  return keyId(createPublicKey(certPem));
}

/** The id of whoever is on the other end of a TLS connection, or null without a certificate. */
export function peerId(socket: TLSSocket): string | null {
  const cert = socket.getPeerX509Certificate();
  return cert ? keyId(cert.publicKey) : null;
}

// ---------------------------------------------------------------------------
// DER
// ---------------------------------------------------------------------------

function tlv(tag: number, body: Buffer): Buffer {
  const n = body.length;
  let len: Buffer;
  if (n < 0x80) len = Buffer.from([n]);
  else {
    const bytes: number[] = [];
    for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
    len = Buffer.from([0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), len, body]);
}

const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts));

/** A non-negative INTEGER from big-endian bytes. */
function int(bytes: Buffer): Buffer {
  let b = bytes;
  while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
  return tlv(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
}

function oid(dotted: string): Buffer {
  const [a, b, ...rest] = dotted.split(".").map(Number);
  const out = [a * 40 + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >>> 7; v > 0; v >>>= 7) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

/** UTCTime through 2049, GeneralizedTime after (RFC 5280). */
function time(d: Date): Buffer {
  const s = d.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z";
  return d.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(s.slice(2))) : tlv(0x18, Buffer.from(s));
}
