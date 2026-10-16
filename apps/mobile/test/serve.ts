// The test desktop on the network, for the app on a simulator or a phone: the desktop's host and
// discovery with the demo's engines (host.ts). It always has a pairing code out; the current one,
// with where it listens, is in /tmp/ret-test-host.json.
import { writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { Discovery } from "../../../src/main/remote/discovery";
import { startTestHost } from "./host";

const port = Number(process.argv[2] ?? 47899);
const name = "Ret Test Desktop";
const desk = await startTestHost({ name, port });
const discovery = new Discovery(desk.store.identity.id, () => {});
discovery.publish(name, desk.port);

const addresses = Object.values(networkInterfaces())
  .flat()
  .filter((a) => a && a.family === "IPv4" && !a.internal)
  .map((a) => a!.address);

function report() {
  const p = desk.host.pairing;
  const state = { name, id: desk.store.identity.id, port: desk.port, addresses, code: p?.code ?? null, clients: desk.store.clients.map((c) => c.name), result: desk.host.pairingResult };
  writeFileSync("/tmp/ret-test-host.json", JSON.stringify(state, null, 2));
  console.log(`[test host] ${addresses.join(", ")}:${desk.port} · code ${state.code ?? "–"} · paired: ${state.clients.join(", ") || "none"}`);
}

// Always a code on show: a new one whenever the last is used up, expires or is burnt.
setInterval(() => {
  if (!desk.host.pairing) {
    desk.host.startPairing();
    report();
  }
}, 1000);
desk.host.startPairing();
report();

process.on("SIGINT", () => {
  discovery.destroy();
  void desk.stop().then(() => process.exit(0));
});
