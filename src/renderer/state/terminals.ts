import { create } from "zustand";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { engineId } from "@shared/bridge";
import { rpcFor, RpcError, type RpcClient } from "../rpc/client";
import { bridge } from "../bridge";
import { useShallow } from "../lib/shallow";
import { activeBoard, appId, isApp, isDraft, isFile, newId, terminalOf, useUI, type TermConf, type UIState } from "./ui";
import { useThreads } from "./threads";
import { hostOfView, projectTreeNow } from "./projectTree";
import { hostName, hostPlatform } from "./hosts";
import { focusWindow, openThread } from "./actions";
import { toast } from "./toasts";

/**
 * Terminals: a shell in a folder, run through the `process/*` methods Ret's main process answers on
 * every engine connection (so on a paired device's too). Each lives here, outside React, with its
 * xterm.js view in an element of its own that moves to whichever view shows it: a thread's panel in
 * Focus, Code or the Inbox, or a terminal window on the canvas. So switching modes, tabs or windows
 * never restarts the shell or loses what's on screen. A terminal's shell starts the first time it's
 * shown; one left from a previous run of Ret starts again, fresh, in the same folder.
 */

export type TermState = "idle" | "starting" | "running" | "exited" | "failed";

export interface TermLive {
  state: TermState;
  exitCode?: number;
  /** What the shell calls itself (its window title), else the shell's name. */
  title?: string;
}

interface TermsState {
  live: Record<string, TermLive>;
  /** Which view has each terminal (a TerminalView's token). */
  holders: Record<string, string>;
}

export const useTerms = create<TermsState>(() => ({ live: {}, holders: {} }));

const IDLE: TermLive = { state: "idle" };
const SPAWN_MS = 15_000;
const RESIZE_MS = 40;
/** Input typed before the shell is up, kept to send once it is. */
const MAX_QUEUED = 64 * 1024;

const sessions = new Map<string, Session>();
const byHandle = new Map<string, Session>();

const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** The shells to try, in order, on the device it runs on. */
function shellsFor(host: string | null): { command: string[]; name: string }[] {
  if (hostPlatform(host) === "win32") {
    return [
      { command: ["pwsh.exe", "-NoLogo"], name: "pwsh" },
      { command: ["powershell.exe", "-NoLogo"], name: "powershell" },
    ];
  }
  // The user's own login shell, whatever it is there.
  return [{ command: ["/bin/sh", "-c", 'exec "${SHELL:-/bin/sh}" -l'], name: "shell" }];
}

const SHELL_ENV = { TERM: "xterm-256color", COLORTERM: "truecolor", TERM_PROGRAM: "Ret" };

/** Engine connections to start a terminal through on a device: Ret's main answers on both (Claude's first: it never restarts under it). */
function clientsFor(host: string | null): RpcClient[] {
  return [rpcFor(engineId("claude", host)), rpcFor(engineId("codex", host))];
}

const listening = new WeakSet<RpcClient>();
function listen(client: RpcClient) {
  if (listening.has(client)) return;
  listening.add(client);
  client.onNotification((method, params) => {
    if (method === "process/outputDelta") byHandle.get(params?.processHandle)?.output(params.deltaBase64);
    else if (method === "process/exited") byHandle.get(params?.processHandle)?.exited(params.processHandle, Number(params.exitCode));
  });
  // A paired device's window that reconnects has had its terminals ended there (the device's mux
  // ends a window's terminals when it goes). This computer's outlive an engine's restart.
  let first = true;
  client.onReady(() => {
    if (first) return void (first = false);
    for (const s of sessions.values()) if (s.client === client && s.handle && s.conf()?.host) s.lost();
  });
}

// ---------------------------------------------------------------------------
// Look
// ---------------------------------------------------------------------------

