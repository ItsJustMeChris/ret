import { memo } from "react";
import { Clock, CornerDownRight, Pencil, X } from "lucide-react";
import { useThread } from "../../state/useThread";
import { discardQueued, editQueued, steerQueued } from "../../state/actions";
import { IslandList } from "./IslandList";

/**
 * Follow-ups waiting for the running turn to end, in the thread's Dynamic Island.
 * Each can be pushed into the running turn now, pulled back to edit, or dropped.
 */
export const QueueTray = memo(function QueueTray({ threadId }: { threadId: string }) {
  const queued = useThread(threadId, (s) => s.queued[threadId]);
  if (!queued?.length) return null;
  return (
    <div className="queue-tray">
      <IslandList className="island-list">
        {queued.map((m, i) => (
          <div key={m.id} className="queue-row">
            <Clock size={12} className="queue-icon" />
            <span className="queue-text" title={m.text}>
              {m.text.replace(/\s+/g, " ").trim() || `${m.attachments.length} image${m.attachments.length === 1 ? "" : "s"}`}
            </span>
            {m.attachments.length > 0 && m.text.trim() && <span className="queue-files">+{m.attachments.length}</span>}
            <span className={`queue-when ${i === 0 ? "next" : ""}`}>{i === 0 ? "next" : `#${i + 1}`}</span>
            <div className="queue-actions">
              <button className="icon-btn tiny" title="Steer the running turn with this now" onClick={() => steerQueued(threadId, m.id)}>
                <CornerDownRight size={12} />
              </button>
              <button className="icon-btn tiny" title="Edit (moves it back into the box)" onClick={() => editQueued(threadId, m.id)}>
                <Pencil size={12} />
              </button>
              <button className="icon-btn tiny" title="Remove from queue" onClick={() => discardQueued(threadId, m.id)}>
                <X size={12} />
              </button>
            </div>
          </div>
        ))}
      </IslandList>
    </div>
  );
});
