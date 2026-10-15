import { startTransition, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { Check, ChevronDown, Command, Copy, Folder, GitFork, LayoutGrid, MessageSquarePlus, Minus, Pencil, Plus, Scan, SquareDashed, Trash2, X, Code2, Inbox } from "lucide-react";
import { activeBoard, appId, newId, updateBoard, useUI, type AppKind, type Board, type CanvasWin } from "../../state/ui";
import { DRAG_APP } from "../Titlebar";
import { closeWindow, focusWindow, newThread, openThread } from "../../state/actions";
import { useThreads } from "../../state/threads";
import type { ProjectNode } from "../../state/projects";
import { projectKeyNow, projectTreeNow } from "../../state/projectTree";
import { Links } from "./Links";
import { CanvasWindow } from "./CanvasWindow";
import { Minimap } from "./Minimap";
import { Beacons } from "./Beacons";
import { CARD_ZOOM, fitAll, revealWindow, tidy, viewport, type Flight, type Viewport } from "./viewport";
import { nearView, updateLod } from "./lod";
import { onLiveRect } from "./live";
import { holdViews } from "../../state/useThread";
import { Menu, type MenuItem } from "../Menu";
import { promptText } from "../ui/Dialog";
import { startAutoscroll } from "../../lib/autoscroll";
import { Kept, useRecent, useVisibility } from "../ui/Kept";
import { useShallow } from "../../lib/shallow";

/** Dot spacing at 100%. */
const GRID = 24;
/**
 * Where the world's origin sits in the scroller's content, which is twice as big: room to pan a long
 * way in every direction. Past that, the origin moves (one frame of re-layering, far out). Not bigger:
 * the compositor keeps scroll offsets and transforms as 32-bit floats, which at a million pixels only
 * resolve an eighth of one, and text there would land between pixels.
 */
const ORIGIN = 1 << 17;
/** How near the scroller's content edge the view gets before the origin moves. */
const EDGE = 1 << 13;
/** How far a zoom goes before zoomed-out cards are re-sized for it, mid-gesture (as a log ratio: 4%). */
const CARD_STEP = Math.log(1.04);
/** How far a middle press moves before it's a pan rather than a click (which autoscrolls). */
const PAN_SLOP = 4;
/** Keys that scroll whatever was last clicked: on the canvas, the canvas. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"]);

/**
 * Which of the board's windows are mounted. Switching to a board (or opening the app on one) mounts
 * those near the view at once and the rest a few at a time when the app is idle, nearest first: a
 * board of a hundred windows used to build every one before its first frame. One that comes near
 * the view meanwhile (a pan, a flight to it) mounts then, and one added to the board mounts at once.
 */
function useMountedWindows(board: Board, active: boolean): CanvasWin[] {
  const later = useRef<{ board: string; ids: Set<string> } | null>(null);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  if (later.current?.board !== board.id) {
    const vp = viewport.board === board.id ? viewport.vp : board.viewport;
    later.current = { board: board.id, ids: new Set(board.windows.filter((w) => !nearView(w, vp)).map((w) => w.id)) };
  }
  const ids = later.current.ids;

  useEffect(() => {
    // (Near and far are the view's: a board kept while another shows waits until it's back.)
    if (!ids.size || !active) return;
    const take = (wins: CanvasWin[]) => {
      for (const w of wins) ids.delete(w.id);
      if (!ids.size) stop();
      bump();
    };
    const waiting = () => (useUI.getState().boards.find((b) => b.id === board.id)?.windows ?? []).filter((w) => ids.has(w.id));
    // Come near the view: now.
    let idle = 0;
    let off = () => {};
    const stop = () => {
      off();
      cancelIdleCallback(idle);
    };
    off = viewport.subscribe((vp) => {
      const near = waiting().filter((w) => nearView(w, vp));
      if (near.length) take(near);
    });
    // The rest, a few per idle moment, nearest first. (A transition: a key or click never waits on them.)
    const next = () => {
      idle = requestIdleCallback(
        () => {
          const vp = viewport.vp;
          const { w: W, h: H } = viewport.size;
          const cx = (W / 2 - vp.x) / vp.zoom, cy = (H / 2 - vp.y) / vp.zoom;
          const far = waiting().sort((a, b) => Math.hypot(a.x + a.w / 2 - cx, a.y + a.h / 2 - cy) - Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy));
          if (far.length > 6) next();
          else ids.clear(); // and any that left the board meanwhile
          startTransition(() => take(far.slice(0, 6)));
        },
        { timeout: 300 },
      );
    };
    // (Subscribing calls it at once, which may have taken the last of them.)
    if (ids.size) next();
    else off();
    return stop;
  }, [ids, active, board.id]);

  return ids.size ? board.windows.filter((w) => !ids.has(w.id)) : board.windows;
}

/** Boards kept built after you switch away (see Kept): switching between them neither builds nor takes down a window. */
const KEEP_BOARDS = 3;