const DARK = {
  background: "#0a0a0a",
  foreground: "#e4e4e4",
  cursor: "#ededed",
  cursorAccent: "#0a0a0a",
  selectionBackground: "rgba(139, 156, 255, 0.32)",
  selectionInactiveBackground: "rgba(139, 156, 255, 0.16)",
  scrollbarSliderBackground: "rgba(255, 255, 255, 0.12)",
  scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.2)",
  scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.26)",
  black: "#2a2a2a",
  red: "#f2616a",
  green: "#3fd18f",
  yellow: "#f2b33d",
  blue: "#8b9cff",
  magenta: "#d38cf2",
  cyan: "#4fcfd8",
  white: "#d0d0d0",
  brightBlack: "#767676",
  brightRed: "#ff8a91",
  brightGreen: "#72e4b0",
  brightYellow: "#ffd27a",
  brightBlue: "#b3bfff",
  brightMagenta: "#e6b3ff",
  brightCyan: "#8be6ec",
  brightWhite: "#ffffff",
};

const LIGHT = {
  background: "#ffffff",
  foreground: "#18181f",
  cursor: "#18181f",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(79, 95, 232, 0.24)",
  selectionInactiveBackground: "rgba(79, 95, 232, 0.12)",
  scrollbarSliderBackground: "rgba(10, 10, 30, 0.14)",
  scrollbarSliderHoverBackground: "rgba(10, 10, 30, 0.24)",
  scrollbarSliderActiveBackground: "rgba(10, 10, 30, 0.3)",
  black: "#18181f",
  red: "#d93a44",
  green: "#0f8a54",
  yellow: "#a86f00",
  blue: "#4f5fe8",
  magenta: "#a23fc4",
  cyan: "#0d8291",
  // Programs that print "white" mean light-on-dark: grey stays readable on white.
  white: "#8c8c9e",
  brightBlack: "#6b6b80",
  brightRed: "#e5535c",
  brightGreen: "#12a464",
  brightYellow: "#c98500",
  brightBlue: "#3b4ad6",
  brightMagenta: "#b552d6",
  brightCyan: "#11a0b2",
  brightWhite: "#3a3a48",
};

const themeNow = () => (document.documentElement.dataset.theme === "light" ? LIGHT : DARK);
const monoFont = () => getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "monospace";

