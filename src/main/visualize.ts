import { lstat, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { VisualizationResult } from "../shared/bridge";

/**
 * Codex's visualize skill answers with a content reference pointing at an HTML fragment.
 * Codex Desktop wraps that fragment in the skill's own runtime (theme CSS, widgets, host bridge)
 * inside a sandboxed frame; this builds the same frame document from the installed skill, mirroring
 * the skill's scripts/render.py, so visuals look the way the model designed them.
 */

const MAX_FRAGMENT_BYTES = 1_000_000;
const FRAGMENT_PLACEHOLDER = "<!--__INLINE_VISUALIZATION_FRAGMENT__-->";
const DOCUMENT_MARKUP = /<!doctype\s|<\s*(?:html|head|body)(?:\s|>)/i;

const RESOURCE_SOURCES = [
  "blob:",
  "data:",
  "https://cdnjs.cloudflare.com",
  "https://cdn.jsdelivr.net",
  "https://esm.sh",
  "https://fonts.bunny.net",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
  "https://unpkg.com",
].join(" ");
const FRAME_CSP = [
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' ${RESOURCE_SOURCES}`,
  `style-src 'unsafe-inline' ${RESOURCE_SOURCES}`,
  `img-src ${RESOURCE_SOURCES}`,
  `font-src ${RESOURCE_SOURCES}`,
  `media-src ${RESOURCE_SOURCES}`,
  "worker-src blob:",
  "connect-src blob: data:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const codexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");

function compareVersions(a: string, b: string) {
  const pa = a.split(/[.-]/).map((n) => Number(n) || 0);
  const pb = b.split(/[.-]/).map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Assets dir of the newest installed visualize skill, e.g. ~/.codex/plugins/cache/openai-bundled/visualize/1.0.49/skills/visualize/assets. */
async function skillAssets(): Promise<string | null> {
  const root = join(codexHome(), "plugins", "cache", "openai-bundled", "visualize");
  let versions: string[];
  try {
    versions = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return null;
  }
  for (const v of versions.sort(compareVersions).reverse()) {
    const dir = join(root, v, "skills", "visualize", "assets");
    try {
      await lstat(join(dir, "visualize.html"));
      return dir;
    } catch {
      /* try an older one */
    }
  }
  return null;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const scriptSafe = (s: string) => s.replaceAll("</script", "<\\/script");

function defaultTitle(path: string) {
  const stem = path.split(/[\\/]/).pop()!.replace(/\.html?$/i, "");
  return stem.split(/[-_\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") || "Visualization";
}

/**
 * Builds the frame document for a fragment. The widget-state bootstrap is left as
 * `__CODEX_VISUALIZATION_WIDGET_STATE__` for the renderer to fill, as Codex's own shell does.
 */
export async function renderVisualization(path: string, title?: string): Promise<VisualizationResult> {
  if (typeof path !== "string" || !isAbsolute(path) || !/\.html?$/i.test(path)) {
    return { error: "Not an absolute path to an .html fragment" };
  }
  try {
    const st = await lstat(path);
    if (!st.isFile()) return { error: "Not a regular file" };
    if (st.size > MAX_FRAGMENT_BYTES) return { error: "Visualization is larger than 1 MB" };
  } catch {
    return { error: "File not found" };
  }
  const fragment = await readFile(path, "utf8");
  if (DOCUMENT_MARKUP.test(fragment)) return { error: "Expected an HTML fragment, not a full document" };

  const assets = await skillAssets();
  if (!assets) return { error: "Codex's visualize skill isn't installed, so its runtime can't be loaded" };
  const read = (name: string) => readFile(join(assets, name), "utf8");
  const [stylesheet, kit, hostBridge, calendar] = await Promise.all([
    read("visualize.css"),
    read("visualize.html"),
    read("standalone-host-bridge.js"),
    /\bviz-calendar\b/i.test(fragment) ? read("calendar.js").catch(() => "") : Promise.resolve(""),
  ]);
  const inner = kit.replace(FRAGMENT_PLACEHOLDER, () => (calendar ? `<script>${scriptSafe(calendar)}</script>` : "") + fragment);
  const html = `<!doctype html>
<html lang="en" data-visualize-standalone>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">
<title>${escapeHtml(title || defaultTitle(path))}</title>
<style>${stylesheet}
html>body{padding:0}</style>
</head>
<body>
<script type="application/json" id="codex-visualization-widget-state">__CODEX_VISUALIZATION_WIDGET_STATE__</script>
<script>${scriptSafe(hostBridge)}</script>
${inner}
</body>
</html>
`;
  return { html };
}
