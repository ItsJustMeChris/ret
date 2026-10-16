// Notices for a phone that's away: it gives its push token over the link, says when it goes to the
// background, and the desktop's host (src/main/remote) sends through the push service only then.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { hostKeyOf } from "@shared/remote";
import type { PushMessage, PushResult } from "../../../src/main/remote/push";
import { RemoteAccess } from "../src/remote/access";
import type { HostRecord } from "../src/remote/link";
import { startTestHost, type TestHost } from "./host";
import { nodeIdentity, nodeTransport } from "./nodeTransport";

const TOKEN = "ExponentPushToken[abcdefghijkl12345]";
let desk: TestHost;
let sent: PushMessage[][] = [];
let answer: (m: PushMessage) => PushResult = () => ({ ok: true });
let phone: RemoteAccess;
let phoneId: string;

const until = async (what: string, ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
const settle = () => new Promise((r) => setTimeout(r, 150));
const record = () => desk.store.clients.find((c) => c.id === phoneId)!;

before(async () => {
  desk = await startTestHost({
    bind: "127.0.0.1",
    push: async (messages) => {
      sent.push(messages);
      return messages.map((m) => answer(m));
    },
  });
  const id = await nodeIdentity();
  phoneId = id.id;
  desk.store.clients.push({ id: id.id, name: "Test iPhone", pairedAt: Date.now(), lastSeen: null });
  const hosts: HostRecord[] = [{ id: desk.store.identity.id, name: "Studio", pairedAt: Date.now(), lastSeen: null, address: "127.0.0.1", port: desk.port }];
  phone = new RemoteAccess({
    transport: nodeTransport(id),
    deviceId: id.id,
    defaultName: "Test iPhone",
    store: { load: async () => ({ hosts, name: "Test iPhone" }), save: () => {} },
    state: () => {},
    notify: () => {},
    engineLines: () => {},
    engineStatus: () => {},
  });
  await phone.init();
  await until("connected", () => !!phone.state().hosts[0]?.connected);
});
after(() => desk.stop());

test("only push tokens are kept", async () => {
  phone.setPushToken("https://example.com/collect");
  await settle();
  assert.equal(record().push, undefined);
});

test("the phone's token reaches the desktop; a notice waits until it's away", async () => {
  phone.setPushToken(TOKEN);
  await until("token", () => record().push === TOKEN);
  assert.equal(desk.host.connected().has(phoneId), true);
  desk.host.notifyDevices({ title: "Codex finished", body: "Rate-limit the login endpoint", threadId: "t1" });
  await settle();
  assert.equal(sent.length, 0, "in front: it sees it live");

  phone.setAway(true);
  await settle();
  desk.host.notifyDevices({ title: "Codex finished", body: "Rate-limit the login endpoint", threadId: "t1" });
  await until("a push", () => sent.length === 1);
  assert.deepEqual(sent[0], [{ to: TOKEN, title: "Codex finished", body: "Rate-limit the login endpoint", data: { threadId: "t1", host: hostKeyOf(desk.store.identity.id) } }]);

  phone.setAway(false);
  await settle();
  desk.host.notifyDevices({ title: "Codex finished", body: "again", threadId: "t1" });
  await settle();
  assert.equal(sent.length, 1, "back in front: nothing more");
});

test("a phone that isn't connected is notified too", async () => {
  sent = [];
  phone.forget(desk.store.identity.id);
  await until("disconnected", () => !desk.host.connected().has(phoneId));
  desk.host.notifyDevices({ title: "Claude Code needs your input", body: "Orders page", threadId: "t2" });
  await until("a push", () => sent.length === 1);
  assert.equal(sent[0][0].to, TOKEN);
});

test("a dead token is forgotten", async () => {
  answer = () => ({ ok: false, gone: true, error: "DeviceNotRegistered" });
  desk.host.notifyDevices({ title: "x", body: "y", threadId: null });
  await until("forgotten", () => record().push === undefined);
});
