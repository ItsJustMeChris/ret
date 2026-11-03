import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, Notification, protocol, shell, screen } from "electron";
import type { BrowserWindowConstructorOptions, WebPreferences } from "electron";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import {
  IPC,
  PROVIDER_IDS,
  hostOf,
  providerOf,
  type AppInfo,
  type EditCommand,
  type EngineId,
  type EngineStatus,
  type ProviderId,
  type ProvidersSettings,
  type ProvidersSettingsPatch,
  type UpdaterSettings,
} from "../shared/bridge";
import { IMAGE_SCHEME, RUNNABLE, imageType } from "../shared/files";
import { AppServer, type LaunchTarget } from "./codex/appServer";
import { CodexUpdater } from "./codex/updater";
import { AppUpdater } from "./appUpdate";
import { codexHome, findSystemCodex, probeVersion } from "./codex/platform";
import { ClaudeEngine } from "./claude/engine";
import { findSystemClaude, openLoginTerminal, probeClaudeVersion } from "./claude/platform";
import { ClaudeUpdater } from "./claude/updater";
import { AcpEngine } from "./acp/engine";
import { findOpencode, resolveProgram, splitCommand } from "./acp/platform";
import { openTerminalWindow } from "./terminalWindow";
import { LocalUsage } from "./usage";
import { PtyService } from "./pty";
import { renderVisualization } from "./visualize";
import { createWorktree, gitInfo, mainCheckouts } from "./git";
import { AgentMux, RemoteAccess, type HostCalls, type MuxClient } from "./remote";
import { appInfo } from "./apps";
import { loadShellEnv } from "./shellEnv";

const isDev = !!process.env.VITE_DEV_SERVER_URL;

// Started now so it overlaps window creation; boot() waits for it before spawning anything.
const shellEnvReady = loadShellEnv();

