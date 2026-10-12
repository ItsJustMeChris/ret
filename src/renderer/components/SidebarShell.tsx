import { useEffect, useRef, useState } from "react";
import { useUI } from "../state/ui";
import { Sidebar } from "./Sidebar";

const PEEK_DELAY_MS = 90;
const HIDE_DELAY_MS = 320;

/** Anything that, while open, should keep a peeked sidebar from sliding away. */
const BUSY = ".menu, .sel-menu, .overlay, .dialog";

/**
 * The sidebar always floats over the content (it never resizes the main area).
 * Pinned: stays out. Unpinned: hidden off-screen; a thin hot zone on the left edge slides
 * it out, and it slides back shortly after the pointer leaves (unless a menu, picker or
 * input inside it is in use).
 */
export function SidebarShell() {
  const docked = useUI((s) => s.sidebarOpen);
  const width = useUI((s) => s.sidebarWidth);
  const [peek, setPeek] = useState(false);
  const layer = useRef<HTMLDivElement>(null);
  const timer = useRef(0);
  const hovering = useRef(false);

  useEffect(() => {
    if (docked) setPeek(false);
  }, [docked]);

  const busy = () => !!document.querySelector(BUSY) || !!layer.current?.contains(document.activeElement);

  const scheduleHide = () => {
    clearTimeout(timer.current);
    timer.current = window.setTimeout(function check() {
      if (hovering.current) return;
      // Keep it out while a context menu / picker / rename is open; re-check shortly.
      if (busy()) {
        timer.current = window.setTimeout(check, HIDE_DELAY_MS);
        return;
      }
      setPeek(false);
    }, HIDE_DELAY_MS);
  };

  useEffect(() => {
    if (!peek) return;
    // If the pointer slid out of the window instead of onto the panel, don't stay open forever.
    timer.current = window.setTimeout(() => !hovering.current && scheduleHide(), 900);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector(BUSY)) setPeek(false);
    };
    // Clicking outside the panel (e.g. back into a thread) retracts it.
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element;
      if (!layer.current?.contains(t) && !t.closest(BUSY)) setPeek(false);
    };
    // Backstop for a missed pointerleave (fast flicks, pointer jumping between windows).
    const onMove = (e: PointerEvent) => {
      const r = layer.current?.getBoundingClientRect();
      if (r && e.clientX > r.right + 24 && hovering.current) {
        hovering.current = false;
        scheduleHide();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove);
    };
  }, [peek]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const mode = docked ? "pinned" : peek ? "peek" : "hidden";

  return (
    <>
      <div
        ref={layer}
        className={`sidebar-layer ${mode}`}
        style={{ width }}
        onPointerEnter={() => {
          hovering.current = true;
          clearTimeout(timer.current);
        }}
        onPointerLeave={() => {
          hovering.current = false;
          if (!docked) scheduleHide();
        }}
        aria-hidden={mode === "hidden"}
        inert={mode === "hidden" ? true : undefined}
      >
        <Sidebar />
      </div>
      {!docked && !peek && (
        <div
          className="sidebar-hotzone"
          onPointerEnter={() => {
            clearTimeout(timer.current);
            timer.current = window.setTimeout(() => setPeek(true), PEEK_DELAY_MS);
          }}
          onPointerLeave={() => {
            // Only cancel a pending open; once open, the panel's own leave handler takes over.
            if (!hovering.current) clearTimeout(timer.current);
          }}
          onDragEnter={() => setPeek(true)}
        />
      )}
    </>
  );
}
