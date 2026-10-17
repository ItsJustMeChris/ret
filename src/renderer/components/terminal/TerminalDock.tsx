import { memo, useRef } from "react";
import { ChevronDown, Plus, SquareTerminal, Trash2, X } from "lucide-react";
import { useUI } from "../../state/ui";
import {
  closeTerminal,
  focusTerminal,
  hideDock,
  newThreadTerminal,
  showInDock,
  terminalTitle,
  useTerms,
  useThreadTerminals,
} from "../../state/terminals";
import { holdCursor } from "../../lib/cursorShield";
import { TerminalView } from "./TerminalView";

const MIN_H = 110;
/** What the thread keeps above it, at least. */
const ROOM_ABOVE = 160;

/**
 * A thread's terminals, in a panel at the bottom of its view (Focus, the Inbox, and under the editor
 * in Code): each a shell in the thread's folder, on its device. Tabs for several; the panel's height
 * is shared by every thread.
 */
export const TerminalDock = memo(function TerminalDock({ threadId }: { threadId: string }) {
  const open = useUI((s) => !!s.termDocks[threadId]?.open);
  const chosen = useUI((s) => s.termDocks[threadId]?.active ?? null);
  const height = useUI((s) => s.termHeight);
  const ids = useThreadTerminals(threadId);
  const box = useRef<HTMLDivElement>(null);
  if (!open || !ids.length) return null;
  const active = chosen && ids.includes(chosen) ? chosen : ids[ids.length - 1];

  const onGripDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !box.current) return;
    e.preventDefault();
    const grip = e.currentTarget as HTMLElement;
    grip.setPointerCapture(e.pointerId);
    const el = box.current;
    const start = { y: e.clientY, h: el.offsetHeight };
    const max = Math.max(MIN_H, (el.parentElement?.clientHeight ?? 600) - ROOM_ABOVE);
    let h = start.h;
    const release = holdCursor("row-resize");
    const move = (ev: PointerEvent) => {
      h = Math.round(Math.min(max, Math.max(MIN_H, start.h - (ev.clientY - start.y))));
      el.style.height = `${h}px`;
    };
    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("lostpointercapture", up);
      release();
      useUI.setState({ termHeight: h });
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("lostpointercapture", up);
  };

  return (
    <div className="term-dock" ref={box} style={{ height }}>
      <div className="term-grip" onPointerDown={onGripDown} />
      <div className="term-bar">
        <div className="term-tabs" role="tablist">
          {ids.map((id) => (
            <DockTab key={id} id={id} threadId={threadId} active={id === active} />
          ))}
          <button
            className="icon-btn tiny"
            title="New terminal (Ctrl+Shift+`)"
            onClick={() => {
              const id = newThreadTerminal(threadId);
              if (id) focusTerminal(id);
            }}
          >
            <Plus size={13} />
          </button>
        </div>
        <div className="term-bar-actions">
          <button className="icon-btn tiny" title="End this terminal" onClick={() => closeTerminal(active)}>
            <Trash2 size={13} />
          </button>
          <button className="icon-btn tiny" title="Hide (Ctrl+`)" onClick={() => hideDock(threadId)}>
            <ChevronDown size={14} />
          </button>
        </div>
      </div>
      <div className="term-dock-body">
        <TerminalView key={active} id={active} />
      </div>
    </div>
  );
});

function DockTab({ id, threadId, active }: { id: string; threadId: string; active: boolean }) {
  const live = useTerms((s) => s.live[id]);
  const conf = useUI((s) => s.terminals[id]);
  const done = live?.state === "exited" || live?.state === "failed";
  return (
    <div
      role="tab"
      aria-selected={active}
      className={`term-tab ${active ? "active" : ""} ${done ? "done" : ""}`}
      title={conf?.cwd}
      onClick={() => showInDock(threadId, id)}
      onAuxClick={(e) => e.button === 1 && closeTerminal(id)}
    >
      <SquareTerminal size={12} />
      <span className="term-tab-title">{terminalTitle(live, conf)}</span>
      <button
        className="term-tab-close"
        aria-label="End terminal"
        onClick={(e) => {
          e.stopPropagation();
          closeTerminal(id);
        }}
      >
        <X size={11} />
      </button>
    </div>
  );
}
