import { memo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowUpRight, Bot, ChevronRight, CornerLeftUp, Square } from "lucide-react";
import { useThreads } from "../../state/threads";
import { agentName, spawnedBy, threadTitle } from "../../state/projects";
import { interrupt, openThread } from "../../state/actions";
import { STATE_LABEL, StatusDot, threadStateOf, useThreadState } from "../StatusDot";

const open = (e: React.MouseEvent, threadId: string) => openThread(threadId, { side: e.altKey });

/**
 * The agents a thread spawned, docked on top of its composer: what each is up to, and a way into
 * its thread. Open while any of them works; folded to a line once they're all done.
 */
export const AgentTray = memo(function AgentTray({ threadId }: { threadId: string }) {
  const ids = useThreads(
    useShallow((s) =>
      Object.values(s.threads)
        .filter((t) => spawnedBy(t) === threadId)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((t) => t.id),
    ),
  );
  const running = useThreads((s) => ids.filter((id) => threadStateOf(s, id) === "running").length);
  const [unfolded, setUnfolded] = useState<boolean | null>(null);
  if (!ids.length) return null;
  const expanded = unfolded ?? running > 0;
  return (
    <div className={`queue-tray agent-tray ${expanded ? "open" : ""}`}>
      <button className="queue-row agent-tray-head" onClick={() => setUnfolded(!expanded)}>
        <Bot size={12} className="queue-icon" />
        <span className="queue-text">
          {ids.length} {ids.length === 1 ? "subagent" : "subagents"}
          {running > 0 && <span className="agent-tray-running"> · {running} working</span>}
        </span>
        <ChevronRight size={12} className="tool-chev" />
      </button>
      {expanded && ids.map((id) => <AgentRow key={id} threadId={id} />)}
    </div>
  );
});

function AgentRow({ threadId }: { threadId: string }) {
  const title = useThreads((s) => threadTitle(s.threads[threadId]));
  const state = useThreadState(threadId);
  return (
    <button className="queue-row agent-row" onClick={(e) => open(e, threadId)} title={`Open ${title}'s thread (Alt: beside this one)`}>
      <StatusDot threadId={threadId} />
      <span className="queue-text">{title}</span>
      {/* An agent with nothing left to do has finished its task. */}
      <span className={`queue-when state-${state}`}>{state === "idle" ? "Done" : STATE_LABEL[state]}</span>
      <ArrowUpRight size={12} className="queue-icon" />
    </button>
  );
}

/**
 * Where a subagent's composer would be. Codex subagents take their instructions from the agent
 * that spawned them, not from you; this says so, leads back to that agent, and can stop a turn.
 */
export function SubagentBar({ threadId }: { threadId: string }) {
  const name = useThreads((s) => agentName(s.threads[threadId]) ?? "This agent");
  const parentId = useThreads((s) => spawnedBy(s.threads[threadId]));
  const parentTitle = useThreads((s) => (parentId && s.threads[parentId] ? threadTitle(s.threads[parentId]) : null));
  const running = useThreads((s) => !!s.live[threadId]?.activeTurnId);
  return (
    <div className={`subagent-bar ${running ? "running" : ""}`}>
      <Bot size={13} className="subagent-bar-icon" />
      <span className="subagent-bar-text" title={`${name} takes its instructions from the thread that spawned it, not from you.`}>
        Subagent · takes its instructions from
      </span>
      {parentId && (
        <button className="subagent-bar-btn" onClick={(e) => open(e, parentId)} disabled={!parentTitle} title={parentTitle ?? undefined}>
          <CornerLeftUp size={12} />
          <span>{parentTitle ?? "Parent unavailable"}</span>
        </button>
      )}
      {running && (
        <button className="subagent-bar-btn stop" onClick={() => void interrupt(threadId)} title="Stop this agent's turn">
          <Square size={11} />
          <span>Stop</span>
        </button>
      )}
    </div>
  );
}
