import { useLayoutEffect, useMemo, useRef } from "react";
import { useShallow } from "../../lib/shallow";
import { useThreads } from "../../state/threads";
import { useUI, type Board } from "../../state/ui";
import { threadStateOf } from "../StatusDot";
import { boundsOf, viewport, type Viewport } from "./viewport";

const W = 168;
const H = 110;
/** How long the view has to sit still before the minimap fades out. */
const IDLE_MS = 2500;

export function Minimap({ board, viewportEl }: { board: Board; viewportEl: React.RefObject<HTMLDivElement | null> }) {
  const root = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  // needs input · working · failed · finished and not looked at yet (shimmers until clicked)
  const states = useThreads(useShallow((s) => board.windows.map((w) => threadStateOf(s, w.threadId))));
  const focused = useUI((s) => s.focusedWindow);

  const world = useMemo(() => {
    const b = boundsOf(board.windows) ?? { x: 0, y: 0, w: 1000, h: 800 };
    const pad = 200;
    return { x: b.x - pad, y: b.y - pad, w: b.w + pad * 2, h: b.h + pad * 2 };
  }, [board.windows]);
  const scale = Math.min(W / world.w, H / world.h);

  useLayoutEffect(() => {
    let size = "";
    return viewport.subscribe((vp) => {
      const f = frame.current;
      if (!f) return;
      const vx = -vp.x / vp.zoom;
      const vy = -vp.y / vp.zoom;
      f.style.transform = `translate3d(${(vx - world.x) * scale}px, ${(vy - world.y) * scale}px, 0)`;
      // Resizing it is a relayout and repaint; panning only moves it (on the compositor).
      const next = `${(viewport.size.w / vp.zoom) * scale}|${(viewport.size.h / vp.zoom) * scale}`;
      if (next === size) return;
      size = next;
      const [w, h] = next.split("|");
      f.style.width = `${w}px`;
      f.style.height = `${h}px`;
    });
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
      <div ref={frame} className="mm-frame" />
    </div>
  );
}
