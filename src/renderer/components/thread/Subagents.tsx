import { memo, useState } from "react";
import { Bot, CornerLeftUp, Square } from "lucide-react";
import { Chevron } from "../ui/Chevron";
import { NO_AGENTS } from "../../state/threads";
import { useThread, useThreadGroup } from "../../state/useThread";
import { agentName, spawnedBy, threadTitle } from "../../state/projects";
import { interrupt, openThread } from "../../state/actions";
import { useUI } from "../../state/ui";
import { STATE_LABEL, StatusDot, threadStateOf, useThreadState } from "../StatusDot";

/**
 * Open a thread mentioned in another (`from`): a subagent from its parent, or the other way round.
 * In Focus mode Alt puts it beside `from`; on the canvas its window goes next to `from`'s.
 */
export function openFrom(e: React.MouseEvent, threadId: string, from: string) {
  e.stopPropagation();
  if (useUI.getState().mode === "focus") openThread(threadId, e.altKey ? { side: true, besideThread: from } : {});
  else openThread(threadId, { besideThread: from });
}

/**
 * The agents a thread spawned, docked on top of its composer: what each is up to, and a way into
 * its thread. Open while any of them works; folded to a line once they're all done.
 */
export const AgentTray = memo(function AgentTray({ threadId }: { threadId: string }) {
  const ids = useThread(threadId, (s) => s.agents[threadId] ?? NO_AGENTS);
  return ids.length ? <Tray threadId={threadId} ids={ids} /> : null;
});

function Tray({ threadId, ids }: { threadId: string; ids: readonly string[] }) {
  const running = useThreadGroup(ids, (s) => ids.filter((id) => threadStateOf(s, id) === "running").length);
  const [unfolded, setUnfolded] = useState<boolean | null>(null);
  const expanded = unfolded ?? running > 0;
  return (
    <div className={`queue-tray agent-tray ${expanded ? "open" : ""}`}>
      <button className="queue-row agent-tray-head" onClick={() => setUnfolded(!expanded)}>
        <Bot size={12} className="queue-icon" />
        <span className="queue-text">
          {ids.length} {ids.length === 1 ? "subagent" : "subagents"}
          {running > 0 && <span className="agent-tray-running"> · {running} working</span>}
        </span>
        <Chevron size={12} className="tool-chev" />
      </button>
      {expanded && ids.map((id) => <AgentRow key={id} agentId={id} from={threadId} />)}
    </div>
  );
}

function AgentRow({ agentId, from }: { agentId: string; from: string }) {
  const title = useThread(agentId, (s) => threadTitle(s.threads[agentId]));
  const state = useThreadState(agentId);
  return (
    <button className="queue-row agent-row" onClick={(e) => openFrom(e, agentId, from)} title={`Open ${title}'s thread`}>
      <StatusDot threadId={agentId} />
      <span className="queue-text">{title}</span>
      {/* An agent with nothing left to do has finished its task. */}
      <span className={`queue-when state-${state}`}>{state === "idle" ? "Done" : STATE_LABEL[state]}</span>
    </button>
  );
}

/**
 * Where a subagent's composer would be. Codex subagents take their instructions from the agent
 * that spawned them, not from you; this says so, leads back to that agent, and can stop a turn.
 */
export function SubagentBar({ threadId }: { threadId: string }) {
  const name = useThread(threadId, (s) => agentName(s.threads[threadId]) ?? "This agent");
  const parentId = useThread(threadId, (s) => spawnedBy(s.threads[threadId]));
  const parentTitle = useThread(parentId ?? "", (s) => (parentId && s.threads[parentId] ? threadTitle(s.threads[parentId]) : null));
  const running = useThread(threadId, (s) => !!s.live[threadId]?.activeTurnId);
  return (
    <div className={`subagent-bar ${running ? "running" : ""}`}>
      <Bot size={13} className="subagent-bar-icon" />
      <span className="subagent-bar-text" title={`${name} takes its instructions from the thread that spawned it, not from you.`}>
        Subagent · takes its instructions from
      </span>
      {parentId && (
        <button className="subagent-bar-btn" onClick={(e) => openFrom(e, parentId, threadId)} disabled={!parentTitle} title={parentTitle ?? undefined}>
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
