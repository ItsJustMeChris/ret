import { bridge } from "../bridge";
import { toast } from "../state/toasts";

export interface FileRef {
  path: string;
  line?: number;
  col?: number;
}

/**
 * Parses the file references Codex writes in links and code: `C:/a/b.ts`, `/C:/a/b.ts`,
 * `file:///C:/a/b.ts`, `src/b.ts:12`, `src/b.ts:12:4`, `b.ts#L12`. Returns null for URLs.
 */
export function parseFileRef(raw: string): FileRef | null {
  let s = raw.trim();
  if (!s || /^(https?|mailto|vscode|data|javascript):/i.test(s)) return null;
  if (/^file:/i.test(s)) s = s.replace(/^file:\/\/(localhost)?/i, "");
  s = s.replace(/^\/([A-Za-z]:[\\/])/, "$1"); // "/C:/x" → "C:/x"
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null; // some other URL scheme

  let line: number | undefined;
  let col: number | undefined;
  const hash = /#L(\d+)(?:C(\d+))?(?:-L?\d+)?$/.exec(s);
  if (hash) {
    line = Number(hash[1]);
    col = hash[2] ? Number(hash[2]) : undefined;
    s = s.slice(0, hash.index);
  } else {
    const m = /:(\d+)(?::(\d+))?$/.exec(s);
    if (m && !/^[A-Za-z]$/.test(s.slice(0, m.index))) {
      line = Number(m[1]);
      col = m[2] ? Number(m[2]) : undefined;
      s = s.slice(0, m.index);
    }
  }
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep as written */
  }
  return s ? { path: s, line, col } : null;
}

export function isAbsolutePath(p: string) {
  return /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("/") || p.startsWith("\\\\");
}

export function resolvePath(p: string, cwd?: string | null) {
  if (isAbsolutePath(p) || !cwd) return p;
  const sep = cwd.includes("\\") ? "\\" : "/";
  return cwd.replace(/[\\/]+$/, "") + sep + p.replace(/^\.[\\/]/, "").replace(/[\\/]/g, sep);
}

/** Heuristic for inline `code` that names a file: has a separator or an extension, no spaces. */
export function looksLikePath(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 400 || /\s/.test(t) || /^https?:/i.test(t)) return false;
  return /[\\/]/.test(t) || /^[\w.-]+\.[A-Za-z0-9]{1,8}(:\d+)?$/.test(t);
}

/** Files that open as text in an editor (anything else goes to its default app). */
const NOT_TEXT = /\.(png|jpe?g|gif|webp|bmp|ico|svgz|pdf|zip|7z|rar|gz|tgz|tar|exe|dll|so|dylib|bin|msi|iso|dmg|mp3|mp4|mov|wav|ogg|webm|woff2?|ttf|otf|sqlite|db|lnk)$/i;

export const revealLabel =
  bridge.platform === "darwin" ? "Reveal in Finder" : bridge.platform === "win32" ? "Reveal in File Explorer" : "Show in folder";

/**
 * Open a referenced file the way you'd expect: text/code in VS Code at the referenced line
 * (if installed), everything else with its default app. Programs are revealed, never run.
 */
export async function openFileRef(ref: FileRef, cwd?: string | null) {
  const path = resolvePath(ref.path, cwd);
  const st = await bridge.files.stat(path);
  if (!st.exists) {
    toast(`Not found: ${path}`, "error");
    return;
  }
  if (!st.isDir && !NOT_TEXT.test(path) && (await bridge.editor.available())) {
    await bridge.editor.open(path, ref.line, ref.col);
    return;
  }
  const err = await bridge.shell.openPath(path);
  if (err) toast(err, "error");
}

export function copyText(text: string, what = "Copied") {
  void bridge.copy(text).then(
    () => toast(what),
    () => toast("Couldn't copy to the clipboard", "error"),
  );
}
