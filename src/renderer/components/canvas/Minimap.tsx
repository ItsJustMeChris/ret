import { useLayoutEffect, useMemo, useRef } from "react";
import { useShallow } from "../../lib/shallow";
import { useThreads } from "../../state/threads";
import { useUI, type Board } from "../../state/ui";
import { threadStateOf } from "../StatusDot";
import { boundsOf, viewport, type Viewport } from "./viewport";

// Scroll-driven animation timelines (Chromium 115+); not in TypeScript's DOM library yet.
declare const ScrollTimeline: { new (options: { source: Element; axis: "x" | "y" }): AnimationTimeline } | undefined;

const W = 168;
const H = 110;
/** How long the view has to sit still before the minimap fades out. */
const IDLE_MS = 2500;

export function Minimap({ board, viewportEl }: { board: Board; viewportEl: React.RefObject<HTMLDivElement | null> }) {
  const root = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const frameX = useRef<HTMLDivElement>(null);
  // needs input · working · failed · finished and not looked at yet (shimmers until clicked)
  const states = useThreads(useShallow((s) => board.windows.map((w) => threadStateOf(s, w.threadId))));
  const focused = useUI((s) => s.focusedWindow);

  const world = useMemo(() => {
    const b = boundsOf(board.windows) ?? { x: 0, y: 0, w: 1000, h: 800 };
    const pad = 200;
    return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
  }, [board.windows]);
  const scale = Math.min(W / world.w, H / world.h);

  // The frame follows pans on the compositor: a pan is the canvas scroller's scroll offset (see
  // CanvasView), and two scroll-driven animations map that offset to the frame's place, x on the outer
  // element and y on the inner one. Moving it from script instead would re-layerize the whole canvas
  // on every frame of a pan. The animations are only rebuilt when the mapping changes (a zoom, the
  // view resized, the board's extent). Where there are no scroll timelines, it's moved every frame.
  useLayoutEffect(() => {
    let size = "";
    let mapped = "";
    let anims: Animation[] = [];
    let timelines: { el: HTMLElement; x: AnimationTimeline; y: AnimationTimeline } | null = null;
    const off = viewport.subscribe((vp) => {
      const f = frame.current;
      const fx = frameX.current;
      if (!f || !fx) return;
      // Resizing it is a relayout and repaint; panning only moves it (on the compositor).
      const next = `${(viewport.size.w / vp.zoom) * scale}|${(viewport.size.h / vp.zoom) * scale}`;
      if (next !== size) {
        size = next;
        const [w, h] = next.split("|");
        f.style.width = `${w}px`;
        f.style.height = `${h}px`;
      }
      const sc = viewport.scroll;
      if (!sc || typeof ScrollTimeline === "undefined") {
        f.style.transform = `translate(${(-vp.x / vp.zoom - world.x) * scale}px, ${(-vp.y / vp.zoom - world.y) * scale}px)`;
        return;
      }
      const key = `${vp.zoom}|${sc.origin.x}|${sc.origin.y}|${sc.extent}|${viewport.size.w}|${viewport.size.h}`;
      if (key === mapped && timelines?.el === sc.el) return;
      mapped = key;
      if (timelines?.el !== sc.el) {
        timelines = { el: sc.el, x: new ScrollTimeline({ source: sc.el, axis: "x" }), y: new ScrollTimeline({ source: sc.el, axis: "y" }) };
        for (const a of anims) a.cancel();
        anims = [];
      }
      // The frame's place for a scroll offset s along an axis: the view's world edge, (s - origin) / zoom, on the map.
      const at = (s: number, o: number, w: number) => ((s - o) / vp.zoom - w) * scale;
      const maxX = sc.extent - viewport.size.w;
      const maxY = sc.extent - viewport.size.h;
      const kx = [{ transform: `translateX(${at(0, sc.origin.x, world.x)}px)` }, { transform: `translateX(${at(maxX, sc.origin.x, world.x)}px)` }];
      const ky = [{ transform: `translateY(${at(0, sc.origin.y, world.y)}px)` }, { transform: `translateY(${at(maxY, sc.origin.y, world.y)}px)` }];
      if (anims.length) {
        (anims[0].effect as KeyframeEffect).setKeyframes(kx);
        (anims[1].effect as KeyframeEffect).setKeyframes(ky);
      } else {
        const opts = { fill: "both", easing: "linear" } as const;
        anims = [fx.animate(kx, { ...opts, timeline: timelines.x }), f.animate(ky, { ...opts, timeline: timelines.y })];
        f.style.transform = "";
      }
    });
    return () => {
      off();
      for (const a of anims) a.cancel();
    };
  }, [world, scale]);

  // Shown while the view pans or zooms (or jumps to another board), faded out once it has sat still
  // for a while. Hovering its corner brings it back (CSS). Toggled on the DOM, so panning doesn't re-render.
  const shown = board.windows.length >= 2;
  useLayoutEffect(() => {
    if (!shown) return;
    let last: Viewport | null = null;
    let timer = 0;
    const off = viewport.subscribe((vp) => {
      if (last && vp.x === last.x && vp.y === last.y && vp.zoom === last.zoom) return;
      last = vp;
      root.current?.classList.add("awake");
      clearTimeout(timer);
      timer = window.setTimeout(() => root.current?.classList.remove("awake"), IDLE_MS);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [shown]);

  if (!shown) return null;

  const navigate = (e: React.PointerEvent) => {
    const el = viewportEl.current;
    if (!el) return;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const go = (ev: PointerEvent | React.PointerEvent) => {
      const r = target.getBoundingClientRect();
      const wx = (ev.clientX - r.left) / scale + world.x;
      const wy = (ev.clientY - r.top) / scale + world.y;
      const vp = viewport.vp;
      viewport.set({ ...vp, x: el.clientWidth / 2 - wx * vp.zoom, y: el.clientHeight / 2 - wy * vp.zoom });
    };
    go(e);
    const move = (ev: PointerEvent) => go(ev);
    const up = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
  };

  return (
    <div ref={root} className="canvas-minimap" style={{ width: W, height: H }} onPointerDown={navigate}>
      {board.windows.map((w, i) => (
        <div
          key={w.id}
          className={`mm-win ${states[i] ?? ""} ${w.id === focused ? "focused" : ""}`}
          style={{
            transform: `translate(${(w.x - world.x) * scale}px, ${(w.y - world.y) * scale}px)`,
            width: Math.max(2, w.w * scale),
            height: Math.max(2, w.h * scale),
          }}
        />
      ))}
      <div ref={frameX} className="mm-frame-x">
        <div ref={frame} className="mm-frame" />
      </div>
    </div>
  );
}
