import type { AppUpdateState, CodexStatus, RetBridge, UpdaterState } from "@shared/bridge";

declare global {
  interface Window {
    ret?: RetBridge;
  }
}

/**
 * Browser fallback used by `npm run dev:web`: talks to `codex app-server --listen ws://…`
 * directly. Desktop-only features (folder picker, worktrees, updater) degrade gracefully.
 */
function createWebBridge(url: string): RetBridge {
  const messageSubs = new Set<(lines: string[]) => void>();
  const statusSubs = new Set<(s: CodexStatus) => void>();
  let socket: WebSocket | null = null;
  let queue: string[] = [];
  let status: CodexStatus = {
    state: "starting",
    generation: 0,
    version: null,
    binaryPath: url,
    source: "system",
    engine: "dedicated",
    error: null,
    stderrTail: [],
  };
  const setStatus = (patch: Partial<CodexStatus>) => {
    status = { ...status, ...patch };
    statusSubs.forEach((cb) => cb(status));
  };

  const connect = () => {
    const ws = new WebSocket(url);
    socket = ws;
    ws.onopen = () => {
      setStatus({ state: "running", generation: status.generation + 1, error: null });
      queue.forEach((l) => ws.send(l));
      queue = [];
    };
    ws.onmessage = (ev) => {
      const lines = String(ev.data).split("\n").filter(Boolean);
      messageSubs.forEach((cb) => cb(lines));
    };
    ws.onclose = () => {
      if (socket !== ws) return;
      setStatus({ state: "error", error: "WebSocket closed" });
      setTimeout(connect, 1000);
    };
  };
  connect();

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
    codex: {
      send: (line) => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(line);
        else queue.push(line);
      },
      onMessages: (cb) => {
        messageSubs.add(cb);
        return () => messageSubs.delete(cb);
      },
      onStatus: (cb) => {
        statusSubs.add(cb);
        return () => statusSubs.delete(cb);
      },
      getStatus: async () => status,
      restart: async () => socket?.close(),
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

export const bridge: RetBridge = window.ret ?? createWebBridge(`ws://${location.host}/codex-ws`);

export const isDesktop = !!window.ret;
