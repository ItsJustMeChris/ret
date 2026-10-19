/**
 * The demo's filesystem: a few projects' worth of files, in memory. Serves the protocol's fs/*
 * methods (Code mode, the file viewer) and the bridge's stat; scripted agents edit it as they go,
 * and anything watching a file hears about it like it would from the real engine.
 */

type Watcher = { path: string; changed: (paths: string[]) => void };

export const clean = (p: string) => {
  const s = p.replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  return s.length > 1 ? s.replace(/\/+$/, "") : s;
};
const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";

export class DemoFs {
  private files = new Map<string, string>();
  private dirs = new Set<string>(["/"]);
  private watchers = new Map<string, Watcher>();
  /** When each file was last written (ms); seeded files count as written when the demo started. */
  private mtimes = new Map<string, number>();
  private readonly started = Date.now();

  write(path: string, text: string) {
    const p = clean(path);
    this.mkdirp(parentOf(p));
    this.files.set(p, text);
    this.mtimes.set(p, Date.now());
    this.changed(p);
  }

  modified(path: string): number {
    return this.mtimes.get(clean(path)) ?? this.started;
  }

  read(path: string): string | null {
    return this.files.get(clean(path)) ?? null;
  }

  remove(path: string) {
    const p = clean(path);
    this.mtimes.delete(p);
    if (this.files.delete(p)) this.changed(p);
  }

  mkdirp(path: string) {
    let p = clean(path);
    while (p && p !== "/" && !this.dirs.has(p)) {
      this.dirs.add(p);
      p = parentOf(p);
    }
  }

  exists(path: string) {
    const p = clean(path);
    return this.files.has(p) || this.dirs.has(p);
  }

  stat(path: string): { exists: boolean; isDir: boolean; size?: number } {
    const p = clean(path);
    if (this.dirs.has(p)) return { exists: true, isDir: true };
    const f = this.files.get(p);
    return f == null ? { exists: false, isDir: false } : { exists: true, isDir: false, size: new TextEncoder().encode(f).length };
  }

  /** A folder's entries, or null when there's no such folder. */
  list(path: string): { name: string; dir: boolean }[] | null {
    const p = clean(path);
    if (!this.dirs.has(p)) return null;
    const prefix = p === "/" ? "/" : p + "/";
    const out = new Map<string, boolean>();
    for (const d of this.dirs) if (d.startsWith(prefix) && !d.slice(prefix.length).includes("/") && d !== p) out.set(d.slice(prefix.length), true);
    for (const f of this.files.keys()) if (f.startsWith(prefix) && !f.slice(prefix.length).includes("/")) out.set(f.slice(prefix.length), false);
    return [...out].map(([name, dir]) => ({ name, dir }));
  }

  /** Every file under a folder (absolute paths). */
  walk(root: string): string[] {
    const prefix = clean(root) + "/";
    return [...this.files.keys()].filter((f) => f.startsWith(prefix)).sort();
  }

  /** A copy of one folder at another path (a new worktree). */
  copyTree(from: string, to: string) {
    const src = clean(from);
    const dst = clean(to);
    this.mkdirp(dst);
    for (const d of [...this.dirs]) if (d.startsWith(src + "/")) this.mkdirp(dst + d.slice(src.length));
    for (const [f, text] of [...this.files]) if (f.startsWith(src + "/")) this.files.set(dst + f.slice(src.length), text);
  }

  watch(id: string, path: string, changed: (paths: string[]) => void) {
    this.watchers.set(id, { path: clean(path), changed });
  }

  unwatch(id: string) {
    this.watchers.delete(id);
  }

  private changed(path: string) {
    for (const w of this.watchers.values()) {
      if (w.path === path || path.startsWith(w.path + "/")) setTimeout(() => w.changed([path]), 60);
    }
  }
}

// ---------------------------------------------------------------------------
// base64 <-> text, the way fs/readFile and fs/writeFile carry file contents.
// ---------------------------------------------------------------------------

export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function fromBase64(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
