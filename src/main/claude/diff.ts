import { isAbsolute, relative } from "node:path";

/**
 * Diffs for Claude Code's edits: a turn's changes to files as `git diff` shows them (what Codex
 * sends as `turn/diff/updated`, and the details' Changes and a turn's +/− read), and an edit's own
 * hunks. Claude Code reports each Edit and Write with the file before it (`originalFile`) and its
 * hunks (`structuredPatch`), live (`tool_use_result`) and in its transcript (`toolUseResult`).
 */

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/**
 * What an Edit or Write did to a file, from Claude Code's account of it (null if it gives none).
 * Its hunks are always there; the file's text before it often isn't (Claude Code leaves it out),
 * and `before`/`after` are then undefined.
 */
export interface FileEdit {
  path: string;
  /** A Write that made the file. */
  created: boolean;
  hunks: Hunk[] | null;
  /** The file before (null: it didn't exist), if known. */
  before: string | null | undefined;
  /** The file after, if known. */
  after: string | undefined;
}

export function fileEdit(structured: any): FileEdit | null {
  if (!structured || typeof structured !== "object" || typeof structured.filePath !== "string") return null;
  const hunks: Hunk[] | null = Array.isArray(structured.structuredPatch) ? structured.structuredPatch : null;
  const created = structured.type === "create";
  const before: string | null | undefined = created ? null : typeof structured.originalFile === "string" ? structured.originalFile : undefined;
  // A Write gives the new content; an Edit, its hunks against the file before.
  const after = typeof structured.content === "string" ? structured.content : before != null && hunks ? applyHunks(before, hunks) : undefined;
  if (!hunks && after === undefined) return null;
  return { path: structured.filePath, created, hunks, before, after };
}

/** An edit's hunks as unified diff text. */
export function hunksText(hunks: Hunk[]): string {
  return hunks.map((h) => `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n${h.lines.join("\n")}`).join("\n");
}

/** A file's text with an edit's hunks applied. */
export function applyHunks(original: string, hunks: Hunk[]): string {
  const src = splitLines(original);
  const out: string[] = [];
  let at = 0;
  for (const h of hunks) {
    const start = Math.max(0, (h.oldLines ? h.oldStart : h.oldStart + 1) - 1);
    while (at < start && at < src.length) out.push(src[at++]);
    for (const l of h.lines) {
      if (l.startsWith("+")) out.push(l.slice(1));
      else if (l.startsWith("-")) at++;
      else if (l.startsWith(" ")) out.push(src[at++] ?? l.slice(1));
    }
  }
  while (at < src.length) out.push(src[at++]);
  return out.join("\n");
}

/**
 * A turn's changes, file by file: each from before the turn first touched it to how it left it, when
 * Claude Code said what the file was; otherwise its edits' own hunks, one after another.
 */
export class TurnDiff {
  private files = new Map<string, { before: string | null | undefined; after: string | undefined; hunks: Hunk[][] }>();

  note(e: FileEdit) {
    const f = this.files.get(e.path);
    if (!f) return void this.files.set(e.path, { before: e.before, after: e.after, hunks: e.hunks?.length ? [e.hunks] : [] });
    // An edit that didn't say what the file was: it was what the turn last left it, if that's known.
    f.after = e.after ?? (f.after !== undefined && e.hunks ? applyHunks(f.after, e.hunks) : undefined);
    if (e.hunks?.length) f.hunks.push(e.hunks);
  }

  get empty() {
    return !this.files.size;
  }

  /** As `git diff` prints it, paths relative to `cwd` where they're under it. */
  text(cwd: string): string {
    const out: string[] = [];
    for (const [path, f] of this.files) {
      const body = f.before !== undefined && f.after !== undefined ? unifiedDiff(f.before ?? "", f.after) : f.hunks.map(hunksText).join("\n");
      if (!body) continue;
      const p = displayPath(path, cwd);
      out.push(`diff --git a/${p} b/${p}`);
      if (f.before === null) out.push("new file mode 100644", "--- /dev/null");
      else out.push(`--- a/${p}`);
      out.push(`+++ b/${p}`, body);
    }
    return out.length ? out.join("\n") + "\n" : "";
  }
}

function displayPath(path: string, cwd: string): string {
  const rel = cwd ? relative(cwd, path) : path;
  const p = !rel || rel.startsWith("..") || isAbsolute(rel) ? path : rel;
  return p.replace(/\\/g, "/");
}

const splitLines = (s: string) => (s === "" ? [] : s.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));

/** Unified diff of two texts, in hunks with `context` lines around each change (no file header). */
export function unifiedDiff(a: string, b: string, context = 3): string {
  const A = splitLines(a);
  const B = splitLines(b);
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  if (pre === A.length && pre === B.length) return "";
  // Only what's around the changes is needed: the rest of the shared start and end isn't walked.
  const from = Math.max(0, pre - context);
  const ops: string[] = [
    ...A.slice(from, pre).map((l) => ` ${l}`),
    ...editScript(A.slice(pre, A.length - suf), B.slice(pre, B.length - suf)),
    ...A.slice(A.length - suf, Math.min(A.length, A.length - suf + context)).map((l) => ` ${l}`),
  ];
  const oldAt: number[] = [];
  const newAt: number[] = [];
  let o = from + 1;
  let n = from + 1;
  for (const op of ops) {
    oldAt.push(o);
    newAt.push(n);
    if (op[0] !== "+") o++;
    if (op[0] !== "-") n++;
  }
  const changes = ops.flatMap((op, i) => (op[0] === " " ? [] : [i]));
  const hunks: string[] = [];
  for (let i = 0; i < changes.length; i++) {
    const start = Math.max(0, changes[i] - context);
    let end = changes[i];
    while (i + 1 < changes.length && changes[i + 1] - end <= 2 * context) end = changes[++i];
    end = Math.min(ops.length - 1, end + context);
    const slice = ops.slice(start, end + 1);
    const oldLen = slice.filter((l) => l[0] !== "+").length;
    const newLen = slice.filter((l) => l[0] !== "-").length;
    // As diff prints them: a side with no lines starts at the line before.
    hunks.push(`@@ -${oldLen ? oldAt[start] : oldAt[start] - 1},${oldLen} +${newLen ? newAt[start] : newAt[start] - 1},${newLen} @@\n${slice.join("\n")}`);
  }
  return hunks.join("\n");
}

/** LCS-based line edit script; big inputs fall back to remove-all/add-all. */
export function editScript(A: string[], B: string[]): string[] {
  if (!A.length) return B.map((l) => `+${l}`);
  if (!B.length) return A.map((l) => `-${l}`);
  if (A.length * B.length > 4_000_000) return [...A.map((l) => `-${l}`), ...B.map((l) => `+${l}`)];
  const n = A.length;
  const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push(` ${A[i]}`);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(`-${A[i++]}`);
    else out.push(`+${B[j++]}`);
  }
  while (i < n) out.push(`-${A[i++]}`);
  while (j < m) out.push(`+${B[j++]}`);
  return out;
}