let themeWatched = false;
function watchTheme() {
  if (themeWatched) return;
  themeWatched = true;
  new MutationObserver(() => {
    const theme = themeNow();
    for (const s of sessions.values()) if (s.term) s.term.options.theme = theme;
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

/**
 * Where the pointer last was (window-wide, captured before anything handles it): a terminal in a
 * zoomed canvas window turns it into its own unscaled coordinates (see `unscale`).
 */
const pointer = { x: 0, y: 0 };
let pointerWatched = false;
function watchPointer() {
  if (pointerWatched) return;
  pointerWatched = true;
  const note = (e: MouseEvent) => {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
  };
  for (const type of ["pointerdown", "pointermove", "pointerup", "mousedown", "mousemove", "mouseup", "click", "dblclick", "wheel", "contextmenu"]) {
    window.addEventListener(type, note as EventListener, { capture: true, passive: true });
  }
}

/**
 * xterm finds the cell under the pointer from its screen's on-screen rect and its unscaled cell size,
 * which disagree in a canvas window drawn at another zoom. Its screen reports a rect, in the
 * pointer's terms, that puts the pointer as far from its corner as it is in the screen's own pixels.
 */
function unscale(screen: HTMLElement) {
  const own = screen.getBoundingClientRect.bind(screen);
  screen.getBoundingClientRect = () => {
    const r = own();
    const scale = screen.offsetWidth ? r.width / screen.offsetWidth : 1;
    if (!scale || Math.abs(scale - 1) < 0.001) return r;
    const left = pointer.x - (pointer.x - r.left) / scale;
    const top = pointer.y - (pointer.y - r.top) / scale;
    return new DOMRect(left, top, r.width / scale, r.height / scale);
  };
}

// ---------------------------------------------------------------------------
// A terminal
// ---------------------------------------------------------------------------

class Session {
  term: Terminal | null = null;
  private fit: FitAddon | null = null;
  /** xterm lives in here, and this moves between the views that show it. */
  readonly el = document.createElement("div");
  client: RpcClient | null = null;
  handle: string | null = null;
  private building: Promise<void> | null = null;
  private queued: Uint8Array[] = [];
  private queuedBytes = 0;
  private resizeTimer = 0;
  /** The size the shell was last told. */
  private told = "";
  /** Focus it once it's built and in its view. */
  wantFocus = false;
  disposed = false;

  constructor(readonly id: string) {
    this.el.className = "term-surface";
  }

  conf(): TermConf | undefined {
    return useUI.getState().terminals[this.id];
  }

  live(): TermLive {
    return useTerms.getState().live[this.id] ?? IDLE;
  }

  private patch(p: Partial<TermLive>) {
    useTerms.setState((s) => ({ live: { ...s.live, [this.id]: { ...(s.live[this.id] ?? IDLE), ...p } } }));
  }

  /** Show it in `host`, taking it from wherever it was; its shell starts the first time. */
  attach(host: HTMLElement, token: string) {
    if (this.disposed) return;
    if (this.el.parentElement !== host) host.appendChild(this.el);
    if (useTerms.getState().holders[this.id] !== token) useTerms.setState((s) => ({ holders: { ...s.holders, [this.id]: token } }));
    if (this.term) {
      this.refit();
      this.term.refresh(0, this.term.rows - 1);
      this.focusIfWanted();
      return;
    }
    this.building ??= this.build().then(() => {
      if (this.disposed || !this.el.isConnected) return;
      this.refit();
      this.focusIfWanted();
      if (this.live().state === "idle") void this.start();
    });
  }

  /** A view that had it went away. */
  release(token: string) {
    if (useTerms.getState().holders[this.id] !== token) return;
    useTerms.setState((s) => {
      const holders = { ...s.holders };
      delete holders[this.id];
      return { holders };
    });
    this.el.remove();
  }

  private async build() {
    watchTheme();
    watchPointer();
    const { Terminal, FitAddon, WebLinksAddon, Unicode11Addon } = await import("../lib/xterm");
    if (this.disposed) return;
    const host = this.conf()?.host ?? null;
    const term = new Terminal({
      allowProposedApi: true,
      fontFamily: monoFont(),
      fontSize: 12.5,
      lineHeight: 1.2,
      scrollback: 5000,
      cursorBlink: true,
      cursorInactiveStyle: "outline",
      theme: themeNow(),
      macOptionIsMeta: true,
      ...(hostPlatform(host) === "win32" ? { windowsPty: { backend: "conpty" as const } } : {}),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const unicode = new Unicode11Addon();
    term.loadAddon(unicode);
    term.unicode.activeVersion = "11";
    // Links open with Ctrl/Cmd+click, so a click to place the cursor or select never leaves Ret.
    term.loadAddon(new WebLinksAddon((e, uri) => (e.ctrlKey || e.metaKey) && void bridge.shell.openExternal(uri)));
    term.attachCustomKeyEventHandler((e) => this.key(e));
    term.onData((data) => this.input(encoder.encode(data)));
    term.onBinary((data) => this.input(Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff)));
    term.onResize(() => this.tellSize());
    term.onTitleChange((title) => this.patch({ title: tidyTitle(title) }));
    term.open(this.el);
    const screen = this.el.querySelector<HTMLElement>(".xterm-screen");
    if (screen) unscale(screen);
    this.term = term;
    this.fit = fit;
  }

  /** Keys the app keeps (and copy/paste); everything else goes to the shell. Returning false hands it on. */
  private key(e: KeyboardEvent): boolean {
    if (e.type !== "keydown") return true;
    const mac = bridge.platform === "darwin";
    const mod = mac ? e.metaKey : e.ctrlKey;
    const k = e.key.toLowerCase();
    // Copy: Ctrl+C (or Ctrl+Shift+C) with something selected; with nothing selected it's an interrupt.
    if (mod && !e.altKey && k === "c" && this.term?.hasSelection()) {
      void bridge.copy(this.term.getSelection());
      this.term.clearSelection();
      e.preventDefault();
      return false;
    }
    // Paste: the browser's own, which xterm takes (bracketed, when the shell asks for it).
    if (mod && !e.altKey && k === "v") return false;
    // Ret's own shortcuts: the palette, tab and window switching, modes, the terminal panel.
    if (e.code === "Backquote" && e.ctrlKey) return false;
    if (mod && !e.altKey && (k === "k" || k === "tab" || /^[1-9]$/.test(e.key))) return false;
    if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && /^[1-4]$/.test(e.key)) return false;
    // Cmd shortcuts on a Mac belong to the app (shells take Ctrl).
    if (mac && e.metaKey) return false;
    return true;
  }

  private input(bytes: Uint8Array) {
    const state = this.live().state;
    if (state === "exited" || state === "failed") {
      if (bytes.includes(13)) void this.start(); // Enter starts it again
      return;
    }
    if (state !== "running" || !this.client || !this.handle) {
      if (this.queuedBytes + bytes.length > MAX_QUEUED) return;
      this.queued.push(bytes);
      this.queuedBytes += bytes.length;
      return;
    }
    void this.client.direct("process/writeStdin", { processHandle: this.handle, deltaBase64: toBase64(bytes) }).catch(() => {});
  }

  output(b64: string) {
    if (b64) this.term?.write(fromBase64(b64));
  }

  exited(handle: string, code: number) {
    byHandle.delete(handle);
    if (handle !== this.handle) return;
    this.handle = null;
    this.patch({ state: "exited", exitCode: code });
    this.term?.write(`\r\n\x1b[90m[Exited${code ? ` with code ${code}` : ""} · press Enter to start a new shell]\x1b[0m\r\n`);
  }

  /** Its device's connection dropped, and that ended the shell there. */
  lost() {
    const handle = this.handle;
    if (!handle) return;
    void this.client?.direct("process/kill", { processHandle: handle }).catch(() => {});
    byHandle.delete(handle);
    this.handle = null;
    this.patch({ state: "exited", exitCode: undefined });
    this.term?.write(`\r\n\x1b[90m[Lost the connection to ${hostName(this.conf()?.host)} · press Enter to start a new shell]\x1b[0m\r\n`);
  }

  async start() {
    const conf = this.conf();
    if (!conf || !this.term || this.disposed) return;
    const st = this.live().state;
    if (st === "starting" || st === "running") return;
    this.patch({ state: "starting", exitCode: undefined });
    this.queued = [];
    this.queuedBytes = 0;
    const size = { cols: this.term.cols, rows: this.term.rows };
    let error = "";
    engines: for (const client of clientsFor(conf.host)) {
      listen(client);
      for (const shell of shellsFor(conf.host)) {
        const handle = `ret-term-${this.id}-${newId()}`;
        byHandle.set(handle, this);
        try {
          await withTimeout(
            client.direct("process/spawn", { command: shell.command, processHandle: handle, cwd: conf.cwd, tty: true, size, outputBytesCap: null, timeoutMs: null, env: SHELL_ENV }),
            SPAWN_MS,
          );
        } catch (err) {
          byHandle.delete(handle);
          error = (err as Error).message ?? String(err);
          // A spawn that only timed out may still start: don't leave it running unseen.
          if (!(err instanceof RpcError)) void client.direct("process/kill", { processHandle: handle }).catch(() => {});
          // An older Ret on a paired device: its Claude connection doesn't run terminals.
          if (err instanceof RpcError && err.code === -32601) {
            error = conf.host ? `the Ret on ${hostName(conf.host)} is too old to run terminals` : "terminals aren't available here";
            continue engines;
          }
          if (/not found|cannot find|no such file|ENOENT/i.test(error)) continue;
          break engines;
        }
        if (this.disposed) {
          void client.direct("process/kill", { processHandle: handle }).catch(() => {});
          byHandle.delete(handle);
          return;
        }
        this.client = client;
        this.handle = handle;
        this.told = `${size.cols}x${size.rows}`;
        this.patch({ state: "running", title: this.live().title ?? shell.name });
        const queued = this.queued;
        this.queued = [];
        this.queuedBytes = 0;
        for (const bytes of queued) this.input(bytes);
        this.tellSize();
        return;
      }
    }
    this.patch({ state: "failed" });
    this.term.write(`\r\n\x1b[31mCouldn't start a shell${conf.host ? ` on ${hostName(conf.host)}` : ""}: ${error || "no shell found"}\x1b[0m\r\n\x1b[90m[Press Enter to try again]\x1b[0m\r\n`);
  }

  /** A new shell in place of the one there (what's on screen stays). */
  restart() {
    if (this.handle) {
      void this.client?.direct("process/kill", { processHandle: this.handle }).catch(() => {});
      byHandle.delete(this.handle);
      this.handle = null;
    }
    this.patch({ state: "idle" });
    this.term?.write("\r\n");
    void this.start();
    this.focus();
  }

  /** Fit the terminal to its view. */
  refit() {
    if (!this.fit || !this.el.isConnected || !this.el.clientWidth || !this.el.clientHeight) return;
    try {
      this.fit.fit();
    } catch {
      /* not laid out yet */
    }
  }

  /** Tell the shell its size (once the resizing settles). */
  private tellSize() {
    clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => {
      if (!this.term || !this.client || !this.handle) return;
      const size = `${this.term.cols}x${this.term.rows}`;
      if (size === this.told) return;
      this.told = size;
      void this.client.direct("process/resizePty", { processHandle: this.handle, size: { cols: this.term.cols, rows: this.term.rows } }).catch(() => {});
    }, RESIZE_MS);
  }

  private focusIfWanted() {
    if (!this.wantFocus || !this.term || !this.el.isConnected) return;
    this.wantFocus = false;
    this.term.focus();
  }

  focus() {
    this.wantFocus = true;
    this.focusIfWanted();
  }

  get focused() {
    return !!this.el.isConnected && this.el.contains(document.activeElement);
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.resizeTimer);
    if (this.handle) {
      void this.client?.direct("process/kill", { processHandle: this.handle }).catch(() => {});
      byHandle.delete(this.handle);
      this.handle = null;
    }
    this.term?.dispose();
    this.el.remove();
    useTerms.setState((s) => {
      const live = { ...s.live };
      const holders = { ...s.holders };
      delete live[this.id];
      delete holders[this.id];
      return { live, holders };
    });
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("the shell didn't start in time")), ms);
    p.then(resolve, reject).finally(() => clearTimeout(t));
  });
}

