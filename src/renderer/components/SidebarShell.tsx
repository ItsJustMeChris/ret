import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useUI } from "../state/ui";
import { Sidebar } from "./Sidebar";
import { EDGE, EDGE_DWELL_MS, GRACE_BAND, NEAR, NEAR_DWELL_MS, STILL_SPEED, createTracker, edgeIntent } from "../lib/edgeIntent";

const REOPEN_COOLDOWN_MS = 400; // after closing, only a clear signal reopens it

/** Popups that belong to the sidebar (its context menus and dropdowns): it stays out while they're open. */
const MENUS = ".menu, .sel-menu";
/** Modals (settings, palette, dialogs) take over the screen: a peeked sidebar gets out of their way. */
const MODAL = ".overlay:not(.monaco-editor *)"; // (Monaco's colour picker has an .overlay too)
/** Typing in one of these (the filter, a rename) holds the sidebar out while the pointer stays near. */
const FIELDS = "input, textarea, select, [contenteditable]";
/** Things near the edge you might rest the pointer on for their own sake (not lingering for the sidebar). */
const TARGETS = "button, a, input, textarea, select, [role=button], [role=tab], [contenteditable], .turn-rail";

/**
 * Pinned: a solid column that takes its width out of the main area (a spacer in the flow
 * reserves it, so the panel itself never remounts). Unpinned: it pops off the edge and is
 * tossed away, then lives off-screen, floating back over the content when the pointer's
 * motion says you're reaching for it (see edgeIntent); a faint handle at the edge grows
 * with that intent. It slides back when you move away, with a little grace for drift.
 */
