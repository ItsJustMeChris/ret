import { normPath } from "../state/projects";
import { fileId, useUI, type Board, type CanvasWin, type UIState, type ViewMode } from "../state/ui";
import { T } from "./fixtures";
import { P, REDIS_WT } from "./workspace";

/**
 * Where every visitor starts: the same curated workspace, whatever an earlier visit left in
 * the persisted UI store. Canvas windows are laid out in world coordinates; the boot module fits
 * them to the frame once the canvas is on screen.
 */

const win = (id: string, threadId: string, x: number, y: number, w: number, h: number, z: number): CanvasWin => ({ id, threadId, x, y, w, h, z });

export const BOARD: Board = {
  id: "demo-main",
  name: "Main",
  viewport: { x: 24, y: 24, zoom: 0.62 },
  windows: [
    win("w-rate", T.rate, 0, 0, 540, 510, 3),
    win("w-vite", T.vite, 564, 0, 540, 510, 5),
    win("w-orders", T.orders, 1128, 0, 520, 510, 4),
    win("w-redis", T.redis, 0, 534, 540, 380, 1),
    win("w-notes", T.notes, 564, 534, 540, 380, 2),
    win("w-passkeys", T.passkeys, 1128, 534, 520, 380, 1),
  ],
};

export function seedUI(mode: ViewMode, theme: "dark" | "light", sidebarPinned: boolean) {
  const added = Date.now() - 30 * 86_400_000;
  const projects: UIState["projects"] = {};
  for (const path of Object.values(P)) projects[normPath(path)] = { path, explicit: true, addedAt: added };
  const api = normPath(P.api);
  const file = (rel: string) => fileId(`${P.api}/${rel}`);

  const seed: Partial<UIState> = {
    mode,
    theme,
    // Unpinned, the views get the whole frame; the sidebar slides in from the left edge.
    sidebarOpen: sidebarPinned,
    sidebarWidth: 252,
    projects,
    threadProject: { [T.redis]: api },
    worktrees: { [T.redis]: { path: REDIS_WT.path, branch: REDIS_WT.branch, repoRoot: REDIS_WT.repoRoot } },
    expanded: { [T.rate]: true },
    showAll: {},
    drafts: {},
    tabs: [T.rate, T.vite, T.orders, T.notes, T.passkeys],
    activeTab: T.rate,
    splits: { [T.rate]: { right: T.redis, ratio: 0.52 } },
    focusedSide: "left",
    showLinks: true,
    showDetails: false,
    boards: [structuredClone(BOARD)],
    activeBoard: BOARD.id,
    focusedWindow: null,
    selectedWindows: [],
    composer: { model: null, effort: null, access: "config" },
    composerBy: {},
    lastAgent: undefined,
    code: {
      project: null,
      tabs: [file("src/server/rateLimit.ts"), file("src/server/auth.ts")],
      active: file("src/server/rateLimit.ts"),
      chat: T.rate,
      expanded: { [`${P.api}/src`]: true, [`${P.api}/src/server`]: true, [`${P.api}/test`]: true },
      explorerWidth: 232,
      chatWidth: 420,
    },
    inbox: { selected: T.rate },
    paletteOpen: false,
    settingsOpen: false,
  };
  useUI.setState(seed);
}
