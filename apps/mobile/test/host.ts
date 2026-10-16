// A desktop Ret for testing the phone against: the desktop's own remote-access host and agent
// muxes (src/main/remote), with the web demo's scripted engines behind them instead of Codex and
// Claude Code. Its threads, streaming turns, approvals and questions are the demo's.

import type { EngineStatus, ProviderId, ProvidersSettings } from "@shared/bridge";
import { PROVIDER_IDS } from "@shared/bridge";
import { createDeviceCert, certId } from "../../../src/main/remote/cert";
import { RemoteHost, type HostCalls } from "../../../src/main/remote/host";
import { AgentMux } from "../../../src/main/remote/mux";
import type { PushSender } from "../../../src/main/remote/push";
import type { RemoteStore } from "../../../src/main/remote/store";
import { DemoEngine, World } from "../../../src/renderer/demo/engine";
import { populate } from "../../../src/renderer/demo/fixtures";

export interface TestHost {
  host: RemoteHost;
  store: RemoteStore;
  world: World;
  muxes: Record<ProviderId, AgentMux>;
  port: number;
  stop(): Promise<void>;
}

export interface TestHostOptions {
  name?: string;
  port?: number;
  /** Where to listen ("127.0.0.1" keeps a test off the network; undefined: everywhere). */
  bind?: string;
  calls?: HostCalls;
  /** Stands in for Expo's push service. */
  push?: PushSender;
}

export async function startTestHost(opts: TestHostOptions = {}): Promise<TestHost> {
  if (opts.bind) process.env.RET_REMOTE_BIND = opts.bind;
  else delete process.env.RET_REMOTE_BIND;
  const cert = createDeviceCert();
  const store = {
    identity: { id: certId(cert.certPem), keyPem: cert.keyPem, certPem: cert.certPem },
    settings: { hosting: true, name: opts.name ?? "Test Desktop", port: opts.port ?? 0 },
    clients: [],
    hosts: [],
    saveSettings() {},
    saveClients() {},
    saveHosts() {},
  } as unknown as RemoteStore;

  const world = new World();
  populate(world);
  const providers: ProvidersSettings = { enabled: { codex: true, claude: true }, claude: { source: "system", customPath: null, autoUpdate: false } };
  const muxes = {} as Record<ProviderId, AgentMux>;
  for (const p of PROVIDER_IDS) {
    const status: EngineStatus = {
      provider: p,
      state: "running",
      generation: 1,
      version: p === "codex" ? "0.162.1" : "2.1.296",
      binaryPath: null,
      source: "system",
      engine: "dedicated",
      error: null,
      stderrTail: [],
    };
    world.engines[p] = new DemoEngine(p, world, (lines) => muxes[p].fromEngine(lines), status);
    muxes[p] = new AgentMux((line) => setTimeout(() => world.engines[p].receive(line), 0), p === "codex", status);
  }

  // The desktop's calls (src/main/index.ts), over the demo's files; images saved go in memory.
  const images = new Map<string, string>();
  const calls: HostCalls = {
    "git.info": (path: unknown) => ({ isRepo: true, root: String(path), branch: "main" }),
    "git.mainCheckouts": () => ({}),
    "files.stat": (path: unknown) => world.fs.stat(String(path)),
    "files.saveImage": (data: unknown, ext: unknown) => {
      const path = `/tmp/ret-images/${images.size + 1}.${String(ext).replace(/[^a-z0-9]/gi, "") || "png"}`;
      images.set(path, String(data));
      return path;
    },
    image: (path: unknown) => images.get(String(path)) ?? null,
    "apps.info": () => ({ name: null, icon: null }),
    ...opts.calls,
  };
  const host = new RemoteHost({ store, muxes, providers: () => providers, calls, changed: () => {}, connected: () => {}, push: opts.push });
  await host.start();
  if (!host.port) throw new Error(host.error ?? "The test host didn't start");
  return {
    host,
    store,
    world,
    muxes,
    port: host.port,
    stop: () => host.stop(),
  };
}
