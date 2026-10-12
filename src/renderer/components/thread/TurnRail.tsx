import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { useThreads } from "../../state/threads";
import { useUI } from "../../state/ui";
import type { ThreadItem } from "../../protocol";
import { duration, plainText } from "../../lib/format";

const PAD = 8; // the rail's vertical padding (matches the CSS)
const FOCUS_SLOT = 16; // px the turn under the pointer grows to on a crowded rail
const MAX_FISHEYE = 24;

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
  const [hover, setHover] = useState<{ id: string; y: number } | null>(null);

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
  const height = useRef(0);
  const frame = useRef(0);
  const arrange = (focus: number | null) => {
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
    });
  };

  /** The turn under a pointer at `clientY`, from its even slot (see layoutTicks), and its focus y. */
  const pick = (clientY: number) => {
    const el = rail.current!;
    const n = turns.length;
    const H = height.current;
    // Screen px → layout px: a canvas window may be zoomed.
    const r = el.getBoundingClientRect();
    const scale = r.height / el.offsetHeight || 1;
    const y = Math.max(0, Math.min(H - 0.001, (clientY - r.top) / scale - PAD));
    const i = Math.min(n - 1, Math.floor((y / H) * n));
    const { top, size } = layoutTicks(n, H, y);
    return { i, y, centre: PAD + top[i] + size[i] / 2 };
  };

  const jump = (id: string) => {
    const root = scroller.current;
    const target = root?.querySelector<HTMLElement>(`section.turn[data-turn="${CSS.escape(id)}"]`);
    if (!root || !target) return;
    root.dispatchEvent(new Event("ret:unstick"));
    const top = target.getBoundingClientRect().top - root.getBoundingClientRect().top + root.scrollTop - 12;
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
      const w = wrap.getBoundingClientRect();
      const inner = wrap.querySelector(".transcript-inner")?.getBoundingClientRect();
      let left = inner ? inner.left - w.left - 14 : 8;
      const pinned = document.querySelector(".sidebar-layer.pinned");
      if (pinned && wrap.closest(".chrome-focus")) left = Math.max(left, pinned.getBoundingClientRect().right - w.left + 8);
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
      onPointerMove={(e) => {
        const { i, y, centre } = pick(e.clientY);
        arrange(y);
        const id = turns[i];
        if (hover?.id !== id || Math.abs(hover.y - centre) > 1) setHover({ id, y: centre });
      }}
      onPointerLeave={() => {
        arrange(null);
        setHover(null);
      }}
      // The pointer, not the hit-tested element, says which turn: clicks between ticks still land.
      onClick={(e) => {
        if (e.detail === 0) return; // keyboard activation goes to the focused tick's own onClick
        e.preventDefault();
        jump(turns[pick(e.clientY).i]);
      }}
    >
      {turns.map((id, i) => (
        <button
          key={id}
          className={`rail-tick ${lit.has(id) ? "lit" : ""} ${id === running ? "running" : ""} ${hover?.id === id ? "hot" : ""}`}
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
      {hover && <RailPreview threadId={threadId} turnId={hover.id} index={turns.indexOf(hover.id)} y={hover.y} />}
    </div>
  );
});

function RailPreview({ threadId, turnId, index, y }: { threadId: string; turnId: string; index: number; y: number }) {
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
    <div className="rail-preview" style={{ top: y }} key={turnId}>
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