/** A window title worth showing: a shell's executable path becomes its name. */
function tidyTitle(title: string): string {
  const t = title.trim();
  const exe = /^(?:[A-Za-z]:)?[\\/].*[\\/]([^\\/]+?)(?:\.exe)?$/i.exec(t);
  return (exe ? exe[1] : t).slice(0, 120);
}

/** A terminal's controller (built on first use). */
export function terminalSession(id: string): Session | null {
  let s = sessions.get(id);
  if (!s) {
    if (!useUI.getState().terminals[id]) return null;
    sessions.set(id, (s = new Session(id)));
  }
  return s;
}

export type { Session as TerminalSession };

// ---------------------------------------------------------------------------
// Terminals and where they show
// ---------------------------------------------------------------------------

/** A thread's terminals, oldest first. */
export function threadTerminals(s: UIState, threadId: string): string[] {
  return Object.entries(s.terminals)
    .filter(([, t]) => t.thread === threadId)
    .sort((a, b) => a[1].createdAt - b[1].createdAt)
    .map(([id]) => id);
}

export function useThreadTerminals(threadId: string | null): string[] {
  return useUI(useShallow((s) => (threadId ? threadTerminals(s, threadId) : NONE)));
}
const NONE: string[] = [];

/** Whether any of a thread's terminals has a shell running. */
export function useThreadTerminalRunning(threadId: string): boolean {
  const ids = useThreadTerminals(threadId);
  return useTerms((s) => ids.some((id) => s.live[id]?.state === "running" || s.live[id]?.state === "starting"));
}

