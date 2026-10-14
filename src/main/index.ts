import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, Notification, protocol, shell, screen } from "electron";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { IPC, type EditCommand, type ProviderId, type ProvidersSettings, type ProvidersSettingsPatch, type UpdaterSettings } from "../shared/bridge";
import { IMAGE_SCHEME, RUNNABLE, imageType } from "../shared/files";
import { AppServer, type LaunchTarget } from "./codex/appServer";
import { CodexUpdater } from "./codex/updater";
import { AppUpdater } from "./appUpdate";
import { findSystemCodex, probeVersion } from "./codex/platform";
import { ClaudeEngine } from "./claude/engine";
import { findSystemClaude, openLoginTerminal, probeClaudeVersion } from "./claude/platform";
import { ClaudeUpdater } from "./claude/updater";
import { createWorktree, gitInfo } from "./git";
import { appInfo } from "./apps";

const isDev = !!process.env.VITE_DEV_SERVER_URL;

// Images in threads (attachments, files the agent viewed, local images in messages) are local
// files. The page can't load file:// from the dev server, and shouldn't read arbitrary files
// anyway, so it asks for them as ret-img://local/<encoded absolute path>, images only.
protocol.registerSchemesAsPrivileged([{ scheme: IMAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const IMAGE_MAX_BYTES = 64 * 1024 * 1024;

function serveImages() {
  protocol.handle(IMAGE_SCHEME, async (req) => {
    try {
      const path = decodeURIComponent(new URL(req.url).pathname.slice(1));
      const type = imageType(path);
      if (!type || !isAbsolute(path)) return new Response(null, { status: 403 });
      const st = await stat(path);
      if (!st.isFile() || st.size > IMAGE_MAX_BYTES) return new Response(null, { status: 404 });
      return new Response(await readFile(path), { headers: { "content-type": type, "cache-control": "no-cache" } });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}


let vscodeCache: Promise<boolean> | null = null;
/** VS Code registers the vscode:// URL handler; look for its install rather than shelling out. */
function vscodeInstalled(): Promise<boolean> {
  vscodeCache ??= (async () => {
    const candidates =
      process.platform === "win32"
        ? [
            join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "Code.exe"),
            join(process.env.ProgramFiles ?? "C:\\Program Files", "Microsoft VS Code", "Code.exe"),
          ]
        : process.platform === "darwin"
          ? ["/Applications/Visual Studio Code.app", join(app.getPath("home"), "Applications", "Visual Studio Code.app")]
          : ["/usr/bin/code", "/usr/share/code/code", "/snap/bin/code"];
    return candidates.some((c) => c && existsSync(c));
  })();
  return vscodeCache;
}
// Dev runs get their own profile so they can coexist with an installed Ret.
if (isDev) app.setPath("userData", join(app.getPath("appData"), "ret-dev"));
const userData = app.getPath("userData");
const windowStateFile = join(userData, "window.json");

let win: BrowserWindow | null = null;

// A second instance must not boot its own codex/updater (it could prune the first one's download).
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.exit(0);

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

const send = (channel: string, payload: unknown) => {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
};

const appServer = new AppServer(
  (lines) => send(IPC.agentMessages, { provider: "codex", lines }),
  (status) => send(IPC.agentStatus, status),
);

const claude = new ClaudeEngine(
  join(userData, "claude-state.json"),
  app.getVersion(),
  (lines) => send(IPC.agentMessages, { provider: "claude", lines }),
  (status) => send(IPC.agentStatus, status),
);

const claudeUpdater = new ClaudeUpdater({
  binary: () => claude.status.binaryPath,
  version: () => claude.status.version,
  busy: () => claude.busy,
  closeIdle: () => claude.closeIdle(),
  changed: (update) => claude.setUpdate(update),
  updated: () => bootClaude(),
});

// ---------------------------------------------------------------------------
// Providers: which agent engines are on, and where Claude Code is found.
// ---------------------------------------------------------------------------

const providersFile = join(userData, "providers.json");
const DEFAULT_PROVIDERS: ProvidersSettings = {
  enabled: { codex: true, claude: true },
  claude: { source: "system", customPath: null, autoUpdate: true },
};

function loadProviders(): ProvidersSettings {
  try {
    const raw = JSON.parse(readFileSync(providersFile, "utf8"));
    return {
      enabled: { ...DEFAULT_PROVIDERS.enabled, ...raw.enabled },
      claude: { ...DEFAULT_PROVIDERS.claude, ...raw.claude },
    };
  } catch {
    return DEFAULT_PROVIDERS;
  }
}

let providers = loadProviders();

async function setProviders(patch: ProvidersSettingsPatch): Promise<ProvidersSettings> {
  const prev = providers;
  providers = {
    ...prev,
    ...patch,
    enabled: { ...prev.enabled, ...patch.enabled },
    claude: { ...prev.claude, ...patch.claude },
  };
  await writeFile(providersFile, JSON.stringify(providers, null, 2));
  send(IPC.providersState, providers);
  if (prev.enabled.codex !== providers.enabled.codex) {
    if (providers.enabled.codex) void bootCodex();
    else {
      updater.stop();
      await appServer.disable();
    }
  }
  const claudeMoved = prev.claude.source !== providers.claude.source || prev.claude.customPath !== providers.claude.customPath;
  if (prev.enabled.claude !== providers.enabled.claude || claudeMoved) void bootClaude().then(() => scheduleClaudeUpdates());
  else if (prev.claude.autoUpdate !== providers.claude.autoUpdate) scheduleClaudeUpdates();
  return providers;
}

/** Find the user's own Claude Code (Ret never installs it) and point the engine at it. */
/** Keep the user's Claude Code current (it updates itself only when used interactively). */
function scheduleClaudeUpdates() {
  if (providers.enabled.claude && claude.status.state === "running") claudeUpdater.schedule(providers.claude.autoUpdate);
  else claudeUpdater.stop();
}

async function bootClaude() {
  if (!providers.enabled.claude) {
    claude.disable();
    return;
  }
  const c = providers.claude;
  const custom = c.source === "custom" && c.customPath && existsSync(c.customPath) ? c.customPath : null;
  const binary = custom ?? (c.source === "system" ? await findSystemClaude() : null);
  if (!binary) {
    claude.setMissing(
      c.source === "custom" ? "The Claude Code path in Settings doesn't exist." : "Claude Code isn't installed. Install it from claude.com/claude-code, then restart it here.",
    );
    return;
  }
  // The version decides whether an update is due, so it's known before the engine goes live.
  claude.start({ binary, version: await probeClaudeVersion(binary), source: custom ? "custom" : "system" });
}

let autoApplying = false;
const updater = new CodexUpdater(join(userData, "codex"), join(userData, "codex-settings.json"), (state) => {
  send(IPC.updaterState, state);
  // Nothing is running yet (first launch with no codex anywhere): go live as soon as the download lands.
  const down = appServer.status.state === "missing" || appServer.status.state === "error";
  if (state.phase === "ready" && down && !autoApplying) {
    autoApplying = true;
    void applyStaged().finally(() => (autoApplying = false));
  }
});

const appUpdate = new AppUpdater((state) => send(IPC.appUpdateState, state));

async function resolveTarget(): Promise<LaunchTarget | null> {
  const target = await resolveBinary();
  return target && { ...target, shared: updater.settings.engine === "shared" };
}

async function resolveBinary(): Promise<LaunchTarget | null> {
  const s = updater.settings;
  if (s.source === "custom" && s.customPath && existsSync(s.customPath)) {
    return { binary: s.customPath, pathDir: null, version: null, source: "custom" };
  }
  if (s.source === "managed") {
    const managed = await updater.currentManaged();
    if (managed) return { binary: managed.binary, pathDir: managed.pathDir, version: managed.version, source: "managed" };
  }
  const system = await findSystemCodex();
  if (system) return { ...system, version: null, source: "system" };
  return null;
}

// Launches are serialized: overlapping restarts (double-clicked Restart, an update landing
// mid-restart) would otherwise each spawn a process and orphan one of them.
let launchQueue: Promise<void> = Promise.resolve();
function launch(target: LaunchTarget | null, restart = false): Promise<void> {
  const next = launchQueue.then(() => doLaunch(target, restart));
  launchQueue = next.catch(() => {});
  return next;
}

async function doLaunch(target: LaunchTarget | null, restart: boolean) {
  if (!target) {
    appServer.setMissing("No codex binary found yet — downloading the latest release…");
    return;
  }
  if (target.shared) {
    // Attach to the daemon the Codex desktop app uses, so its threads stream live into Ret too.
    try {
      target = { ...target, version: await ensureDaemon(target.binary) };
    } catch (err) {
      appServer.setMissing(`Could not start the shared Codex daemon: ${(err as Error).message}`);
      return;
    }
  }
  if (restart) await appServer.restart(target);
  else appServer.start(target);
  if (target.shared) return; // Ret's own binary isn't what's running; the daemon manages its version.
  updater.setRunning(target.version, target.source === "managed");
  if (!target.version) {
    // Probe off the critical path so startup isn't blocked on a second process.
    void probeVersion(target.binary).then((version) => {
      if (appServer.status.binaryPath !== target.binary) return;
      appServer.status = { ...appServer.status, version };
      send(IPC.agentStatus, appServer.status);
      updater.setRunning(version, target.source === "managed");
    });
  }
}

function run(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { windowsHide: true, timeout: 45_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

/** Starts the shared app-server daemon if needed and returns the version it is running. */
async function ensureDaemon(binary: string): Promise<string | null> {
  await run(binary, ["app-server", "daemon", "start"]);
  try {
    const info = JSON.parse(await run(binary, ["app-server", "daemon", "version"]));
    return info.appServerVersion ?? null;
  } catch {
    return null;
  }
}

async function applyStaged() {
  if (!providers.enabled.codex) return;
  await launch(await resolveTarget(), true);
}

async function boot() {
  void bootClaude().then(() => scheduleClaudeUpdates());
  await updater.init();
  await bootCodex();
}

async function bootCodex() {
  if (!providers.enabled.codex) {
    updater.stop();
    await appServer.disable();
    return;
  }
  const target = await resolveTarget();
  await launch(target);
  const s = updater.settings;
  // In shared mode the daemon owns the codex version, so there's nothing for Ret to install.
  if (s.source === "managed" && s.engine !== "shared" && (s.autoUpdate || target?.source !== "managed")) {
    // Managed mode with no managed copy yet always installs one, even if auto-update is off.
    void updater.check({ install: true });
  }
  updater.schedule();
}

/**
 * A renderer reload starts a fresh JSON-RPC client, but codex only accepts one
 * `initialize` per connection — so give every page load after the first a new connection.
 */
let pageLoads = 0;
async function onPageLoad() {
  if (++pageLoads === 1) return;
  claude.reconnect();
  if (providers.enabled.codex) await launch(await resolveTarget(), true);
}

function loadWindowState() {
  try {
    const state = JSON.parse(readFileSync(windowStateFile, "utf8"));
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return state.x < a.x + a.width && state.x + state.width > a.x && state.y < a.y + a.height && state.y + state.height > a.y;
    });
    return visible ? state : null;
  } catch {
    return null;
  }
}

/**
 * Packaged builds carry their icon in the executable / app bundle (electron-builder, from
 * build/). Unpackaged (dev) runs would show Electron's own, so point at build/ directly.
 */
function devIcon(file: string): string | undefined {
  if (app.isPackaged) return undefined;
  const p = join(app.getAppPath(), "build", file);
  return existsSync(p) ? p : undefined;
}

function createWindow() {
  const saved = loadWindowState();
  win = new BrowserWindow({
    width: saved?.width ?? 1480,
    height: saved?.height ?? 940,
    x: saved?.x,
    y: saved?.y,
    minWidth: 720,
    minHeight: 480,
    show: false,
    icon: process.platform === "darwin" ? undefined : devIcon(process.platform === "win32" ? "icon.ico" : "icon.png"),
    backgroundColor: "#000000",
    titleBarStyle: "hidden",
    titleBarOverlay: process.platform === "darwin" ? undefined : { color: "#00000000", symbolColor: "#a1a1aa", height: 38 },
    trafficLightPosition: { x: 14, y: 12 },
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      backgroundThrottling: false,
      additionalArguments: [`--ret-version=${app.getVersion()}`],
    },
  });
  if (saved?.maximized) win.maximize();

  win.once("ready-to-show", () => win?.show());
  win.webContents.on("did-finish-load", () => void onPageLoad());
  // The renderer draws its own context menus; it only needs the spellchecker's view of the click.
  win.webContents.on("context-menu", (_e, params) => {
    if (params.isEditable && params.misspelledWord) {
      send(IPC.spelling, { word: params.misspelledWord, suggestions: params.dictionarySuggestions.slice(0, 5) });
    }
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    if (details.reason !== "clean-exit") win?.webContents.reload();
  });

  const persist = () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getNormalBounds();
    void writeFile(windowStateFile, JSON.stringify({ ...b, maximized: win.isMaximized() }));
  };
  win.on("close", persist);

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl && url.startsWith(devUrl)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });

  if (isDev) void win.loadURL(process.env.VITE_DEV_SERVER_URL!);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));

  // Diagnostics: RET_EVAL=<js> runs an expression in the page after load and prints the result.
  const evalSrc = process.env.RET_EVAL;
  if (evalSrc) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          console.log("[RET_EVAL]", JSON.stringify(await win?.webContents.executeJavaScript(evalSrc, true)));
        } catch (err) {
          console.log("[RET_EVAL] error", (err as Error).message);
        }
      }, Number(process.env.RET_EVAL_DELAY ?? 3000));
    });
  }

  // Diagnostics: RET_CAPTURE=<file.png> saves a screenshot of the window shortly after load.
  const capture = process.env.RET_CAPTURE;
  if (capture) {
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        const img = await win?.webContents.capturePage();
        if (img) await writeFile(capture, img.toPNG());
      }, Number(process.env.RET_CAPTURE_DELAY ?? 6000));
    });
  }
}

