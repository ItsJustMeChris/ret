import {
  PROVIDER_IDS,
  hostOf,
  providerOf,
  type AppInfo,
  type AppUpdateState,
  type EngineStatus,
  type ProviderId,
  type ProvidersSettings,
  type RetBridge,
  type UpdaterState,
} from "@shared/bridge";
import type { RemoteState } from "@shared/remote";
import { RemoteAccess, type AccessStore, type Found } from "../remote/access";
import { toBase64 } from "../remote/bytes";
import type { Transport } from "../remote/transport";

export interface MobileBridgeDeps {
  platform: string;
  appVersion: string;
  /** This device's id and the transport presenting its key; ready before any connection. */
  identity(): Promise<{ id: string; transport: Transport }>;
  store: AccessStore;
  defaultName: string;
  discover?(found: (list: Found[]) => void): void;
  notify(title: string, body: string): void;
  openExternal(url: string): Promise<void>;
  copy(text: string): Promise<void>;
}

const UNSUPPORTED = "Do that on your computer";

/**
 * Ret's bridge on the phone. The phone runs no agents of its own: its engines are the paired
 * desktops' ("codex@<host>"), reached over remote access exactly as a desktop window reaches a
 * paired computer's. This computer's engines (plain "codex") stay off, so the shared stores see a
 * Ret whose every thread lives on a paired device. File, git and app calls go to the device the
 * path is on; anything that needs a local machine says so.
 */
