import type { AppUpdateState, EngineStatus, ProviderId, ProvidersSettings, RetBridge, UpdaterState } from "@shared/bridge";

declare global {
  interface Window {
    ret?: RetBridge;
  }
}

/**
 * Browser fallback used by `npm run dev:web`: talks to each provider's engine over a WebSocket
 * the dev server exposes (`codex app-server --listen`, and the Claude engine it hosts).
 * Desktop-only features (folder picker, worktrees, updater) degrade gracefully.
 */
function createWebBridge(base: string): RetBridge {
  const messageSubs = new Set<(provider: ProviderId, lines: string[]) => void>();
  const statusSubs = new Set<(s: EngineStatus) => void>();
  const settingsSubs = new Set<(s: ProvidersSettings) => void>();
  let settings: ProvidersSettings = { enabled: { codex: true, claude: true }, claude: { source: "system", customPath: null, autoUpdate: false } };

  /** One provider's engine over a WebSocket, reconnecting while it's enabled. */
  const pipe = (provider: ProviderId, url: string) => {
    let socket: WebSocket | null = null;
    let queue: string[] = [];
    let fails = 0;
    let status: EngineStatus = { provider, state: "starting", generation: 0, version: null, binaryPath: url, source: "system", engine: "dedicated", error: null, stderrTail: [] };
    const setStatus = (patch: Partial<EngineStatus>) => {
      status = { ...status, ...patch };
      statusSubs.forEach((cb) => cb(status));
    };
    const connect = () => {
      if (!settings.enabled[provider]) return setStatus({ state: "disabled", error: null });
      const ws = new WebSocket(url);
      socket = ws;
      ws.onopen = () => {
        fails = 0;
        setStatus({ state: "running", generation: status.generation + 1, error: null });
        queue.forEach((l) => ws.send(l));
        queue = [];
      };
      ws.onmessage = (ev) => {
        const lines = String(ev.data).split("\n").filter(Boolean);
        messageSubs.forEach((cb) => cb(provider, lines));
      };
      ws.onclose = () => {
        if (socket !== ws) return;
        socket = null;
        fails++;
        setStatus({ state: fails > 3 ? "missing" : "error", error: fails > 3 ? "Not served by this dev server" : "WebSocket closed" });
        setTimeout(connect, Math.min(1000 * fails, 10_000));
      };
    };
    connect();
    return {
      get status() {
        return status;
      },
      send(line: string) {
        if (socket?.readyState === WebSocket.OPEN) socket.send(line);
        else queue.push(line);
      },
      restart() {
        if (socket) socket.close();
        else connect();
      },
    };
  };
  const pipes: Record<ProviderId, ReturnType<typeof pipe>> = { codex: pipe("codex", `${base}/codex-ws`), claude: pipe("claude", `${base}/claude-ws`) };

  const updater: UpdaterState = {
    settings: { source: "system", autoUpdate: false, channel: "latest", customPath: null, checkIntervalHours: 2, engine: "dedicated" },
    phase: "idle",
    progress: null,
    latest: null,
    running: null,
    staged: null,
    installed: [],
    lastCheckedAt: null,
    error: "Updater is only available in the desktop app",
  };
  const appUpdate: AppUpdateState = { phase: "unsupported", version: null, progress: null, lastCheckedAt: null, error: null };

  return {
    platform: navigator.platform.toLowerCase().includes("win") ? "win32" : "web",
    appVersion: "web",
    agents: {
      send: (provider, line) => pipes[provider].send(line),
      onMessages: (cb) => {
        messageSubs.add(cb);
        return () => messageSubs.delete(cb);
      },
      onStatus: (cb) => {
        statusSubs.add(cb);
        return () => statusSubs.delete(cb);
      },
      getStatus: async (provider) => pipes[provider].status,
      restart: async (provider) => pipes[provider].restart(),
      getSettings: async () => settings,
      onSettings: (cb) => {
        settingsSubs.add(cb);
        return () => settingsSubs.delete(cb);
      },
      setSettings: async (patch) => {
        settings = { ...settings, ...patch, enabled: { ...settings.enabled, ...patch.enabled }, claude: { ...settings.claude, ...patch.claude } };
        settingsSubs.forEach((cb) => cb(settings));
        return settings;
      },
      openLogin: async () => {},
      update: async () => {},
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
      pickFolder: async () => (await import("./components/ui/Dialog")).promptText({ title: "Add project", label: "Folder path", placeholder: "C:\path\to\project", confirmLabel: "Add" }),
      pickFile: async () => (await import("./components/ui/Dialog")).promptText({ title: "Choose file", label: "File path", confirmLabel: "Choose" }),
    },
    shell: {
      openExternal: async (u) => void window.open(u, "_blank", "noopener"),
      openPath: async () => "Opening files needs the desktop app",
      reveal: async () => {},
    },
    editor: {
      available: async () => false,
      open: async () => {},
    },
    edit: (command) => {
      if (command === "replaceMisspelling" || command === "addToDictionary") return;
      document.execCommand(command === "selectAll" ? "selectAll" : command);
    },
    onSpelling: () => () => {},
    copy: (text) => navigator.clipboard.writeText(text),
    apps: { info: async () => ({ name: null, icon: null }) },
    git: {
      info: async () => ({ isRepo: false, root: null, branch: null }),
      createWorktree: async () => {
        throw new Error("Worktrees need the desktop app");
      },
    },
    files: {
      saveImage: async () => {
        throw new Error("Image attachments need the desktop app");
      },
      stat: async () => ({ exists: false, isDir: false }),
      pathFor: () => null,
    },
    setTheme: () => {},
    notify: (title, body) => {
      if ("Notification" in window && Notification.permission === "granted" && !document.hasFocus()) {
        new Notification(title, { body });
      }
    },
  };
}

export const bridge: RetBridge = window.ret ?? createWebBridge(`ws://${location.host}`);

export const isDesktop = !!window.ret;
