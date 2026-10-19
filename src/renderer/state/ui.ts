import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ProviderId } from "@shared/bridge";
import { hostOfKey, pathOfKey, scopedKey } from "./projects";

export interface ComposerPrefs {
  model: string | null;
  effort: string | null;
  access: AccessPreset;
  speed?: string;
}

/**
 * Ret's own views as apps (each defined in src/renderer/apps, listed in its index.ts): windows on the
 * canvas desktop, and some are full-screen modes too.
 */
export type ModeApp = "code" | "inbox";
export type AppKind = ModeApp | "terminal";
export type ViewMode = "focus" | "canvas" | ModeApp;
export const isModeApp = (mode: ViewMode): mode is ModeApp => mode !== "focus" && mode !== "canvas";

/** Code mode: a project's files in an editor, with one of its threads to talk to alongside. */
export interface CodeLayout {
  /** Project whose folder the explorer shows; null follows the chat thread's project. */
  project: string | null;
  /** Open files (file:… view ids), in tab order, and the one showing. */
  tabs: string[];
  active: string | null;
  /** Thread (or draft) in the chat column. */
  chat: string | null;
  /** Explorer folders that are open (absolute paths). */
  expanded: Record<string, true>;
  explorerWidth: number;
  chatWidth: number;
}

/** Inbox mode: threads that want something from you, across every project. */
export interface InboxState {
  selected: string | null;
}
/** One of a provider's access options (see agents.ts); "config" = whatever its own settings say. */
export type AccessPreset = string;
export type Theme = "dark" | "light" | "system";

export interface ProjectConf {
  path: string;
  /** Added via "Add project": also captures threads started in its subdirectories. */
  explicit?: boolean;
  name?: string;
  color?: string;
  pinned?: boolean;
  collapsed?: boolean;
  hidden?: boolean;
  addedAt: number;
}

export interface CanvasWin {
  id: string;
  /** Thread id or `draft:<id>` for a not-yet-started thread. */
  threadId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  /** Rect to restore when un-maximizing. */
  prev?: { x: number; y: number; w: number; h: number; vp: { x: number; y: number; zoom: number } };
}

export interface Board {
  id: string;
  name: string;
  windows: CanvasWin[];
  viewport: { x: number; y: number; zoom: number };
}

export interface FocusSplit {
  right: string;
  /** Left pane's share of the width, 0..1. */
  ratio: number;
}

export interface Draft {
  cwd: string;
  /** Its project, which also says which device the thread runs on (see hostOfKey). */
  projectKey: string;
  /** Agent the thread will start with (unset: the default from Settings). */
  provider?: ProviderId;
  /** For forks into a fresh worktree, the eventual thread is grouped under this project. */
  createdAt: number;
}

/** A terminal: a shell in a folder, on this computer or a paired device (its process lives only while Ret runs). */
export interface TermConf {
  cwd: string;
  /** The paired device it runs on; null for this computer. */
  host: string | null;
  /** The thread (or draft) it was opened for: it's listed in that thread's terminal panel. */
  thread: string | null;
  createdAt: number;
}

/** A thread's terminal panel (Focus, Code, Inbox). */
export interface TermDock {
  open: boolean;
  /** Its terminal showing. */
  active: string | null;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  repoRoot: string;
}

export interface UIState {
  mode: ViewMode;
  theme: Theme;
  sidebarOpen: boolean;
  sidebarWidth: number;
  projects: Record<string, ProjectConf>;
  /** Explicit thread → project assignment (forks into worktrees live elsewhere on disk). */
  threadProject: Record<string, string>;
  worktrees: Record<string, WorktreeInfo>;
  /** Folders in linked git worktrees → the same place in their main checkout, which they group with. */
  checkouts: Record<string, string>;
  /** Fork-group folders that are expanded, keyed by root thread id. */
  expanded: Record<string, boolean>;
  /** Projects showing their full thread list instead of the most recent few. */
  showAll: Record<string, boolean>;
  /** Paired devices' sidebar sections that are folded away, by host key. */
  hostsCollapsed?: Record<string, boolean>;
  drafts: Record<string, Draft>;
  tabs: string[];
  activeTab: string | null;
  /** Focus mode: a tab (keyed by its thread) can show a second thread beside it. */
  splits: Record<string, FocusSplit>;
  /** Which side of a split view has focus (drives shortcuts like Ctrl+W / Ctrl+Shift+F). */
  focusedSide: "left" | "right";
  /** Canvas: draw lines from each thread to its forks. */
  showLinks: boolean;
  /**
   * Threads whose details panel is open, by thread id: a column beside the transcript in a pane wide
   * enough for it. (A narrower pane opens it as a card for as long as you look, kept by the pane.)
   */
  details: Record<string, true>;
  boards: Board[];
  activeBoard: string;
  focusedWindow: string | null;
  /** Canvas windows picked with Shift+click (or a Shift+drag marquee); dragging one moves them all. */
  selectedWindows: string[];
  /** Last-used new-thread settings (Codex's, from before there were providers). */
  composer: ComposerPrefs;
  /** Last-used new-thread settings per provider. */
  composerBy?: Partial<Record<ProviderId, ComposerPrefs>>;
  /** Agent of the model last picked for a new thread: the next one starts with it. */
  lastAgent?: ProviderId;
  code: CodeLayout;
  inbox: InboxState;
  /** Terminals, by id: listed in their thread's panel, or shown as windows on the canvas. */
  terminals: Record<string, TermConf>;
  /** Each thread's terminal panel, by thread id. */
  termDocks: Record<string, TermDock>;
  /** Height of the terminal panel, in px. */
  termHeight: number;
  paletteOpen: boolean;
  settingsOpen: boolean;
}

