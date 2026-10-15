import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Bot, CircleAlert, CircleDashed, FileDiff, GitFork, LoaderCircle, Radar, SquareTerminal, Workflow } from "lucide-react";
import { Chevron } from "../ui/Chevron";
import { ownerOf } from "../../state/threads";
import { useThread } from "../../state/useThread";
import { shallowEqual } from "../../lib/shallow";
import { PROVIDERS } from "../../agents";
import { forkThread, loadOlder, resendUnanswered } from "../../state/actions";
import type { BackgroundTask, ThreadItem } from "@shared/protocol";
import { backgroundLabel, useBackgroundOnly } from "../StatusDot";
import { activitySummary, DiffView, isActivity, ItemView } from "./Items";
import { ThreadImage } from "./ThreadImage";
import { diffStats, duration } from "../../lib/format";
import { Approvals } from "./Approvals";
import { TurnRail } from "./TurnRail";
import { Shimmer } from "../ui/Shimmer";

type Ctx = { threadId: string; cwd: string | null };

function ActivityGroup({ ids, ctx, live }: { ids: string[]; ctx: Ctx; live: boolean }) {
  const items = useThread(ctx.threadId, (s) => ids.map((id) => s.live[ctx.threadId]?.items[id]).filter(Boolean) as ThreadItem[], shallowEqual);
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
  // Images the agent looked at stay visible while the group is folded.
  const viewed = items.flatMap((i) => (i.type === "imageView" ? [i.path] : []));
  return (
    <div className={`activity ${open ? "open" : ""}`}>
      <button className="activity-head" onClick={() => setOpen(!open)}>
        <Chevron className="tool-chev" size={13} />
        <span>{activitySummary(items)}</span>
        {failed && <span className="badge err">failed step</span>}
      </button>
      {!open && viewed.length > 0 && (
        <div className="activity-thumbs">
          {viewed.slice(0, 6).map((path, i) => (
            <ThreadImage key={i} path={path} cwd={ctx.cwd} size="sm" />
          ))}
          {viewed.length > 6 && <span className="activity-thumbs-more">+{viewed.length - 6}</span>}
        </div>
      )}
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
  const turn = useThread(ctx.threadId, (s) => s.live[ctx.threadId]?.turns[turnId]);
  const types = useThread(
    ctx.threadId,
    (s) => {
      const lt = s.live[ctx.threadId];
      return turn ? turn.itemIds.map((id) => lt?.items[id]?.type ?? "") : [];
    },
    shallowEqual,
  );
  const [showDiff, setShowDiff] = useState(false);
  const elsewhere = useThread(ctx.threadId, (s) => s.external[ctx.threadId]?.turnId === turnId);
  const background = useThread(ctx.threadId, (s) => s.background[ctx.threadId]?.length ?? 0);
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
      {live && !pending && <Working since={turn.startedAt} elsewhere={elsewhere ? PROVIDERS[ownerOf(ctx.threadId)].name : null} />}
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
          {turn.stale &&
            (background ? (
              // Not cut off: the agent left work running and will be back.
              <span className="badge" title={`${PROVIDERS[ownerOf(ctx.threadId)].name} is waiting on work it left running, and picks the thread up again when it's done.`}>
                {background === 1 ? "1 background task" : `${background} background tasks`}
              </span>
            ) : (
              <span className="badge warn" title={`This turn didn't finish in Ret's session. It may still be running in another ${PROVIDERS[ownerOf(ctx.threadId)].name} app, or it was cut off.`}>
                unfinished
              </span>
            ))}
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
  const item = useThread(threadId, (s) => (lastItemId ? s.live[threadId]?.items[lastItemId] : undefined));
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

/** `elsewhere` names the agent when the turn runs in another of its apps. */
function Working({ since, elsewhere }: { since: number | null; elsewhere?: string | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = since ? Math.max(0, Math.floor(Date.now() / 1000 - since)) : 0;
  return (
    <div className="working">
      <span className="pulse" />
      <Shimmer text={elsewhere ? `Working in another ${elsewhere} app` : "Working"} />
      <span className="muted">{secs >= 1 ? duration(secs * 1000) : ""}</span>
    </div>
  );
}

const TASK_ICON: Record<BackgroundTask["kind"], typeof Bot> = { shell: SquareTerminal, agent: Bot, monitor: Radar, workflow: Workflow, task: CircleDashed };

/**
 * Work the agent left running when its turn ended: a background shell, subagent or monitor. It
 * takes the thread up again once that finishes, so the thread is waiting, not done (or dead).
 */
function BackgroundWork({ threadId }: { threadId: string }) {
  const count = useBackgroundOnly(threadId);
  const tasks = useThread(threadId, (s) => s.background[threadId]);
  const agent = useThread(threadId, (s) => PROVIDERS[s.owner[threadId] ?? "codex"].name);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!count) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [count]);
  if (!count || !tasks) return null;
  return (
    <section className="background-work">
      <div className="working">
        <span className="pulse calm" />
        <span>{backgroundLabel(count)}</span>
        <span className="muted">{agent} picks this up again when it's done</span>
      </div>
      {tasks.map((t) => {
        const Icon = TASK_ICON[t.kind];
        return (
          <div key={t.id} className="background-task" title={`${t.kind} · ${t.id}`}>
            <Icon size={12} />
            <span className="background-task-desc">{t.description || "Background task"}</span>
            <span className="muted">{duration(Math.max(0, Date.now() - t.startedAt))}</span>
          </div>
        );
      })}
    </section>
  );
}

export function Transcript({ threadId, cwd }: { threadId: string; cwd: string | null }) {
  // Only what this level shows: a token streaming into an item re-renders that item, not the transcript.
  const lt = useThread(
    threadId,
    (s) => {
      const l = s.live[threadId];
      return l && { turnOrder: l.turnOrder, olderCursor: l.olderCursor, loadingOlder: l.loadingOlder, notice: l.notice, error: l.error, loading: !l.hydrated && l.hydrating };
    },
    shallowEqual,
  );
  const scroller = useRef<HTMLDivElement>(null);
  const ctx = useMemo(() => ({ threadId, cwd }), [threadId, cwd]);
  const loading = !lt || lt.loading;

  // The transcript is laid out from its end (column-reverse, see .transcript): its scroll origin is the
  // bottom, so a view at the bottom stays there as replies grow, and one scrolled up stays on what it
  // shows (scroll anchoring), with no script setting scroll offsets on every token. Each of those cost
  // a layout and, in Electron, a walk of the whole page for its draggable regions.
  //
  // Out of the document (a canvas window off screen, or zoomed out to its card) it forgets where it
  // was, so that's kept, and put back when it's back. (The bottom is offset 0: nothing to put back.)
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let top = 0;
    let away = false;
    const onScroll = () => {
      if (!away && el.isConnected) top = el.scrollTop;
    };
    const ro = new ResizeObserver(() => {
      if (!el.isConnected) {
        away = true;
        return;
      }
      if (away && top) el.scrollTop = top;
      away = false;
    });
    ro.observe(el);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
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
      <div className="transcript-inner">
        {lt.olderCursor && (
          <button className="load-older" onClick={() => void loadOlder(threadId)} disabled={lt.loadingOlder}>
            {lt.loadingOlder ? <LoaderCircle className="spin" size={12} /> : null} Load earlier turns
          </button>
        )}
        {lt.turnOrder.map((id) => (
          <Turn key={id} turnId={id} ctx={ctx} />
        ))}
        <BackgroundWork threadId={threadId} />
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
