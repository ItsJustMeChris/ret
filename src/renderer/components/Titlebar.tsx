import { AppWindow, Code2, Command, Inbox, PanelLeft, Rows3 } from "lucide-react";
import { useUI } from "../state/ui";
import { useInboxCount } from "./inbox/InboxView";
import { useConn, useEnabledProviders } from "../state/conn";
import { PROVIDERS } from "../agents";
import { useThreads } from "../state/threads";
import { bridge } from "../bridge";

/** Dragging a mode button onto the canvas makes that view a window there. */
export const DRAG_APP = "application/x-ret-app";

function GlobalActivity() {
  const running = useThreads((s) => {
    const ids = new Set(Object.keys(s.external));
    for (const [id, l] of Object.entries(s.live)) if (l.activeTurnId) ids.add(id);
    return ids.size;
  });
  const attention = useThreads((s) => Object.keys(s.requests).length);
  if (!running && !attention) return null;
  return (
    <div className="global-activity">
      {attention > 0 && (
        <span className="pill attention" title="Threads waiting on you">
          {attention} waiting
        </span>
      )}
      {running > 0 && (
        <span className="pill running" title="Threads working">
          {running} running
        </span>
      )}
    </div>
  );
}

export function Titlebar() {
  const mode = useUI((s) => s.mode);
  const inboxCount = useInboxCount();
  const sidebarOpen = useUI((s) => s.sidebarOpen);
  const engines = useConn((s) => s.providers);
  const enabled = useEnabledProviders();
  const isMac = bridge.platform === "darwin";

  return (
    <header className={`titlebar ${isMac ? "mac" : ""}`}>
      <div className="tb-left">
        <button className="icon-btn" title="Toggle sidebar (Ctrl+B)" onClick={() => useUI.setState({ sidebarOpen: !sidebarOpen })}>
          <PanelLeft size={15} />
        </button>
        <span className="brand">ret</span>
        <div className="segmented" role="tablist">
          <button className={mode === "focus" ? "on" : ""} onClick={() => useUI.setState({ mode: "focus" })} title="Focus mode — tabs (Ctrl+\)">
            <Rows3 size={13} /> Focus
          </button>
          <button className={mode === "canvas" ? "on" : ""} onClick={() => useUI.setState({ mode: "canvas" })} title="Canvas mode — windows (Ctrl+\)">
            <AppWindow size={13} /> Canvas
          </button>
          <button
            className={mode === "code" ? "on" : ""}
            onClick={() => useUI.setState({ mode: "code" })}
            title="Code mode — the project's files beside a thread (Alt+3). Drag onto the canvas to make it a window."
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_APP, "code");
              e.dataTransfer.effectAllowed = "copy";
            }}
          >
            <Code2 size={13} /> Code
          </button>
          <button
            className={mode === "inbox" ? "on" : ""}
            onClick={() => useUI.setState({ mode: "inbox" })}
            title="Inbox — everything that needs you, across projects (Alt+4). Drag onto the canvas to make it a window."
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_APP, "inbox");
              e.dataTransfer.effectAllowed = "copy";
            }}
          >
            <Inbox size={13} /> Inbox
            {inboxCount > 0 && <span className="seg-badge">{inboxCount}</span>}
          </button>
        </div>
      </div>
      <button className="tb-search" onClick={() => useUI.setState({ paletteOpen: true })}>
        <Command size={12} />
        <span>Search threads, projects, commands</span>
        <kbd>Ctrl K</kbd>
      </button>
      <div className="tb-right">
        <GlobalActivity />
        {enabled.map((p) => {
          const st = engines[p].status;
          if (!st || st.state === "running" || st.state === "disabled") return null;
          const name = PROVIDERS[p].name;
          const label =
            st.state === "starting" ? `Starting ${name}…` : st.state === "missing" ? (p === "codex" ? "Installing Codex…" : `${name} not found`) : `${name} offline`;
          return (
            <span key={p} className={`conn conn-${st.state}`} data-card="engine" data-provider={p}>
              {label}
            </span>
          );
        })}
      </div>
    </header>
  );
}
