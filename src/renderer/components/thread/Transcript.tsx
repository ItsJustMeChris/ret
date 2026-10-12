import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronRight, CircleAlert, FileDiff, GitFork, LoaderCircle } from "lucide-react";
import { useThreads } from "../../state/threads";
import { forkThread, loadOlder, resendUnanswered } from "../../state/actions";
import type { ThreadItem } from "../../protocol";
import { activitySummary, DiffView, isActivity, ItemView } from "./Items";
import { diffStats, duration } from "../../lib/format";
import { Approvals } from "./Approvals";
import { TurnRail } from "./TurnRail";

type Ctx = { threadId: string; cwd: string | null };

function ActivityGroup({ ids, ctx, live }: { ids: string[]; ctx: Ctx; live: boolean }) {
  const items = useThreads(useShallow((s) => ids.map((id) => s.live[ctx.threadId]?.items[id]).filter(Boolean) as ThreadItem[]));
  const [open, setOpen] = useState(false);
  if (live) {
    // While the agent works, show the most recent steps live.
    const hidden = Math.max(0, ids.length - 3);
    return (
      <div className="activity live">
        {hidden > 0 && !open && (
          <button className="activity-more" onClick={() => setOpen(true)}>
            {hidden} earlier {hidden === 1 ? "step" : "steps"}
          </button>
        )}
        {(open ? ids : ids.slice(-3)).map((id) => (
          <ItemView key={id} itemId={id} ctx={ctx} live={id === ids[ids.length - 1]} />
        ))}
      </div>
    );
  }
  if (ids.length === 1) return <ItemView itemId={ids[0]} ctx={ctx} live={false} />;
  const failed = items.some((i) => i.type === "commandExecution" && i.exitCode != null && i.exitCode !== 0);
  return (
    <div className={`activity ${open ? "open" : ""}`}>
      <button className="activity-head" onClick={() => setOpen(!open)}>
        <ChevronRight className="tool-chev" size={13} />
        <span>{activitySummary(items)}</span>
        {failed && <span className="badge err">failed step</span>}
      </button>
      {open && (
        <div className="activity-body">
          {ids.map((id) => (
            <ItemView key={id} itemId={id} ctx={ctx} live={false} />
          ))}
        </div>
      )}
    </div>
  );
}

const Turn = memo(function Turn({ turnId, ctx }: { turnId: string; ctx: Ctx }) {
  const turn = useThreads((s) => s.live[ctx.threadId]?.turns[turnId]);
  const types = useThreads(
    useShallow((s) => {
      const lt = s.live[ctx.threadId];
      return turn ? turn.itemIds.map((id) => lt?.items[id]?.type ?? "") : [];
    }),
  );
  const [showDiff, setShowDiff] = useState(false);
  const elsewhere = useThreads((s) => s.external[ctx.threadId]?.turnId === turnId);
  if (!turn) return null;
  const live = turn.status === "inProgress" && !turn.stale;

  // Split items into runs: activity steps are grouped, messages/edits stand alone.
  const segments: { kind: "item" | "group"; ids: string[] }[] = [];
  turn.itemIds.forEach((id, i) => {
    const activity = isActivity({ type: types[i] } as ThreadItem);
    const last = segments[segments.length - 1];
    if (activity && last?.kind === "group") last.ids.push(id);
    else segments.push({ kind: activity ? "group" : "item", ids: [id] });
  });

  const stats = turn.diff ? diffStats(turn.diff) : null;
  const pending = turnId.startsWith("pending:");

  return (
    <section className={`turn ${live ? "live" : ""}`} data-turn={turnId}>
      {segments.map((seg, i) =>
        seg.kind === "group" ? (
          <ActivityGroup key={seg.ids[0]} ids={seg.ids} ctx={ctx} live={live && i === segments.length - 1} />
        ) : (
          <ItemView key={seg.ids[0]} itemId={seg.ids[0]} ctx={ctx} live={live && i === segments.length - 1} />
        ),
      )}
      {turn.plan && turn.plan.steps.length > 0 && (
        <div className="plan-steps">
          {turn.plan.steps.map((s, i) => (
            <div key={i} className={`plan-step ${s.status}`}>
              <span className="plan-dot" />
              {s.step}
            </div>
          ))}
        </div>
      )}
      {live && !pending && <Working since={turn.startedAt} elsewhere={elsewhere} />}
      {!live && !pending && turn.status !== "interrupted" && <UnansweredNotice threadId={ctx.threadId} lastItemId={turn.itemIds[turn.itemIds.length - 1]} count={turn.itemIds.length} />}
      {turn.error && (
        <div className="turn-error">
          <CircleAlert size={14} />
          <span>{turn.error.message}</span>
        </div>
      )}
      {!live && !pending && (
        <div className="turn-foot">
          {turn.status === "interrupted" && <span className="badge warn">interrupted</span>}
          {turn.stale && (
            <span className="badge warn" title="This turn didn't finish in Ret's session. It may still be running in another Codex app, or it was cut off.">
              unfinished
            </span>
          )}
          {turn.durationMs != null && <span>{duration(turn.durationMs)}</span>}
          {stats && (stats.add > 0 || stats.del > 0) && (
            <button className="link" onClick={() => setShowDiff(!showDiff)}>
              <FileDiff size={12} /> <span className="add">+{stats.add}</span> <span className="del">−{stats.del}</span>
            </button>
          )}
          <button className="link fork-here" title="Fork the conversation from this point" onClick={() => void forkThread(ctx.threadId, { atTurnId: turnId })}>
            <GitFork size={12} /> Fork from here
          </button>
        </div>
      )}
      {showDiff && turn.diff && <DiffView diff={turn.diff} />}
    </section>
  );
});

