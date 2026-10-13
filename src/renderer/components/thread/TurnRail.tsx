import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { useThreads } from "../../state/threads";
import { useUI } from "../../state/ui";
import type { ThreadItem } from "@shared/protocol";
import { duration, plainText } from "../../lib/format";

const PAD = 8; // the rail's vertical padding (matches the CSS)

/** Screen px per layout px for `el`: a canvas window is scaled by the canvas zoom. */
const scaleOf = (el: HTMLElement) => el.getBoundingClientRect().height / el.offsetHeight || 1;
const FOCUS_SLOT = 16; // px the turn under the pointer grows to on a crowded rail
const MAX_FISHEYE = 24;
/** How far (in even slots) the pointer must cross into a neighbour before it takes over: no flicker on a boundary. */
const HYSTERESIS = 0.3;
/** Grace before the rail relaxes after the pointer leaves it, so an overshoot past an end doesn't reset everything. */
const LEAVE_MS = 160;

/**
 * Tick layout along a rail of height `H`: even slots, or with `focus` (pointer y) a fisheye
 * (Sarkar–Brown) that grows the slots near the pointer and squeezes the rest. The transform
 * is monotonic and leaves the focus point fixed, so the turn under the pointer is the one
 * whose even slot contains it: picking never depends on the magnified layout, and can't flicker.
 */
function layoutTicks(n: number, H: number, focus: number | null): { top: number[]; size: number[] } {
  const s0 = H / n;
  const d = focus == null ? 0 : Math.min(MAX_FISHEYE, Math.max(0, FOCUS_SLOT / s0 - 1));
  const g = (x: number) => ((d + 1) * x) / (d * x + 1);
  const T = (u: number) => {
    if (!d || focus == null) return u;
    if (u >= focus) return focus + (H - focus) * g(H - focus > 0 ? (u - focus) / (H - focus) : 0);
    return focus - focus * g(focus > 0 ? (focus - u) / focus : 0);
  };
  const top: number[] = [], size: number[] = [];
  let prev = T(0);
  for (let i = 0; i < n; i++) {
    const next = T((i + 1) * s0);
    top.push(prev);
    size.push(next - prev);
    prev = next;
  }
  return { top, size };
}

/**
 * Jump rail on the left of a transcript, just outside the text column: one tick per turn.
 * It stays invisible until the pointer reaches it, then fades in as a small frosted pill.
 * Ticks for turns in view are lit; under the pointer the rail fisheyes so every turn is easy
 * to hit however long the thread is; hovering shows the turn's opening message, and clicking
 * smooth-scrolls there.
 */
