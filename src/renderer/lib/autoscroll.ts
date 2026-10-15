/**
 * Middle-click autoscroll, as browsers do it: press and release the middle button over something
 * that scrolls, then move the pointer above or below the mark to scroll that way, faster the
 * further you go. Any click, key or wheel ends it. The canvas needs its own because a middle press
 * there might start a pan, and only the release tells which it was: too late for the browser's.
 */

/** Pointer travel around the mark that doesn't scroll. */
const DEAD_ZONE = 12;

let active: (() => void) | null = null;

/** The nearest thing at or above `from` that scrolls vertically and has somewhere to go. */
function scrollerAt(from: Element | null): HTMLElement | null {
  for (let el = from; el && el !== document.body; el = el.parentElement) {
    // The canvas scrolls (its pans are scroll offsets), but it pans by dragging, not this.
    if (el.classList.contains("canvas-scroller")) return null;
    if (!(el instanceof HTMLElement) || el.scrollHeight <= el.clientHeight + 1) continue;
    const y = getComputedStyle(el).overflowY;
    if (y === "auto" || y === "scroll" || y === "overlay") return el;
  }
  return null;
}

/** Start autoscrolling what's under (x, y), from `from` up. False when nothing there scrolls. */
export function startAutoscroll(from: Element | null, x: number, y: number): boolean {
  if (from?.closest("a[href]")) return false; // a middle click on a link is the link's
  const el = scrollerAt(from);
  if (!el) return false;
  active?.();

  const mark = document.createElement("div");
  mark.className = "autoscroll-mark";
  mark.style.left = `${x}px`;
  mark.style.top = `${y}px`;
  mark.innerHTML =
    '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M12 4l-4 5h8z"/><circle cx="12" cy="12" r="1.6"/><path d="M12 20l-4-5h8z"/></svg>';
  document.body.append(mark);
  const root = document.documentElement;
  root.classList.add("autoscrolling");

  let pointerY = y;
  let last = performance.now();
  let frame = 0;
  const tick = (now: number) => {
    const dt = Math.min(50, now - last) / 1000;
    last = now;
    const d = pointerY - y;
    const past = Math.abs(d) - DEAD_ZONE;
    // px/s grows a little faster than the distance, so a long reach races through a transcript.
    if (past > 0) el.scrollTop += Math.sign(d) * Math.pow(past, 1.2) * 3 * dt;
    root.dataset.autoscroll = past > 0 ? (d < 0 ? "up" : "down") : "";
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);

  const onMove = (e: PointerEvent) => {
    pointerY = e.clientY;
  };
  // The press that ends it is spent on that, like the browser's: it clicks nothing.
  const onPress = (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const swallow = (ev: Event) => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    window.addEventListener("auxclick", swallow, { capture: true, once: true });
    window.addEventListener("pointerup", () => setTimeout(() => {
      window.removeEventListener("click", swallow, true);
      window.removeEventListener("auxclick", swallow, true);
    }), { capture: true, once: true });
    stop();
  };
  const stop = () => {
    cancelAnimationFrame(frame);
    mark.remove();
    root.classList.remove("autoscrolling");
    delete root.dataset.autoscroll;
    window.removeEventListener("pointermove", onMove, true);
    window.removeEventListener("pointerdown", onPress, true);
    window.removeEventListener("wheel", stop, true);
    window.removeEventListener("keydown", stop, true);
    window.removeEventListener("blur", stop);
    if (active === stop) active = null;
  };
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerdown", onPress, true);
  window.addEventListener("wheel", stop, true);
  window.addEventListener("keydown", stop, true);
  window.addEventListener("blur", stop);
  active = stop;
  return true;
}
