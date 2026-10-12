import type { Attachment } from "./actions";

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

/** Attachments handed to a composer that may not be on screen yet (it takes them when it mounts). */
const pendingAttachments = new Map<string, Attachment[]>();

export function attachToComposer(threadId: string, list: Attachment[]) {
  if (!list.length) return;
  pendingAttachments.set(threadId, [...(pendingAttachments.get(threadId) ?? []), ...list]);
  window.dispatchEvent(new CustomEvent("ret:composer-attach", { detail: { threadId } }));
}

export function takeAttachments(threadId: string): Attachment[] {
  const list = pendingAttachments.get(threadId) ?? [];
  pendingAttachments.delete(threadId);
  return list;
}

/** Put the caret in a thread's composer (now, or when it next shows). */
export function focusComposer(threadId: string) {
  composerFocus.add(threadId);
  window.dispatchEvent(new CustomEvent("ret:composer-focus", { detail: { threadId } }));
}

/**
 * Send `text` as your next message in a thread, the way the composer would (with the model,
 * effort and access you've picked there). Used for answers to Codex's questions. If no composer
 * for the thread is on screen, it goes straight out with the thread's own settings.
 */
export function sendFromComposer(threadId: string, text: string, opts: { mode?: "plan" | "default" } = {}) {
  const detail = { threadId, text, mode: opts.mode, handled: false };
  window.dispatchEvent(new CustomEvent("ret:composer-send", { detail }));
  if (detail.handled) return;
  void import("./actions").then(({ sendMessage }) => sendMessage(threadId, text, [], opts.mode ? { mode: opts.mode } : {}, "auto"));
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
