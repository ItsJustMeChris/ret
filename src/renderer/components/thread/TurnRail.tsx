import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { CircleAlert, LoaderCircle } from "lucide-react";
import { useThreads } from "../../state/threads";
import { useUI } from "../../state/ui";
import type { ThreadItem } from "../../protocol";
import { duration, plainText } from "../../lib/format";

/**
 * Jump rail on the left of a transcript, just outside the text column: one tick per turn.
 * It stays invisible until the pointer reaches it, then fades in as a small frosted pill. Ticks for turns in view are
 * lit, the tick under the pointer and its neighbours magnify (dock-style), hovering shows the
 * turn's opening message, and clicking smooth-scrolls there.
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

  // Dock-style magnification, written straight to the DOM on pointer move.
  const magnify = (clientY: number | null) => {
    const el = rail.current;
    if (!el) return;
    for (const tick of el.querySelectorAll<HTMLElement>(".rail-tick")) {
      if (clientY == null) {
        tick.style.setProperty("--mag", "0");
        continue;
      }
      const r = tick.getBoundingClientRect();
      const d = (r.top + r.height / 2 - clientY) / 26;
      tick.style.setProperty("--mag", String(Math.exp(-d * d)));
    }
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

  useLayoutEffect(() => magnify(null), [turns.length]);

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
        magnify(e.clientY);
        const tick = (e.target as HTMLElement).closest<HTMLElement>(".rail-tick");
        if (tick?.dataset.turn) {
          const r = tick.getBoundingClientRect();
          const box = rail.current!.getBoundingClientRect();
          if (hover?.id !== tick.dataset.turn) setHover({ id: tick.dataset.turn, y: r.top + r.height / 2 - box.top });
        }
      }}
      onPointerLeave={() => {
        magnify(null);
        setHover(null);
      }}
    >
      {turns.map((id, i) => (
        <button
          key={id}
          className={`rail-tick ${lit.has(id) ? "lit" : ""} ${id === running ? "running" : ""}`}
          data-turn={id}
          style={{ "--i": i } as React.CSSProperties}
          aria-label={`Jump to turn ${i + 1}`}
          onClick={() => jump(id)}
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
