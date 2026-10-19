import type { AppUpdateState, EngineStatus, ProviderId, ProvidersSettings, RetBridge, UpdaterState } from "@shared/bridge";
import { PROVIDER_IDS, providerOf } from "@shared/bridge";
import { noRemoteAccess } from "@shared/remote";
import { DemoEngine, World } from "./engine";
import { populate } from "./fixtures";
import { BRANCH, HOME, P, WORKTREES } from "./workspace";

declare const __RET_VERSION__: string;

/**
 * Ret's bridge for the web demo: everything the renderer asks of the desktop app, answered in
 * the page. Each provider's pipe leads to a scripted engine (engine.ts) instead of a process;
 * files come from the demo's in-memory disk; desktop-only things (dialogs, other apps, updates)
 * do something sensible or say they're not part of the demo.
 */
export function createDemoBridge(): RetBridge & { world: World } {
  const world = new World();
  populate(world);

  const messageSubs = new Set<(provider: ProviderId, lines: string[]) => void>();
  const statusSubs = new Set<(s: EngineStatus) => void>();
  const settingsSubs = new Set<(s: ProvidersSettings) => void>();
  const updaterSubs = new Set<(s: UpdaterState) => void>();
  const appUpdateSubs = new Set<(s: AppUpdateState) => void>();
  let settings: ProvidersSettings = {
    enabled: { codex: true, claude: true, opencode: false, acp: false },
    claude: { source: "system", customPath: null, autoUpdate: true },
    opencode: { source: "system", customPath: null },
    acp: { name: "", command: "" },
  };
  const hourAgo = Date.now() - 52 * 60_000;

  world.engines.codex = new DemoEngine("codex", world, (lines) => deliver("codex", lines), {
    state: "running",
    generation: 1,
    version: "0.162.1",
    binaryPath: `${HOME}/Library/Application Support/Ret/codex/versions/0.162.1/codex`,
    source: "managed",
    engine: "dedicated",
    error: null,
    stderrTail: [],
  });
  world.engines.claude = new DemoEngine("claude", world, (lines) => deliver("claude", lines), {
    state: "running",
    generation: 1,
    version: "2.1.296",
    binaryPath: `${HOME}/.local/bin/claude`,
    source: "system",
    engine: "dedicated",
    error: null,
    stderrTail: [],
    update: { phase: "idle", latest: "2.1.296", error: null, checkedAt: hourAgo, auto: true },
  });

  // The ACP agents are left out of the demo: off, with nothing behind them.
  for (const p of ["opencode", "acp"] as const) {
    world.engines[p] = new DemoEngine(p, world, (lines) => deliver(p, lines), {
      state: "disabled",
      generation: 0,
      version: null,
      binaryPath: null,
      source: null,
      engine: "dedicated",
      error: null,
      stderrTail: [],
    });
  }

  function deliver(provider: ProviderId, lines: string[]) {
    if (!settings.enabled[provider]) return;
    for (const cb of messageSubs) cb(provider, lines);
  }

  function setStatus(provider: ProviderId, patch: Partial<EngineStatus>) {
    const e = world.engines[provider];
    e.status = { ...e.status, ...patch };
    for (const cb of statusSubs) cb(e.status);
  }

  let updater: UpdaterState = {
    settings: { source: "managed", autoUpdate: true, channel: "latest", customPath: null, checkIntervalHours: 2, engine: "dedicated" },
    phase: "upToDate",
    progress: null,
    latest: "0.162.1",
    running: "0.162.1",
    staged: null,
    installed: ["0.162.1", "0.161.0"],
    lastCheckedAt: hourAgo,
    error: null,
  };
  const setUpdater = (patch: Partial<UpdaterState>) => {
    updater = { ...updater, ...patch };
    for (const cb of updaterSubs) cb(updater);
    return updater;
  };
  let appUpdate: AppUpdateState = { phase: "upToDate", version: null, progress: null, lastCheckedAt: hourAgo, error: null };
  const setAppUpdate = (patch: Partial<AppUpdateState>) => {
    appUpdate = { ...appUpdate, ...patch };
    for (const cb of appUpdateSubs) cb(appUpdate);
    return appUpdate;
  };
  const later = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const toast = async (message: string) => (await import("../state/toasts")).toast(message);
  const notInDemo = (what: string) => `${what} isn't part of the web demo. Download Ret to use it.`;

  const sub = <T>(set: Set<T>, cb: T) => {
    set.add(cb);
    return () => void set.delete(cb);
  };

  return {
    world,
    platform: "web",
    appVersion: typeof __RET_VERSION__ === "string" ? __RET_VERSION__ : "demo",
    agents: {
      send: (engine, line) => {
        const provider = providerOf(engine);
        if (!settings.enabled[provider]) return;
        setTimeout(() => world.engines[provider].receive(line), 0);
      },
      onMessages: (cb) => sub(messageSubs, cb),
      onStatus: (cb) => sub(statusSubs, cb),
      getStatus: async (engine) => world.engines[providerOf(engine)].status,
      restart: async (engine) => {
        const provider = providerOf(engine);
        world.engines[provider].disconnect();
        setStatus(provider, { state: "starting" });
        await later(500);
        setStatus(provider, { state: "running", generation: world.engines[provider].status.generation + 1 });
      },
      getSettings: async () => settings,
      onSettings: (cb) => sub(settingsSubs, cb),
      setSettings: async (patch) => {
        const prev = settings;
        settings = {
          ...settings,
          ...patch,
          enabled: { ...settings.enabled, ...patch.enabled, opencode: false, acp: false },
          claude: { ...settings.claude, ...patch.claude },
          opencode: { ...settings.opencode, ...patch.opencode },
          acp: { ...settings.acp, ...patch.acp },
        };
        for (const cb of settingsSubs) cb(settings);
        for (const p of PROVIDER_IDS) {
          if (prev.enabled[p] === settings.enabled[p]) continue;
          if (settings.enabled[p]) setStatus(p, { state: "running", generation: world.engines[p].status.generation + 1, error: null });
          else {
            world.engines[p].disconnect();
            setStatus(p, { state: "disabled" });
          }
        }
        return settings;
      },
      openLogin: async () => void toast(notInDemo("Signing in")),
      update: async (provider) => {
        const u = world.engines[provider].status.update;
        if (!u) return;
        setStatus(provider, { update: { ...u, phase: "checking" } });
        await later(1200);
        setStatus(provider, { update: { ...u, phase: "idle", checkedAt: Date.now() } });
      },
    },
    updater: {
      getState: async () => updater,
      onState: (cb) => sub(updaterSubs, cb),
      check: async () => {
        setUpdater({ phase: "checking" });
        await later(900);
        return setUpdater({ phase: "upToDate", lastCheckedAt: Date.now() });
      },
      apply: async () => {},
      setSettings: async (patch) => setUpdater({ settings: { ...updater.settings, ...patch } }),
    },
    appUpdate: {
      getState: async () => appUpdate,
      onState: (cb) => sub(appUpdateSubs, cb),
      check: async () => {
        setAppUpdate({ phase: "checking" });
        await later(900);
        return setAppUpdate({ phase: "upToDate", lastCheckedAt: Date.now() });
      },
      install: async () => {},
    },
    dialog: {
      pickFolder: async () => {
        const { promptText } = await import("../components/ui/Dialog");
        const path = await promptText({ title: "Add project", label: "Folder", initial: `${HOME}/code/`, placeholder: `${HOME}/code/my-app`, confirmLabel: "Add" });
        const clean = path?.trim().replace(/\/+$/, "");
        if (!clean) return null;
        world.fs.mkdirp(clean);
        return clean;
      },
      pickFile: async () => {
        void toast(notInDemo("Attaching files"));
        return null;
      },
    },
    shell: {
      openExternal: async (url) => void window.open(url, "_blank", "noopener"),
      openPath: async () => notInDemo("Opening files in other apps"),
      reveal: async () => void toast(notInDemo("Showing files in Finder")),
    },
    editor: {
      available: async () => false,
      open: async () => {},
    },
    git: {
      info: async (path) => {
        const root = Object.keys(BRANCH)
          .filter((r) => path === r || path.startsWith(r + "/"))
          .sort((a, b) => b.length - a.length)[0];
        return root ? { isRepo: true, root, branch: BRANCH[root] } : { isRepo: false, root: null, branch: null };
      },
      createWorktree: async (cwd, label) => {
        const repoRoot = Object.values(P).find((r) => cwd === r || cwd.startsWith(r + "/")) ?? cwd;
        const slug = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "fork"}-${Date.now().toString(36).slice(-5)}`;
        const path = `${WORKTREES}/${repoRoot.split("/").pop()}/${slug}`;
        const branch = `ret/${slug}`;
        world.fs.copyTree(repoRoot, path);
        BRANCH[path] = branch;
        return { path, branch, repoRoot };
      },
      mainCheckouts: async () => ({}),
    },
    files: {
      saveImage: async () => {
        throw new Error(notInDemo("Attaching images"));
      },
      stat: async (path) => world.fs.stat(path),
      visualization: async () => ({ error: notInDemo("Visualizations") }),
      pathFor: () => null,
    },
    apps: { info: async () => ({ name: null, icon: null }) },
    copy: async (text) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Clipboard API blocked (an iframe without permission): the old way still works on a click.
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;opacity:0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        if (!ok) throw new Error("Clipboard unavailable");
      }
    },
    edit: (command) => {
      if (command === "replaceMisspelling" || command === "addToDictionary") return;
      document.execCommand(command);
    },
    onSpelling: () => () => {},
    notify: () => {},
    setTheme: () => {},
    remoteAccess: noRemoteAccess(notInDemo("Remote access")),
  };
}
