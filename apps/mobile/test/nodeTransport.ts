// The phone's transport, played by Node: a P-256 key made here, a certificate built by the
// phone's own cert.ts, and TLS 1.3 through node:tls. Everything above it is the app's code.

import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import tls from "node:tls";
import { buildCertificate, deviceIdOf } from "../src/remote/cert";
import { SocketEvents, type TlsSocket, type Transport } from "../src/remote/transport";

export interface NodeIdentity {
  id: string;
  keyPem: string;
  certPem: string;
}

export async function nodeIdentity(): Promise<NodeIdentity> {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const point = Uint8Array.from(Buffer.concat([Buffer.of(4), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]));
  const der = await buildCertificate(point, async (tbs) => Uint8Array.from(sign("sha256", tbs, privateKey)), Uint8Array.from(randomBytes(16)));
  const certPem = `-----BEGIN CERTIFICATE-----\n${Buffer.from(der).toString("base64").replace(/.{64}/g, "$&\n").trimEnd()}\n-----END CERTIFICATE-----\n`;
  return { id: deviceIdOf(point), keyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string, certPem };
}

export function nodeTransport(identity: NodeIdentity): Transport {
  return {
    connect: (target, expect, timeoutMs) =>
      new Promise<TlsSocket>((resolve, reject) => {
        const socket = tls.connect({
          host: target.address,
          port: target.port,
          key: identity.keyPem,
          cert: identity.certPem,
          rejectUnauthorized: false,
          minVersion: "TLSv1.3",
        });
        const timer = setTimeout(() => fail(new Error("timed out")), timeoutMs);
        const fail = (err: Error) => {
          clearTimeout(timer);
          socket.destroy();
          reject(err);
        };
        socket.once("error", fail);
        socket.once("secureConnect", () => {
          clearTimeout(timer);
          socket.removeListener("error", fail);
          const cert = socket.getPeerX509Certificate();
          const peer = cert ? createHash("sha256").update(cert.publicKey.export({ type: "spki", format: "der" })).digest("hex") : "";
          if (!peer || (expect && peer !== expect)) return fail(new Error("a different device"));
          resolve(wrap(socket, peer));
        });
      }),
  };
}

function wrap(socket: tls.TLSSocket, peer: string): TlsSocket {
  const events = new SocketEvents();
  let maxLine = 64 * 1024;
  let partial = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    const parts = (partial + chunk).split("\n");
    partial = parts.pop()!;
    if (partial.length > maxLine || parts.some((l) => l.length > maxLine)) {
      socket.destroy();
      return events.close("Message too long");
    }
    if (parts.length) events.lines(parts);
  });
  socket.on("close", () => events.close("Connection closed"));
  socket.on("error", (err) => events.close(err.message));
  return {
    peer,
    write: (text) => void socket.write(text),
    close: () => socket.end(),
    exportKeyingMaterial: async (label, length) => Uint8Array.from(socket.exportKeyingMaterial(length, label, Buffer.alloc(0))),
    setMaxLine: (n) => (maxLine = n),
    onLines: (cb) => events.onLines(cb),
    onClose: (cb) => events.onClose(cb),
  };
}
