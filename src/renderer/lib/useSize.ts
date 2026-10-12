import { useLayoutEffect, useState, type RefObject } from "react";

export type SizeClass = "glance" | "compact" | "regular" | "wide";

export function classify(w: number, h: number): SizeClass {
  if (w < 300 || h < 230) return "glance";
  if (w < 520) return "compact";
  if (w >= 1100 && h >= 500) return "wide";
  return "regular";
}

/** Structural size class for adaptive layouts (fine-grained styling uses CSS container queries). */
export function useSizeClass(ref: RefObject<HTMLElement | null>): SizeClass {
  const [size, setSize] = useState<SizeClass>("regular");
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      const next = classify(width, height);
      setSize((prev) => (prev === next ? prev : next));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}
