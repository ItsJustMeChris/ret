import { memo, useContext, useEffect, useState } from "react";
import { Goal, Maximize2, Minimize2, Pause, Play, Trash2 } from "lucide-react";
import type { ThreadGoal, ThreadGoalStatus } from "@shared/protocol/generated/v2";
import { FreezeContext, useThread } from "../../state/useThread";
import { ownerOf } from "../../state/threads";
import { clearGoal, setGoalStatus } from "../../state/actions";
import { agentOf } from "../../agents";
import { compactNumber, duration, sinceWhen } from "../../lib/format";
import { useVisibility } from "../ui/Kept";

const LABEL: Record<ThreadGoalStatus, string> = {
  active: "Pursuing goal",
  paused: "Goal paused",
  blocked: "Goal blocked",
  usageLimited: "Goal paused at usage limit",
  budgetLimited: "Goal hit its token budget",
  complete: "Goal complete",
};

/**
 * The objective the agent keeps working toward across turns (Codex's `/goal`), docked on top of
 * the composer: what it is, how long it's been worked on, and controls to pause, resume or drop it.
 */
export const GoalBar = memo(function GoalBar({ threadId }: { threadId: string }) {
  const goal = useThread(threadId, (s) => s.goals[threadId]);
  const elsewhere = useThread(threadId, (s) => !!s.external[threadId]);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  // The next goal starts folded.
  const has = !!goal;
  useEffect(() => {
    if (!has) setExpanded(false);
  }, [has]);
  if (!goal) return null;

  const objective = goal.objective.replace(/\s+/g, " ").trim();
  const resumable = goal.status === "paused" || goal.status === "blocked" || goal.status === "usageLimited";
  const act = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    await fn();
    setBusy(false);
  };
  // Another app runs it: Ret only watches (as the composer won't send to it either).
  const locked = busy || elsewhere;
  const why = elsewhere ? ` (it's running in another ${agentOf(ownerOf(threadId)).name} app)` : "";

  return (
    <div className={`goal-bar ${goal.status} ${expanded ? "expanded" : ""}`}>
      <div className="goal-row">
        <Goal size={13} className="goal-icon" />
        <button className="goal-text" onClick={() => setExpanded((v) => !v)} title={expanded ? undefined : goal.objective}>
          <span className="goal-label">{LABEL[goal.status]}</span> <span className="goal-objective">{objective}</span>
        </button>
        <GoalTime threadId={threadId} goal={goal} />
        <div className="goal-actions">
          <button className="icon-btn tiny" title={`Clear goal${why}`} disabled={locked} onClick={act(() => clearGoal(threadId))}>
            <Trash2 size={12} />
          </button>
          {goal.status === "active" && (
            <button className="icon-btn tiny" title={`Pause goal${why}`} disabled={locked} onClick={act(() => setGoalStatus(threadId, "paused"))}>
              <Pause size={12} />
            </button>
          )}
          {resumable && (
            <button className="icon-btn tiny" title={`Resume goal${why}`} disabled={locked} onClick={act(() => setGoalStatus(threadId, "active"))}>
              <Play size={12} />
            </button>
          )}
          <button className="icon-btn tiny" title={expanded ? "Collapse" : "Show the whole goal"} onClick={() => setExpanded((v) => !v)}>
            {expanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
          </button>
        </div>
      </div>
      {expanded && (
        <div className="goal-detail">
          <p className="goal-full">{goal.objective}</p>
          <div className="goal-meta">
            <span>
              {compactNumber(goal.tokensUsed)}
              {goal.tokenBudget != null ? ` of ${compactNumber(goal.tokenBudget)}` : ""} tokens
            </span>
            <span>set {sinceWhen(goal.createdAt)}</span>
          </div>
        </div>
      )}
    </div>
  );
});

/**
 * Time spent on the goal. The engine banks it at each goal update; while a turn works on the goal,
 * this counts on from whichever is later, that update or the turn's start (the turn running here, or
 * in another app). Only this leaf re-renders on the tick, and not while its view is hidden or frozen.
 */
function GoalTime({ threadId, goal }: { threadId: string; goal: ThreadGoal }) {
  const started = useThread(threadId, (s) => {
    const lt = s.live[threadId];
    const turn = lt?.activeTurnId ?? s.external[threadId]?.turnId;
    return turn ? (lt?.turns[turn]?.startedAt ?? null) : null;
  });
  const gate = useContext(FreezeContext);
  const visibility = useVisibility();
  const ticking = goal.status === "active" && started != null;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => {
      if (visibility.shown && !gate?.frozen) tick((n) => n + 1);
    }, 1000);
    return () => clearInterval(t);
  }, [ticking, gate, visibility]);
  const secs = goal.timeUsedSeconds + (ticking ? Math.max(0, Date.now() / 1000 - Math.max(goal.updatedAt, started!)) : 0);
  return secs >= 1 ? <span className="goal-time">{duration(Math.floor(secs) * 1000)}</span> : null;
}
