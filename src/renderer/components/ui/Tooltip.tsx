import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CARD_TARGETS } from "../HoverCards";

const DELAY = 450;

/** Longer than this is a paragraph, not a tooltip. */
const MAX_CHARS = 280;

/** Marks an aria-label set here from a title (not one a component chose), which follows later titles. */
const OWN_LABEL = "data-tip-label";

/** Move a native `title` to `data-tip`, so only our styled tooltip ever shows. */
function adopt(el: Element) {
  const native = el.getAttribute("title");
  if (native === null) return;
  el.removeAttribute("title");
  if (native) el.setAttribute("data-tip", native);
  else el.removeAttribute("data-tip");
  // Icon-only buttons relied on title for their accessible name; keep it, and keep it current
  // (a status dot's title changes with its state).
  if (el.hasAttribute(OWN_LABEL)) {
    if (native) el.setAttribute("aria-label", native);
    else {
      el.removeAttribute("aria-label");
      el.removeAttribute(OWN_LABEL);
    }
  } else if (native && !el.hasAttribute("aria-label") && !el.textContent?.trim()) {
    el.setAttribute("aria-label", native);
    el.setAttribute(OWN_LABEL, "");
  }
}

const clip = (text: string) => (text.length > MAX_CHARS ? text.slice(0, MAX_CHARS).replace(/\s+\S*$/, "") + "…" : text);

/**
 * App-wide styled tooltips. Any element with a `title` gets a themed tooltip instead of the
 * native OS one. Titles are adopted the moment they appear in the DOM (React re-setting a
 * changed title included), so the browser's own tooltip never gets a chance to show. Things
 * with a richer hover card (links, files, threads…) get no plain tooltip on top of it.
 */
export function TooltipHost() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number; below: boolean } | null>(null);

  useEffect(() => {
    let timer = 0;
    let current: Element | null = null;
    let shownText: string | null = null;

    const hide = () => {
      clearTimeout(timer);
      current = null;
      shownText = null;
      setTip(null);
    };

    const place = (el: Element, text: string) => {
      const r = el.getBoundingClientRect();
      const below = r.top < 48;
      shownText = text;
      setTip({ text: clip(text), x: r.left + r.width / 2, y: below ? r.bottom + 6 : r.top - 6, below });
    };

    document.querySelectorAll("[title]").forEach(adopt);
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "attributes") adopt(r.target as Element);
        else
          for (const n of r.addedNodes) {
            if (n.nodeType !== 1) continue;
            adopt(n as Element);
            (n as Element).querySelectorAll("[title]").forEach(adopt);
          }
      }
      // A tooltip that's up follows its element's text (e.g. a countdown).
      if (current && shownText !== null) {
        const text = current.isConnected ? current.getAttribute("data-tip") : null;
        if (!text) hide();
        else if (text !== shownText) place(current, text);
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["title", "data-tip"] });

    const onOver = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.("[title], [data-tip]");
      if (el === current) return;
      hide();
      if (!el) return;
      adopt(el);
      // Inside a hover-card target the card says it all.
      if (el.closest(CARD_TARGETS)) return;
      const text = el.getAttribute("data-tip");
      if (!text) return;
      current = el;
      timer = window.setTimeout(() => {
        if (current !== el || !el.isConnected) return;
        place(el, el.getAttribute("data-tip") ?? text);
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
      observer.disconnect();
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