/** Where a thread's terminal opens: its folder, on its device. */
function placeFor(threadId: string): { cwd: string; host: string | null } | null {
  const ui = useUI.getState();
  const cwd = isDraft(threadId) ? ui.drafts[threadId]?.cwd : useThreads.getState().threads[threadId]?.cwd;
  return cwd ? { cwd, host: hostOfView(threadId) } : null;
}

export function newTerminal(conf: Omit<TermConf, "createdAt">): string {
  const id = newId();
  useUI.setState((s) => ({ terminals: { ...s.terminals, [id]: { ...conf, createdAt: Date.now() } } }));
  return id;
}

/** A new terminal in a thread's folder, listed in its panel. */
export function newThreadTerminal(threadId: string): string | null {
  const place = placeFor(threadId);
  if (!place) {
    toast("This thread has no folder to open a terminal in", "error");
    return null;
  }
  const id = newTerminal({ ...place, thread: threadId });
  useUI.setState((s) => ({ termDocks: { ...s.termDocks, [threadId]: { open: true, active: id } } }));
  return id;
}

/** End a terminal: its shell, its tab in its thread's panel, its canvas windows. */
export function closeTerminal(id: string) {
  sessions.get(id)?.dispose();
  sessions.delete(id);
  useUI.setState((s) => {
    const conf = s.terminals[id];
    if (!conf) return s;
    const terminals = { ...s.terminals };
    delete terminals[id];
    const win = appId("terminal", id);
    const boards = s.boards.some((b) => b.windows.some((w) => w.threadId === win))
      ? s.boards.map((b) => ({ ...b, windows: b.windows.filter((w) => w.threadId !== win) }))
      : s.boards;
    let termDocks = s.termDocks;
    const owner = conf.thread;
    const dock = owner ? s.termDocks[owner] : undefined;
    if (owner && dock) {
      const rest = threadTerminals({ ...s, terminals }, owner);
      termDocks = { ...s.termDocks };
      if (!rest.length) delete termDocks[owner];
      else if (dock.active === id) {
        const mine = threadTerminals(s, owner);
        termDocks[owner] = { ...dock, active: rest[Math.min(mine.indexOf(id), rest.length - 1)] };
      }
    }
    return { terminals, boards, termDocks };
  });
}