// Images in threads (attachments, files the agent viewed, local images in messages) are local
// files. The page can't load file:// from the dev server, and shouldn't read arbitrary files
// anyway, so it asks for them as ret-img://local/<encoded absolute path>, images only.
protocol.registerSchemesAsPrivileged([{ scheme: IMAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const IMAGE_MAX_BYTES = 64 * 1024 * 1024;

/** An image file for ret-img://, or the HTTP status to answer with instead. */
async function readImage(path: string): Promise<{ type: string; data: Buffer<ArrayBuffer> } | number> {
  const type = imageType(path);
  if (!type || !isAbsolute(path)) return 403;
  try {
    const st = await stat(path);
    if (!st.isFile() || st.size > IMAGE_MAX_BYTES) return 404;
    return { type, data: await readFile(path) };
  } catch {
    return 404;
  }
}

const imageResponse = (type: string, data: Buffer<ArrayBuffer>) => new Response(data, { headers: { "content-type": type, "cache-control": "no-cache" } });

/**
 * ret-img://local/<path> is a file here; ret-img://<host key>/<path> one on a paired device,
 * fetched over its link (with the same checks on that side).
 */
function serveImages() {
  protocol.handle(IMAGE_SCHEME, async (req) => {
    try {
      const url = new URL(req.url);
      const path = decodeURIComponent(url.pathname.slice(1));
      if (url.hostname !== "local") {
        const type = imageType(path);
        const link = remote?.linkFor(url.hostname);
        if (!type || !link) return new Response(null, { status: type ? 404 : 403 });
        const data: string | null = await link.call("image", path);
        return data ? imageResponse(type, Buffer.from(data, "base64")) : new Response(null, { status: 404 });
      }
      const r = await readImage(path);
      return typeof r === "number" ? new Response(null, { status: r }) : imageResponse(r.type, r.data);
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
// Dev runs get their own profile so they can coexist with an installed Ret, and so does a run started
// with --ret-profile=<name> (a build from the repo tried out next to the installed app, say).
const profileArg = process.argv.find((a) => a.startsWith("--ret-profile="))?.slice("--ret-profile=".length);
const profile = profileArg || (isDev ? "ret-dev" : null);
if (profile) app.setPath("userData", join(app.getPath("appData"), profile));
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

// Every window talks to the engines through a mux: this computer's window, and other devices'
// through remote access. Each gets its own request ids, generations and thread subscriptions.
const muxes = {} as Record<ProviderId, AgentMux>;

const appServer = new AppServer(
  (lines) => muxes.codex.fromEngine(lines),
  (status) => muxes.codex.setEngineStatus(status),
);

const claude = new ClaudeEngine(
  join(userData, "claude-state.json"),
  app.getVersion(),
  (lines) => muxes.claude.fromEngine(lines),
  (status) => muxes.claude.setEngineStatus(status),
);

/** OpenCode, over the Agent Client Protocol (`opencode acp`). */
const opencode = new AcpEngine(
  "opencode",
  () => "OpenCode",
  join(userData, "opencode-state.json"),
  app.getVersion(),
  (lines) => muxes.opencode.fromEngine(lines),
  (status) => muxes.opencode.setEngineStatus(status),
);

/** The agent the user brings: any program with an ACP mode, started by the command in Settings. */
const customAgent = new AcpEngine(
  "acp",
  () => providers.acp.name.trim(),
  join(userData, "acp-state.json"),
  app.getVersion(),
  (lines) => muxes.acp.fromEngine(lines),
  (status) => muxes.acp.setEngineStatus(status),
);

/**
 * Codex's activity by day (tokens by model, prompts by hour), from its rollouts: Ret's own
 * `ret/usage/activity`, answered here ahead of the app-server, which doesn't know it.
 */
const codexActivity = new LocalUsage("codex", () => [join(codexHome(), "sessions"), join(codexHome(), "archived_sessions")], null, (activity) =>
  muxes.codex.fromEngine([JSON.stringify({ method: "account/usage/updated", params: { activity } })]),
);
const ACTIVITY_REQUEST = /^\{"id":("~\d+"),"method":"ret\/usage\/activity"/;

/**
 * Terminals on the Codex connection: Ret runs them itself (as the Claude engine does), so they work
 * the same whichever agents are on, and keep running while Codex restarts or updates.
 */
const codexPty = new PtyService((method, params) => muxes.codex.fromEngine([JSON.stringify({ method, params })]));
const PROCESS_REQUEST = /^\{"id":("~\d+"),"method":"process\//;

function toCodex(line: string) {
  if (PROCESS_REQUEST.test(line)) {
    const msg = JSON.parse(line);
    codexPty.call(msg.method, msg.params).then(
      (result) => muxes.codex.fromEngine([JSON.stringify({ id: msg.id, result })]),
      (err) => muxes.codex.fromEngine([JSON.stringify({ id: msg.id, error: { code: err?.code ?? -32603, message: String(err?.message ?? err) } })]),
    );
    return;
  }
  const m = ACTIVITY_REQUEST.exec(line);
  if (!m) return appServer.send(line);
  codexActivity.read().then(
    (result) => muxes.codex.fromEngine([`{"id":${m[1]},"result":${JSON.stringify(result)}}`]),
    (err) => muxes.codex.fromEngine([JSON.stringify({ id: JSON.parse(m[1]), error: { code: -32603, message: String(err?.message ?? err) } })]),
  );
}

muxes.codex = new AgentMux(toCodex, true, appServer.status);
muxes.claude = new AgentMux((line) => claude.send(line), false, claude.status);
muxes.opencode = new AgentMux((line) => opencode.send(line), false, opencode.status);
muxes.acp = new AgentMux((line) => customAgent.send(line), false, customAgent.status);

/** This computer's window, as a client of each engine's mux. */
const localClients = Object.fromEntries(
  PROVIDER_IDS.map((provider) => [
    provider,
    { deliver: (lines) => send(IPC.agentMessages, { engine: provider, lines }), status: (status) => send(IPC.agentStatus, status) } satisfies MuxClient,
  ]),
) as Record<ProviderId, MuxClient>;
for (const p of PROVIDER_IDS) muxes[p].attach(localClients[p]);

let remote!: RemoteAccess;

/** The link for a call about a paired device's engines or files (by its host key); null for this computer's. */
/** An app's name and icon as a paired device sent them: only a short name and a PNG data URL get through. */
function appInfoFrom(v: unknown): AppInfo {
  const o = (v ?? {}) as { name?: unknown; icon?: unknown };
  return {
    name: typeof o.name === "string" ? o.name.slice(0, 200) : null,
    icon: typeof o.icon === "string" && o.icon.startsWith("data:image/png;base64,") && o.icon.length < 512 * 1024 ? o.icon : null,
  };
}

function linkTo(host: string | null | undefined) {
  if (!host) return null;
  const link = remote.linkFor(host);
  if (!link) throw new Error("That device isn't paired any more");
  return link;
}

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
  // OpenCode turns on by itself where it's installed (bootOpencode); a custom agent once it's set up.
  enabled: { codex: true, claude: true, opencode: false, acp: false },
  claude: { source: "system", customPath: null, autoUpdate: true },
  opencode: { source: "system", customPath: null },
  acp: { name: "", command: "" },
};

/** Settings saved before OpenCode was an option: whether it's on is still to be decided. */
let opencodeUndecided = false;

function loadProviders(): ProvidersSettings {
  try {
    const raw = JSON.parse(readFileSync(providersFile, "utf8"));
    opencodeUndecided = typeof raw.enabled?.opencode !== "boolean";
    return {
      enabled: { ...DEFAULT_PROVIDERS.enabled, ...raw.enabled },
      claude: { ...DEFAULT_PROVIDERS.claude, ...raw.claude },
      opencode: { ...DEFAULT_PROVIDERS.opencode, ...raw.opencode },
      acp: { ...DEFAULT_PROVIDERS.acp, ...raw.acp },
    };
  } catch {
    opencodeUndecided = true;
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
    opencode: { ...prev.opencode, ...patch.opencode },
    acp: { ...prev.acp, ...patch.acp },
  };
  if (patch.enabled?.opencode !== undefined) opencodeUndecided = false;
  await writeFile(providersFile, JSON.stringify(providers, null, 2));
  send(IPC.providersState, providers);
  remote?.broadcastProviders(providers);
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
  const opencodeMoved = prev.opencode.source !== providers.opencode.source || prev.opencode.customPath !== providers.opencode.customPath;
  if (prev.enabled.opencode !== providers.enabled.opencode || opencodeMoved) void bootOpencode();
  const acpMoved = prev.acp.command.trim() !== providers.acp.command.trim();
  // Another agent altogether: what was remembered about the last one's sessions isn't its.
  if (acpMoved && splitCommand(prev.acp.command)[0] !== splitCommand(providers.acp.command)[0]) customAgent.resetState();
  if (prev.enabled.acp !== providers.enabled.acp || acpMoved) void bootAcp();
  return providers;
}

/** OpenCode from where its installers put it (or the path in Settings), run as `opencode acp`. */
async function bootOpencode() {
  const o = providers.opencode;
  const custom = o.source === "custom" && o.customPath && existsSync(o.customPath) ? o.customPath : null;
  const program = custom ?? (o.source === "system" ? findOpencode() : null);
  // The first run that knows OpenCode turns it on where it's installed; after that it's the user's call.
  if (opencodeUndecided) {
    opencodeUndecided = false;
    if (program && !providers.enabled.opencode) return void setProviders({ enabled: { opencode: true } });
  }
  if (!providers.enabled.opencode) return opencode.disable();
  if (!program) {
    return opencode.setMissing(o.source === "custom" ? "The OpenCode path in Settings doesn't exist." : "OpenCode isn't installed. Install it from opencode.ai, then restart it here.");
  }
  await opencode.start({ command: { program, args: ["acp"] }, source: custom ? "custom" : "system", version: null });
}

/** The user's own agent, started by the command they gave it. */
async function bootAcp() {
  if (!providers.enabled.acp) return customAgent.disable();
  const [name, ...args] = splitCommand(providers.acp.command);
  if (!name) return customAgent.setMissing("Give the command that starts your agent in its ACP mode (Settings → Custom agent).");
  const program = resolveProgram(name);
  if (!program) return customAgent.setMissing(`${name} wasn't found. Check the command in Settings → Custom agent.`);
  await customAgent.start({ command: { program, args }, source: "custom", version: null });
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
      muxes.codex.setEngineStatus(appServer.status);
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
  await shellEnvReady;
  void bootClaude().then(() => scheduleClaudeUpdates());
  void bootOpencode();
  void bootAcp();
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
 * A renderer reload starts a fresh JSON-RPC client. The engines stay up (other devices may be
 * using them, and turns keep running): the window gets a new generation from each mux, which
 * hands it Codex's cached `initialize` (codex takes only one per connection).
 */
let pageLoads = 0;
function onPageLoad() {
  if (++pageLoads === 1) return;
  for (const p of PROVIDER_IDS) muxes[p].reset(localClients[p]);
  remote?.resetLinks();
}

async function restartProvider(provider: ProviderId) {
  if (provider === "claude") return bootClaude();
  if (provider === "opencode") return bootOpencode();
  if (provider === "acp") return bootAcp();
  if (providers.enabled.codex) return launch(await resolveTarget(), true);
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

/** How every Ret window looks and runs; `prefs` adds to its webPreferences. */
function windowOptions(opts: BrowserWindowConstructorOptions, prefs: WebPreferences = {}): BrowserWindowConstructorOptions {
  return {
    width: 1480,
    height: 940,
    minWidth: 720,
    minHeight: 480,
    show: false,
    icon: process.platform === "darwin" ? undefined : devIcon(process.platform === "win32" ? "icon.ico" : "icon.png"),
    backgroundColor: "#000000",
    titleBarStyle: "hidden",
    titleBarOverlay: process.platform === "darwin" ? undefined : { color: "#00000000", symbolColor: "#a1a1aa", height: 38 },
    trafficLightPosition: { x: 14, y: 12 },
    ...opts,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      backgroundThrottling: false,
      additionalArguments: [`--ret-version=${app.getVersion()}`],
      ...prefs,
    },
  };
}

/** What every window needs: its own spellcheck suggestions, links out to the browser, a reload after a crash. */
function wireWindow(w: BrowserWindow) {
  // The renderer draws its own context menus; it only needs the spellchecker's view of the click.
  w.webContents.on("context-menu", (_e, params) => {
    if (params.isEditable && params.misspelledWord) {
      w.webContents.send(IPC.spelling, { word: params.misspelledWord, suggestions: params.dictionarySuggestions.slice(0, 5) });
    }
  });
  w.webContents.on("render-process-gone", (_e, details) => {
    if (details.reason !== "clean-exit" && !w.isDestroyed()) w.webContents.reload();
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  w.webContents.on("will-navigate", (e, url) => {
    const devUrl = process.env.VITE_DEV_SERVER_URL;
    if (devUrl && url.startsWith(devUrl)) return;
    e.preventDefault();
    if (/^https?:/i.test(url)) void shell.openExternal(url);
  });
}

function loadRenderer(w: BrowserWindow) {
  if (isDev) void w.loadURL(process.env.VITE_DEV_SERVER_URL!);
  else void w.loadFile(join(__dirname, "../renderer/index.html"));
}

function createWindow() {
  const saved = loadWindowState();
  win = new BrowserWindow(windowOptions({ width: saved?.width ?? 1480, height: saved?.height ?? 940, x: saved?.x, y: saved?.y }));
  if (saved?.maximized) win.maximize();

  win.once("ready-to-show", () => win?.show());
  win.webContents.on("did-finish-load", () => onPageLoad());
  wireWindow(win);

  const persist = () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getNormalBounds();
    void writeFile(windowStateFile, JSON.stringify({ ...b, maximized: win.isMaximized() }));
  };
  win.on("close", persist);

  loadRenderer(win);

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

const statPath = async (p: string) => {
  try {
    const st = await stat(p);
    return { exists: true, isDir: st.isDirectory(), size: st.size };
  } catch {
    return { exists: false, isDir: false, size: 0 };
  }
};

async function saveImage(data: Buffer, ext: string) {
  const dir = join(tmpdir(), "ret-images");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${randomUUID()}.${ext.replace(/[^a-z0-9]/gi, "") || "png"}`);
  await writeFile(file, data);
  return file;
}

/** What a paired device can ask of this one besides the engines' JSON-RPC. */
const hostCalls: HostCalls = {
  "agents.restart": (provider: unknown) => (PROVIDER_IDS.includes(provider as ProviderId) ? restartProvider(provider as ProviderId) : undefined),
  "git.info": (p: unknown) => gitInfo(String(p)),
  "git.mainCheckouts": (cwds: unknown) => mainCheckouts(Array.isArray(cwds) ? cwds.map(String) : []),
  "git.createWorktree": (cwd: unknown, label: unknown) => createWorktree(join(userData, "worktrees"), String(cwd), String(label)),
  "files.stat": (p: unknown) => statPath(String(p)),
  "files.visualization": (p: unknown, title: unknown) => renderVisualization(String(p), typeof title === "string" ? title : undefined),
  "files.saveImage": (data: unknown, ext: unknown) => saveImage(Buffer.from(String(data), "base64"), String(ext)),
  "apps.info": (appId: unknown) => appInfo(appId),
  image: async (p: unknown) => {
    const r = await readImage(String(p));
    return typeof r === "number" ? null : r.data.toString("base64");
  },
};

function registerIpc() {
  // A paired device's engines (and files, git) are reached through its link; this computer's through the muxes.
  ipcMain.on(IPC.agentSend, (_e, engine: EngineId, line: string) => {
    const host = hostOf(engine);
    const provider = providerOf(engine);
    if (host) remote.linkFor(host)?.send(provider, line);
    else if (muxes[provider]) muxes[provider].fromClient(localClients[provider], line);
  });
  ipcMain.handle(IPC.agentGetStatus, (_e, engine: EngineId): EngineStatus => {
    const host = hostOf(engine);
    const provider = providerOf(engine);
    if (!host) return muxes[provider].statusFor(localClients[provider]);
    // A view still showing a device that was just forgotten: say so rather than fail.
    const link = remote.linkFor(host);
    return link
      ? link.status(provider)
      : { provider, host, state: "error", generation: 0, version: null, binaryPath: null, source: null, engine: "dedicated", error: "That device isn't paired any more", stderrTail: [] };
  });
  ipcMain.handle(IPC.agentRestart, (_e, engine: EngineId) => {
    const link = linkTo(hostOf(engine));
    return link ? link.call("agents.restart", providerOf(engine)) : restartProvider(providerOf(engine));
  });
  ipcMain.handle(IPC.agentUpdate, (_e, provider: ProviderId) => {
    if (provider === "claude") return claudeUpdater.check({ install: true });
    // ACP agents keep themselves current.
    if (provider === "opencode" || provider === "acp") return;
    return updater.check({ install: true }).then(() => {});
  });
  ipcMain.handle(IPC.agentLogin, (_e, provider: ProviderId) => {
    if (provider === "claude" && claude.status.binaryPath) openLoginTerminal(claude.status.binaryPath);
    if (provider === "opencode") {
      const cmd = opencode.loginCommand(["auth", "login"]);
      if (cmd) openTerminalWindow("OpenCode sign-in", cmd);
    }
    if (provider === "acp") {
      const cmd = customAgent.loginCommand();
      if (cmd) openTerminalWindow(`${providers.acp.name || "Agent"} sign-in`, cmd);
    }
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
  ipcMain.handle(IPC.openPath, async (_e, p: string, host?: string | null) => {
    if (host) return `That file is on ${remote.state().hosts.find((h) => h.key === host)?.name ?? "another device"}.`;
    // Never launch programs from a link in a transcript; show them instead.
    if (RUNNABLE.test(p)) {
      shell.showItemInFolder(p);
      return "";
    }
    return shell.openPath(p);
  });
  ipcMain.handle(IPC.reveal, (_e, p: string, host?: string | null) => {
    if (!host) shell.showItemInFolder(p);
  });
  ipcMain.handle(IPC.stat, (_e, p: string, host?: string | null) => {
    const link = linkTo(host);
    return link ? link.call("files.stat", p) : statPath(p);
  });
  ipcMain.handle(IPC.visualization, (_e, p: string, title?: string, host?: string | null) => {
    const link = linkTo(host);
    return link ? link.call("files.visualization", p, title) : renderVisualization(p, title);
  });
  // VS Code here can't open another device's files.
  ipcMain.handle(IPC.editorAvailable, (_e, host?: string | null) => (host ? false : vscodeInstalled()));
  ipcMain.handle(IPC.editorOpen, (_e, p: string, line?: number, col?: number, host?: string | null) => {
    if (host) return;
    const target = p.replace(/\\/g, "/");
    const loc = line ? `:${line}${col ? `:${col}` : ""}` : "";
    return shell.openExternal(`vscode://file${target.startsWith("/") ? "" : "/"}${encodeURI(target)}${loc}`);
  });
  ipcMain.handle(IPC.copy, (_e, text: string) => clipboard.writeText(String(text)));
  ipcMain.handle(IPC.appInfo, async (_e, appId: unknown, host?: string | null) => {
    const link = linkTo(host);
    return link ? appInfoFrom(await link.call("apps.info", appId)) : appInfo(appId);
  });
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

  ipcMain.handle(IPC.gitInfo, (_e, p: string, host?: string | null) => {
    const link = linkTo(host);
    return link ? link.call("git.info", p) : gitInfo(p);
  });
  ipcMain.handle(IPC.gitCheckouts, (_e, cwds: string[], host?: string | null) => {
    const link = linkTo(host);
    return link ? link.call("git.mainCheckouts", cwds) : mainCheckouts(cwds);
  });
  ipcMain.handle(IPC.gitWorktree, (_e, cwd: string, label: string, host?: string | null) => {
    const link = linkTo(host);
    return link ? link.call("git.createWorktree", cwd, label) : createWorktree(join(userData, "worktrees"), cwd, label);
  });

  // Pasted images go where the agent that reads them runs.
  ipcMain.handle(IPC.saveImage, (_e, data: ArrayBuffer, ext: string, host?: string | null) => {
    const link = linkTo(host);
    return link ? link.call("files.saveImage", Buffer.from(data).toString("base64"), ext) : saveImage(Buffer.from(data), ext);
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

  ipcMain.handle(IPC.remoteGet, () => remote.state());
  ipcMain.handle(IPC.remoteSetHosting, (_e, on: boolean) => remote.setHosting(!!on));
  ipcMain.handle(IPC.remoteSetName, (_e, name: string) => remote.setName(String(name)));
  ipcMain.handle(IPC.remotePairStart, () => remote.startPairing());
  ipcMain.handle(IPC.remotePairStop, () => remote.stopPairing());
  ipcMain.handle(IPC.remoteRevoke, (_e, id: string) => remote.revoke(String(id)));
  ipcMain.handle(IPC.remotePair, (_e, target: { address: string; port: number }, code: string) => remote.pair(target, String(code)));
  ipcMain.handle(IPC.remoteForget, (_e, id: string) => remote.forget(String(id)));
  ipcMain.on(IPC.remoteDiscover, () => remote.discover());
  ipcMain.on(IPC.remoteNotify, (_e, n: { title?: unknown; body?: unknown; threadId?: unknown }) =>
    remote.notifyDevices({
      title: String(n?.title ?? "").slice(0, 200),
      body: String(n?.body ?? "").slice(0, 500),
      threadId: typeof n?.threadId === "string" ? n.threadId : null,
    }),
  );
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
  // Needs the app ready: the device key is sealed with the OS's encryption.
  remote = new RemoteAccess({
    userData,
    muxes,
    providers: () => providers,
    calls: hostCalls,
    state: (state) => send(IPC.remoteState, state),
    notify: (title, body) => {
      if (Notification.isSupported()) new Notification({ title, body }).show();
    },
    engineLines: (engine, lines) => send(IPC.agentMessages, { engine, lines }),
    engineStatus: (status) => send(IPC.agentStatus, status),
  });
  registerIpc();
  createWindow();
  void boot();
  void remote.init();
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
  opencode.stop();
  customAgent.stop();
  codexPty.dispose();
  void Promise.all([appServer.stop(), remote?.shutdown()]).finally(() => app.quit());
});