/** A steer that landed after the final answer: the turn ended with the user's message unanswered. */
function UnansweredNotice({ threadId, lastItemId, count }: { threadId: string; lastItemId: string | undefined; count: number }) {
  const item = useThreads((s) => (lastItemId ? s.live[threadId]?.items[lastItemId] : undefined));
  if (!item || item.type !== "userMessage" || count < 2) return null;
  return (
    <div className="unanswered">
      <CircleAlert size={13} />
      <span>This message arrived as the turn was ending and wasn't answered.</span>
      <button className="link" onClick={() => resendUnanswered(threadId, item)}>
        Send again
      </button>
    </div>
  );
}

function Working({ since, elsewhere }: { since: number | null; elsewhere?: boolean }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = since ? Math.max(0, Math.floor(Date.now() / 1000 - since)) : 0;
  return (
    <div className="working">
      <span className="pulse" />
      <span className="shimmer">{elsewhere ? "Working in another Codex app" : "Working"}</span>
      <span className="muted">{secs >= 1 ? duration(secs * 1000) : ""}</span>
    </div>
  );
}

export function Transcript({ threadId, cwd }: { threadId: string; cwd: string | null }) {
  const lt = useThreads((s) => s.live[threadId]);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const ctx = useMemo(() => ({ threadId, cwd }), [threadId, cwd]);
  const loading = !lt || (!lt.hydrated && lt.hydrating);

  // Stick to the bottom while content grows, unless the user scrolled up.
  // Re-attaches once history has loaded (the scroller doesn't exist while the spinner shows).
  useLayoutEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    stick.current = true;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    };
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    // Programmatic jumps (turn rail) must not be pulled back to the bottom while
    // off-screen turns render at their real size along the way.
    const unstick = () => {
      stick.current = false;
    };
    ro.observe(inner);
    el.addEventListener("scroll", onScroll, { passive: true });
    el.addEventListener("ret:unstick", unstick);
    el.scrollTop = el.scrollHeight;
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
      el.removeEventListener("ret:unstick", unstick);
    };
  }, [threadId, loading]);

  if (loading || !lt) {
    return (
      <div className="transcript center">
        <LoaderCircle className="spin muted" size={18} />
      </div>
    );
  }

  return (
    <div className="transcript-wrap">
    <div className="transcript" ref={scroller}>
      <div className="transcript-inner" ref={content}>
        {lt.olderCursor && (
          <button className="load-older" onClick={() => void loadOlder(threadId)} disabled={lt.loadingOlder}>
            {lt.loadingOlder ? <LoaderCircle className="spin" size={12} /> : null} Load earlier turns
          </button>
        )}
        {lt.turnOrder.map((id) => (
          <Turn key={id} turnId={id} ctx={ctx} />
        ))}
        {lt.notice && <div className="notice">{lt.notice}</div>}
        {lt.error && (
          <div className="turn-error">
            <CircleAlert size={14} />
            <span>{lt.error}</span>
          </div>
        )}
        <Approvals threadId={threadId} />
      </div>
    </div>
    <TurnRail threadId={threadId} scroller={scroller} />
    </div>
  );
}