export function createMobileBridge(deps: MobileBridgeDeps): { bridge: RetBridge; access: Promise<RemoteAccess> } {
  const messageSubs = new Set<(engine: `${ProviderId}@${string}`, lines: string[]) => void>();
  const statusSubs = new Set<(s: EngineStatus) => void>();
  const remoteSubs = new Set<(s: RemoteState) => void>();
  let lastState: RemoteState | null = null;

  /** The phone's own engines: none run here. */
  const settings: ProvidersSettings = {
    enabled: Object.fromEntries(PROVIDER_IDS.map((p) => [p, false])) as Record<ProviderId, boolean>,
    claude: { source: "system", customPath: null, autoUpdate: false },
    opencode: { source: "system", customPath: null },
    acp: { name: "", command: "" },
  };
  const localStatus = (provider: ProviderId): EngineStatus => ({
    provider,
    state: "disabled",
    generation: 0,
    version: null,
    binaryPath: null,
    source: null,
    engine: "dedicated",
    error: null,
    stderrTail: [],
  });

  let failure: string | null = null;
  const access: Promise<RemoteAccess> = deps.identity().then(
    async ({ id, transport }) => {
      const a = new RemoteAccess({
        transport,
        deviceId: id,
        defaultName: deps.defaultName,
        store: deps.store,
        discover: deps.discover,
        notify: deps.notify,
        state: (s) => {
          lastState = s;
          remoteSubs.forEach((cb) => cb(s));
        },
        engineLines: (engine, lines) => messageSubs.forEach((cb) => cb(engine as `${ProviderId}@${string}`, lines)),
        engineStatus: (s) => statusSubs.forEach((cb) => cb(s)),
      });
      await a.init();
      return a;
    },
    (err: Error) => {
      failure = `This phone couldn't set up its device key: ${err.message}`;
      throw err;
    },
  );
  // A failed setup shows in the remote state (below); nothing is left unhandled.
  access.catch(() => {});

  const remoteState = async (): Promise<RemoteState> => {
    try {
      return (await access).state();
    } catch {
      return { hosting: false, name: deps.defaultName, deviceId: "", port: null, addresses: [], error: failure, pairing: null, pairingResult: null, clients: [], hosts: [], nearby: [] };
    }
  };

  /** The link to the desktop a call is about; this phone has nothing of its own to answer with. */
  const linkTo = async (host: string | null | undefined) => {
    if (!host) throw new Error(UNSUPPORTED);
    const link = (await access).linkFor(host);
    if (!link) throw new Error("That computer isn't paired any more");
    return link;
  };

  const sub = <T>(set: Set<T>, cb: T) => {
    set.add(cb);
    return () => void set.delete(cb);
  };

  const unsupported = async (): Promise<never> => {
    throw new Error(UNSUPPORTED);
  };

  const updater: UpdaterState = {
    settings: { source: "system", autoUpdate: false, channel: "latest", customPath: null, checkIntervalHours: 2, engine: "dedicated" },
    phase: "idle",
    progress: null,
    latest: null,
    running: null,
    staged: null,
    installed: [],
    lastCheckedAt: null,
    error: null,
  };
  const appUpdate: AppUpdateState = { phase: "unsupported", version: null, progress: null, lastCheckedAt: null, error: null };

  // The link is created asynchronously; lines sent before it exists have no engine to go to anyway.
  let ready: RemoteAccess | null = null;
  void access.then((a) => (ready = a), () => {});

  const bridge: RetBridge = {
    platform: deps.platform,
    appVersion: deps.appVersion,
    agents: {
      send: (engine, line) => {
        const host = hostOf(engine);
        if (host) ready?.linkFor(host)?.send(providerOf(engine), line);
      },
      onMessages: (cb) => sub(messageSubs, cb as (engine: `${ProviderId}@${string}`, lines: string[]) => void),
      onStatus: (cb) => sub(statusSubs, cb),
      getStatus: async (engine) => {
        const host = hostOf(engine);
        if (!host) return localStatus(providerOf(engine));
        const link = (await access).linkFor(host);
        if (link) return link.status(providerOf(engine));
        return { ...localStatus(providerOf(engine)), host, state: "error", error: "That computer isn't paired any more" };
      },
      restart: async (engine) => {
        await (await linkTo(hostOf(engine))).call("agents.restart", providerOf(engine));
      },
      getSettings: async () => settings,
      onSettings: () => () => {},
      setSettings: async () => settings,
      openLogin: unsupported,
      update: unsupported,
    },
    updater: {
      getState: async () => updater,
      onState: () => () => {},
      check: async () => updater,
      apply: async () => {},
      setSettings: async () => updater,
    },
    appUpdate: {
      getState: async () => appUpdate,
      onState: () => () => {},
      check: async () => appUpdate,
      install: async () => {},
    },
    dialog: {
      pickFolder: async () => null,
      pickFile: async () => null,
    },
    shell: {
      openExternal: deps.openExternal,
      openPath: async () => "Open it on your computer",
      reveal: async () => {},
    },
    editor: {
      available: async () => false,
      open: async () => {},
    },
    git: {
      info: async (path, host) => (host ? (await linkTo(host)).call("git.info", path) : { isRepo: false, root: null, branch: null }),
      createWorktree: async (cwd, label, host) => (await linkTo(host)).call("git.createWorktree", cwd, label),
      mainCheckouts: async (cwds, host) => (host ? (await linkTo(host)).call("git.mainCheckouts", cwds) : {}),
    },
    files: {
      saveImage: async (data, ext, host) => (await linkTo(host)).call("files.saveImage", toBase64(new Uint8Array(data)), ext),
      stat: async (path, host) => (host ? (await linkTo(host)).call("files.stat", path) : { exists: false, isDir: false }),
      visualization: async () => ({ error: "Visualizations show in Ret on your computer" }),
      pathFor: () => null,
    },
    apps: {
      info: async (appId, host): Promise<AppInfo> => {
        if (!host) return { name: null, icon: null };
        const v = ((await (await linkTo(host)).call("apps.info", appId)) ?? {}) as { name?: unknown; icon?: unknown };
        return {
          name: typeof v.name === "string" ? v.name.slice(0, 200) : null,
          icon: typeof v.icon === "string" && v.icon.startsWith("data:image/png;base64,") && v.icon.length < 512 * 1024 ? v.icon : null,
        };
      },
    },
    copy: deps.copy,
    edit: () => {},
    onSpelling: () => () => {},
    notify: deps.notify,
    setTheme: () => {},
    remoteAccess: {
      getState: remoteState,
      onState: (cb) => {
        const off = sub(remoteSubs, cb);
        if (lastState) cb(lastState);
        return off;
      },
      setHosting: unsupported,
      setName: async (name) => (await access).setName(name),
      startPairing: unsupported,
      stopPairing: remoteState,
      revoke: unsupported,
      pair: async (target, code) => (await access).pair(target, code),
      forget: async (hostId) => (await access).forget(hostId),
      discover: () => void access.then((a) => a.discover(), () => {}),
      // The phone has no threads of its own to tell anyone about.
      notifyDevices: () => {},
    },
  };
  return { bridge, access };
}
