import { activeBoard, useUI, type CanvasWin } from "../../state/ui";
import { viewsHeld } from "../../state/useThread";
import { liveRect, type Rect } from "./live";
import { CARD_ZOOM, viewport, type Viewport } from "./viewport";

/**
 * How much of each window the canvas draws (its level of detail), set straight on the DOM so a pan
 * or zoom never re-renders a window:
 *
 * - Away from the view, a window is culled: its contents are skipped by style, layout and paint
 *   (`.cwin[data-culled]`, content-visibility: hidden) and its views stop following the store
 *   (FreezeGate), so a board costs what's on screen, however many windows it has. A window is drawn
 *   again once it comes within NEAR screen pixels of the view and let go once it's FAR away:
 *   panning arrives at windows already drawn, and one near the edge doesn't flip between the two.
 *   (Margins of whole screens kept most of a big board drawn after a pan or two.) The focused
 *   window is always drawn (its composer may have the caret).
 * - Zoomed out below CARD_ZOOM, a window shows its summary card (`.cwin[data-lod="card"]`) over
 *   its full view, which is skipped and frozen the same way.
 *
 * Bringing a full view back (culled to drawn, or card to full) is a style, layout and paint of
 * everything in it, so only one comes back per frame, nearest the middle of the view first: zooming
 * in on a big board or panning across it spreads that work over frames instead of stalling one.
 * Cards and culling are cheap and happen at once.
 *
 * A window that opened away from the view has never been styled or laid out at all, which makes its
 * first reveal the dearest. So when the app is idle, those are drawn one at a time while still off
 * screen (styled and laid out, nothing painted) and culled again: by the time a pan reaches them,
 * only what comes into view is left to do.
 */

const NEAR = 240;
const FAR = 480;
/** Full views brought back per frame. */
const BUDGET = 1;
/** Turns laid out ahead, per window, when warming it up (what a transcript at the bottom shows). */
const WARM_TURNS = 3;

export interface Lod {
  culled: boolean;
  card: boolean;
}

type Apply = (lod: Lod) => void;

interface Entry {
  lod: Lod;
  apply: Apply;
  el: HTMLElement;
  /** Drawn at least once (or warmed up off screen) since it mounted. */
  laidOut: boolean;
}

const windows = new Map<string, Entry>();

/** A window's hook for its level of detail, and the one it mounted with; returns its unregister. */
export function registerWindow(id: string, el: HTMLElement, apply: Apply, lod: Lod) {
  const entry: Entry = { lod: { ...lod }, apply, el, laidOut: !lod.culled };
  windows.set(id, entry);
  if (lod.culled) scheduleWarm();
  return () => {
    if (windows.get(id) === entry) windows.delete(id);
  };
}

let warming = 0;

function scheduleWarm() {
  if (!warming) warming = requestIdleCallback(warmOne, { timeout: 4000 });
}

/** Lay out the nearest window that's never been drawn, off screen, and cull it again two frames on. */
function warmOne() {
  warming = 0;
  if (viewsHeld()) return void setTimeout(scheduleWarm, 500);
  const vp = viewport.vp;
  const { w, h } = screen();
  const cx = (w / 2 - vp.x) / vp.zoom, cy = (h / 2 - vp.y) / vp.zoom;
  let next: Entry | null = null;
  let best = Infinity;
  for (const win of activeBoard().windows) {
    const e = windows.get(win.id);
    // Only built windows (the full view is mounted) have anything to lay out.
    if (!e || e.laidOut || !e.lod.culled || e.lod.card || !e.el.querySelector(":scope > .thread-pane")) continue;
    const d = Math.hypot(win.x + win.w / 2 - cx, win.y + win.h / 2 - cy);
    if (d < best) [best, next] = [d, e];
  }
  if (!next) {
    // Windows still being built: look again in a while.
    for (const e of windows.values()) if (!e.laidOut && e.lod.culled && !e.lod.card) return void setTimeout(scheduleWarm, 1000);
    return;
  }
  const e = next;
  e.laidOut = true;
  // On the DOM only: its views stay frozen, so nothing re-renders. Frame one lays out the window (and
  // its transcript scrolls to the bottom); frame two the last few turns, the ones on screen at the
  // bottom, which would otherwise wait to be laid out until they scroll into view. Then it's culled.
  e.el.removeAttribute("data-culled");
  let turns: HTMLElement[] = [];
  const done = () => {
    for (const t of turns) t.removeAttribute("data-warm");
    if (e.lod.culled) e.el.setAttribute("data-culled", "");
  };
  requestAnimationFrame(() => {
    // Drawn for real meanwhile, or the view started moving: that frame is the view's.
    if (!e.lod.culled || viewsHeld()) {
      done();
      e.laidOut = !e.lod.culled;
      return void setTimeout(scheduleWarm, 500);
    }
    turns = [...e.el.querySelectorAll<HTMLElement>("section.turn")].slice(-WARM_TURNS);
    for (const t of turns) t.setAttribute("data-warm", "");
    requestAnimationFrame(() => {
      done();
      scheduleWarm();
    });
  });
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
    // Everything but a full view appearing is cheap (hiding, or a card), and happens at once.
    const full = !culled && !card;
    if (!full || (!lod.culled && !lod.card)) {
      e.lod = { culled, card };
      e.apply(e.lod);
      if (!culled) e.laidOut = true;
      continue;
    }
    // A full view coming back: the focused window first, then those on screen, then by closeness.
    const rank = win.id === keep ? -2 : !outside(r, vp, 0) ? -1 : Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy);
    pending.push({
      rank,
      go: () => {
        e.lod = { culled, card };
        e.apply(e.lod);
        e.laidOut = true;
      },
    });
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
