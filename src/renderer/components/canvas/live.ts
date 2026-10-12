/**
 * Window rects that are mid-gesture. Dragging and resizing write straight to the DOM
 * (no React renders), so anything drawn relative to windows — fork links — listens
 * here to follow along and falls back to the stored rect otherwise.
 */
export type Rect = { x: number; y: number; w: number; h: number };

const rects = new Map<string, Rect>();
const listeners = new Set<(winId: string) => void>();

export function setLiveRect(winId: string, rect: Rect | null) {
  if (rect) rects.set(winId, rect);
  else rects.delete(winId);
  for (const l of listeners) l(winId);
}

export function liveRect(winId: string): Rect | undefined {
  return rects.get(winId);
}

export function onLiveRect(fn: (winId: string) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
