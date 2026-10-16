import { memo, useState } from "react";
import { Bot, CornerLeftUp, Square } from "lucide-react";
import { Chevron } from "../ui/Chevron";
import { NO_AGENTS } from "../../state/threads";
import { useThread, useThreadGroup } from "../../state/useThread";
import { agentName, spawnedBy, threadTitle } from "../../state/projects";
import { interrupt, openThread } from "../../state/actions";
import { useUI } from "../../state/ui";
import { shallowEqual } from "../../lib/shallow";
import { STATE_LABEL, StatusDot, threadStateOf, useThreadState, type ThreadState } from "../StatusDot";
import { IslandList } from "./IslandList";

/**
 * Open a thread mentioned in another (`from`): a subagent from its parent, or the other way round.
 * In Focus mode Alt puts it beside `from`; on the canvas its window goes next to `from`'s.
 */
export function openFrom(e: React.MouseEvent, threadId: string, from: string) {
  e.stopPropagation();
  if (useUI.getState().mode === "focus") openThread(threadId, e.altKey ? { side: true, besideThread: from } : {});
  else openThread(threadId, { besideThread: from });
}

/** An agent that matters right now: at work, or waiting on you. */
const CURRENT = new Set<ThreadState>(["running", "attention"]);

/** The agents a thread spawned that are at work or waiting on you (the rest are done with). */
export function useActiveAgents(threadId: string): readonly string[] {
  const ids = useThread(threadId, (s) => s.agents[threadId] ?? NO_AGENTS);
  return useThreadGroup(
    ids,
    (s) => {
      const current = ids.filter((id) => CURRENT.has(threadStateOf(s, id)));
      return current.length === ids.length ? ids : current.length ? current : NO_AGENTS;
    },
    shallowEqual,
  );
}

/**
 * The agents a thread has out that are working or need you (`ids`), in its Dynamic Island: what each
 * is up to, and a way into its thread. One that's done leaves.
 */
export const AgentTray = memo(function AgentTray({ threadId, ids }: { threadId: string; ids: readonly string[] }) {
  const asking = useThreadGroup(ids, (s) => ids.filter((id) => threadStateOf(s, id) === "attention").length);
  const working = ids.length - asking;
  const [folded, setFolded] = useState(false);
  return (
    <div className={`queue-tray agent-tray ${folded ? "" : "open"}`}>
      <button className="queue-row agent-tray-head" onClick={() => setFolded(!folded)}>
        <Bot size={12} className="queue-icon" />
        <span className="queue-text">
          {ids.length} {ids.length === 1 ? "subagent" : "subagents"}
          {asking ? (
            <>
              {working > 0 && <span className="agent-tray-running"> · {working} working</span>}
              <span className="agent-tray-asking">
                {" "}
                · {asking} {asking === 1 ? "needs" : "need"} your input
              </span>
            </>
          ) : (
            <span className="agent-tray-running"> working</span>
          )}
        </span>
        <Chevron size={12} className="tool-chev" />
      </button>
      <IslandList className="island-list">{!folded && ids.map((id) => <AgentRow key={id} agentId={id} from={threadId} />)}</IslandList>
    </div>
  );
});

function AgentRow({ agentId, from }: { agentId: string; from: string }) {
  const title = useThread(agentId, (s) => threadTitle(s.threads[agentId]));
  const state = useThreadState(agentId);
  return (
    <button className="queue-row agent-row" onClick={(e) => openFrom(e, agentId, from)} title={`Open ${title}'s thread`}>
      <StatusDot threadId={agentId} />
      <span className="queue-text">{title}</span>
      {/* One with nothing left to do (seen on its way out) has finished its task. */}
      <span className={`queue-when state-${state}`}>{state === "idle" || state === "unread" ? "Done" : STATE_LABEL[state]}</span>
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
