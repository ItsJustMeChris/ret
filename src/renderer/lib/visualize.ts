export interface VisualizationRef {
  path: string;
  title?: string;
  wide: boolean;
}

export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "viz"; viz: VisualizationRef }
  /** A visualization reference still streaming in. */
  | { kind: "pending" };

/**
 * Codex embeds rich content as private-use "content references": U+E200 <kind> U+E202 <payload> U+E201,
 * e.g. `\uE200visualize\uE202{"path":"/…/chart.html"}\uE201`. Codex Desktop swaps them for widgets;
 * as plain text they show up as tofu boxes around the raw JSON.
 */
const START = "\uE200";
const SEP = "\uE202";
const END = "\uE201";
const REF = /\uE200([^\uE200-\uE202]*)\uE202([^\uE200-\uE202]*)\uE201/g;

function parseViz(json: string): VisualizationRef | null {
  try {
    const v = JSON.parse(json);
    if (!v || typeof v.path !== "string" || !v.path) return null;
    return { path: v.path, title: typeof v.title === "string" ? v.title : undefined, wide: v.mode === "wide" };
  } catch {
    return null;
  }
}

/**
 * Splits an agent message around its content references. Visualizations become their own parts;
 * kinds Ret doesn't render are dropped rather than shown as raw markers.
 */
export function splitContentRefs(text: string, streaming: boolean): MessagePart[] {
  if (!text.includes(START)) return [{ kind: "text", text }];
  const parts: MessagePart[] = [];
  let buf = "";
  const flush = () => {
    if (buf.trim()) parts.push({ kind: "text", text: buf });
    buf = "";
  };
  let last = 0;
  for (const m of text.matchAll(REF)) {
    buf += text.slice(last, m.index);
    last = m.index + m[0].length;
    const viz = m[1] === "visualize" ? parseViz(m[2]) : null;
    if (viz) {
      flush();
      parts.push({ kind: "viz", viz });
    }
  }
  let rest = text.slice(last);
  // A reference cut off mid-stream: hold it back instead of flashing its raw payload.
  const open = rest.lastIndexOf(START);
  if (open >= 0 && !rest.includes(END, open)) {
    const kind = rest.slice(open + 1).split(SEP)[0];
    rest = rest.slice(0, open);
    buf += rest;
    if (streaming && "visualize".startsWith(kind.slice(0, 9)) && kind.length <= 9) {
      flush();
      parts.push({ kind: "pending" });
    }
  } else buf += rest;
  flush();
  return parts;
}
