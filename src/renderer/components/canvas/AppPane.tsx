import { memo } from "react";
import { Code2, Inbox } from "lucide-react";
import { appKind, useUI } from "../../state/ui";
import { InboxView, useInboxCount } from "../inbox/InboxView";
import { CodeView } from "../code/CodeView";
import { filePath } from "../../state/ui";

const NAMES = { inbox: "Inbox", code: "Code" } as const;

/** Inbox or Code as a window on the canvas desktop: the same view as its mode, framed. */
export const AppPane = memo(function AppPane({
  id,
  focused,
  onHeaderPointerDown,
  onHeaderDoubleClick,
  windowControls,
}: {
  id: string;
  focused: boolean;
  onHeaderPointerDown: (e: React.PointerEvent) => void;
  onHeaderDoubleClick: () => void;
  windowControls: React.ReactNode;
}) {
  const kind = appKind(id);
  const count = useInboxCount();
  return (
    <div className={`thread-pane app-pane app-${kind} chrome-window ${focused ? "focused" : ""}`}>
      <div
        className="pane-header draggable"
        onPointerDown={onHeaderPointerDown}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("button, input")) return;
          onHeaderDoubleClick();
        }}
      >
        {kind === "inbox" ? <Inbox size={14} className="app-icon" /> : <Code2 size={14} className="app-icon" />}
        <div className="pane-title">{NAMES[kind]}</div>
        {kind === "inbox" && count > 0 && <span className="seg-badge">{count}</span>}
        {kind === "inbox" && focused && (
          <span className="inbox-keys">
            <kbd>j</kbd>
            <kbd>k</kbd> move · <kbd>e</kbd> done
          </span>
        )}
        <div className="pane-header-actions" onPointerDown={(e) => e.stopPropagation()}>
          {windowControls}
        </div>
      </div>
      <div className="app-win-body">{kind === "inbox" ? <InboxView active={focused} /> : <CodeView />}</div>
    </div>
  );
});

/** Zoomed out: what the app is up to, at a glance. */
export function AppTile({ id, onPointerDown, onDoubleClick }: { id: string; onPointerDown: (e: React.PointerEvent) => void; onDoubleClick: () => void }) {
  const kind = appKind(id);
  const count = useInboxCount();
  const active = useUI((s) => s.code.active);
  const tabs = useUI((s) => s.code.tabs.length);
  return (
    <div className="tcard app-tile" onPointerDown={onPointerDown} onDoubleClick={onDoubleClick}>
      <div className="tcard-head">
        {kind === "inbox" ? <Inbox className="tcard-fork" /> : <Code2 className="tcard-fork" />}
        <span className="tcard-title">{NAMES[kind]}</span>
      </div>
      <div className="tcard-body">
        {kind === "inbox"
          ? count
            ? `${count} thing${count === 1 ? "" : "s"} need${count === 1 ? "s" : ""} you`
            : "All clear"
          : active
            ? filePath(active).split(/[\\/]/).pop()
            : "No file open"}
      </div>
      <div className="tcard-state">{kind === "code" && tabs ? `${tabs} open` : ""}</div>
    </div>
  );
}
