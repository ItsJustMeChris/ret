import RetTls from "../../modules/ret-tls";
import { fromBase64, toBase64 } from "./bytes";
import { buildCertificate, deviceIdOf } from "./cert";
import { SocketEvents, type TlsSocket, type Transport } from "./transport";

/**
 * This phone's device identity: the key the native module keeps (keychain / Android Keystore),
 * and a certificate around it, made the first time and kept with it. The id is what desktops pin.
 */
export async function deviceIdentity(): Promise<{ id: string; transport: Transport }> {
  const { publicKey, certificate } = await RetTls.identity();
  const point = fromBase64(publicKey);
  if (!certificate) {
    const serial = crypto.getRandomValues(new Uint8Array(16));
    const der = await buildCertificate(point, async (tbs) => fromBase64(await RetTls.sign(toBase64(tbs))), serial);
    await RetTls.setCertificate(toBase64(der));
  }
  return { id: deviceIdOf(point), transport: nativeTransport };
}

const sockets = new Map<number, SocketEvents>();
RetTls.addListener("onLines", ({ id, lines }) => sockets.get(id)?.lines(lines));
RetTls.addListener("onClose", ({ id, reason }) => {
  sockets.get(id)?.close(reason);
  sockets.delete(id);
});

/** TLS 1.3 through the native module, which presents the device key and checks the peer's. */
export const nativeTransport: Transport = {
  async connect(target, expect, timeoutMs) {
    const { id, peer } = await RetTls.connect({ host: target.address, port: target.port, expect, timeoutMs });
    const events = new SocketEvents();
    sockets.set(id, events);
    const socket: TlsSocket = {
      peer,
      write: (text) => RetTls.write(id, text),
      close: () => RetTls.close(id),
      exportKeyingMaterial: async (label, length) => fromBase64(await RetTls.exportKeyingMaterial(id, label, length)),
      setMaxLine: (max) => RetTls.setMaxLine(id, max),
      onLines: (cb) => events.onLines(cb),
      onClose: (cb) => events.onClose(cb),
    };
    return socket;
  },
};