/** A board's windows. */
function BoardWindows({ boardId, active, focused }: { boardId: string; active: boolean; focused: string | null }) {
  const board = useUI((s) => s.boards.find((b) => b.id === boardId));
  if (!board) return null;
  return <Windows board={board} active={active} focused={focused} />;
}

function Windows({ board, active, focused }: { board: Board; active: boolean; focused: string | null }) {
  const mounted = useMountedWindows(board, active);
  return mounted.map((w) => <CanvasWindow key={w.id} win={w} focused={focused === w.id} />);
}

export function CanvasView() {
  const board = useUI((s) => activeBoard(s));
  const focused = useUI((s) => s.focusedWindow);
  const visibility = useVisibility();
  const boardIds = useUI(useShallow((s) => s.boards.map((b) => b.id)));
  const keptBoards = useRecent(board.id, KEEP_BOARDS, (id) => boardIds.includes(id));
  const vpRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<HTMLDivElement>(null);
  const dotsRef = useRef<HTMLDivElement>(null);
  const zoomLabelRef = useRef<HTMLButtonElement>(null);
  /** Where the canvas view sits in the window, kept so a wheel event needn't measure it. */
  const viewOrigin = useRef({ x: 0, y: 0 });
  /** The last press landed on the canvas itself, so the keys that scroll would scroll the canvas. */
  const canvasPressed = useRef(false);
  const spaceDown = useRef(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const showLinks = useUI((s) => s.showLinks);
  const selectedCount = useUI((s) => s.selectedWindows.length);

  // Load this board's saved viewport when switching boards.
  useLayoutEffect(() => {
    viewport.load(board.viewport, board.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.id]);

  // Draw only the windows near the view, as cards when zoomed out (see lod.ts): again whenever
  // windows move, come or go, or focus changes, and while a drag carries windows along.
  useLayoutEffect(() => {
    updateLod(viewport.vp, board.windows, focused);
  }, [board.windows, focused]);
  useEffect(() => {
    let frame = 0;
    const off = onLiveRect(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const ui = useUI.getState();
        updateLod(viewport.vp, activeBoard(ui).windows, ui.focusedWindow);
      });
    });
    return () => {
      off();
      cancelAnimationFrame(frame);
    };
  }, []);

  // Paint viewport changes straight to the DOM.
  //
  // A pan scrolls: the canvas is a scroller (its scrollbars hidden) with the world at a fixed spot in
  // it, and the view's x/y is its scroll offset. Chromium applies a new scroll offset to the GPU layer
  // directly, where a transform set from script re-layerizes the whole canvas every frame, which costs
  // milliseconds a frame with a few big windows on screen. And the scrolled content stays painted with
  // the page, so its text keeps ClearType throughout.
  //
  // A zoom scales the world. While it does, the world is a GPU layer of its own (.scaling): the
  // compositor scales the windows as last drawn instead of redrawing them every frame. Once it settles
  // the world is flattened back into the page, because text on a layer of its own only gets grayscale
  // antialiasing, and flat it gets ClearType, drawn sharp at the new zoom. The dots are in the world
  // too, so they scale along and are redrawn with it.
  useLayoutEffect(() => {
    const view = vpRef.current!;
    const scroller = scrollerRef.current!;
    const world = worldRef.current!;
    const items = itemsRef.current!;
    const dotsEl = dotsRef.current!;
    let last: Viewport | null = null;
    let settle = 0;
    let undo = 0;
    let moving = false;
    let scaling = false;
    /** Zoom the windows' contents were last drawn at, while zooming: the compositor scales that drawing. */
    let drawnAt = 0;
    /** Zoom the things kept the same size on screen were last sized for. */
    let scaledAt = 1;
    /** Where the world's origin sits in the scroller's content: a pan scrolls past it, a zoom moves it. */
    let origin = { x: ORIGIN, y: ORIGIN };
    /** What the world's transform was last set for. */
    let placed: { zoom: number; ox: number; oy: number } | null = null;
    /** The scroll offset last set here: any other is the browser's own (see onScroll). */
    let scrolled = { left: -1, top: -1 };
    /** The dots' extent (world units, whole grid steps), and the zoom they were drawn for. */
    let dots: { x: number; y: number; w: number; h: number } | null = null;
    let dotsFor = 0;
    const counterScale = (zoom: number) => {
      scaledAt = zoom;
      items.style.setProperty("--inv-zoom", String(1 / zoom));
    };
    const setMoving = (on: boolean) => {
      moving = on;
      // Windows hold their views still while the canvas moves, and catch up once it settles.
      holdViews("view", on);
      if (!on) setScaling(false);
    };
    const setScaling = (on: boolean) => {
      if (on === scaling) return;
      scaling = on;
      drawnAt = viewport.vp.zoom;
      view.classList.toggle("scaling", on);
      cancelAnimationFrame(undo);
      world.classList.remove("redraw");
      // Settled: the transform goes back to being a plain style (the same frame the animation goes).
      if (!on && scaler) {
        world.style.transform = transform;
        scaler.cancel();
        scaler = null;
      }
    };
    /**
     * The world's transform. While a zoom is going, it's the value of an animation, its keyframes set
     * each frame: the compositor takes an animated transform as is, where a new transform style makes
     * Chromium re-layerize the canvas, and repaint whatever moved past its cull rect, every frame.
     */
    let transform = "";
    let scaler: Animation | null = null;
    const setTransform = (t: string) => {
      transform = t;
      if (!scaling) {
        world.style.transform = t;
        return;
      }
      const frames = [{ transform: t }, { transform: t }];
      if (scaler) (scaler.effect as KeyframeEffect).setKeyframes(frames);
      else scaler = world.animate(frames, { duration: 1e9, fill: "forwards" });
    };
    /**
     * A flight (viewport.animateTo) runs on the compositor: one animation of the world's transform, from
     * where it is to the destination's, so it keeps its frames whatever the page does meanwhile (windows
     * coming into the document as it goes, replies streaming in). The view follows the animation's own
     * progress (viewport.flightProgress), and the scroll offset stays put while it runs.
     */
    let flying: Flight | null = null;
    let flyer: Animation | null = null;
    viewport.flightProgress = (f) => (f === flying && flyer ? (flyer.effect?.getComputedTiming().progress ?? null) : null);
    const takeOff = (f: Flight, left: number, top: number) => {
      // A zoom animation hands over: the flight starts where the world is.
      if (scaler) {
        world.style.transform = transform;
        scaler.cancel();
        scaler = null;
      }
      const r = window.devicePixelRatio || 1;
      const end = `translate(${Math.round(f.to.x * r) / r + left}px, ${Math.round(f.to.y * r) / r + top}px) scale(${f.to.zoom})`;
      flyer = world.animate([{ transform }, { transform: end }], { duration: f.ms, easing: f.easing, fill: "forwards" });
      flying = f;
    };
    /** The flight's over (or another move took over): the world as it left it, as a plain style, in the same frame. */
    const land = () => {
      world.style.transform = transform;
      flyer?.cancel();
      flyer = null;
      flying = null;
    };
    /** Draw the windows afresh at the current zoom mid-gesture: will-change off for a frame (two, from a timer). */
    const redraw = () => {
      drawnAt = viewport.vp.zoom;
      world.classList.add("redraw");
      cancelAnimationFrame(undo);
      undo = requestAnimationFrame(() => (undo = requestAnimationFrame(() => world.classList.remove("redraw"))));
    };
    /** The dot grid: an element in the world covering the view and a view's worth around it, moved when the view leaves that. */
    const placeDots = (vp: Viewport) => {
      dotsEl.hidden = vp.zoom < 0.45;
      if (dotsEl.hidden) return;
      const vw = (viewport.size.w || window.innerWidth) / vp.zoom;
      const vh = (viewport.size.h || window.innerHeight) / vp.zoom;
      const x0 = -vp.x / vp.zoom;
      const y0 = -vp.y / vp.zoom;
      if (!dots || x0 < dots.x || y0 < dots.y || x0 + vw > dots.x + dots.w || y0 + vh > dots.y + dots.h) {
        const step = (v: number) => Math.floor(v / GRID) * GRID;
        dots = { x: step(x0 - vw), y: step(y0 - vh), w: step(3 * vw) + 2 * GRID, h: step(3 * vh) + 2 * GRID };
        Object.assign(dotsEl.style, { left: `${dots.x}px`, top: `${dots.y}px`, width: `${dots.w}px`, height: `${dots.h}px` });
      }
      // A dot is a screen pixel, drawn for the zoom once it settles: a zoom scales them meanwhile.
      if (!scaling && dotsFor !== vp.zoom) {
        dotsFor = vp.zoom;
        const r = 1 / vp.zoom;
        dotsEl.style.backgroundImage = `radial-gradient(circle at ${r}px ${r}px, var(--grid-dot) ${r}px, transparent ${1.2 * r}px)`;
      }
    };
    const place = (vp: Viewport) => {
      placeDots(vp);
      // Whole device pixels: a fractional offset makes the browser redraw every glyph to re-align it.
      const r = window.devicePixelRatio || 1;
      const x = Math.round(vp.x * r) / r;
      const y = Math.round(vp.y * r) / r;
      const flight = viewport.flight;
      let left: number;
      let top: number;
      if (placed && placed.zoom === vp.zoom && !flight) {
        // A pan: the scroll offset.
        left = origin.x - x;
        top = origin.y - y;
      } else {
        // A zoom or a flight (or the first placing): the world's transform alone, its origin moving
        // with the view and the scroll offset staying put. Zooming about a point far from the origin
        // would scroll the content by hundreds of pixels a frame, and the browser repaints what it
        // scrolls past.
        left = scrolled.left >= 0 ? scrolled.left : ORIGIN;
        top = scrolled.top >= 0 ? scrolled.top : ORIGIN;
        origin = { x: x + left, y: y + top };
      }
      // Panned most of the way to the content's edge: move the origin back to the middle.
      if (left < EDGE || top < EDGE || left > 2 * ORIGIN - EDGE || top > 2 * ORIGIN - EDGE) {
        left = ORIGIN;
        top = ORIGIN;
        origin = { x: x + left, y: y + top };
      }
      if (viewport.scroll?.origin !== origin) viewport.scroll = { el: scroller, origin, extent: 2 * ORIGIN };
      if (flight !== flying) {
        if (flying) land();
        if (flight) takeOff(flight, left, top);
      }
      if (placed?.zoom !== vp.zoom || placed.ox !== origin.x || placed.oy !== origin.y) {
        placed = { zoom: vp.zoom, ox: origin.x, oy: origin.y };
        const t = `translate(${origin.x}px, ${origin.y}px) scale(${vp.zoom})`;
        // In flight the animation draws it; kept for when it lands.
        if (flying) transform = t;
        else setTransform(t);
      }
      if (left === scrolled.left && top === scrolled.top) return;
      scrolled = { left, top };
      // Lays out whatever changed before it (to know how far it can scroll), so it comes last.
      scroller.scrollTo(left, top);
    };
    // Something other than a pan here scrolled the canvas: a field taking focus brought into view, or
    // the keys that scroll. That's a pan too.
    const onScroll = () => {
      const { scrollLeft: left, scrollTop: top } = scroller;
      if (Math.abs(left - scrolled.left) < 1 && Math.abs(top - scrolled.top) < 1) return;
      scrolled = { left, top };
      viewport.set({ ...viewport.vp, x: origin.x - left, y: origin.y - top });
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    viewport.scroll = { el: scroller, origin, extent: 2 * ORIGIN };
    // Out of the document (another mode showing: see Kept), the scroller forgets its offset: put it
    // back when it's back. (Where the view is lives in the viewport, and that's where it goes.)
    let away = false;
    const back = new ResizeObserver(() => {
      if (!scroller.isConnected) {
        away = true;
        return;
      }
      if (!away) return;
      away = false;
      scrolled = { left: -1, top: -1 };
      place(viewport.vp);
    });
    back.observe(scroller);
    const settled = () => {
      counterScale(viewport.vp.zoom);
      setMoving(false);
      place(viewport.vp);
    };
    const off = viewport.subscribe((vp) => {
      const prev = last;
      last = vp;
      const gesture = !!prev && !viewport.jumping;
      const zoomed = vp.zoom !== prev?.zoom;
      if (gesture && (vp.x !== prev.x || vp.y !== prev.y || zoomed)) {
        if (!moving) setMoving(true);
        if (zoomed) setScaling(true);
        clearTimeout(settle);
        settle = window.setTimeout(settled, 150);
      } else if (!gesture && moving) {
        clearTimeout(settle);
        setMoving(false);
      }
      const ui = useUI.getState();
      updateLod(vp, activeBoard(ui).windows, ui.focusedWindow);
      if (zoomed) {
        zoomLabelRef.current!.textContent = `${Math.round(vp.zoom * 100)}%`;
        const nextCard = vp.zoom < CARD_ZOOM;
        // Things kept the same size on screen (window outlines and glows, link badges, card text)
        // follow a zoom live only on cards, and then in steps of a few percent: each step re-lays out
        // and repaints every card's text, and in between the compositor scales them as drawn. Full
        // windows catch up when it settles: restyling every window each frame costs more than a
        // moment of slightly-off outline shows.
        if (!gesture || (nextCard && Math.abs(Math.log(vp.zoom / scaledAt)) > CARD_STEP)) counterScale(vp.zoom);
        // Settling flattens the world, which draws it sharp. Redraw along the way when the zoom has
        // drifted far enough to look soft (in) or cost memory (out).
        // (A flight's animation is drawn at the scale it ends at.)
        if (scaling && !viewport.flight && (vp.zoom > drawnAt * 2 || vp.zoom < drawnAt / 1.6)) redraw();
      }
      place(vp);
    });
    return () => {
      off();
      scaler?.cancel();
      flyer?.cancel();
      viewport.flightProgress = null;
      viewport.scroll = null;
      scroller.removeEventListener("scroll", onScroll);
      back.disconnect();
      clearTimeout(settle);
      cancelAnimationFrame(undo);
      holdViews("view", false);
    };
  }, []);

  useLayoutEffect(() => {
    const el = vpRef.current!;
    const measure = () => {
      // Out of the document it measures nothing: the view keeps the size it had.
      if (!el.isConnected || !el.clientWidth) return;
      viewport.size = { w: el.clientWidth, h: el.clientHeight };
      const r = el.getBoundingClientRect();
      viewOrigin.current = { x: r.left, y: r.top };
    };
    measure();
    viewport.flush(); // the minimap and beacons subscribed (as children) before the size was known
    const ro = new ResizeObserver(() => {
      measure();
      viewport.flush();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onReveal = (e: Event) => requestAnimationFrame(() => revealWindow((e as CustomEvent<string>).detail));
    window.addEventListener("ret:reveal-window", onReveal);
    return () => window.removeEventListener("ret:reveal-window", onReveal);
  }, []);

  // Wheel: ctrl/pinch zooms around the cursor; plain wheel pans unless a window's content wants to scroll.
  useEffect(() => {
    const el = vpRef.current!;
    const onWheel = (e: WheelEvent) => {
      if (e.defaultPrevented) return; // taken by what's under it (an editor scrolls itself)
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022));
        viewport.zoomAt(factor, e.clientX - viewOrigin.current.x, e.clientY - viewOrigin.current.y);
        return;
      }
      const inWindow = (e.target as HTMLElement).closest<HTMLElement>(".cwin:not([data-lod])");
      if (inWindow && !e.shiftKey) {
        // Let a transcript (or anything else in there) scroll natively. Nothing to scroll there, or
        // it's at its end: the canvas is a scroller too, and mustn't take the wheel over a window.
        if (!scrollsWithin(e.target as Element, inWindow, e.deltaX, e.deltaY)) e.preventDefault();
        return;
      }
      e.preventDefault();
      const k = e.deltaMode === 1 ? 32 : 1;
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      const vp = viewport.vp;
      viewport.set({ ...vp, x: vp.x - dx * k, y: vp.y - dy * k });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (!visibility.shown) return; // another mode is showing
      if (e.code === "Space" && !isTyping()) {
        spaceDown.current = true;
        vpRef.current?.classList.add("space-pan");
        e.preventDefault();
      }
      // The canvas is a scroller, so after a press on it these would scroll it (Home to the far edge).
      if (canvasPressed.current && SCROLL_KEYS.has(e.key) && !isTyping()) e.preventDefault();
    };
    const press = (e: PointerEvent) => {
      const t = e.target as Element;
      canvasPressed.current = isBackground(t);
    };
    window.addEventListener("pointerdown", press, true);
    const release = () => {
      spaceDown.current = false;
      vpRef.current?.classList.remove("space-pan");
    };
    const up = (e: KeyboardEvent) => e.code === "Space" && release();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    // Alt-tabbing away while holding Space never delivers the keyup.
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
      window.removeEventListener("pointerdown", press, true);
    };
  }, []);

  // Escape lets go of a multi-selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || isTyping() || !useUI.getState().selectedWindows.length) return;
      if (document.querySelector(".menu, .overlay:not(.monaco-editor *), .dialog")) return;
      useUI.setState({ selectedWindows: [] });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Selections belong to a board.
  useEffect(() => {
    useUI.setState({ selectedWindows: [] });
  }, [board.id]);

  /** The canvas itself, not anything on it. */
  const isBackground = (t: Element) => t === vpRef.current || t === scrollerRef.current || t === worldRef.current;

  /** Shift+drag on empty canvas: rubber-band select, adding to what's already selected. */
  const marquee = useRef<HTMLDivElement>(null);
  const startMarquee = (e: React.PointerEvent) => {
    const el = vpRef.current!;
    const box = marquee.current!;
    const origin = el.getBoundingClientRect();
    const base = useUI.getState().selectedWindows;
    const sx = e.clientX - origin.left, sy = e.clientY - origin.top;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* capture is a nicety (keeps the band tracking outside the canvas) */
    }
    const move = (ev: PointerEvent) => {
      const x0 = Math.min(sx, ev.clientX - origin.left), y0 = Math.min(sy, ev.clientY - origin.top);
      const x1 = Math.max(sx, ev.clientX - origin.left), y1 = Math.max(sy, ev.clientY - origin.top);
      Object.assign(box.style, { display: "block", transform: `translate(${x0}px, ${y0}px)`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
      const a = viewport.toWorld(x0, y0), b = viewport.toWorld(x1, y1);
      const hits = activeBoard()
        .windows.filter((w) => w.x < b.x && w.x + w.w > a.x && w.y < b.y && w.y + w.h > a.y)
        .map((w) => w.id);
      const next = [...new Set([...base, ...hits])];
      const cur = useUI.getState().selectedWindows;
      if (next.length !== cur.length || next.some((id, i) => id !== cur[i])) useUI.setState({ selectedWindows: next });
    };
    const up = () => {
      box.style.display = "none";
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  // Drag-to-pan on empty canvas, middle mouse anywhere, or space+drag.
  const onPointerDown = (e: React.PointerEvent) => {
    const onBackground = isBackground(e.target as Element);
    if (onBackground && e.button === 0 && e.shiftKey && !spaceDown.current) {
      e.preventDefault();
      startMarquee(e);
      return;
    }
    if (!(e.button === 1 || (e.button === 0 && (onBackground || spaceDown.current)))) return;
    e.preventDefault();
    if (onBackground && e.button === 0 && !spaceDown.current) useUI.setState({ focusedWindow: null, selectedWindows: [] });
    const el = vpRef.current!;
    el.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, vx: viewport.vp.x, vy: viewport.vp.y };
    // A middle press pans only once it moves; let go where it was and it autoscrolls what's under
    // it instead (the browser's own can't start: this press was taken for a possible pan).
    const from = e.target as Element;
    let panning = e.button !== 1;
    if (panning) el.classList.add("panning");
    const move = (ev: PointerEvent) => {
      if (!panning) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < PAN_SLOP) return;
        panning = true;
        el.classList.add("panning");
      }
      viewport.set({ ...viewport.vp, x: start.vx + ev.clientX - start.x, y: start.vy + ev.clientY - start.y });
    };
    const up = (ev: PointerEvent) => {
      el.classList.remove("panning");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      if (!panning && ev.type === "pointerup") startAutoscroll(from, start.x, start.y);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const onDrop = (e: React.DragEvent) => {
    // A thread from the sidebar, or a mode (Inbox, Code) from the title bar to have as a window.
    const app = e.dataTransfer.getData(DRAG_APP) as AppKind | "";
    const id = app ? appId(app) : e.dataTransfer.getData("application/x-ret-thread");
    if (!id) return;
    e.preventDefault();
    const rect = vpRef.current!.getBoundingClientRect();
    const p = viewport.toWorld(e.clientX - rect.left, e.clientY - rect.top);
    const existing = activeBoard().windows.find((w) => w.threadId === id);
    if (existing) {
      updateBoard((b) => ({ ...b, windows: b.windows.map((w) => (w.id === existing.id ? { ...w, x: p.x - 40, y: p.y - 16 } : w)) }));
      focusWindow(existing.id);
      return;
    }
    openThread(id, { mode: "canvas" });
    // Move the freshly placed window under the cursor.
    updateBoard((b) => {
      const w = b.windows.find((x) => x.threadId === id);
      return w ? { ...b, windows: b.windows.map((x) => (x === w ? { ...x, x: p.x - 40, y: p.y - 16 } : x)) } : b;
    });
  };

  const zoomBy = (f: number) => {
    const el = vpRef.current!;
    const vp = viewport.vp;
    const cx = el.clientWidth / 2;
    const cy = el.clientHeight / 2;
    const next = Math.max(0.15, Math.min(2, vp.zoom * f));
    const k = next / vp.zoom;
    viewport.animateTo({ zoom: next, x: cx - (cx - vp.x) * k, y: cy - (cy - vp.y) * k }, 160);
  };

  return (
    <div className="canvas-view">
      <div
        ref={vpRef}
        className="canvas-viewport"
        onPointerDown={onPointerDown}
        onDragOver={(e) => (e.dataTransfer.types.includes("application/x-ret-thread") || e.dataTransfer.types.includes(DRAG_APP)) && e.preventDefault()}
        onDrop={onDrop}
        onContextMenu={(e) => {
          const t = e.target as Element;
          if (!isBackground(t) && !t.closest(".links")) return;
          e.preventDefault();
          const rect = vpRef.current!.getBoundingClientRect();
          const at = viewport.toWorld(e.clientX - rect.left, e.clientY - rect.top);
          setMenu({ x: e.clientX, y: e.clientY, items: canvasMenu(at, e.clientX, e.clientY, setMenu) });
        }}
      >
        {/* Pans scroll this (see the viewport effect). */}
        <div ref={scrollerRef} className="canvas-scroller" data-own-scroll="">
          <div className="canvas-extent" />
          <div ref={worldRef} className="canvas-world">
            <div ref={dotsRef} className="canvas-dots" />
            {/* Carries --inv-zoom. Not on the world itself: its transform changes every zoom frame, and
                the windows opt in to inheriting --inv-zoom, so they'd be restyled every frame too. */}
            <div ref={itemsRef} className="canvas-items">
              <Links board={board} />
              {keptBoards.map((id) => (
                <Kept key={id} shown={id === board.id} className="board-windows">
                  <BoardWindows boardId={id} active={id === board.id} focused={focused} />
                </Kept>
              ))}
            </div>
          </div>
        </div>
        <div ref={marquee} className="marquee" />
        {board.windows.length === 0 && (
          <div className="canvas-empty">
            <p>Drag threads here from the sidebar, or open them with <kbd>Ctrl K</kbd>.</p>
            <p className="muted">Right-click for a new thread here · Scroll to pan · Ctrl+scroll to zoom</p>
          </div>
        )}
      </div>
      <div className="canvas-toolbar">
        <BoardSwitcher />
        {selectedCount > 1 && (
          <>
            <span className="tb-sep" />
            <button className="sel-chip" title="Drag any of them to move them together · Esc to clear" onClick={() => useUI.setState({ selectedWindows: [] })}>
              {selectedCount} selected
              <X size={12} />
            </button>
          </>
        )}
        <span className="tb-sep" />
        <button className="icon-btn" title="Zoom out (Ctrl -)" onClick={() => zoomBy(1 / 1.25)}>
          <Minus size={14} />
        </button>
        {/* Text written by the viewport listener: zooming doesn't re-render the canvas. */}
        <button ref={zoomLabelRef} className="zoom-label" title="Reset to 100%" onClick={() => zoomBy(1 / viewport.vp.zoom)} />
        <button className="icon-btn" title="Zoom in (Ctrl +)" onClick={() => zoomBy(1.25)}>
          <Plus size={14} />
        </button>
        <span className="tb-sep" />
        <button className="icon-btn" title="Fit all windows (Ctrl 0)" onClick={() => fitAll()}>
          <Scan size={14} />
        </button>
        <button className="icon-btn" title="Tidy windows into rows" onClick={tidy}>
          <LayoutGrid size={14} />
        </button>
        <button
          className={`icon-btn ${showLinks ? "on" : ""}`}
          title={showLinks ? "Hide fork links" : "Show fork links"}
          onClick={() => useUI.setState((s) => ({ showLinks: !s.showLinks }))}
        >
          <GitFork size={14} />
        </button>
      </div>
      <Beacons board={board} viewportEl={vpRef} />
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
      <Minimap board={board} viewportEl={vpRef} />
    </div>
  );
}

type SetMenu = (m: { x: number; y: number; items: MenuItem[] } | null) => void;

/** The project a "new thread here" most likely belongs to: the focused window's, else the most recent. */
function contextProject(projects: ProjectNode[]): ProjectNode | undefined {
  const ui = useUI.getState();
  const focused = activeBoard(ui).windows.find((w) => w.id === ui.focusedWindow);
  const t = focused ? useThreads.getState().threads[focused.threadId] : undefined;
  const draft = focused ? ui.drafts[focused.threadId] : undefined;
  const key = draft?.projectKey ?? (t ? projectKeyNow(t) : undefined);
  return projects.find((p) => p.key === key) ?? projects[0];
}

/** Inbox or Code as a window at `at`. There's one of each: if it's open already, it moves there. */
function placeApp(kind: AppKind, at: { x: number; y: number }) {
  const id = appId(kind);
  const existing = activeBoard().windows.find((w) => w.threadId === id);
  if (!existing) return openThread(id, { mode: "canvas", at });
  updateBoard((b) => ({ ...b, windows: b.windows.map((w) => (w.id === existing.id ? { ...w, x: at.x, y: at.y } : w)) }));
  focusWindow(existing.id);
}

function canvasMenu(at: { x: number; y: number }, x: number, y: number, setMenu: SetMenu): MenuItem[] {
  const ui = useUI.getState();
  const projects = projectTreeNow();
  const here = contextProject(projects);
  const board = activeBoard(ui);
  const create = (p: ProjectNode) => newThread(p.key, p.path, { mode: "canvas", at });
  return [
    ...(here
      ? [{ label: `New thread in ${here.name}`, icon: <MessageSquarePlus size={14} />, hint: "here", onClick: () => create(here) }]
      : []),
    {
      label: "New thread in…",
      icon: <Folder size={14} />,
      // Re-open in place as a project picker (menus don't nest).
      onClick: () =>
        setTimeout(() =>
          setMenu({
            x,
            y,
            items: projects.slice(0, 14).map((p) => ({ label: p.name, icon: <Folder size={14} />, hint: String(p.threadCount || ""), onClick: () => create(p) })),
          }),
        ),
    },
    { label: "Open a thread…", icon: <Command size={14} />, hint: "Ctrl+K", onClick: () => useUI.setState({ paletteOpen: true }) },
    ...(["inbox", "code"] as const).map((kind) => ({
      label: kind === "inbox" ? "Inbox window" : "Code window",
      icon: kind === "inbox" ? <Inbox size={14} /> : <Code2 size={14} />,
      hint: board.windows.some((w) => w.threadId === appId(kind)) ? "move here" : "here",
      onClick: () => placeApp(kind, at),
    })),
    { separator: true },
    { label: "Fit all windows", icon: <Scan size={14} />, hint: "Ctrl+0", disabled: !board.windows.length, onClick: () => fitAll() },
    { label: "Tidy windows", icon: <LayoutGrid size={14} />, disabled: !board.windows.length, onClick: tidy },
    {
      label: "Zoom to 100%",
      icon: <SquareDashed size={14} />,
      onClick: () => {
        const el = document.querySelector<HTMLElement>(".canvas-viewport");
        const k = 1 / viewport.vp.zoom;
        viewport.zoomAt(k, (el?.clientWidth ?? 0) / 2, (el?.clientHeight ?? 0) / 2);
      },
    },
    {
      label: "Fork links",
      icon: ui.showLinks ? <Check size={14} /> : <GitFork size={14} />,
      hint: ui.showLinks ? "on" : "off",
      onClick: () => useUI.setState((s) => ({ showLinks: !s.showLinks })),
    },
    { separator: true },
    {
      label: "New board",
      icon: <Plus size={14} />,
      onClick: () => {
        viewport.commit();
        const b: Board = { id: newId(), name: `Board ${useUI.getState().boards.length + 1}`, windows: [], viewport: { x: 40, y: 40, zoom: 1 } };
        useUI.setState((s) => ({ boards: [...s.boards, b], activeBoard: b.id, focusedWindow: null }));
      },
    },
    {
      label: "Close all windows",
      icon: <X size={14} />,
      danger: true,
      disabled: !board.windows.length,
      onClick: () => board.windows.forEach((w) => closeWindow(w.id)),
    },
  ];
}

/** Whether something from `target` up to `stop` will scroll for a wheel of (dx, dy). */
function scrollsWithin(target: Element, stop: Element, dx: number, dy: number): boolean {
  // How far there is to go: offsets run from 0 to the range, or (laid out from the end, as transcripts
  // are) from minus the range to 0.
  const room = (pos: number, range: number, reversed: boolean, d: number) => {
    const lo = reversed ? -range : 0;
    const hi = reversed ? 0 : range;
    return d < 0 ? pos > lo + 1 : pos < hi - 1;
  };
  for (let el: Element | null = target; el && el !== stop; el = el.parentElement) {
    const canY = dy !== 0 && el.scrollHeight > el.clientHeight + 1;
    const canX = dx !== 0 && el.scrollWidth > el.clientWidth + 1;
    if (!canY && !canX) continue;
    const style = getComputedStyle(el);
    const scrolls = (v: string) => v === "auto" || v === "scroll" || v === "overlay";
    if (canY && scrolls(style.overflowY) && room(el.scrollTop, el.scrollHeight - el.clientHeight, style.flexDirection === "column-reverse", dy)) return true;
    const rtl = style.flexDirection === "row-reverse" || style.direction === "rtl";
    if (canX && scrolls(style.overflowX) && room(el.scrollLeft, el.scrollWidth - el.clientWidth, rtl, dx)) return true;
  }
  return false;
}

function isTyping() {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

function BoardSwitcher() {
  const boards = useUI((s) => s.boards);
  const current = useUI((s) => activeBoard(s));
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const switchTo = (b: Board) => {
    viewport.commit();
    useUI.setState({ activeBoard: b.id, focusedWindow: null });
  };

  const open = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.left,
      y: r.top - 8 - (boards.length + 5) * 32,
      items: [
        ...boards.map((b) => ({
          label: `${b.name}  ·  ${b.windows.length}`,
          icon: b.id === current.id ? <span className="dot-sel" /> : <span />,
          onClick: () => switchTo(b),
        })),
        { separator: true },
        {
          label: "New board",
          icon: <Plus size={14} />,
          onClick: () => {
            viewport.commit();
            const b: Board = { id: newId(), name: `Board ${boards.length + 1}`, windows: [], viewport: { x: 40, y: 40, zoom: 1 } };
            useUI.setState((s) => ({ boards: [...s.boards, b], activeBoard: b.id, focusedWindow: null }));
          },
        },
        {
          label: "Duplicate board",
          icon: <Copy size={14} />,
          onClick: () => {
            viewport.commit();
            const src = activeBoard();
            const b: Board = { ...structuredClone(src), id: newId(), name: `${src.name} copy`, windows: src.windows.map((w) => ({ ...w, id: newId() })) };
            useUI.setState((s) => ({ boards: [...s.boards, b], activeBoard: b.id }));
          },
        },
        {
          label: "Rename board",
          icon: <Pencil size={14} />,
          onClick: async () => {
            const name = await promptText({ title: "Rename board", initial: current.name, confirmLabel: "Rename" });
            if (name) updateBoard((b) => ({ ...b, name }));
          },
        },
        {
          label: "Delete board",
          icon: <Trash2 size={14} />,
          danger: true,
          disabled: boards.length < 2,
          onClick: () =>
            useUI.setState((s) => {
              const rest = s.boards.filter((b) => b.id !== s.activeBoard);
              return { boards: rest, activeBoard: rest[0].id, focusedWindow: null };
            }),
        },
      ],
    });
  };

  return (
    <>
      <button className="board-btn" onClick={open} title="Boards">
        <span>{current.name}</span>
        <ChevronDown size={12} />
      </button>
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
    </>
  );
}
