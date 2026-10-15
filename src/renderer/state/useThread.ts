import { createContext, useCallback, useContext, useRef, useSyncExternalStore } from "react";
import { useThreads, type ThreadsState } from "./threads";

/**
 * Store subscriptions scoped to one thread.
 *
 * `useThreads(selector)` runs its selector on every store update, and a streamed token is a store
 * update: with a board of big transcripts that's thousands of selectors (one per turn and item in
 * every window) for each frame of text. `useThread(threadId, selector)` only runs when that thread's
 * own entries change, so streaming into one thread costs nothing in the others.
 *
 * Selectors given to it must only read that thread's entries (`s.live[threadId]`,
 * `s.threads[threadId]`…) and `s.requests`; anything else belongs in `useThreads`.
 */

type Listener = () => void;

/** The store's per-thread maps: a change to one thread's entry concerns that thread's subscribers only. */
const KEYED = ["threads", "owner", "live", "unread", "external", "background", "queued", "visible", "attended"] as const;

const subs = new Map<string, Set<Listener>>();

useThreads.subscribe((s, prev) => {
  let changed: (typeof KEYED)[number][] | null = null;
  for (const k of KEYED) if (s[k] !== prev[k]) (changed ??= []).push(k);
  // Requests are keyed by request, not thread: any change may concern anyone (and they're rare).
  const everyone = s.requests !== prev.requests;
  if (!changed && !everyone) return;
  for (const [id, set] of subs) {
    if (!everyone && !changed!.some((k) => (s[k] as Record<string, unknown>)[id] !== (prev[k] as Record<string, unknown>)[id])) continue;
    for (const l of set) l();
  }
});

function listen(threadId: string, l: Listener) {
  let set = subs.get(threadId);
  if (!set) subs.set(threadId, (set = new Set()));
  set.add(l);
  return () => {
    set.delete(l);
    if (!set.size && subs.get(threadId) === set) subs.delete(threadId);
  };
}

// ---------------------------------------------------------------------------
// Freezing: a canvas window that's off screen (or covered by its zoomed-out card) stops following
// the store. Its view keeps what it last showed, catches up now and then when the app is idle, and
// all at once when it comes back into view. While the canvas is panned or zoomed, or a window
// dragged or resized, every window holds still the same way and catches up when the gesture ends:
// a reply streaming into a window costs a layout and repaint of the canvas each time it grows,
// which a moving canvas can't fit into its frames.
//
// A view kept built while another shows (a mode, a tab: see Kept) freezes the same way, and so does
// everything in it: a gate inside another follows it, and catches up when it's let go.
// ---------------------------------------------------------------------------

/** Least time between two idle catch-ups of the same frozen view, and the most one waits for a quiet moment. */
const THAW_EVERY = 2000;
const THAW_WAIT = 3000;

/** Every canvas window's gate, and what's holding them all still (a pan, a drag…). */
const gates = new Set<FreezeGate>();
const holds = new Set<string>();

export class FreezeGate {
  /** Whether the view should be frozen (off screen, under a card). */
  private want = false;
  /** Whether it is right now, by itself (a frozen view thaws briefly to catch up; a gesture holds it). */
  private own = false;
  private stale = false;
  private staleSince = 0;
  private lastThaw = 0;
  private listeners = new Set<Listener>();

  /**
   * `idle`: catch up now and then while frozen. Without it, a view only catches up when it's unfrozen.
   * `parent`: the gate of the view this one is in, which freezes it too (see `follow`).
   */
  constructor(
    private readonly idle = true,
    private readonly parent: FreezeGate | null = null,
  ) {}

  /** Whether the view holds still right now: frozen itself, or the view it's in is. */
  get frozen(): boolean {
    return this.own || !!this.parent?.frozen;
  }

  /** Join the canvas (gestures hold it still) and follow the view it's in; returns the leave. */
  connect() {
    gates.add(this);
    if (holds.size) this.own = true;
    const unfollow = this.follow();
    return () => {
      gates.delete(this);
      stale.delete(this);
      unfollow();
    };
  }

  /** Catch up when the view it's in is let go; returns the stop. */
  follow() {
    return this.parent?.subscribe(() => this.parentReleased()) ?? (() => {});
  }

  /** Gestures on the canvas hold its windows' gates only. */
  private held() {
    return holds.size > 0 && gates.has(this);
  }

  private parentReleased() {
    if (this.frozen) {
      // Still frozen itself: back to catching up when idle, if that's what it does.
      if (this.stale && this.want && this.idle) {
        stale.add(this);
        scheduleThaw();
      }
      return;
    }
    if (!this.stale) return;
    this.stale = false;
    this.release();
  }

