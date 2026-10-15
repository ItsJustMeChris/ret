import { useLayoutEffect, useRef } from "react";
import { useShallow } from "../../lib/shallow";
import { useThreads } from "../../state/threads";
import { focusWindow } from "../../state/actions";
import type { Board } from "../../state/ui";
import { threadStateOf, type ThreadState } from "../StatusDot";
import { viewport, type Viewport } from "./viewport";

const INSET = 20; // px from the viewport edge
const SPACING = 26; // min px between beacons on the same edge
const SHOWN = 28; // a window this much on screen (both ways) doesn't need a beacon

/** Most urgent first, so a crowded edge keeps the important ones on top. */
const RANK: Record<ThreadState, number> = { attention: 0, error: 1, unread: 2, running: 3, idle: 9 };

/**
 * Edge markers for windows that are off screen and want something: needs input (pulsing),
 * finished but not looked at (shimmer), failed, or working. Each sits where the line from the
 * view's centre to the window leaves the view, points at it, and flies there when clicked.
 */
export function Beacons({ board, viewportEl }: { board: Board; viewportEl: React.RefObject<HTMLDivElement | null> }) {
  const states = useThreads(useShallow((s) => board.windows.map((w) => threadStateOf(s, w.threadId))));
  const flagged = board.windows
    .map((win, i) => ({ win, state: states[i] }))
    .filter((f) => f.state !== "idle")
    .sort((a, b) => RANK[a.state] - RANK[b.state]);
  const refs = useRef(new Map<string, HTMLButtonElement>());

  const key = flagged.map((f) => `${f.win.id}:${f.state}:${f.win.x},${f.win.y},${f.win.w},${f.win.h}`).join("|");
  useLayoutEffect(() => {
    // Placing runs every pan and zoom frame, so it doesn't read layout then (that would force one
    // right after the canvas has moved): the view's size is kept by CanvasView, and the toolbar
    // and minimap are measured when they change size, when layout is fresh anyway.
    // (They're the viewport's siblings: searching the canvas for them would walk every window's DOM.)
    if (!flagged.length) return;
    let blockers: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const view = viewportEl.current;
    const siblings = view ? [...view.parentElement!.children].filter((c) => c.matches(".canvas-toolbar, .canvas-minimap")) : [];
    const measure = () => {
      if (!view) return;
      const vr = view.getBoundingClientRect();
      blockers = siblings.map((b) => {
        const r = b.getBoundingClientRect();
        return { x0: r.left - vr.left - 16, y0: r.top - vr.top - 16, x1: r.right - vr.left + 16, y1: r.bottom - vr.top + 16 };
      });
    };
    // Also called once just after observing, before the beacons are first painted.
    const ro = new ResizeObserver(() => {
      measure();
      place(viewport.vp);
    });
    for (const el of [view, ...siblings]) if (el) ro.observe(el);
    const place = (vp: Viewport) => {
      const { w: W, h: H } = viewport.size;
      const box = { x0: INSET, y0: INSET, x1: W - INSET, y1: H - INSET };
      const ox = W / 2, oy = H / 2;
      const placed: { el: HTMLButtonElement; edge: string; x: number; y: number; a: number }[] = [];

      for (const { win } of flagged) {
        const b = refs.current.get(win.id);
        if (!b) continue;
        const sx = win.x * vp.zoom + vp.x, sy = win.y * vp.zoom + vp.y;
        const sw = win.w * vp.zoom, sh = win.h * vp.zoom;
        const visW = Math.min(sx + sw, W) - Math.max(sx, 0);
        const visH = Math.min(sy + sh, H) - Math.max(sy, 0);
        if (visW >= Math.min(SHOWN, sw) && visH >= Math.min(SHOWN, sh)) {
          b.hidden = true;
          continue;
        }
        // Where the ray from the view's centre to the window's centre crosses the inset box.
        const dx = sx + sw / 2 - ox, dy = sy + sh / 2 - oy;
        const tx = dx > 0 ? (box.x1 - ox) / dx : dx < 0 ? (box.x0 - ox) / dx : Infinity;
        const ty = dy > 0 ? (box.y1 - oy) / dy : dy < 0 ? (box.y0 - oy) / dy : Infinity;
        const t = Math.min(tx, ty);
        const x = ox + dx * t, y = oy + dy * t;
        const edge = tx < ty ? (dx > 0 ? "r" : "l") : dy > 0 ? "b" : "t";
        b.hidden = false;
        placed.push({ el: b, edge, x, y, a: Math.atan2(dy, dx) });
      }

      // Keep beacons on the same edge from stacking on top of each other.
      for (const edge of ["t", "b", "l", "r"]) {
        const along = edge === "t" || edge === "b" ? "x" : "y";
        const row = placed.filter((p) => p.edge === edge).sort((a, b) => a[along] - b[along]);
        for (let i = 1; i < row.length; i++) row[i][along] = Math.max(row[i][along], row[i - 1][along] + SPACING);
      }
      if (!placed.length) return;
      // Step out from under the toolbar and minimap: up off the bottom edge, left off the right one.
      for (const p of placed) {
        for (const b of blockers) {
          if (p.x < b.x0 || p.x > b.x1 || p.y < b.y0 || p.y > b.y1) continue;
          if (p.edge === "r") p.x = b.x0;
          else p.y = b.y0;
        }
        steer(p.el, `${Math.round(p.x * 10) / 10}px ${Math.round(p.y * 10) / 10}px`, `${Math.round(p.a * 1000) / 1000}rad`);
      }
    };
    // While the view moves, each beacon is placed and aimed by two animations whose keyframes are set
    // as it goes (the button's translate, its arrow's rotate): the compositor takes animated values as
    // they are, where a new style from script would re-layerize the whole canvas on every frame of a
    // pan. Once the view is still they become plain styles again, so nothing ticks while nothing moves.
    const steering = new Map<HTMLElement, { arrow: HTMLElement; move: Animation; aim: Animation; translate: string; rotate: string }>();
    /** Where each beacon was left as plain styles. */
    const rested = new Map<HTMLElement, string>();
    let still = 0;
    const settle = () => {
      for (const [el, s] of steering) {
        rested.set(el, `${s.translate}|${s.rotate}`);
        el.style.translate = s.translate;
        s.arrow.style.rotate = s.rotate;
        s.move.cancel();
        s.aim.cancel();
      }
      steering.clear();
    };
    const steer = (el: HTMLButtonElement, translate: string, rotate: string) => {
      const s = steering.get(el);
      if (s ? s.translate === translate && s.rotate === rotate : rested.get(el) === `${translate}|${rotate}`) return;
      const move = [{ translate }, { translate }];
      const aim = [{ rotate }, { rotate }];
      if (s) {
        (s.move.effect as KeyframeEffect).setKeyframes(move);
        (s.aim.effect as KeyframeEffect).setKeyframes(aim);
        Object.assign(s, { translate, rotate });
      } else {
        const arrow = el.querySelector<HTMLElement>(".beacon-arrow")!;
        const opts = { duration: 1e9, fill: "forwards" } as const;
        steering.set(el, { arrow, move: el.animate(move, opts), aim: arrow.animate(aim, opts), translate, rotate });
      }
      clearTimeout(still);
      still = window.setTimeout(settle, 200);
    };
    const off = viewport.subscribe(place);
    return () => {
      off();
      ro.disconnect();
      clearTimeout(still);
      settle();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, viewportEl]);

  if (!flagged.length) return null;
  return (
    <div className="beacons">
      {flagged.map(({ win, state }) => (
        <button
          key={win.id}
          ref={(b) => {
            if (b) refs.current.set(win.id, b);
            else refs.current.delete(win.id);
          }}
          hidden
          className={`beacon ${state}`}
          data-card="thread"
          data-id={win.threadId}
          aria-label={`Go to ${state === "unread" ? "finished" : state} thread`}
          onClick={() => focusWindow(win.id, true)}
        >
          <span className="beacon-arrow" />
          <span className="beacon-dot" />
        </button>
      ))}
    </div>
  );
}
