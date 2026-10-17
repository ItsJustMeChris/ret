import { memo } from "react";
import { FolderOpen, MessageSquare, Monitor, RotateCcw, SquareTerminal, Trash2 } from "lucide-react";
import { terminalOf, useUI } from "../../state/ui";
import { closeTerminal, restartTerminal, terminalTitle, useTerms, type TermLive } from "../../state/terminals";
import { useThreads } from "../../state/threads";
import { useHosts } from "../../state/hosts";
import { baseName, threadTitle } from "../../state/projects";
import { openThread } from "../../state/actions";
import { TerminalView } from "./TerminalView";

/**
 * A terminal as a window on the canvas: an app of its own, like Inbox and Code. One opened from a
 * thread is that thread's terminal (the same shell its panel shows in Focus) and links back to it;
 * closing the window leaves it with the thread. One opened on the canvas itself ends with its window.
 */
export const TerminalPane = memo(function TerminalPane({
  id: winThreadId,
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
  const id = terminalOf(winThreadId)!;
  const conf = useUI((s) => s.terminals[id]);
  const live = useTerms((s) => s.live[id]);
  const owner = conf?.thread ?? null;
  const ownerTitle = useThreads((s) => (owner ? threadTitle(s.threads[owner]) : null));
  const hostLabel = useHosts((s) => (conf?.host ? (s.hosts[conf.host]?.name ?? "another device") : null));

  return (
    <div className={`thread-pane app-pane app-terminal chrome-window ${focused ? "focused" : ""}`} data-cwd={conf?.cwd}>
      <div
        className="pane-header draggable"
        onPointerDown={onHeaderPointerDown}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("button, input")) return;
          onHeaderDoubleClick();
        }}
      >
        <SquareTerminal size={14} className="app-icon" />
        <div className="pane-title">{terminalTitle(live, conf)}</div>
        {hostLabel && (
          <span className="chip host-chip" title={`Runs on ${hostLabel}`}>
            <Monitor size={11} />
            {hostLabel}
          </span>
        )}
        {conf && (
          <span className="chip path-chip" title={conf.cwd} data-path={conf.cwd}>
            <FolderOpen size={11} />
            {baseName(conf.cwd)}
          </span>
        )}
        {owner && (
          <button className="chip term-owner" title={`${ownerTitle}: go to its thread`} onPointerDown={(e) => e.stopPropagation()} onClick={() => openThread(owner, { mode: "canvas" })}>
            <MessageSquare size={11} />
            <span>{ownerTitle}</span>
          </button>
        )}
        <div className="pane-header-actions" onPointerDown={(e) => e.stopPropagation()}>
          {conf && (
            <>
              <button className="icon-btn" title="New shell" onClick={() => restartTerminal(id)}>
                <RotateCcw size={13} />
              </button>
              <button className="icon-btn" title="End this terminal" onClick={() => closeTerminal(id)}>
                <Trash2 size={13} />
              </button>
            </>
          )}
          {windowControls}
        </div>
      </div>
      <div className="app-win-body">{conf ? <TerminalView id={id} /> : <div className="term-gone">This terminal has ended.</div>}</div>
    </div>
  );
});

function stateText(live: TermLive | undefined): string {
  switch (live?.state) {
    case "running":
      return "Running";
    case "starting":
      return "Starting…";
    case "exited":
      return live.exitCode ? `Exited with code ${live.exitCode}` : "Exited";
    case "failed":
      return "Couldn't start";
    default:
      return "Starts when you look at it";
  }
}

/** Zoomed out: which terminal, where, and whether its shell is running. */
export function TerminalTile({ id: winThreadId, onPointerDown, onDoubleClick }: { id: string; onPointerDown: (e: React.PointerEvent) => void; onDoubleClick: () => void }) {
  const id = terminalOf(winThreadId)!;
  const conf = useUI((s) => s.terminals[id]);
  const live = useTerms((s) => s.live[id]);
  return (
    <div className="tcard app-tile" onPointerDown={onPointerDown} onDoubleClick={onDoubleClick}>
      <div className="tcard-head">
        <SquareTerminal className="tcard-fork" />
        <span className="tcard-title">{terminalTitle(live, conf)}</span>
      </div>
      <div className="tcard-body term-tile-path">{conf?.cwd ?? "Ended"}</div>
      <div className="tcard-state">{conf ? stateText(live) : ""}</div>
    </div>
  );
}
