import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

const DELAY = 450;

/**
 * App-wide styled tooltips. Any element with a `title` gets a themed tooltip instead of the
 * native OS one: on hover the title moves to `data-tip` (so the browser never shows it).
 * React only rewrites `title` when the prop changes, so this stays in sync without extra work.
 */
export function TooltipHost() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; below: boolean } | null>(null);

  useEffect(() => {
    let timer = 0;
    let current: Element | null = null;

    const hide = () => {
      clearTimeout(timer);
      current = null;
      setTip(null);
    };

    const onOver = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.("[title], [data-tip]");
      if (el === current) return;
      hide();
      if (!el) return;
      const native = el.getAttribute("title");
      if (native !== null) {
        el.removeAttribute("title");
        if (native) el.setAttribute("data-tip", native);
        else el.removeAttribute("data-tip");
        // Icon-only buttons relied on title for their accessible name; keep it.
        if (native && !el.hasAttribute("aria-label") && !el.textContent?.trim()) el.setAttribute("aria-label", native);
      }
      const text = el.getAttribute("data-tip");
      if (!text) return;
      current = el;
      timer = window.setTimeout(() => {
        if (current !== el || !el.isConnected) return;
        const r = el.getBoundingClientRect();
        const below = r.top < 48;
        setTip({ text, x: r.left + r.width / 2, y: below ? r.bottom + 6 : r.top - 6, below });
      }, DELAY);
    };

    const onOut = (e: PointerEvent) => {
      if (current && !current.contains(e.relatedTarget as Node | null)) hide();
    };

    window.addEventListener("pointerover", onOver, true);
    window.addEventListener("pointerout", onOut, true);
    window.addEventListener("pointerdown", hide, true);
    window.addEventListener("keydown", hide, true);
    window.addEventListener("wheel", hide, { capture: true, passive: true });
    window.addEventListener("blur", hide);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pointerover", onOver, true);
      window.removeEventListener("pointerout", onOut, true);
      window.removeEventListener("pointerdown", hide, true);
      window.removeEventListener("keydown", hide, true);
      window.removeEventListener("wheel", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  if (!tip) return null;
  return createPortal(
    <div className={`tooltip ${tip.below ? "below" : ""}`} style={{ left: tip.x, top: tip.y }} role="tooltip">
      {tip.text}
    </div>,
    document.body,
  );
}
