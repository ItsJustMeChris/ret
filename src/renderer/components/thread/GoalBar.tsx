import { memo, useEffect, useState } from "react";
import { Goal, Maximize2, Minimize2, Pause, Play, Trash2 } from "lucide-react";
import type { ThreadGoalStatus } from "@shared/protocol/generated/v2";
import { useThreads } from "../../state/threads";
import { clearGoal, setGoalStatus } from "../../state/actions";
import { compactNumber, duration, timeAgo } from "../../lib/format";

const LABEL: Record<ThreadGoalStatus, string> = {
  active: "Pursuing goal",
  paused: "Goal paused",
  blocked: "Goal blocked",
  usageLimited: "Goal paused at usage limit",
  budgetLimited: "Goal hit its token budget",
  complete: "Goal complete",
};

function setWhen(seconds: number): string {
  const ago = timeAgo(seconds);
  return ago === "now" ? "just now" : /^\d/.test(ago) ? `${ago} ago` : `on ${ago}`;
}

/**
 * The objective the agent keeps working toward across turns (Codex's `/goal`), docked on top of
 * the composer: what it is, how long it's been worked on, and controls to pause, resume or drop it.
 */
export const GoalBar = memo(function GoalBar({ threadId }: { threadId: string }) {
  const goal = useThreads((s) => s.goals[threadId]);
  const turnStarted = useThreads((s) => {
    const lt = s.live[threadId];
    return lt?.activeTurnId ? (lt.turns[lt.activeTurnId]?.startedAt ?? null) : null;
  });
  const elsewhere = useThreads((s) => !!s.external[threadId]);
  const running = turnStarted != null || elsewhere;
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const ticking = !!goal && goal.status === "active" && running;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  if (!goal) return null;

  // The server banks time when it updates the goal; while work goes on, count on from there.
  const since = Math.max(goal.updatedAt, turnStarted ?? 0);
  const secs = goal.timeUsedSeconds + (ticking ? Math.max(0, Date.now() / 1000 - since) : 0);
  const objective = goal.objective.replace(/\s+/g, " ").trim();
  const resumable = goal.status === "paused" || goal.status === "blocked" || goal.status === "usageLimited";
  const act = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    await fn();
    setBusy(false);
  };
  const locked = busy || elsewhere;
  const why = elsewhere ? " (it's running in another Codex app)" : "";

  return (
    <div className={`goal-bar ${goal.status} ${expanded ? "expanded" : ""}`}>
      <div className="goal-row">
        <Goal size={13} className="goal-icon" />
        <button className="goal-text" onClick={() => setExpanded((v) => !v)} title={expanded ? undefined : goal.objective}>
          <span className="goal-label">{LABEL[goal.status]}</span> <span className="goal-objective">{objective}</span>
        </button>
        {secs >= 1 && <span className="goal-time">{duration(Math.floor(secs) * 1000)}</span>}
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
            <span>set {setWhen(goal.createdAt)}</span>
          </div>
        </div>
      )}
    </div>
  );
});