const uid = () => Math.random().toString(36).slice(2, 10);

const defaultBoard = (): Board => ({ id: uid(), name: "Main", windows: [], viewport: { x: 40, y: 40, zoom: 1 } });

const initialBoard = defaultBoard();

export const useUI = create<UIState>()(
  persist(
    (): UIState => ({
      mode: "focus",
      theme: "dark",
      sidebarOpen: true,
      sidebarWidth: 284,
      projects: {},
      threadProject: {},
      worktrees: {},
      checkouts: {},
      expanded: {},
      showAll: {},
      drafts: {},
      tabs: [],
      activeTab: null,
      splits: {},
      focusedSide: "left",
      showLinks: true,
      details: {},
      boards: [initialBoard],
      activeBoard: initialBoard.id,
      focusedWindow: null,
      selectedWindows: [],
      composer: { model: null, effort: null, access: "config" },
      code: { project: null, tabs: [], active: null, chat: null, expanded: {}, explorerWidth: 260, chatWidth: 420 },
      inbox: { selected: null },
      terminals: {},
      termDocks: {},
      termHeight: 260,
      paletteOpen: false,
      settingsOpen: false,
    }),
    {
      name: "ret-ui",
      version: 1,
      partialize: (s) => {
        // (showDetails: the one switch every thread's details panel used to share.)
        const { paletteOpen: _p, settingsOpen: _s, selectedWindows: _w, showDetails: _d, ...rest } = s as UIState & { showDetails?: boolean };
        return rest;
      },
    },
  ),
);

export const isDraft = (id: string) => id.startsWith("draft:");
/** A file open as its own view (a tab, split side or canvas window) rather than a thread. */
export const isFile = (id: string) => id.startsWith("file:");
/** A file's view id: `file:<path>`, or `file:<host>|<path>` for one on a paired device. */
export const fileId = (path: string, host?: string | null) => `file:${scopedKey(host, path)}`;
export const filePath = (id: string) => pathOfKey(id.slice(5));
/** The paired device a file view's file is on; null for this computer. */
export const fileHost = (id: string) => hostOfKey(id.slice(5));
/**
 * One of Ret's apps living as a window on the canvas desktop: `app:<kind>` for one there's a single
 * window of (Inbox, Code), `app:<kind>:<instance>` for one with as many as you like (a terminal's
 * instance is its terminal id).
 */
export const isApp = (id: string) => id.startsWith("app:");
export const appId = (kind: AppKind, instance?: string) => (instance ? `app:${kind}:${instance}` : `app:${kind}`);
export const appKind = (id: string) => id.slice(4).split(":")[0] as AppKind;
export const appInstance = (id: string) => id.slice(5 + appKind(id).length) || null;
/** The terminal a canvas window shows, if it's a terminal's. */
export const terminalOf = (id: string | null | undefined) => (id?.startsWith("app:terminal:") ? id.slice(13) : null);
/** A real agent thread (not a draft, a file view, or an app window). */
export const isThread = (id: string) => !isDraft(id) && !isFile(id) && !isApp(id);
export const newId = uid;

export function activeBoard(s: UIState = useUI.getState()): Board {
  return s.boards.find((b) => b.id === s.activeBoard) ?? s.boards[0];
}

/** Open or close a thread's details panel (the column a wide pane shows). */
export function setDetails(threadId: string, open: boolean) {
  useUI.setState((s) => {
    if (!!s.details[threadId] === open) return s;
    const details = { ...s.details };
    if (open) details[threadId] = true;
    else delete details[threadId];
    return { details };
  });
}

export function updateBoard(fn: (b: Board) => Board) {
  useUI.setState((s) => ({ boards: s.boards.map((b) => (b.id === s.activeBoard ? fn(b) : b)) }));
}
