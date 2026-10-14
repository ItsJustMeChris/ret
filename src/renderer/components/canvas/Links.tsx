import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { GitFork } from "lucide-react";
import { useThreads } from "../../state/threads";
import { useUI, type Board, type CanvasWin } from "../../state/ui";
import { openThread } from "../../state/actions";
import { lineageParent, threadTitle } from "../../state/projects";
import { Menu, type MenuItem } from "../Menu";
import { liveRect, onLiveRect, type Rect } from "./live";
import { boundsOf, viewport, viewportSize } from "./viewport";

interface Link {
  id: string;
  from: CanvasWin;
  to: CanvasWin;
  /** False when intermediate forks aren't on the board (drawn dashed). */
  direct: boolean;
}

/** Header-height anchor so links read as "this window came from that one". */
const HEADER_Y = 20;

function geometry(a: Rect, b: Rect) {
  const acx = a.x + a.w / 2;
  const acy = a.y + a.h / 2;
  const bcx = b.x + b.w / 2;
  const bcy = b.y + b.h / 2;
  const dx = bcx - acx;
  const dy = bcy - acy;
  // Side-by-side relationships attach at the title bars; stacked ones at top/bottom edges.
  const horizontal = Math.abs(dx) * (a.h + b.h) >= Math.abs(dy) * (a.w + b.w);
  let p1: { x: number; y: number };
  let p2: { x: number; y: number };
  let c1: { x: number; y: number };
  let c2: { x: number; y: number };
  if (horizontal) {
    const s = dx >= 0 ? 1 : -1;
    p1 = { x: s > 0 ? a.x + a.w : a.x, y: a.y + HEADER_Y };
    p2 = { x: s > 0 ? b.x : b.x + b.w, y: b.y + HEADER_Y };
    const k = Math.max(48, Math.abs(p2.x - p1.x) * 0.45);
    c1 = { x: p1.x + s * k, y: p1.y };
    c2 = { x: p2.x - s * k, y: p2.y };
  } else {
    const s = dy >= 0 ? 1 : -1;
    p1 = { x: acx, y: s > 0 ? a.y + a.h : a.y };
    p2 = { x: bcx, y: s > 0 ? b.y : b.y + b.h };
    const k = Math.max(48, Math.abs(p2.y - p1.y) * 0.45);
    c1 = { x: p1.x, y: p1.y + s * k };
    c2 = { x: p2.x, y: p2.y - s * k };
  }
  const mid = {
    x: (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8,
    y: (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8,
  };
  return { d: `M ${p1.x} ${p1.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p2.x} ${p2.y}`, p1, p2, mid };
}

/** Lines from each thread window to the windows of its forks and subagents (nearest ancestor on the board). */
export function Links({ board }: { board: Board }) {
  const show = useUI((s) => s.showLinks);
  // For each window: the window id of its nearest forked-from ancestor on this board, plus whether it's the direct parent.
  const parents = useThreads(
    useShallow((s) => {
      const byThread = new Map(board.windows.map((w) => [w.threadId, w.id]));
      return board.windows.map((w) => {
        const up = (id: string) => (s.threads[id] ? lineageParent(s.threads[id]) : null);
        let p = up(w.threadId);
        let hops = 1;
        const seen = new Set<string>();
        while (p && !byThread.has(p) && !seen.has(p)) {
          seen.add(p);
          p = up(p);
          hops++;
        }
        return p && byThread.has(p) ? `${byThread.get(p)}|${hops === 1 ? 1 : 0}` : "";
      });
    }),
  );

  const links = useMemo<Link[]>(() => {
    const byId = new Map(board.windows.map((w) => [w.id, w]));
    const out: Link[] = [];
    board.windows.forEach((w, i) => {
      const entry = parents[i];
      if (!entry) return;
      const [fromId, direct] = entry.split("|");
      const from = byId.get(fromId);
      if (from) out.push({ id: `${from.id}>${w.id}`, from, to: w, direct: direct === "1" });
    });
    return out;
  }, [board.windows, parents]);

  if (!show || !links.length) return null;
  return (
    <>
      <svg className="links" width="1" height="1">
        <defs>
          <marker id="link-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 1 L 9 5 L 0 9 z" className="link-arrowhead" />
          </marker>
        </defs>
        {links.map((l) => (
          <LinkPath key={l.id} link={l} />
        ))}
      </svg>
      {links.map((l) => (
        <LinkLabel key={l.id} link={l} />
      ))}
    </>
  );
}

function useLinkGeometry(link: Link, apply: (g: ReturnType<typeof geometry>) => void) {
  const applyRef = useRef(apply);
  applyRef.current = apply;
  useLayoutEffect(() => {
    const draw = () => applyRef.current(geometry(liveRect(link.from.id) ?? link.from, liveRect(link.to.id) ?? link.to));
    draw();
    let frame = 0;
    const off = onLiveRect((id) => {
      if (id !== link.from.id && id !== link.to.id) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    });
    return () => {
      off();
      cancelAnimationFrame(frame);
    };
  }, [link]);
}

const LinkPath = memo(function LinkPath({ link }: { link: Link }) {
  const path = useRef<SVGPathElement>(null);
  const start = useRef<SVGCircleElement>(null);
  const focused = useUI((s) => s.focusedWindow === link.from.id || s.focusedWindow === link.to.id);
  const running = useThreads((s) => !!s.live[link.to.threadId]?.activeTurnId || !!s.external[link.to.threadId]);
  useLinkGeometry(link, (g) => {
    path.current?.setAttribute("d", g.d);
    start.current?.setAttribute("cx", String(g.p1.x));
    start.current?.setAttribute("cy", String(g.p1.y));
  });
  return (
    <g className={`link ${focused ? "focused" : ""} ${running ? "running" : ""} ${link.direct ? "" : "indirect"}`}>
      <path ref={path} className="link-line" markerEnd="url(#link-arrow)" vectorEffect="non-scaling-stroke" />
      <circle ref={start} r="3.5" className="link-start" vectorEffect="non-scaling-stroke" />
    </g>
  );
});

const LinkLabel = memo(function LinkLabel({ link }: { link: Link }) {
  const el = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const focused = useUI((s) => s.focusedWindow === link.from.id || s.focusedWindow === link.to.id);
  const parentTitle = useThreads((s) => threadTitle(s.threads[link.from.threadId]));
  useLinkGeometry(link, (g) => {
    if (el.current) el.current.style.transform = `translate(${g.mid.x}px, ${g.mid.y}px) translate(-50%, -50%) scale(min(var(--inv-zoom, 1), 2.5))`;
  });

  // Frame both windows so the pair can be compared at a glance.
  const frame = () => {
    const b = boundsOf([link.from, link.to]);
    if (!b) return;
    const { w, h } = viewportSize();
    viewport.animateTo(viewport.fitRect(b, w, h, 48, 1));
  };

  return (
    <>
      <button
        ref={el}
        className={`link-label ${focused ? "focused" : ""} ${link.direct ? "" : "indirect"}`}
        title={`${link.direct ? "Forked from" : "Descends from"} “${parentTitle}” — click to frame both, right-click for more`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={frame}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({
            x: e.clientX,
            y: e.clientY,
            items: [
              { label: "Frame both", onClick: frame },
              {
                label: "Compare side by side in Focus",
                onClick: () => {
                  useUI.setState({ mode: "focus" });
                  openThread(link.from.threadId, { mode: "focus" });
                  openThread(link.to.threadId, { mode: "focus", side: true, besideThread: link.from.threadId });
                },
              },
            ],
          });
        }}
      >
        <GitFork size={12} />
      </button>
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
    </>
  );
});