export const TurnRail = memo(function TurnRail({ threadId, scroller }: { threadId: string; scroller: React.RefObject<HTMLDivElement | null> }) {
  const turns = useThreads(
    useShallow((s) => {
      const lt = s.live[threadId];
      if (!lt) return [] as string[];
      return lt.turnOrder.filter((id) => !id.startsWith("pending:"));
    }),
  );
  const running = useThreads((s) => {
    const lt = s.live[threadId];
    return lt?.activeTurnId ?? (s.external[threadId]?.turnId || null);
  });
  const rail = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState<string>("");
  /** The turn the pointer picks. Only this is React state: the layout and the preview's position are written to the DOM. */
  const [hot, setHot] = useState<string | null>(null);
  const hotIndex = useRef<number | null>(null);
  const preview = useRef<HTMLDivElement | null>(null);
  /** The preview's y (layout px within the rail), kept for when it mounts after the layout was written. */
  const previewY = useRef(0);
  const leaving = useRef(0);
  const arriving = useRef(0);

  // Which turns are on screen.
  useEffect(() => {
    const root = scroller.current;
    if (!root || turns.length < 2) return;
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set((e.target as HTMLElement).dataset.turn!, e.isIntersecting);
        const ids = turns.filter((id) => seen.get(id)).join("|");
        setVisible((prev) => (prev === ids ? prev : ids));
      },
      { root, threshold: 0 },
    );
    for (const el of root.querySelectorAll<HTMLElement>("section.turn[data-turn]")) io.observe(el);
    return () => io.disconnect();
  }, [scroller, turns]);

  // Lay the ticks out (evenly, or fisheyed around the pointer), written straight to the DOM.
  // Everything is computed, nothing measured per tick, so it stays cheap on long threads.
  // The preview rides on the picked tick's centre in the same frame, so they never drift apart.
  const height = useRef(0);
  const frame = useRef(0);
  const arrange = (focus: number | null, picked: number | null = null) => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      const el = rail.current;
      if (!el) return;
      const ticks = el.querySelectorAll<HTMLElement>(".rail-tick");
      if (!ticks.length || !height.current) return;
      const { top, size } = layoutTicks(ticks.length, height.current, focus);
      ticks.forEach((tick, i) => {
        const centre = top[i] + size[i] / 2;
        const d = focus == null ? Infinity : (centre - focus) / 26;
        tick.style.transform = `translateY(${top[i]}px)`;
        tick.style.height = `${size[i]}px`;
        tick.style.setProperty("--h", String(size[i]));
        tick.style.setProperty("--mag", focus == null ? "0" : String(Math.exp(-d * d)));
      });
      if (picked != null && picked < ticks.length) {
        previewY.current = PAD + top[picked] + size[picked] / 2;
        if (preview.current) preview.current.style.top = `${previewY.current}px`;
      }
    });
  };

  /**
   * The turn under a pointer at `clientY` and its focus y. The turn is the one whose even slot holds
   * the pointer (see layoutTicks), except that the current one keeps it until the pointer is well
   * into a neighbour's slot, so a pointer resting on a boundary doesn't flip between the two.
   */
  const pick = (clientY: number) => {
    const el = rail.current!;
    const n = turns.length;
    const H = height.current;
    // Screen px → layout px: a canvas window may be zoomed. Past either end counts as the end tick.
    const r = el.getBoundingClientRect();
    const y = Math.max(0, Math.min(H - 0.001, (clientY - r.top) / scaleOf(el) - PAD));
    const slot = (y / H) * n;
    let i = Math.min(n - 1, Math.floor(slot));
    const prev = hotIndex.current;
    if (prev != null && prev < n && Math.abs(i - prev) === 1 && Math.abs(slot - (i > prev ? i : prev)) < HYSTERESIS) i = prev;
    return { i, y };
  };

  const point = (clientY: number) => {
    window.clearTimeout(leaving.current);
    const el = rail.current;
    if (!el || !height.current) return;
    const { i, y } = pick(clientY);
    // Ticks ease into the fisheye when the pointer arrives, then follow it exactly (no lag to
    // fall behind a quick back-and-forth); they ease back out when it leaves.
    if (!el.dataset.tracking && !arriving.current) {
      arriving.current = window.setTimeout(() => {
        arriving.current = 0;
        if (rail.current && hotIndex.current != null) rail.current.dataset.tracking = "1";
      }, 110);
    }
    hotIndex.current = i;
    arrange(y, i);
    if (hot !== turns[i]) setHot(turns[i]);
  };

  const leave = () => {
    window.clearTimeout(leaving.current);
    leaving.current = window.setTimeout(() => {
      const el = rail.current;
      window.clearTimeout(arriving.current);
      arriving.current = 0;
      if (el) delete el.dataset.tracking;
      hotIndex.current = null;
      arrange(null);
      setHot(null);
    }, LEAVE_MS);
  };

  const jump = (id: string) => {
    const root = scroller.current;
    const target = root?.querySelector<HTMLElement>(`section.turn[data-turn="${CSS.escape(id)}"]`);
    if (!root || !target) return;
    root.dispatchEvent(new Event("ret:unstick"));
    // The rects are screen px (zoomed on the canvas); scrollTop is layout px.
    const top = (target.getBoundingClientRect().top - root.getBoundingClientRect().top) / scaleOf(root) + root.scrollTop - 12;
    root.scrollTo({ top, behavior: "smooth" });
    target.classList.remove("flash");
    void target.offsetWidth; // restart the highlight animation
    target.classList.add("flash");
  };

  // Track the rail's usable height; re-lay the ticks evenly when it or the turn count changes.
  useLayoutEffect(() => {
    const el = rail.current;
    if (!el) return;
    const measure = () => {
      height.current = Math.max(1, el.clientHeight - PAD * 2);
      arrange(null);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame.current);
      window.clearTimeout(leaving.current);
      window.clearTimeout(arriving.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns.length >= 2, turns.length]);

  // Sit just left of the text column, and clear of the floating sidebar when it's pinned over us.
  const sidebar = useUI((s) => (s.sidebarOpen ? s.sidebarWidth : 0));
  const show = turns.length >= 2;
  useLayoutEffect(() => {
    const el = rail.current;
    const wrap = el?.parentElement;
    if (!el || !wrap) return;
    const place = () => {
      // Measured in screen px but written in layout px, so divide out a canvas window's zoom.
      const scale = scaleOf(wrap);
      const w = wrap.getBoundingClientRect();
      const inner = wrap.querySelector(".transcript-inner")?.getBoundingClientRect();
      let left = inner ? (inner.left - w.left) / scale - 14 : 8;
      const pinned = document.querySelector(".sidebar-layer.pinned");
      if (pinned && wrap.closest(".chrome-focus")) left = Math.max(left, (pinned.getBoundingClientRect().right - w.left) / scale + 8);
      el.style.left = `${Math.max(6, Math.round(left))}px`;
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [show, sidebar]);

  if (turns.length < 2) return null;
  const lit = new Set(visible.split("|"));

  return (
    <div
      ref={rail}
      className="turn-rail"
      style={{ "--n": turns.length } as React.CSSProperties}
      onPointerMove={(e) => point(e.clientY)}
      onPointerLeave={leave}
      // The highlighted turn, not the hit-tested element, is what a click takes: clicks between ticks still land.
      onClick={(e) => {
        if (e.detail === 0) return; // keyboard activation goes to the focused tick's own onClick
        e.preventDefault();
        const i = hotIndex.current ?? pick(e.clientY).i;
        jump(turns[i]);
      }}
    >
      {turns.map((id, i) => (
        <button
          key={id}
          className={`rail-tick ${lit.has(id) ? "lit" : ""} ${id === running ? "running" : ""} ${hot === id ? "hot" : ""}`}
          data-turn={id}
          style={{ "--i": i } as React.CSSProperties}
          aria-label={`Jump to turn ${i + 1}`}
          onClick={(e) => {
            if (e.detail !== 0) return; // pointer clicks are handled by the rail
            jump(id);
          }}
        >
          <span />
        </button>
      ))}
      {hot && (
        <RailPreview
          threadId={threadId}
          turnId={hot}
          index={turns.indexOf(hot)}
          place={(el) => {
            preview.current = el;
            if (el) el.style.top = `${previewY.current}px`;
          }}
        />
      )}
    </div>
  );
});

/** The hovered turn's opening message. Stays mounted while the pointer moves between turns (so it doesn't re-pop); the rail positions it. */
function RailPreview({ threadId, turnId, index, place }: { threadId: string; turnId: string; index: number; place: (el: HTMLDivElement | null) => void }) {
  const info = useThreads(
    useShallow((s) => {
      const lt = s.live[threadId];
      const turn = lt?.turns[turnId];
      if (!turn) return null;
      const user = turn.itemIds.map((id) => lt.items[id]).find((it): it is Extract<ThreadItem, { type: "userMessage" }> => it?.type === "userMessage");
      const text = user?.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .join(" ")
        .trim();
      return { text: text ?? "", status: turn.status, stale: !!turn.stale, startedAt: turn.startedAt, durationMs: turn.durationMs };
    }),
  );
  if (!info) return null;
  const when = info.startedAt ? new Date(info.startedAt * 1000).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "";
  return (
    <div className="rail-preview" ref={place}>
      <div className="rail-preview-meta">
        <span>Turn {index + 1}</span>
        {when && <span>· {when}</span>}
        {info.durationMs != null && <span>· {duration(info.durationMs)}</span>}
        {info.status === "inProgress" && !info.stale && <LoaderCircle size={11} className="spin st-run" />}
        {info.status === "failed" && <CircleAlert size={11} className="st-err" />}
      </div>
      <div className="rail-preview-text">{plainText(info.text || "(no message)", 160)}</div>
    </div>
  );
}