export function SidebarShell() {
  const docked = useUI((s) => s.sidebarOpen);
  const width = useUI((s) => s.sidebarWidth);
  const [peek, setPeek] = useState(false);
  /** The flourish for a pin toggle: tossed away when unpinned, landing when pinned from out of sight. */
  const [motion, setMotion] = useState<"toss" | "land" | null>(null);
  const wasDocked = useRef(docked);
  const layer = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const hideTimer = useRef(0);
  const hovering = useRef(false);
  const closedAt = useRef(0);
  const peekRef = useRef(false);
  /** Last pointer position in viewport coordinates (shared by the open/close logic). */
  const lastPointer = useRef({ x: -1, y: -1 });

  const open = () => {
    if (peekRef.current) return;
    peekRef.current = true;
    setMotion(null); // reaching for it mid-toss: it comes straight back
    setPeek(true);
  };
  const close = () => {
    if (!peekRef.current) return;
    peekRef.current = false;
    // However it closed (Escape, a modal, a click elsewhere), the pointer isn't on it any more;
    // a stale "hovering" would keep the next peek from ever sliding away.
    hovering.current = false;
    closedAt.current = performance.now();
    // Don't leave keystrokes going into a panel that's off screen.
    const a = document.activeElement as HTMLElement | null;
    if (a && layer.current?.contains(a)) a.blur();
    setPeek(false);
  };

  useLayoutEffect(() => {
    if (wasDocked.current === docked) return;
    wasDocked.current = docked;
    if (docked) {
      // A peeking panel just settles into the column; one out of sight lands there.
      setMotion(peekRef.current ? null : "land");
      peekRef.current = false;
      hovering.current = false;
      setPeek(false);
    } else {
      // The pointer is likely still near it: don't let a peek catch it on the way out.
      closedAt.current = performance.now();
      setMotion("toss");
    }
  }, [docked]);

  /**
   * Something in the sidebar is in use: one of its menus is open, or you're typing in it with the
   * pointer still nearby. A button that merely kept focus after a click doesn't count.
   */
  const busy = () => {
    if (document.querySelector(MENUS)) return true;
    const a = document.activeElement;
    const el = layer.current;
    if (!a || !el?.contains(a) || !a.matches(FIELDS)) return false;
    return lastPointer.current.x <= el.getBoundingClientRect().right + GRACE_BAND;
  };

  /** Close after `delay`, unless the pointer comes back or something inside is in use. */
  const scheduleHide = (delay: number) => {
    clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(function check() {
      if (hovering.current) return;
      if (busy()) {
        hideTimer.current = window.setTimeout(check, 300);
        return;
      }
      close();
    }, delay);
  };

  // Track pointer motion and turn it into open/close decisions.
  useEffect(() => {
    if (docked) return;
    const tracker = createTracker();
    const m = tracker.m;
    let edgeSince = 0;
    let nearSince = 0;
    let dwellTimer = 0;
    let frame = 0;

    // Measured when it changes size, not on every move: reading it then would force a layout of
    // whatever just changed (a streaming reply) in the middle of handling the pointer.
    const bodyEl = document.querySelector(".app-body");
    let bodyRect = bodyEl?.getBoundingClientRect();
    const remeasure = () => (bodyRect = bodyEl?.getBoundingClientRect());
    const bodyObserver = new ResizeObserver(remeasure);
    if (bodyEl) bodyObserver.observe(bodyEl);
    window.addEventListener("resize", remeasure);
    const body = () => bodyRect;

    const paintHandle = (score: number) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const el = handle.current;
        if (!el) return;
        el.style.opacity = String(peekRef.current ? 0 : score);
        el.style.transform = `scaleY(${0.6 + score * 0.4})`;
      });
    };

    const evaluate = () => {
      const now = performance.now();
      const cooling = now - closedAt.current < REOPEN_COOLDOWN_MS;
      const { score, open: go } = edgeIntent(m, edgeSince ? now - edgeSince : 0, nearSince ? now - nearSince : 0, cooling);
      paintHandle(go ? 0 : score);
      if (go && !document.querySelector(MENUS) && !document.querySelector(MODAL)) open();
    };

    const onMove = (e: PointerEvent) => {
      const now = performance.now();
      const b = body();
      const left = b?.left ?? 0;
      const inBody = !b || (e.clientY >= b.top && e.clientY <= b.bottom);
      // Every hardware sample since the last event, with its own timestamp, so a busy
      // frame doesn't distort the velocity.
      const samples = e.getCoalescedEvents?.() ?? [];
      for (const c of samples.length ? samples : [e]) tracker.push(c.timeStamp, c.clientX - left, c.clientY);
      lastPointer.current = { x: e.clientX, y: e.clientY };

      if (peekRef.current) {
        // Open: close on a decisive move away, give drifting some grace.
        const r = layer.current?.getBoundingClientRect();
        const beyond = r ? e.clientX - r.right : 0;
        if (hovering.current) {
          // Normally pointerleave ends hovering; but if it was only inferred (the pointer was never
          // really over it), no leave comes, so a pointer well clear of the panel lets go too.
          if (beyond <= GRACE_BAND) return;
          hovering.current = false;
        }
        if (beyond > 0 && m.vx > 0.9) scheduleHide(90);
        else if (beyond > GRACE_BAND) scheduleHide(160);
        return;
      }

      // Closed: only an empty-handed pointer inside the app body expresses intent.
      if (e.buttons !== 0 || !inBody) {
        edgeSince = nearSince = 0;
        paintHandle(0);
        return;
      }
      edgeSince = m.x <= EDGE ? edgeSince || now : 0;
      const onTarget = !!(e.target as Element | null)?.closest?.(TARGETS);
      nearSince = m.x < NEAR && Math.hypot(m.vx, m.vy) < STILL_SPEED && !onTarget ? nearSince || now : 0;
      evaluate();
      // Resting pointers emit no events: re-check once a dwell could have elapsed.
      clearTimeout(dwellTimer);
      if (edgeSince || nearSince) {
        dwellTimer = window.setTimeout(() => {
          tracker.rest(); // no events since: the pointer is at rest
          evaluate();
        }, (edgeSince ? EDGE_DWELL_MS : NEAR_DWELL_MS) + 10);
      }
    };

    // Pointer events go quiet during HTML drag and drop, so drags report position here instead.
    const inPanel = (x: number, y: number) => {
      const r = layer.current?.getBoundingClientRect();
      return !!r && x <= r.right && y >= r.top && y <= r.bottom;
    };
    const onDragOver = (e: DragEvent) => {
      lastPointer.current = { x: e.clientX, y: e.clientY };
      // Dragging a thread toward the edge opens it as a drop target.
      if (!peekRef.current) {
        if (e.clientX < 24) open();
        return;
      }
      if (inPanel(e.clientX, e.clientY)) {
        hovering.current = true;
        clearTimeout(hideTimer.current);
      } else if (hovering.current) {
        // Dragging out of it (say, a thread onto the canvas): get out of the way.
        hovering.current = false;
        scheduleHide(400);
      }
    };
    // After a drop no pointerenter/leave fires; settle where the pointer ended up.
    const onDragEnd = () => {
      if (!peekRef.current) return;
      hovering.current = inPanel(lastPointer.current.x, lastPointer.current.y);
      if (!hovering.current) scheduleHide(300);
    };
    const onLeaveWindow = () => {
      tracker.reset();
      edgeSince = nearSince = 0;
      paintHandle(0);
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragend", onDragEnd);
    window.addEventListener("drop", onDragEnd);
    document.documentElement.addEventListener("pointerleave", onLeaveWindow);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragend", onDragEnd);
      window.removeEventListener("drop", onDragEnd);
      document.documentElement.removeEventListener("pointerleave", onLeaveWindow);
      bodyObserver.disconnect();
      window.removeEventListener("resize", remeasure);
      clearTimeout(dwellTimer);
      cancelAnimationFrame(frame);
    };
  }, [docked]);

  // While peeking: Escape, clicks elsewhere and modals put it away; so does a pointer that never arrives.
  useEffect(() => {
    if (!peek) return;
    const modal = () => document.querySelector(MODAL) && close();
    modal();
    const watch = new MutationObserver(modal);
    watch.observe(document.body, { childList: true, subtree: true });
    const arrive = window.setTimeout(() => {
      if (hovering.current) return;
      // A pointer that stopped right as the panel slid under it never fires pointerenter.
      const r = layer.current?.getBoundingClientRect();
      const { x, y } = lastPointer.current;
      if (r && x >= 0 && x <= r.right && y >= r.top && y <= r.bottom) hovering.current = true;
      else scheduleHide(0);
    }, 1100);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(MENUS)) close();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element;
      if (!layer.current?.contains(t) && !t.closest(MENUS)) close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      watch.disconnect();
      clearTimeout(arrive);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [peek]);

  useEffect(() => () => clearTimeout(hideTimer.current), []);

  const mode = docked ? "pinned" : peek ? "peek" : "hidden";

  return (
    <>
      <div className={`sidebar-dock ${motion ?? ""}`} style={{ width: docked ? width : 0 }} aria-hidden />
      <div
        ref={layer}
        className={`sidebar-layer ${mode} ${motion ?? ""}`}
        style={{ width }}
        onAnimationEnd={(e) => {
          if (e.target === e.currentTarget) setMotion(null);
        }}
        onPointerEnter={() => {
          hovering.current = true;
          clearTimeout(hideTimer.current);
        }}
        onPointerLeave={() => {
          hovering.current = false;
          // The motion tracker closes sooner on a decisive move away; drifting gets this grace.
          if (!docked) scheduleHide(700);
        }}
        aria-hidden={mode === "hidden"}
        inert={mode === "hidden" ? true : undefined}
      >
        <Sidebar />
      </div>
      {!docked && <div ref={handle} className="sidebar-handle" aria-hidden />}
    </>
  );
}
