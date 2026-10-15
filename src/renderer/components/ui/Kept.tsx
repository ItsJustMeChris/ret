import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FreezeContext, FreezeGate } from "../../state/useThread";

/**
 * Whether a view is on screen: false in one kept built while another shows (see Kept). An object to
 * ask and listen to rather than a context value, so a mode switch re-renders only what depends on it,
 * not every window on the canvas.
 */
export class Visibility {
  private own = true;
  private listeners = new Set<() => void>();

  constructor(private readonly parent: Visibility | null = null) {}

  get shown(): boolean {
    return this.own && (this.parent?.shown ?? true);
  }

  set(shown: boolean) {
    if (shown === this.own) return;
    this.own = shown;
    this.notify();
  }

  /** Follow the view it's in; returns the stop. */
  follow() {
    return this.parent?.subscribe(() => this.notify()) ?? (() => {});
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  private notify() {
    for (const l of [...this.listeners]) l();
  }
}

const ALWAYS = new Visibility();

/** How long a view you've just left stays in the page, its rendering skipped, before it leaves the document. */
const LINGER_MS = 60_000;
const VisibilityContext = createContext(ALWAYS);

/** The view's visibility, to ask (`.shown`) when something happens: no re-render when it changes. */
export const useVisibility = () => useContext(VisibilityContext);

/** Whether the view is on screen, re-rendering when that changes. With `watch` false, it's taken as shown and nothing is watched. */
export function useShown(watch = true): boolean {
  const v = useVisibility();
  return useSyncExternalStore(watch ? v.subscribe : noSubscribe, () => !watch || v.shown);
}
const noSubscribe = () => () => {};

/**
 * A view kept built while it isn't shown (a mode you've left, a tab you've switched from), so going
 * back to it puts it back in the page rather than building it again: a long transcript or a board of
 * windows takes a few hundred milliseconds to build, and a moment to put back.
 *
 * Hidden, it's frozen (it stops following the store, and catches up when it's back). For a little
 * while it stays in the page, under the view that shows, with its rendering skipped and its
 * animations paused, so going straight back costs about a frame; then it leaves the document
 * (nothing of it to style, lay out or walk, as with the canvas's windows), and going back lays it
 * out again. Where its scrollers were scrolled and what had the keyboard come back with it. Inside it, `useVisibility`
 * says whether it's on screen: what only the view you're looking at should do (take keys, count as
 * read) checks it.
 */
export function Kept({ shown, className, children }: { shown: boolean; className?: string; children: ReactNode }) {
  const parent = useVisibility();
  const [visibility] = useState(() => new Visibility(parent));
  const parentGate = useContext(FreezeContext);
  const [gate] = useState(() => new FreezeGate(false, parentGate));
  const [host] = useState(() => {
    const el = document.createElement("div");
    el.className = className ? `kept ${className}` : "kept";
    return el;
  });
  const slot = useRef<HTMLDivElement | null>(null);
  const shownNow = useRef(shown);
  shownNow.current = shown;
  // Shown from the start, it's in the page before what's in it runs its layout effects (a child's
  // run before its parent's): those that measure, or set a scroll offset, need it there.
  const place = useCallback(
    (el: HTMLDivElement | null) => {
      slot.current = el;
      if (el && shownNow.current && !host.isConnected) el.append(host);
    },
    [host],
  );
  /** Out of the document, scrollers forget their offsets: those it had, by element. */
  const scrolls = useRef(new Map<Element, [number, number]>());
  const focus = useRef<HTMLElement | null>(null);
  const linger = useRef(0);
  /** Its animations, paused while it lingers: one running in skipped content has Chrome make a frame on every vsync. */
  const paused = useRef<Animation[]>([]);
  useLayoutEffect(() => () => clearTimeout(linger.current), []);

  useLayoutEffect(() => gate.follow(), [gate]);
  useLayoutEffect(() => visibility.follow(), [visibility]);
  useLayoutEffect(() => {
    // Scroll events don't bubble, but they do pass by on their way down (capture).
    const onScroll = (e: Event) => {
      const t = e.target;
      // Those that put back their own offsets (the canvas, transcripts) say so.
      if (t instanceof HTMLElement && !t.dataset.ownScroll) scrolls.current.set(t, [t.scrollLeft, t.scrollTop]);
    };
    host.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => host.removeEventListener("scroll", onScroll, { capture: true });
  }, [host]);

  useLayoutEffect(() => {
    if (!shown) {
      const active = document.activeElement;
      focus.current = active instanceof HTMLElement && host.contains(active) ? active : null;
      focus.current?.blur();
      // For a while it stays in the page with its rendering skipped (content-visibility), so going
      // straight back finds it laid out; then it leaves the document.
      if (host.isConnected) {
        paused.current = host.getAnimations({ subtree: true }).filter((a) => a.playState === "running");
        for (const a of paused.current) a.pause();
        host.setAttribute("data-away", "");
        clearTimeout(linger.current);
        linger.current = window.setTimeout(() => {
          // Out of the document, CSS animations end (and start again when it's back).
          paused.current = [];
          host.remove();
          host.removeAttribute("data-away");
        }, LINGER_MS);
      }
    } else {
      clearTimeout(linger.current);
      if (host.hasAttribute("data-away")) {
        host.removeAttribute("data-away");
        for (const a of paused.current) if (a.playState === "paused") a.play();
        paused.current = [];
      } else if (!host.isConnected) {
        slot.current!.append(host);
        for (const [el, [left, top]] of scrolls.current) {
          if (!host.contains(el)) scrolls.current.delete(el);
          else if (el.scrollLeft !== left || el.scrollTop !== top) el.scrollTo(left, top);
        }
      }
      const f = focus.current;
      focus.current = null;
      // Unless something else took the keyboard meanwhile.
      if (f && host.contains(f) && (!document.activeElement || document.activeElement === document.body)) f.focus({ preventScroll: true });
    }
    gate.set(!shown);
    visibility.set(shown);
  }, [shown, host, gate, visibility]);

  // The portal comes after the slot (not in it): siblings' layout effects run in order, so the slot's ref has placed the host by then.
  return (
    <>
      <div ref={place} className="kept-slot" />
      {createPortal(
        <FreezeContext.Provider value={gate}>
          <VisibilityContext.Provider value={visibility}>{children}</VisibilityContext.Provider>
        </FreezeContext.Provider>,
        host,
      )}
    </>
  );
}

/**
 * What `current` has been lately, newest first and at most `max` of them, for the views to keep built:
 * those `keep` still allows (a tab that's still open, say).
 */
export function useRecent(current: string | null, max: number, keep: (id: string) => boolean = () => true): string[] {
  const list = useRef<string[]>([]);
  const next = [...(current ? [current] : []), ...list.current.filter((id) => id !== current && keep(id))].slice(0, max);
  if (next.length !== list.current.length || next.some((id, i) => id !== list.current[i])) list.current = next;
  return list.current;
}
