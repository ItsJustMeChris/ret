import { useLayoutEffect, useState, type RefObject } from "react";

export type SizeClass = "glance" | "compact" | "regular" | "wide";

export function classify(w: number, h: number): SizeClass {
  if (w < 300 || h < 230) return "glance";
  if (w < 520) return "compact";
  if (w >= 1100 && h >= 500) return "wide";
  return "regular";
}

/**
 * Structural size class for adaptive layouts (fine-grained styling uses CSS container queries).
 * `initial` is the class it most likely has, for a view that's built before it's first shown.
 */
export function useSizeClass(ref: RefObject<HTMLElement | null>, initial: SizeClass = "regular"): SizeClass {
  const [size, setSize] = useState<SizeClass>(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      // Out of the document (a canvas window's view while it's off screen) it measures 0×0: keep what it was.
      if (!el.isConnected || (!width && !height)) return;
      const next = classify(width, height);
      setSize((prev) => (prev === next ? prev : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}