export function closeThreadTerminals(threadId: string) {
  for (const id of threadTerminals(useUI.getState(), threadId)) closeTerminal(id);
}

/** A draft became a thread: its terminals go with it. */
export function moveTerminals(s: UIState, from: string, to: string): Partial<UIState> {
  const mine = Object.entries(s.terminals).filter(([, t]) => t.thread === from);
  if (!mine.length && !s.termDocks[from]) return {};
  const terminals = { ...s.terminals };
  for (const [id, t] of mine) terminals[id] = { ...t, thread: to };
  const termDocks = { ...s.termDocks };
  if (termDocks[from]) {
    termDocks[to] = termDocks[from];
    delete termDocks[from];
  }
  return { terminals, termDocks };
}

export function restartTerminal(id: string) {
  terminalSession(id)?.restart();
}

export function focusTerminal(id: string) {
  terminalSession(id)?.focus();
}

/**
 * Show a thread's terminal panel (with a terminal in it, focused) or hide it. From the keyboard
 * (`fromKeys`), an open panel you're not typing in takes the keyboard first, as an editor's does.
 */
export function toggleDock(threadId: string, opts: { fromKeys?: boolean } = {}) {
  const ui = useUI.getState();
  const dock = ui.termDocks[threadId];
  const ids = threadTerminals(ui, threadId);
  const active = dock?.active && ids.includes(dock.active) ? dock.active : ids[ids.length - 1];
  if (dock?.open && active) {
    if (opts.fromKeys && !sessions.get(active)?.focused) return focusTerminal(active);
    useUI.setState((s) => ({ termDocks: { ...s.termDocks, [threadId]: { ...dock, open: false } } }));
    focusComposer(threadId);
    return;
  }
  const id = active ?? newThreadTerminal(threadId);
  if (!id) return;
  useUI.setState((s) => ({ termDocks: { ...s.termDocks, [threadId]: { open: true, active: id } } }));
  focusTerminal(id);
}

export function hideDock(threadId: string) {
  useUI.setState((s) => (s.termDocks[threadId] ? { termDocks: { ...s.termDocks, [threadId]: { ...s.termDocks[threadId], open: false } } } : s));
  focusComposer(threadId);
}

export function showInDock(threadId: string, id: string) {
  useUI.setState((s) => ({ termDocks: { ...s.termDocks, [threadId]: { open: true, active: id } } }));
  focusTerminal(id);
}

function focusComposer(threadId: string) {
  requestAnimationFrame(() => {
    const ta = [...document.querySelectorAll<HTMLTextAreaElement>(`.thread-pane[data-thread="${CSS.escape(threadId)}"] .composer textarea`)].find((el) => el.offsetParent);
    ta?.focus({ preventScroll: true });
  });
}

/**
 * A thread's terminal as a window on the canvas, beside the thread's window: the one its panel
 * shows (the same shell, wherever you look at it), else a new one.
 */