function registerIpc() {
  ipcMain.on(IPC.agentSend, (_e, provider: ProviderId, line: string) => (provider === "claude" ? claude.send(line) : appServer.send(line)));
  ipcMain.handle(IPC.agentGetStatus, (_e, provider: ProviderId) => (provider === "claude" ? claude.status : appServer.status));
  ipcMain.handle(IPC.agentRestart, async (_e, provider: ProviderId) => {
    if (provider === "claude") return bootClaude();
    if (providers.enabled.codex) return launch(await resolveTarget(), true);
  });
  ipcMain.handle(IPC.agentUpdate, (_e, provider: ProviderId) => {
    if (provider === "claude") return claudeUpdater.check({ install: true });
    return updater.check({ install: true }).then(() => {});
  });
  ipcMain.handle(IPC.agentLogin, (_e, provider: ProviderId) => {
    if (provider === "claude" && claude.status.binaryPath) openLoginTerminal(claude.status.binaryPath);
  });
  ipcMain.handle(IPC.providersGet, () => providers);
  ipcMain.handle(IPC.providersSet, (_e, patch: ProvidersSettingsPatch) => setProviders(patch));

  ipcMain.handle(IPC.updaterGet, () => updater.snapshot());
  ipcMain.handle(IPC.updaterCheck, async () => {
    await updater.check({ install: true });
    return updater.snapshot();
  });
  ipcMain.handle(IPC.updaterApply, () => applyStaged());
  ipcMain.handle(IPC.appUpdateGet, () => appUpdate.state);
  ipcMain.handle(IPC.appUpdateCheck, async () => {
    await appUpdate.check();
    return appUpdate.state;
  });
  ipcMain.handle(IPC.appUpdateInstall, () => appUpdate.install());
  ipcMain.handle(IPC.updaterSettings, async (_e, patch: Partial<UpdaterSettings>) => {
    const sourceChanged =
      (patch.source !== undefined && patch.source !== updater.settings.source) ||
      (patch.engine !== undefined && patch.engine !== updater.settings.engine);
    const pathChanged = patch.customPath !== undefined && patch.customPath !== updater.settings.customPath;
    await updater.setSettings(patch);
    if (sourceChanged || pathChanged) {
      await applyStaged();
      if (updater.settings.source === "managed") void updater.check({ install: true });
    }
    return updater.snapshot();
  });

  ipcMain.handle(IPC.pickFolder, async () => {
    const res = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"] });
    return res.canceled ? null : res.filePaths[0] ?? null;
  });
  ipcMain.handle(IPC.pickFile, async (_e, filters) => {
    const res = await dialog.showOpenDialog(win!, { properties: ["openFile"], filters });
    return res.canceled ? null : res.filePaths[0] ?? null;
  });
  ipcMain.handle(IPC.openExternal, (_e, url: string) => {
    if (/^(https?|mailto):/i.test(url)) return shell.openExternal(url);
  });
  ipcMain.handle(IPC.openPath, async (_e, p: string) => {
    // Never launch programs from a link in a transcript; show them instead.
    if (RUNNABLE.test(p)) {
      shell.showItemInFolder(p);
      return "";
    }
    return shell.openPath(p);
  });
  ipcMain.handle(IPC.reveal, (_e, p: string) => shell.showItemInFolder(p));
  ipcMain.handle(IPC.stat, async (_e, p: string) => {
    try {
      const st = await stat(p);
      return { exists: true, isDir: st.isDirectory(), size: st.size };
    } catch {
      return { exists: false, isDir: false, size: 0 };
    }
  });
  ipcMain.handle(IPC.editorAvailable, () => vscodeInstalled());
  ipcMain.handle(IPC.editorOpen, (_e, p: string, line?: number, col?: number) => {
    const target = p.replace(/\\/g, "/");
    const loc = line ? `:${line}${col ? `:${col}` : ""}` : "";
    return shell.openExternal(`vscode://file${target.startsWith("/") ? "" : "/"}${encodeURI(target)}${loc}`);
  });
  ipcMain.handle(IPC.copy, (_e, text: string) => clipboard.writeText(String(text)));
  ipcMain.handle(IPC.appInfo, (_e, appId: string) => appInfo(String(appId)));
  ipcMain.on(IPC.edit, (e, command: EditCommand, arg?: string) => {
    const wc = e.sender;
    switch (command) {
      case "undo":
      case "redo":
      case "cut":
      case "copy":
      case "paste":
      case "selectAll":
        wc[command]();
        break;
      case "replaceMisspelling":
        if (arg) wc.replaceMisspelling(arg);
        break;
      case "addToDictionary":
        if (arg) wc.session.addWordToSpellCheckerDictionary(arg);
        break;
    }
  });

  ipcMain.handle(IPC.gitInfo, (_e, p: string) => gitInfo(p));
  ipcMain.handle(IPC.gitWorktree, (_e, cwd: string, label: string) => createWorktree(join(userData, "worktrees"), cwd, label));

  ipcMain.handle(IPC.saveImage, async (_e, data: ArrayBuffer, ext: string) => {
    const dir = join(tmpdir(), "ret-images");
    await mkdir(dir, { recursive: true });
    const file = join(dir, `${randomUUID()}.${ext.replace(/[^a-z0-9]/gi, "") || "png"}`);
    await writeFile(file, Buffer.from(data));
    return file;
  });

  ipcMain.on(IPC.setTheme, (_e, theme: "dark" | "light") => {
    nativeTheme.themeSource = theme;
    if (process.platform !== "darwin" && win && !win.isDestroyed()) {
      win.setBackgroundColor(theme === "light" ? "#f6f6f8" : "#000000");
      win.setTitleBarOverlay({ color: "#00000000", symbolColor: theme === "light" ? "#55556a" : "#a1a1aa", height: 38 });
    }
  });

  ipcMain.on(IPC.notify, (_e, title: string, body: string) => {
    if (!Notification.isSupported() || win?.isFocused()) return;
    const n = new Notification({ title, body, silent: false });
    n.on("click", () => {
      win?.show();
      win?.focus();
    });
    n.show();
  });
}

function installMenu() {
  if (isDev) return; // keep the default menu (reload, devtools) while developing
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }]));
  } else {
    // No menu bar: the UI owns its shortcuts, and Ctrl+R must not reload the renderer mid-turn.
    Menu.setApplicationMenu(null);
  }
}

app.whenReady().then(() => {
  if (!primaryInstance) return;
  serveImages();
  const dock = process.platform === "darwin" ? devIcon("icon.png") : undefined;
  if (dock) app.dock?.setIcon(dock);
  installMenu();
  registerIpc();
  createWindow();
  void boot();
  appUpdate.schedule();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

let quitting = false;
app.on("before-quit", (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  claudeUpdater.stop();
  claude.stop();
  void appServer.stop().finally(() => app.quit());
});
