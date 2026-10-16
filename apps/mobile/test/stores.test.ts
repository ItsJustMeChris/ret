// The app, headless: the desktop's own stores and actions (src/renderer/state), booted on the
// phone's bridge (createMobileBridge) and connected to a paired desktop (host.ts). What the
// screens read and do, without the screens.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { engineId, type EngineId } from "@shared/bridge";
import { hostKeyOf } from "@shared/remote";
import type { MobileBridgeDeps } from "../src/platform/createBridge";
import type { HostRecord } from "../src/remote/link";
import { startTestHost, type TestHost } from "./host";
import { nodeIdentity, nodeTransport } from "./nodeTransport";

let desk: TestHost;
let state: typeof import("../../../src/renderer/state/threads");
let actions: typeof import("../../../src/renderer/state/actions");
let conn: typeof import("../../../src/renderer/state/conn");
let tree: typeof import("../../../src/renderer/state/projectTree");
let ui: typeof import("../../../src/renderer/state/ui");
let fileText: typeof import("../../../src/renderer/lib/fileText");
let bridgeMod: typeof import("./support/bridge");
let codex: EngineId;
const notes: string[] = [];

const until = async (what: string, ok: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

before(async () => {
  desk = await startTestHost({ bind: "127.0.0.1", name: "Studio" });
  const phone = await nodeIdentity();
  // Paired already: the desktop knows the phone, the phone has the desktop on record.
  desk.store.clients.push({ id: phone.id, name: "Test iPhone", pairedAt: Date.now(), lastSeen: null });
  const hosts: HostRecord[] = [{ id: desk.store.identity.id, name: "Studio", pairedAt: Date.now(), lastSeen: null, address: "127.0.0.1", port: desk.port }];
  codex = engineId("codex", hostKeyOf(desk.store.identity.id));
  (globalThis as { __retTestBridge?: MobileBridgeDeps }).__retTestBridge = {
    platform: "ios",
    appVersion: "test",
    identity: async () => ({ id: phone.id, transport: nodeTransport(phone) }),
    store: { load: async () => ({ hosts, name: "Test iPhone" }), save: () => {} },
    defaultName: "Test iPhone",
    notify: (title, body) => void notes.push(`${title}: ${body}`),
    openExternal: async () => {},
    copy: async () => {},
  };
  actions = await import("../../../src/renderer/state/actions");
  state = await import("../../../src/renderer/state/threads");
  conn = await import("../../../src/renderer/state/conn");
  tree = await import("../../../src/renderer/state/projectTree");
  ui = await import("../../../src/renderer/state/ui");
  fileText = await import("../../../src/renderer/lib/fileText");
  bridgeMod = await import("./support/bridge");
  actions.bootstrap();
});
after(() => desk.stop());

test("the desktop's threads load into the shared stores, grouped by project", async () => {
  await until("thread list", () => Object.values(state.useThreads.getState().owner).filter((o) => o === codex).length > 3);
  assert.equal(conn.useConn.getState().providers[codex]?.status?.state, "running");
  // This phone's own engines are off: every thread is the paired desktop's.
  assert.ok(Object.values(state.useThreads.getState().owner).every((o) => o.includes("@")));
  const projects = tree.projectTreeNow();
  assert.ok(projects.length > 0);
  assert.ok(projects.every((p) => p.host === hostKeyOf(desk.store.identity.id)));
});

test("the waiting approval and question reach the phone", async () => {
  await until("requests", () => Object.keys(state.useThreads.getState().requests).length >= 2);
  const methods = Object.values(state.useThreads.getState().requests).map((r) => r.method);
  assert.ok(methods.some((m) => /approval|requestApproval/i.test(m)), `an approval among ${methods}`);
  assert.ok(methods.some((m) => /requestUserInput|question/i.test(m)), `a question among ${methods}`);
});

test("opening a thread hydrates it; sending streams the reply back", async () => {
  const s = state.useThreads.getState();
  const idle = Object.values(s.threads).find((t) => s.owner[t.id] === codex && t.status.type === "idle")!;
  assert.ok(idle, "an idle Codex thread");
  state.markVisible(idle.id, 1);
  await actions.hydrateThread(idle.id);
  await until("history", () => !!state.useThreads.getState().live[idle.id]?.hydrated);
  const before = state.useThreads.getState().live[idle.id].turnOrder.length;
  assert.ok(before > 0);

  await actions.sendMessage(idle.id, "Hello from the phone");
  await until("a new turn", () => state.useThreads.getState().live[idle.id].turnOrder.length > before);
  await until("an answer", () => {
    const lt = state.useThreads.getState().live[idle.id];
    const turn = lt.turns[lt.turnOrder.at(-1)!];
    return turn.status === "completed" && turn.itemIds.some((id) => lt.items[id]?.type === "agentMessage" && (lt.items[id] as { text: string }).text.length > 0);
  }, 20_000);
  const lt = state.useThreads.getState().live[idle.id];
  const mine = lt.turns[lt.turnOrder.at(-1)!].itemIds.map((id) => lt.items[id]).find((i) => i?.type === "userMessage");
  assert.ok(mine, "my message is in the turn");
});

test("answering an approval reaches the desktop's engine", async () => {
  const [key, req] = Object.entries(state.useThreads.getState().requests).find(([, r]) => /approval/i.test(r.method))!;
  const engine = desk.world.engines[req.engine.startsWith("claude") ? "claude" : "codex"] as unknown as { requests: Map<string, unknown> };
  assert.ok(engine.requests.has(String(req.id)), "the desktop's engine is waiting on it");
  actions.respondToRequest(key, { decision: "accept" });
  assert.equal(state.useThreads.getState().requests[key], undefined);
  // The answer crossed the link and the desktop's mux: the engine stopped waiting.
  await until("the engine's answer", () => !engine.requests.has(String(req.id)));
});

test("a new thread starts in a project on the paired computer", async () => {
  const host = hostKeyOf(desk.store.identity.id);
  const project = tree.projectTreeNow().find((p) => p.host === host)!;
  const draft = `draft:${ui.newId()}`;
  ui.useUI.setState((s) => ({ drafts: { ...s.drafts, [draft]: { cwd: project.path, projectKey: project.key, createdAt: Date.now() } } }));
  const id = await actions.sendMessage(draft, "Add a health check");
  assert.notEqual(id, draft);
  assert.equal(state.useThreads.getState().owner[id], codex);
  assert.equal(ui.useUI.getState().drafts[draft], undefined, "the draft became the thread");
  await until("its turn", () => (state.useThreads.getState().live[id]?.turnOrder.length ?? 0) > 0);
});

test("files are read through the computer's agent", async () => {
  const host = hostKeyOf(desk.store.identity.id);
  const project = tree.projectTreeNow().find((p) => p.host === host)!;
  const { rpcFor } = await import("../../../src/renderer/rpc/client");
  const listing = (await rpcFor(codex).request("fs/readDirectory", { path: project.path })) as { entries: { fileName: string; isFile: boolean }[] };
  const file = listing.entries.find((e) => e.isFile)!;
  assert.ok(file, `a file in ${project.path}`);
  const read = await fileText.readText(`${project.path}/${file.fileName}`, host);
  assert.ok("text" in read && read.text.length > 0);
  await assert.rejects(fileText.readText(`${project.path}/nope.txt`, host), /not found/i);
});

test("an image goes to the computer, and comes back to be shown", async () => {
  const host = hostKeyOf(desk.store.identity.id);
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const path = await bridgeMod.bridge.files.saveImage(bytes.buffer, "png", host);
  assert.match(path, /\.png$/);
  const link = (await bridgeMod.access).linkFor(host)!;
  assert.equal(await link.call("image", path), Buffer.from(bytes).toString("base64"));
});