export function openThreadTerminalWindow(threadId: string, opts: { fresh?: boolean } = {}) {
  const ui = useUI.getState();
  const ids = threadTerminals(ui, threadId);
  const dockActive = ui.termDocks[threadId]?.active;
  let id = opts.fresh ? null : (dockActive && ids.includes(dockActive) ? dockActive : ids[ids.length - 1]) ?? null;
  if (!id) {
    const place = placeFor(threadId);
    if (!place) return toast("This thread has no folder to open a terminal in", "error");
    id = newTerminal({ ...place, thread: threadId });
    useUI.setState((s) => ({ termDocks: { ...s.termDocks, [threadId]: { open: s.termDocks[threadId]?.open ?? false, active: id! } } }));
  }
  showTerminalWindow(id, { besideThread: threadId });
}

/** A terminal of its own on the canvas (not a thread's), in a project's folder. */
export function newTerminalWindow(place: { cwd: string; host: string | null }, at?: { x: number; y: number }) {
  const id = newTerminal({ ...place, thread: null });
  showTerminalWindow(id, { at });
  return id;
}

function showTerminalWindow(id: string, opts: { besideThread?: string; at?: { x: number; y: number } }) {
  const win = appId("terminal", id);
  const existing = activeBoard().windows.find((w) => w.threadId === win);
  if (existing) focusWindow(existing.id, true);
  else openThread(win, { mode: "canvas", ...opts });
  focusTerminal(id);
}

/**
 * Ctrl+`: the current thread's terminal. In Focus, Code and the Inbox its panel opens (or takes the
 * keyboard, or goes away); on the canvas its terminal window opens beside it, and from a terminal
 * window you go back to its thread.
 */
export function toggleTerminal(threadId: string | null, opts: { fresh?: boolean } = {}) {
  const ui = useUI.getState();
  if (ui.mode === "canvas") {
    const term = terminalOf(threadId);
    if (term) {
      const owner = ui.terminals[term]?.thread;
      const w = owner && activeBoard(ui).windows.find((x) => x.threadId === owner);
      if (opts.fresh) {
        const conf = ui.terminals[term];
        if (conf) newTerminalWindow({ cwd: conf.cwd, host: conf.host });
      } else if (w && owner) {
        focusWindow(w.id, true);
        focusComposer(owner);
      }
      return;
    }
    if (threadId && !isFile(threadId) && !isApp(threadId)) return openThreadTerminalWindow(threadId, opts);
    // Nothing (or an Inbox or Code window) in focus: one of its own, in the latest project.
    const project = projectTreeNow()[0];
    if (project) newTerminalWindow({ cwd: project.path, host: project.host });
    return;
  }
  if (!threadId || isFile(threadId)) return;
  if (opts.fresh) {
    const id = newThreadTerminal(threadId);
    if (id) focusTerminal(id);
    return;
  }
  toggleDock(threadId, { fromKeys: true });
}

/** Closing a canvas window: a terminal of its own goes with it; a thread's stays in the thread's panel. */
export function terminalWindowClosed(winThreadId: string) {
  const id = terminalOf(winThreadId);
  if (!id) return;
  const ui = useUI.getState();
  const conf = ui.terminals[id];
  if (!conf || conf.thread) return;
  if (ui.boards.some((b) => b.windows.some((w) => w.threadId === winThreadId))) return;
  closeTerminal(id);
}

/**
 * Terminals nothing shows any more: one of its own whose windows are all gone (a board deleted),
 * or a draft's whose draft was closed.
 */
function gc(s: UIState) {
  const onBoards = new Set(s.boards.flatMap((b) => b.windows.map((w) => terminalOf(w.threadId))).filter(Boolean) as string[]);
  for (const [id, t] of Object.entries(s.terminals)) {
    if (t.thread ? isDraft(t.thread) && !s.drafts[t.thread] : !onBoards.has(id)) queueMicrotask(() => closeTerminal(id));
  }
}

useUI.subscribe((s, prev) => {
  if (s.boards !== prev.boards || s.drafts !== prev.drafts) gc(s);
});
gc(useUI.getState());

/** What to call a terminal: what its shell calls itself, else its folder. */
export const terminalTitle = (live: TermLive | undefined, conf: TermConf | undefined) =>
  live?.title || (conf ? conf.cwd.split(/[\\/]/).filter(Boolean).pop() : null) || "Terminal";
