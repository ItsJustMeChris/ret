import { bridge } from "../bridge";
import { appHasFocus } from "../lib/appFocus";
import { threadTitle } from "./projects";
import { agentsWorking, hostOfThread, useThreads } from "./threads";

/**
 * "Finished" news, once per job. A turn that ends while agents the thread started are still at
 * it (see agentsWorking) isn't done: their reports wake the thread for another turn, and the last
 * of those is what's worth hearing about. So its news waits, and is dropped when the thread is
 * woken (that turn reports instead). If it's never woken, it's told once its agents have stopped
 * for a moment.
 */

interface News {
  heading: string;
  /** Paired phones that are away hear about it too. */
  devices: boolean;
}

/** News waiting on the thread's agents, with the turn it's about. */
const held = new Map<string, News & { turnId: string }>();
const settling = new Map<string, ReturnType<typeof setTimeout>>();
/** How long a thread's agents stay stopped, with it not woken, before its news goes out. */
const SETTLE_MS = 4000;

/**
 * A turn of the thread's ended: say so now, or once its agents are done (`waiting`, as the reducer
 * saw it). The caller marks the thread unread when it isn't waiting; once it's done waiting, it's
 * marked here.
 */
export function turnFinished(threadId: string, turnId: string, news: News, waiting: boolean) {
  drop(threadId);
  if (waiting) held.set(threadId, { ...news, turnId });
  else announce(threadId, news);
}

/** Whether a turn's news would wait on the thread's agents now (failures never do). */
export const waitsOnAgents = (threadId: string, failed: boolean) => !failed && agentsWorking(useThreads.getState(), threadId);

function announce(threadId: string, news: News) {
  const s = useThreads.getState();
  const title = threadTitle(s.threads[threadId]);
  if (!s.visible[threadId] || !appHasFocus()) bridge.notify(news.heading, title);
  if (news.devices && !hostOfThread(threadId)) bridge.remoteAccess.notifyDevices({ title: news.heading, body: title, threadId });
}

function drop(threadId: string) {
  held.delete(threadId);
  clearTimeout(settling.get(threadId));
  settling.delete(threadId);
}

function release(threadId: string) {
  const news = held.get(threadId);
  drop(threadId);
  if (!news) return;
  if (!useThreads.getState().attended[threadId]) useThreads.setState((s) => (s.unread[threadId] ? s : { unread: { ...s.unread, [threadId]: true } }));
  announce(threadId, news);
}

useThreads.subscribe((s) => {
  if (!held.size) return;
  for (const [id, news] of held) {
    const lt = s.live[id];
    const woken = (lt?.activeTurnId && lt.activeTurnId !== news.turnId) || (s.external[id] && s.external[id].turnId !== news.turnId);
    if (!s.threads[id] || woken) {
      drop(id);
      continue;
    }
    const done = !agentsWorking(s, id);
    if (done && !settling.has(id)) settling.set(id, setTimeout(() => release(id), SETTLE_MS));
    else if (!done && settling.has(id)) {
      clearTimeout(settling.get(id));
      settling.delete(id);
    }
  }
});
