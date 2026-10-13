/**
 * Unified diffs for the demo's file changes: one hunk around the lines that differ, with real
 * line numbers and three lines of context, as the engines report them.
 */

const lines = (s: string) => (s === "" ? [] : s.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));

export function hunk(before: string, after: string): string {
  const A = lines(before);
  const B = lines(after);
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const head = Math.max(0, pre - 3);
  const body: string[] = [];
  for (const l of A.slice(head, pre)) body.push(` ${l}`);
  body.push(...editScript(A.slice(pre, A.length - suf), B.slice(pre, B.length - suf)));
  for (const l of A.slice(A.length - suf, Math.min(A.length, A.length - suf + 3))) body.push(` ${l}`);
  const oldLen = body.filter((l) => l[0] !== "+").length;
  const newLen = body.filter((l) => l[0] !== "-").length;
  return `@@ -${head + 1},${oldLen} +${head + 1},${newLen} @@\n${body.join("\n")}`;
}

/** A git-style diff of one file, for a turn's aggregated diff. */
export function gitDiff(rel: string, before: string | null, after: string | null): string {
  if (before == null && after != null) {
    const B = lines(after);
    return `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${B.length} @@\n${B.map((l) => `+${l}`).join("\n")}`;
  }
  if (after == null && before != null) {
    const A = lines(before);
    return `diff --git a/${rel} b/${rel}\ndeleted file mode 100644\n--- a/${rel}\n+++ /dev/null\n@@ -1,${A.length} +0,0 @@\n${A.map((l) => `-${l}`).join("\n")}`;
  }
  return `diff --git a/${rel} b/${rel}\n--- a/${rel}\n+++ b/${rel}\n${hunk(before ?? "", after ?? "")}`;
}

/** A turn's aggregated diff (Codex's turn/diff/updated), from the edits it made. */
export function turnDiff(items: readonly { type: string; changes?: { path: string; kind: { type: string }; diff: string }[] }[], cwd: string): string {
  const out: string[] = [];
  for (const it of items) {
    if (it.type !== "fileChange" || !it.changes) continue;
    for (const c of it.changes) {
      const rel = c.path.startsWith(cwd + "/") ? c.path.slice(cwd.length + 1) : c.path;
      if (c.kind.type === "add") out.push(gitDiff(rel, null, c.diff));
      else if (c.kind.type === "delete") out.push(gitDiff(rel, c.diff, null));
      else out.push(`diff --git a/${rel} b/${rel}\n--- a/${rel}\n+++ b/${rel}\n${c.diff}`);
    }
  }
  return out.join("\n");
}

/** LCS line edit script; big inputs fall back to remove-all/add-all. */
function editScript(A: string[], B: string[]): string[] {
  if (!A.length) return B.map((l) => `+${l}`);
  if (!B.length) return A.map((l) => `-${l}`);
  if (A.length * B.length > 1_000_000) return [...A.map((l) => `-${l}`), ...B.map((l) => `+${l}`)];
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
