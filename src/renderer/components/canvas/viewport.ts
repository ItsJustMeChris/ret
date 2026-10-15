import { activeBoard, updateBoard, useUI, type CanvasWin } from "../../state/ui";

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 2;
/** Below this zoom, windows render as lightweight summary cards. */
export const CARD_ZOOM = 0.5;

type Listener = (vp: Viewport) => void;

/**
 * Live viewport shared between the canvas, windows and minimap. Gestures write
 * here and paint straight to the DOM; the persisted store is updated lazily so
 * panning and zooming never trigger React renders.
 *
 * Listeners run at most once per frame, however many wheel or pointer events
 * arrive in it, so their DOM writes (and any layout reads) happen once.
 */
class ViewportController {
  vp: Viewport = { x: 0, y: 0, zoom: 1 };
  /** The canvas element's size, kept by CanvasView: listeners read this instead of forcing a layout every frame. */
  size = { w: 0, h: 0 };
  private listeners = new Set<Listener>();
  private commitTimer = 0;
  private anim = 0;
  private frame = 0;
  /** True while painting a jump to another board's view rather than a pan or zoom. */
  jumping = false;
  /** The board whose view this is. */
  board: string | null = null;

  load(vp: Viewport, board: string | null = this.board) {
    cancelAnimationFrame(this.anim);
    this.board = board;
    this.vp = { ...vp };
    this.jumping = true;
    this.flush();
    this.jumping = false;
  }

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    fn(this.vp);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Paint now rather than on the next frame. */
  flush() {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    for (const l of this.listeners) l(this.vp);
  }

  set(vp: Viewport, commit = true) {
    this.vp = { x: vp.x, y: vp.y, zoom: clamp(vp.zoom, MIN_ZOOM, MAX_ZOOM) };
    if (!this.frame) this.frame = requestAnimationFrame(() => this.flush());
    if (commit) {
      clearTimeout(this.commitTimer);
      this.commitTimer = window.setTimeout(() => this.commit(), 180);
    }
  }

  commit() {
    const vp = this.vp;
    updateBoard((b) => ({ ...b, viewport: { ...vp } }));
  }

  zoomAt(factor: number, cx: number, cy: number) {
    const { x, y, zoom } = this.vp;
    const next = clamp(zoom * factor, MIN_ZOOM, MAX_ZOOM);
    const k = next / zoom;
    this.set({ zoom: next, x: cx - (cx - x) * k, y: cy - (cy - y) * k });
  }

  animateTo(target: Viewport, ms = 240) {
    cancelAnimationFrame(this.anim);
    const from = { ...this.vp };
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      const e = 1 - Math.pow(1 - t, 3);
      this.set(
        {
          x: from.x + (target.x - from.x) * e,
          y: from.y + (target.y - from.y) * e,
          zoom: from.zoom + (target.zoom - from.zoom) * e,
        },
        t === 1,
      );
      this.flush(); // already inside a frame
      if (t < 1) this.anim = requestAnimationFrame(step);
    };
    this.anim = requestAnimationFrame(step);
  }

  /** Viewport that fits `rect` (world coords) into a `vw`×`vh` screen area. */
  fitRect(rect: { x: number; y: number; w: number; h: number }, vw: number, vh: number, pad = 48, maxZoom = 1): Viewport {
    const zoom = clamp(Math.min((vw - pad * 2) / rect.w, (vh - pad * 2) / rect.h, maxZoom), MIN_ZOOM, MAX_ZOOM);
    return {
      zoom,
      x: (vw - rect.w * zoom) / 2 - rect.x * zoom,
      y: (vh - rect.h * zoom) / 2 - rect.y * zoom,
    };
  }

  toWorld(sx: number, sy: number) {
    return { x: (sx - this.vp.x) / this.vp.zoom, y: (sy - this.vp.y) / this.vp.zoom };
  }
}

export const viewport = new ViewportController();

export function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

