import { memo } from "react";
import { Code2, Inbox } from "lucide-react";
import { appKind, useUI } from "../../state/ui";
import { InboxView } from "../inbox/InboxView";
import { useInboxCount } from "../../state/inbox";
import { CodeView } from "../code/CodeView";
import { filePath } from "../../state/ui";
import { TerminalPane, TerminalTile } from "../terminal/TerminalWindow";

const NAMES = { inbox: "Inbox", code: "Code" } as const;

type PaneProps = {
  id: string;
  focused: boolean;
  onHeaderPointerDown: (e: React.PointerEvent) => void;
  onHeaderDoubleClick: () => void;
  windowControls: React.ReactNode;
};

/**
 * One of Ret's views as a window on the canvas desktop: Inbox or Code (its mode's view as it is there,
 * under a window title bar), or a terminal.
 */
export const AppPane = memo(function AppPane(props: PaneProps) {
  return appKind(props.id) === "terminal" ? <TerminalPane {...props} /> : <ModePane {...props} />;
});

function ModePane({ id, focused, onHeaderPointerDown, onHeaderDoubleClick, windowControls }: PaneProps) {
  const kind = appKind(id) as "inbox" | "code";
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
        <div className="pane-header-actions" onPointerDown={(e) => e.stopPropagation()}>
          {windowControls}
        </div>
      </div>
      <div className="app-win-body">{kind === "inbox" ? <InboxView active={focused} /> : <CodeView />}</div>
    </div>
  );
}

type TileProps = { id: string; onPointerDown: (e: React.PointerEvent) => void; onDoubleClick: () => void };

/** Zoomed out: what the app is up to, at a glance. */
export function AppTile(props: TileProps) {
  return appKind(props.id) === "terminal" ? <TerminalTile {...props} /> : <ModeTile {...props} />;
}

function ModeTile({ id, onPointerDown, onDoubleClick }: TileProps) {
  const kind = appKind(id) as "inbox" | "code";
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
