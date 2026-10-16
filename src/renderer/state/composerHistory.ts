import { requestText } from "../lib/codexMessage";
import { useThreads } from "./threads";

/**
 * What you've sent in a thread, newest first, for the composer's ↑: as you wrote it (without what
 * the Codex app wraps around it), a message sent several times in a row only once. Only what's
 * loaded: `more` says older turns could add to it.
 */
export function sentMessages(threadId: string): { list: string[]; more: boolean } {
  const lt = useThreads.getState().live[threadId];
  const list: string[] = [];
  if (!lt) return { list, more: false };
  for (let i = lt.turnOrder.length - 1; i >= 0; i--) {
    const ids = lt.turns[lt.turnOrder[i]]?.itemIds ?? [];
    for (let j = ids.length - 1; j >= 0; j--) {
      const it = lt.items[ids[j]];
      if (it?.type !== "userMessage") continue;
      const text = requestText(
        it.content
          .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
          .map((c) => c.text)
          .join("\n"),
      ).trim();
      if (text && text !== list[list.length - 1]) list.push(text);
    }
  }
  return { list, more: !!lt.olderCursor };
}
