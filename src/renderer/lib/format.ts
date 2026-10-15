export function timeAgo(seconds: number | null | undefined): string {
  if (!seconds) return "";
  const diff = Date.now() / 1000 - seconds;
  if (diff < 45) return "now";
  if (diff < 3600) return `${Math.round(diff / 60)}m`;
  if (diff < 86_400) return `${Math.round(diff / 3600)}h`;
  if (diff < 86_400 * 7) return `${Math.round(diff / 86_400)}d`;
  return new Date(seconds * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** When something happened, to follow a verb: "just now", "5m ago", "on Oct 3". */
export function sinceWhen(seconds: number | null | undefined): string {
  const ago = timeAgo(seconds);
  return ago === "now" ? "just now" : /^\d/.test(ago) ? `${ago} ago` : ago ? `on ${ago}` : "";
}

export function duration(ms: number | null | undefined): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 59.5) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  // Two units from the largest that applies: 4m 12s, 2h 5m, 3d 4h.
  const total = Math.round(s);
  const d = Math.floor(total / 86_400);
  const h = Math.floor((total % 86_400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m ${total % 60}s`;
}

export function compactNumber(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return `${(n / 1_000_000_000).toFixed(1)}B`;
}

/** A date's local calendar day as YYYY-MM-DD, the form `account/usage/read` buckets days by. */
export function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Codex wraps commands in the platform shell, e.g.
 * `"C:\…\pwsh.exe" -Command 'git status'` or `bash -lc "ls"`. Show the inner command.
 */
export function unwrapCommand(cmd: string): string {
  const m =
    /^"?[^"]*?(?:pwsh|powershell)(?:\.exe)?"?\s+(?:-NoProfile\s+)?-Command\s+(['"])([\s\S]*)\1\s*$/i.exec(cmd) ??
    /^(?:\/\S+\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1\s*$/.exec(cmd);
  return m ? m[2].replace(/''/g, "'") : cmd;
}

export function shortPath(p: string, cwd?: string | null): string {
  const norm = p.replace(/\\/g, "/");
  if (cwd) {
    const c = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
    if (norm.toLowerCase().startsWith(c.toLowerCase() + "/")) return norm.slice(c.length + 1);
  }
  const parts = norm.split("/");
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : norm;
}

/** Rough markdown → plain text for previews (cards, glance views). */
export function plainText(md: string, max = 420): string {
  // Only the start can show (a long reply on a card would be run through every pattern whole).
  const text = (md.length > max * 8 ? md.slice(0, max * 8) : md)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/```[\s\S]*$/, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > max ? text.slice(0, max).replace(/\s+\S*$/, "") + "…" : text;
}

/** Codex sends whole-file content (not a unified diff) for added and deleted files. */
export function changeStats(change: { kind: { type: string }; diff: string }): { add: number; del: number } {
  if (change.kind.type === "update") return diffStats(change.diff);
  const lines = change.diff ? change.diff.replace(/\n$/, "").split("\n").length : 0;
  return change.kind.type === "add" ? { add: lines, del: 0 } : { add: 0, del: lines };
}

export function diffStats(diff: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) add++;
    else if (line.startsWith("-") && !line.startsWith("---")) del++;
  }
  return { add, del };
}
