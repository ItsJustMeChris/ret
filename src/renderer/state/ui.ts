import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ViewMode = "focus" | "canvas" | "code" | "inbox";

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
export type AccessPreset = "config" | "read-only" | "auto" | "full";
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
  projectKey: string;
  /** For forks into a fresh worktree, the eventual thread is grouped under this project. */
  createdAt: number;
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
  /** Fork-group folders that are expanded, keyed by root thread id. */
  expanded: Record<string, boolean>;
  /** Projects showing their full thread list instead of the most recent few. */
  showAll: Record<string, boolean>;
  drafts: Record<string, Draft>;
  tabs: string[];
  activeTab: string | null;
  /** Focus mode: a tab (keyed by its thread) can show a second thread beside it. */
  splits: Record<string, FocusSplit>;
  /** Which side of a split view has focus (drives shortcuts like Ctrl+W / Ctrl+Shift+F). */
  focusedSide: "left" | "right";
  /** Canvas: draw lines from each thread to its forks. */
  showLinks: boolean;
  /** Wide panes: plan / changes / tokens / lineage panel on the right. Off unless asked for. */
  showDetails: boolean;
  boards: Board[];
  activeBoard: string;
  focusedWindow: string | null;
  /** Canvas windows picked with Shift+click (or a Shift+drag marquee); dragging one moves them all. */
  selectedWindows: string[];
  composer: { model: string | null; effort: string | null; access: AccessPreset; speed?: string };
  code: CodeLayout;
  inbox: InboxState;
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
      expanded: {},
      showAll: {},
      drafts: {},
      tabs: [],
      activeTab: null,
      splits: {},
      focusedSide: "left",
      showLinks: true,
      showDetails: false,
      boards: [initialBoard],
      activeBoard: initialBoard.id,
      focusedWindow: null,
      selectedWindows: [],
      composer: { model: null, effort: null, access: "config" },
      code: { project: null, tabs: [], active: null, chat: null, expanded: {}, explorerWidth: 260, chatWidth: 420 },
      inbox: { selected: null },
      paletteOpen: false,
      settingsOpen: false,
    }),
    {
      name: "ret-ui",
      version: 1,
      partialize: (s) => {
        const { paletteOpen: _p, settingsOpen: _s, selectedWindows: _w, ...rest } = s;
        return rest;
      },
    },
  ),
);

export const isDraft = (id: string) => id.startsWith("draft:");
/** A file open as its own view (a tab, split side or canvas window) rather than a thread. */
export const isFile = (id: string) => id.startsWith("file:");
export const fileId = (path: string) => `file:${path}`;
export const filePath = (id: string) => id.slice(5);
/** One of Ret's own views (Inbox, Code) living as a window on the canvas desktop. */
export type AppKind = "inbox" | "code";
export const isApp = (id: string) => id.startsWith("app:");
export const appId = (kind: AppKind) => `app:${kind}`;
export const appKind = (id: string) => id.slice(4) as AppKind;
/** A real Codex thread (not a draft, a file view, or an app window). */
export const isThread = (id: string) => !isDraft(id) && !isFile(id) && !isApp(id);
export const newId = uid;

export function activeBoard(s: UIState = useUI.getState()): Board {
  return s.boards.find((b) => b.id === s.activeBoard) ?? s.boards[0];
}

export function updateBoard(fn: (b: Board) => Board) {
  useUI.setState((s) => ({ boards: s.boards.map((b) => (b.id === s.activeBoard ? fn(b) : b)) }));
}
