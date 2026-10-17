import { useEffect, useRef, useState } from "react";
import { useThread } from "../../state/useThread";
import { useThreadState } from "../StatusDot";
import { WORK_LABEL, WORK_MOOD, workKindOf, workVerb } from "../../lib/working";
import { botLoop } from "../../lib/retBotMotion";

/**
 * What a live turn's Working row shows, on the desktop and the phone: the kind of work its latest
 * item (`lastItemId`) is, the Ret bot's mood for it and the loop it moves in, a verb and the plain
 * label. The loop and the verb change together. `elsewhere` names the agent when the turn runs in
 * another of its apps (what it's doing there isn't known); `secs`: how long the turn has run.
 */
export function useWork(threadId: string, turnId: string, lastItemId: string | undefined, elsewhere: string | null | undefined, secs: number) {
  const asking = useThreadState(threadId) === "attention";
  const doing = useThread(threadId, (s) => (elsewhere ? "work" : workKindOf(lastItemId ? s.live[threadId]?.items[lastItemId] : undefined)));
  // A turn going back and forth between thinking and quick steps shows each for a moment at least;
  // needing you shows at once.
  const kind = useSettled(asking ? "ask" : doing, asking ? 0 : 2500);
  const verb = elsewhere && kind !== "ask" ? `Working in another ${elsewhere} app` : workVerb(kind, turnId, secs);
  const mood = WORK_MOOD[kind];
  return { kind, mood, loop: botLoop(mood, turnId + kind, secs).name, verb, label: WORK_LABEL[kind] };
}

/** `value`, each one shown for `hold` ms at least, so quick back-and-forth doesn't flicker. */
function useSettled<T>(value: T, hold: number): T {
  const [shown, setShown] = useState(value);
  const since = useRef(Date.now());
  useEffect(() => {
    if (value === shown) return;
    const t = setTimeout(
      () => {
        since.current = Date.now();
        setShown(value);
      },
      Math.max(0, since.current + hold - Date.now()),
    );
    return () => clearTimeout(t);
  }, [value, shown, hold]);
  return shown;
}
