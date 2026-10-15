import { useRef } from "react";

/**
 * Same items (arrays) or same own values (plain objects), compared with Object.is.
 * zustand's own `shallow` compares arrays by building a Map of each one's entries, which costs
 * more than the selectors it guards when they run on every streamed token.
 */
export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b) || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (a instanceof Map || a instanceof Set) {
    const m = b as Map<unknown, unknown> | Set<unknown>;
    if (a.size !== m.size) return false;
    if (a instanceof Set) {
      for (const v of a) if (!m.has(v)) return false;
      return true;
    }
    for (const [k, v] of a) if (!m.has(k) || !Object.is(v, (m as Map<unknown, unknown>).get(k))) return false;
    return true;
  }
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k) || !Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

/** A selector that keeps returning its last result while the next one is shallowly equal (drop-in for zustand's useShallow). */
export function useShallow<S, T>(selector: (state: S) => T): (state: S) => T {
  const prev = useRef<T>(undefined as T);
  return (state) => {
    const next = selector(state);
    return shallowEqual(prev.current, next) ? prev.current : (prev.current = next);
  };
}
