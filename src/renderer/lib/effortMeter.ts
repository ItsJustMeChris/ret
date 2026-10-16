import { useState } from "react";

// The effort meter's workings, shared by the desktop's ModelTuner and the phone's: which way its
// name rolls, how its bars fill one after another, how hot it reads. Each side draws its own bars.

/** 0 at the lightest effort, 1 at the deepest (for colour and glow). */
export const heatOf = (index: number, count: number) => (count > 1 && index >= 0 ? index / (count - 1) : 0);

/** A bar's height between `min` and `max`, rising left to right. */
export const barHeight = (k: number, count: number, min: number, max: number) => min + ((max - min) * k) / Math.max(1, count - 1);

/**
 * How long bar `k` waits before it fills or empties, after the level moved from `from` to `level`:
 * going deeper they fill one after another; going lighter they empty from the top down.
 */
export function fillDelay(k: number, level: number, from: number): number {
  if (level > from && k > from && k <= level) return (k - from - 1) * 45;
  if (level < from && k > level && k <= from) return (from - k) * 35;
  return 0;
}

/** Which way the shown value last moved, for the name's roll: 1 deeper, -1 lighter, 0 not yet. */
export function useRoll(index: number): 1 | -1 | 0 {
  const [seen, setSeen] = useState({ index, dir: 0 as 1 | -1 | 0 });
  if (seen.index === index) return seen.dir;
  const dir = index > seen.index ? 1 : -1;
  setSeen({ index, dir });
  return dir;
}

/** The level before the latest change, for fillDelay. */
export function useFillFrom(level: number): number {
  const [fill, setFill] = useState({ level, from: level });
  if (fill.level === level) return fill.from;
  setFill({ level, from: fill.level });
  return fill.level;
}
