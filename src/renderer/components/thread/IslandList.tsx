import { Children, createContext, isValidElement, useContext, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { FreezeContext, FreezeGate } from "../../state/useThread";

/** The Dynamic Island's motion, told when a list in it changes (see DynamicIsland). */
export const IslandContext = createContext<{ changed: () => void } | null>(null);

interface Item {
  key: string;
  el: ReactElement;
  leaving: boolean;
}

/**
 * Parts of the Dynamic Island that come and go: each in a box of its own (`.island-part`, which the
 * island slides to its new place when the others move). A new one fades in; one that's gone stays
 * a moment, out of the flow where it was so the rest close up around it, and fades out. With
 * `freeze` one that's leaving holds still on what it last showed, its data being gone by then.
 *
 * A leaving one keeps to the top of its section (a row: rows move with their section's top), or
 * with `bottom` to the bottom of the island (a section: they stand on the composer).
 */
export function IslandList({ className, freeze, bottom, children }: { className: string; freeze?: boolean; bottom?: boolean; children: ReactNode }) {
  const island = useContext(IslandContext);
  const gate = useContext(FreezeContext);
  const [still] = useState(stillGate);
  const box = useRef<HTMLDivElement>(null);
  const shown = useRef<Item[]>([]);
  const shape = useRef("");
  const left = useRef(new Set<string>());
  const mounted = useRef(false);
  const [, rerender] = useState(0);
  const items = merge(shown.current, Children.toArray(children).filter(isValidElement), left.current);

  useLayoutEffect(() => {
    shown.current = items;
    left.current.clear();
    mounted.current = true;
    const now = items.map((it) => (it.leaving ? "-" : "+") + it.key).join();
    if (now === shape.current) return;
    shape.current = now;
    // One that's started leaving goes out of the flow where it is (all measured, then all moved), in
    // the positioned box it's in: the island's body for a section, the section for a row. That's
    // outside a tray that scrolls, so it doesn't add to what the tray scrolls (and flash a scrollbar).
    // (Out of the document, a canvas window off screen catching up, there's no where: it fades in place.)
    const parts = Array.from(box.current!.children) as HTMLElement[];
    for (const p of parts) if (p.style.position && !p.classList.contains("leaving")) p.style.cssText = "";
    const going = parts.filter((p) => p.classList.contains("leaving") && !p.style.position && p.offsetParent);
    const spots = going.map((p) => {
      const at = p.offsetParent as HTMLElement;
      let y = p.offsetTop;
      for (let e = p.parentElement; e && e !== at; e = e.parentElement) y -= e.scrollTop;
      return [p.offsetLeft, p.offsetWidth, bottom ? at.clientHeight - y - p.offsetHeight : y];
    });
    going.forEach((p, i) => {
      const [x, w, y] = spots[i];
      p.style.cssText = `position: absolute; left: ${x}px; width: ${w}px; ${bottom ? "bottom" : "top"}: ${y}px`;
    });
    island?.changed();
  });

  return (
    <div ref={box} className={className}>
      {items.map((it) => (
        <Part
          key={it.key}
          leaving={it.leaving}
          arrive={mounted.current}
          onLeft={() => {
            left.current.add(it.key);
            rerender((n) => n + 1);
          }}
        >
          {freeze ? <FreezeContext.Provider value={it.leaving ? still : gate}>{it.el}</FreezeContext.Provider> : it.el}
        </Part>
      ))}
    </div>
  );
}

/** A gate that's shut for good: what's under it shows what it last did. */
function stillGate() {
  const g = new FreezeGate(false);
  g.set(true);
  return g;
}

/** `arrive`: it's new to a list already showing, so it fades in (once: not again each time its view is put back). */
function Part({ leaving, arrive, onLeft, children }: { leaving: boolean; arrive: boolean; onLeft: () => void; children: ReactNode }) {
  const [arriving, setArriving] = useState(arrive);
  return (
    <div
      className={`island-part${arriving ? " arrive" : ""}${leaving ? " leaving" : ""}`}
      inert={leaving}
      onAnimationEnd={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.animationName === "island-in") setArriving(false);
        else if (e.animationName === "island-out") onLeft();
      }}
    >
      {children}
    </div>
  );
}

/** `next` in its order, with those gone since `prev` (and not done leaving) kept where they were. */
function merge(prev: Item[], next: ReactElement[], left: Set<string>): Item[] {
  const keys = new Set(next.map((e) => e.key));
  const out: Item[] = [];
  const seen = new Set<string>();
  let j = 0;
  const take = (e: ReactElement) => {
    seen.add(e.key!);
    out.push({ key: e.key!, el: e, leaving: false });
  };
  for (const p of prev) {
    if (!keys.has(p.key)) {
      if (!left.has(p.key)) out.push(p.leaving ? p : { ...p, leaving: true });
      continue;
    }
    if (seen.has(p.key)) continue;
    // The new ones before it, then it.
    while (j < next.length) {
      const e = next[j++];
      if (!seen.has(e.key!)) take(e);
      if (e.key === p.key) break;
    }
  }
  for (; j < next.length; j++) if (!seen.has(next[j].key!)) take(next[j]);
  return out;
}
