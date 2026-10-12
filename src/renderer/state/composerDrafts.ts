/** Unsent composer text per thread; survives the composer unmounting (switching tabs/windows). */
export const composerDrafts = new Map<string, string>();

/** Threads whose composer should take focus (caret at the end) the next time it shows. */
export const composerFocus = new Set<string>();

/**
 * Put text into a thread's composer, appended to anything already typed there. Works whether
 * or not that composer is on screen yet: a mounted one picks it up from the event, one that
 * mounts later reads it from the drafts.
 */
export function fillComposer(threadId: string, text: string, opts: { focus?: boolean } = {}) {
  const cur = composerDrafts.get(threadId);
  composerDrafts.set(threadId, cur?.trim() ? `${cur}\n${text}` : text);
  if (opts.focus) composerFocus.add(threadId);
  window.dispatchEvent(new CustomEvent("ret:composer-fill", { detail: { threadId, text } }));
}

/** Markdown blockquote of `text`, followed by a blank line to type under. */
export function quoteText(text: string): string {
  const lines = text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .split("\n");
  return `${lines.map((l) => `> ${l}`.trimEnd()).join("\n")}\n\n`;
}
