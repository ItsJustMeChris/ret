/**
 * A gesture's cursor everywhere until it ends: a transparent layer over the whole page with that
 * cursor (`.cursor-shield`). The gesture keeps its pointer events by capture or window listeners, so
 * nothing under the layer misses them. (A rule giving every element the cursor, `body.dragging *`,
 * restyled the whole page when a gesture began and again when it ended.) Returns the release.
 */
export function holdCursor(cursor: string): () => void {
  const el = document.createElement("div");
  el.className = "cursor-shield";
  el.style.cursor = cursor;
  document.body.append(el);
  return () => el.remove();
}
