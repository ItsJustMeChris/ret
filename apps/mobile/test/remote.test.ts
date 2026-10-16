// The phone's remote access against the desktop's own host code (see host.ts): pairing with the
// real CPace on the other end, a session through the real muxes, calls, and being revoked.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { engineId } from "@shared/bridge";
import { hostKeyOf } from "@shared/remote";
import { Pake as DesktopPake, confirmTag as desktopTag } from "../../../src/main/remote/pake";
import { RemoteAccess, type AccessStore } from "../src/remote/access";
import { toHex } from "../src/remote/bytes";
import type { HostRecord } from "../src/remote/link";
import { Pake, confirmTag } from "../src/remote/pake";
import { startTestHost, type TestHost } from "./host";
import { nodeIdentity, nodeTransport, type NodeIdentity } from "./nodeTransport";

let desk: TestHost;
let phone: NodeIdentity;

before(async () => {
  desk = await startTestHost({ bind: "127.0.0.1", name: "Studio" });
  phone = await nodeIdentity();
});
after(() => desk.stop());

function memoryStore(): AccessStore & { saved: HostRecord[] } {
  const s = {
    saved: [] as HostRecord[],
    load: async () => ({ hosts: s.saved, name: "Test iPhone" }),
    save: (d: { hosts: HostRecord[] }) => void (s.saved = d.hosts),
  };
  return s;
}

function access(store = memoryStore(), events: Partial<ConstructorParameters<typeof RemoteAccess>[0]> = {}) {
  return new RemoteAccess({
    transport: nodeTransport(phone),
    deviceId: phone.id,
    defaultName: "Test iPhone",
    store,
    state: () => {},
    notify: () => {},
    engineLines: () => {},
    engineStatus: () => {},
    ...events,
  });
}

const until = async (what: string, ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("CPace: the phone's and the desktop's halves agree on the key and tags", () => {
  const sid = Buffer.alloc(16, 7);
  const channel = Buffer.from("channel");
  const client = new Pake("123456", Uint8Array.from(sid), Uint8Array.from(channel));
  const host = new DesktopPake("123456", sid, channel);
  const shares = { client: client.share, host: host.share };
  const k1 = client.finish(host.share, shares);
  const k2 = host.finish(client.share, shares);
  assert.equal(toHex(k1), k2.toString("hex"));
  assert.equal(toHex(confirmTag(k1, "client")), desktopTag(k2, "client").toString("hex"));
  // A different code: different keys.
  const wrong = new Pake("654321", Uint8Array.from(sid), Uint8Array.from(channel));
  assert.notEqual(toHex(wrong.finish(host.share, { client: wrong.share, host: host.share })), k2.toString("hex"));
});

test("a wrong code is refused, and burns the code", async () => {
  desk.host.startPairing();
  const code = desk.host.pairing!.code;
  const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, "0");
  const a = access();
  await a.init();
  await assert.rejects(a.pair({ address: "127.0.0.1", port: desk.port }, wrong), /wasn't right/);
  assert.equal(desk.host.pairing, null, "one wrong guess ends the pairing");
  assert.equal(desk.store.clients.length, 0);
});

test("pairing pins the desktop, and the desktop knows the phone by its key", async () => {
  desk.host.startPairing();
  const store = memoryStore();
  const a = access(store);
  await a.init();
  const host = await a.pair({ address: "127.0.0.1", port: desk.port }, desk.host.pairing!.code);
  assert.equal(host.id, desk.store.identity.id);
  assert.equal(host.name, "Studio");
  assert.equal(store.saved[0].id, desk.store.identity.id);
  assert.deepEqual(
    desk.store.clients.map((c) => [c.id, c.name]),
    [[phone.id, "Test iPhone"]],
  );
  await until("the link", () => a.state().hosts[0]?.connected);
  a.forget(host.id);
});

test("a session: engine statuses, JSON-RPC through the mux, and calls", async () => {
  const store = memoryStore();
  store.saved = [{ id: desk.store.identity.id, name: "Studio", pairedAt: Date.now(), lastSeen: null, address: "127.0.0.1", port: desk.port }];
  const lines: Record<string, string[]> = {};
  const statuses: Record<string, string> = {};
  const a = access(store, {
    engineLines: (engine, l) => (lines[engine] ??= []).push(...l),
    engineStatus: (s) => (statuses[engineId(s.provider, s.host)] = s.state),
  });
  await a.init();
  const key = hostKeyOf(desk.store.identity.id);
  const codex = engineId("codex", key);
  await until("codex running", () => statuses[codex] === "running");
  assert.equal(statuses[engineId("claude", key)], "running");

  const link = a.linkFor(key)!;
  link.send("codex", JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "ret", title: "Ret", version: "test" }, capabilities: { experimentalApi: true } } }));
  link.send("codex", JSON.stringify({ method: "initialized" }));
  link.send("codex", JSON.stringify({ id: 2, method: "thread/list", params: { limit: 50 } }));
  const reply = (id: number) => (lines[codex] ?? []).map((l) => JSON.parse(l)).find((m) => m.id === id && !m.method);
  await until("thread/list", () => !!reply(2));
  assert.ok(reply(1).result, "initialize answered");
  assert.ok(reply(2).result.data.length > 3, "the desktop's threads came across");

  assert.deepEqual(await link.call("git.info", "/src/app"), { isRepo: true, root: "/src/app", branch: "main" });
  await assert.rejects(link.call("fs.rm", "/"), /isn't available from another device/);
  a.forget(desk.store.identity.id);
});

test("revoked on the desktop: the phone forgets it", async () => {
  const store = memoryStore();
  store.saved = [{ id: desk.store.identity.id, name: "Studio", pairedAt: Date.now(), lastSeen: null, address: "127.0.0.1", port: desk.port }];
  let told = "";
  const a = access(store, { notify: (_t, body) => (told = body) });
  await a.init();
  await until("connected", () => a.state().hosts[0]?.connected);
  desk.host.revoke(phone.id);
  await until("forgotten", () => a.state().hosts.length === 0);
  assert.match(told, /removed this device/);
  assert.equal(store.saved.length, 0);
});

test("a stranger's key is turned away", async () => {
  const stranger = await nodeIdentity();
  const store = memoryStore();
  store.saved = [{ id: desk.store.identity.id, name: "Studio", pairedAt: Date.now(), lastSeen: null, address: "127.0.0.1", port: desk.port }];
  const a = new RemoteAccess({
    transport: nodeTransport(stranger),
    deviceId: stranger.id,
    defaultName: "Stranger",
    store,
    state: () => {},
    notify: () => {},
    engineLines: () => {},
    engineStatus: () => {},
  });
  await a.init();
  await until("forgotten", () => a.state().hosts.length === 0);
});

test("the pinned key is checked: another device at the same address is refused", async () => {
  const other = await startTestHost({ bind: "127.0.0.1", name: "Impostor" });
  const store = memoryStore();
  // The record says Studio, but the address answers with another key.
  store.saved = [{ id: desk.store.identity.id, name: "Studio", pairedAt: Date.now(), lastSeen: null, address: "127.0.0.1", port: other.port }];
  const a = access(store);
  await a.init();
  await until("an error", () => !!a.problem(desk.store.identity.id));
  assert.match(a.problem(desk.store.identity.id)!, /different device/);
  assert.equal(a.state().hosts[0].connected, false);
  a.forget(desk.store.identity.id);
  await other.stop();
});
