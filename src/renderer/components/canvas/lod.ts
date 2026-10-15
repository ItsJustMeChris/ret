import { activeBoard, useUI, type CanvasWin } from "../../state/ui";
import { viewsHeld } from "../../state/useThread";
import { liveRect, type Rect } from "./live";
import { CARD_ZOOM, viewport, type Viewport } from "./viewport";

/**
 * How much of each window the canvas draws (its level of detail), set straight on the DOM so a pan
 * or zoom never re-renders a window:
 *
 * - Away from the view, a window is culled: its views stop following the store (FreezeGate) and, once
 *   it's been away a while, it isn't displayed at all (`.cwin[data-culled]`) and its full view is
 *   taken out of the document (CanvasWindow keeps it, rendered, in a host element of its own). A
 *   window is drawn again once it comes within NEAR screen pixels of the view and let go once it's
 *   FAR away: panning arrives at windows already drawn, and one near the edge doesn't flip between
 *   the two. The focused window is always drawn (its composer may have the caret).
 * - Zoomed out below CARD_ZOOM, a window shows its summary card (`.cwin[data-lod="card"]`), and its
 *   full view is out of the document and frozen the same way.
 *
 * Out of the document, not merely hidden: in Electron a frameless window's title bar is a draggable
 * region (`-webkit-app-region`), and Chromium then walks every layout object in the document after
 * each layout and each scroll to collect those regions. With a big board in the layout tree, even
 * hidden by content-visibility, that walk cost more than everything else a streaming reply does.
 * Now the tree holds what's on screen, and the board's size stops mattering.
 *
 * Bringing a full view back into the document is a style, layout and paint of it, so only one comes
 * back per frame, nearest the middle of the view first: zooming in on a big board or panning across
 * it spreads that work over frames instead of stalling one. And a culled window lingers, laid out as
 * it was, for LINGER_MS before it's let go (a few at most, and only once the view is still): a pan
 * or zoom that goes back and forth finds the windows it just passed still there, for free. Cards
 * and culling are cheap and happen at once.
 */

const NEAR = 240;
const FAR = 480;
/** Full views brought back into the document per frame. */
const BUDGET = 1;
/** How long a culled window stays laid out, in case the view comes right back. */
const LINGER_MS = 2500;
/** How many may linger at once; past that the longest gone are let go first. */
const MAX_LINGER = 10;

export interface Lod {
  culled: boolean;
  card: boolean;
}

type Apply = (lod: Lod) => void;

export interface WindowHooks {
  /** Show the level of detail. Culling only hides (and freezes) a window: `release` lets it go. */
  apply: Apply;
  /** Whether its full view is in the document: showing, or lingering after it was culled. */
  attached: () => boolean;
  /** It's been culled a while: take its full view out of the document. */
  release: () => void;
}

interface Entry extends WindowHooks {
  lod: Lod;
  /** When it was culled with its full view still attached (lingering), else 0. */
  culledAt: number;
}

const windows = new Map<string, Entry>();

/** A window's hooks for its level of detail, and the one it mounted with; returns its unregister. */
export function registerWindow(id: string, hooks: WindowHooks, lod: Lod) {
  const entry: Entry = { ...hooks, lod: { ...lod }, culledAt: 0 };
  windows.set(id, entry);
  return () => {
    if (windows.get(id) === entry) windows.delete(id);
  };
}

function screen(): { w: number; h: number } {
  return viewport.size.w ? viewport.size : { w: window.innerWidth, h: window.innerHeight };
}

function outside(r: Rect, vp: Viewport, margin: number) {
  const { w, h } = screen();
  const z = vp.zoom;
  const m = margin / z;
  const x0 = -vp.x / z, y0 = -vp.y / z;
  return r.x > x0 + w / z + m || r.x + r.w < x0 - m || r.y > y0 + h / z + m || r.y + r.h < y0 - m;
}

/** The level of detail for a window that's about to mount. */
export function lodAtMount(r: Rect, boardId: string, boardViewport: Viewport): Lod {
  // The live view is this board's once the canvas has loaded it; before that, the board's saved one.
  const vp = viewport.board === boardId ? viewport.vp : boardViewport;
  return { culled: outside(r, vp, NEAR), card: vp.zoom < CARD_ZOOM };
}

let again = 0;

/** Set each window's level of detail for the view `vp`: arithmetic per window, DOM only where one changes. */
export function updateLod(vp: Viewport, wins: CanvasWin[], keep: string | null) {
  if (!viewport.size.w) return;
  const card = vp.zoom < CARD_ZOOM;
  const { w, h } = screen();
  const cx = (w / 2 - vp.x) / vp.zoom, cy = (h / 2 - vp.y) / vp.zoom;
  const pending: { rank: number; go: () => void }[] = [];
  for (const win of wins) {
    const e = windows.get(win.id);
    if (!e) continue;
    const r = liveRect(win.id) ?? win;
    const culled = win.id !== keep && outside(r, vp, e.lod.culled ? NEAR : FAR);
    const { lod } = e;
    if (culled === lod.culled && card === lod.card) continue;
    const set = () => {
      e.lod = { culled, card };
      e.apply(e.lod);
      e.culledAt = culled && e.attached() ? performance.now() : 0;
      if (e.culledAt) scheduleRelease();
    };
    // Only a full view coming into the document costs much; hiding, cards and a lingering view
    // coming back happen at once.
    if (culled || card || e.attached()) {
      set();
      continue;
    }
    // The focused window first, then those on screen, then by closeness.
    const rank = win.id === keep ? -2 : !outside(r, vp, 0) ? -1 : Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy);
    pending.push({ rank, go: set });
  }
  pending.sort((a, b) => a.rank - b.rank);
  for (const p of pending.slice(0, BUDGET)) p.go();
  if (pending.length > BUDGET && !again) {
    again = requestAnimationFrame(() => {
      again = 0;
      const ui = useUI.getState();
      updateLod(viewport.vp, activeBoard(ui).windows, ui.focusedWindow);
    });
  }
}

let releasing = 0;

function scheduleRelease() {
  if (!releasing) releasing = window.setTimeout(releaseOne, 500);
}

/**
 * Let go of one lingering window that's been culled long enough, or the longest gone of too many:
 * one per idle period, and not while the view is moving (taking a view out of the layout tree is
 * work of its own). Looks again until none linger.
 */
function releaseOne() {
  releasing = 0;
  const lingering = [...windows.values()].filter((e) => e.culledAt && e.lod.culled && e.attached()).sort((a, b) => a.culledAt - b.culledAt);
  for (const e of windows.values()) if (e.culledAt && !(e.lod.culled && e.attached())) e.culledAt = 0;
  if (!lingering.length) return;
  const oldest = lingering[0];
  if (lingering.length <= MAX_LINGER && performance.now() - oldest.culledAt < LINGER_MS) return scheduleRelease();
  // Mid-gesture only when far too many pile up (a long pan across the board).
  const crowded = lingering.length > 2 * MAX_LINGER;
  if (viewsHeld() && !crowded) return scheduleRelease();
  requestIdleCallback(
    () => {
      if (oldest.culledAt && oldest.lod.culled && oldest.attached() && (crowded || !viewsHeld())) {
        oldest.culledAt = 0;
        oldest.release();
      }
      scheduleRelease();
    },
    { timeout: 1000 },
  );
}