export function boundsOf(wins: CanvasWin[]) {
  if (!wins.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const w of wins) {
    x0 = Math.min(x0, w.x);
    y0 = Math.min(y0, w.y);
    x1 = Math.max(x1, w.x + w.w);
    y1 = Math.max(y1, w.y + w.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function viewportSize() {
  const el = document.querySelector<HTMLElement>(".canvas-viewport");
  return { w: el?.clientWidth ?? window.innerWidth, h: el?.clientHeight ?? window.innerHeight };
}

export function fitAll(animate = true) {
  const b = boundsOf(activeBoard().windows);
  if (!b) return;
  const { w, h } = viewportSize();
  const target = viewport.fitRect(b, w, h, 56, 1);
  if (animate) viewport.animateTo(target);
  else viewport.set(target);
}

export function revealWindow(winId: string) {
  const win = activeBoard().windows.find((w) => w.id === winId);
  if (!win) return;
  const { w, h } = viewportSize();
  const { x, y, zoom } = viewport.vp;
  const sx = win.x * zoom + x;
  const sy = win.y * zoom + y;
  const sw = win.w * zoom;
  const sh = win.h * zoom;
  const pad = 32;
  const fits = sw <= w - pad * 2 && sh <= h - pad * 2;
  if (!fits || zoom < 0.6) {
    viewport.animateTo(viewport.fitRect(win, w, h, 40, 1));
    return;
  }
  let dx = 0;
  let dy = 0;
  if (sx < pad) dx = pad - sx;
  else if (sx + sw > w - pad) dx = w - pad - (sx + sw);
  if (sy < pad) dy = pad - sy;
  else if (sy + sh > h - pad) dy = h - pad - (sy + sh);
  if (dx || dy) viewport.animateTo({ x: x + dx, y: y + dy, zoom });
}

/** Shelf-pack windows into tidy rows (keeping their sizes), ordered by current position. */
export function tidy() {
  const board = activeBoard();
  const wins = board.windows.slice().sort((a, b) => a.y - b.y || a.x - b.x);
  if (!wins.length) return;
  const gap = 24;
  const area = wins.reduce((s, w) => s + (w.w + gap) * (w.h + gap), 0);
  const { w: vw, h: vh } = viewportSize();
  const rowWidth = Math.max(Math.max(...wins.map((w) => w.w)), Math.sqrt(area * (vw / vh)));
  const origin = boundsOf(wins)!;
  let x = 0;
  let y = 0;
  let rowH = 0;
  const placed = new Map<string, { x: number; y: number }>();
  for (const w of wins) {
    if (x > 0 && x + w.w > rowWidth) {
      x = 0;
      y += rowH + gap;
      rowH = 0;
    }
    placed.set(w.id, { x: origin.x + x, y: origin.y + y });
    x += w.w + gap;
    rowH = Math.max(rowH, w.h);
  }
  updateBoard((b) => ({ ...b, windows: b.windows.map((w) => ({ ...w, ...placed.get(w.id), prev: undefined })) }));
  requestAnimationFrame(() => fitAll());
}

/** Toggle a window between its rect and filling the visible canvas at 100%. */
export function toggleMaximize(winId: string) {
  const board = activeBoard();
  const win = board.windows.find((w) => w.id === winId);
  if (!win) return;
  if (win.prev) {
    const { prev } = win;
    updateBoard((b) => ({ ...b, windows: b.windows.map((w) => (w.id === winId ? { ...w, x: prev.x, y: prev.y, w: prev.w, h: prev.h, prev: undefined } : w)) }));
    viewport.animateTo(prev.vp);
    return;
  }
  const { w: vw, h: vh } = viewportSize();
  const vp = viewport.vp;
  const pad = 12;
  // Keep the window's top-left anchored in world space and zoom to 100% around it.
  const target = { zoom: 1, x: pad - win.x, y: pad - win.y };
  const top = Math.max(0, ...board.windows.map((w) => w.z)) + 1;
  updateBoard((b) => ({
    ...b,
    windows: b.windows.map((w) =>
      w.id === winId ? { ...w, w: vw - pad * 2, h: vh - pad * 2, z: top, prev: { x: w.x, y: w.y, w: w.w, h: w.h, vp: { ...vp } } } : w,
    ),
  }));
  useUI.setState({ focusedWindow: winId });
  viewport.animateTo(target);
}