  subscribe(l: Listener) {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  }

  set(frozen: boolean) {
    if (frozen === this.want) return;
    this.want = frozen;
    if (frozen) {
      this.own = true;
      return;
    }
    stale.delete(this);
    if (this.held()) return; // catches up when the gesture ends
    if (this.parent?.frozen) {
      this.own = false; // catches up when the view it's in is let go
      return;
    }
    this.stale = false;
    this.release();
  }

  /** Something it shows changed while it was frozen. */
  markStale() {
    if (this.stale || !this.frozen) return;
    this.stale = true;
    this.staleSince = performance.now();
    if (!this.want || !this.idle || this.parent?.frozen) return; // catches up when it's let go
    stale.add(this);
    scheduleThaw();
  }

  /** Thaw just long enough to render what changed (React renders store updates in a microtask). */
  thaw() {
    if (!this.want || this.held() || this.parent?.frozen) return;
    this.stale = false;
    this.lastThaw = performance.now();
    this.release();
    setTimeout(() => {
      if (this.want || this.held()) this.own = true;
    });
  }

  due(now: number) {
    return now - this.lastThaw >= THAW_EVERY;
  }

  /** Waited long enough for a quiet moment: catch up regardless. */
  overdue(now: number) {
    return now - this.staleSince >= THAW_WAIT;
  }

  hold() {
    this.own = true;
  }

  /** The gesture is over: show what changed meanwhile (or go back to waiting for an idle moment). */
  unhold() {
    if (this.want) {
      if (this.stale && this.idle && !this.parent?.frozen) {
        stale.add(this);
        scheduleThaw();
      }
      return;
    }
    // Nothing it shows changed: nothing to re-render. (Or the view it's in is frozen: it catches up then.)
    if (!this.stale || this.parent?.frozen) {
      this.own = false;
      return;
    }
    this.stale = false;
    this.release();
  }

  private release() {
    this.own = false;
    for (const l of this.listeners) l();
  }
}

/** Whether a gesture is holding the canvas windows' views still. */
export const viewsHeld = () => holds.size > 0;

/** Hold every canvas window's view still for `reason` (a gesture in progress), or let go. */
export function holdViews(reason: string, on: boolean) {
  const was = holds.size > 0;
  if (on) holds.add(reason);
  else holds.delete(reason);
  const now = holds.size > 0;
  if (now === was) return;
  for (const g of gates) {
    if (now) g.hold();
    else g.unhold();
  }
}

const stale = new Set<FreezeGate>();
let idle = 0;
let wait = 0;

function scheduleThaw() {
  if (idle || wait || !stale.size) return;
  idle = requestIdleCallback(thawOne, { timeout: 1000 });
}

/**
 * One view per idle period: a catch-up is a render, and an input arriving during it waits. It waits
 * for an idle period with room for one, but not past THAW_WAIT (a busy app may never have one).
 */
function thawOne(deadline: IdleDeadline) {
  idle = 0;
  if (holds.size) {
    wait = window.setTimeout(() => {
      wait = 0;
      scheduleThaw();
    }, 500);
    return;
  }
  const now = performance.now();
  let next: FreezeGate | null = null;
  for (const g of stale) {
    if (g.due(now)) {
      next = g;
      break;
    }
  }
  if (!next) {
    wait = window.setTimeout(() => {
      wait = 0;
      scheduleThaw();
    }, 500);
    return;
  }
  if (deadline.timeRemaining() < 4 && !deadline.didTimeout && !next.overdue(now)) return scheduleThaw();
  stale.delete(next);
  next.thaw();
  scheduleThaw();
}

export const FreezeContext = createContext<FreezeGate | null>(null);

/**
 * `selector` over the store, re-run only when `threadId`'s entries (or the pending requests) change.
 * Results that `equal` the last one are returned as the last one (pass `shallowEqual` for arrays).
 */
export function useThread<T>(threadId: string, selector: (s: ThreadsState) => T, equal: (a: T, b: T) => boolean = Object.is): T {
  const gate = useContext(FreezeContext);
  const last = useRef<{ v: T } | null>(null);
  const subscribe = useCallback(
    (cb: Listener) => {
      const off = listen(threadId, gate ? () => (gate.frozen ? gate.markStale() : cb()) : cb);
      const offGate = gate?.subscribe(cb);
      return () => {
        off();
        offGate?.();
      };
    },
    [threadId, gate],
  );
  const get = () => {
    const c = last.current;
    if (c && gate?.frozen) return c.v;
    const v = selector(useThreads.getState());
    if (c && equal(c.v, v)) return c.v;
    last.current = { v };
    return v;
  };
  return useSyncExternalStore(subscribe, get);
}
