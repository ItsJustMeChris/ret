import { AppWindow, Command, PanelLeft, Rows3 } from "lucide-react";
import { useUI } from "../state/ui";
import { MODE_APPS, VIEW_MODES } from "../apps";
import { useConn, useSetUpProviders } from "../state/conn";
import { PROVIDERS } from "../agents";
import { useThreads } from "../state/threads";
import { bridge } from "../bridge";

/** Dragging an app's mode button onto the canvas makes that view a window there (the data is its kind). */
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
  const sidebarOpen = useUI((s) => s.sidebarOpen);
  const engines = useConn((s) => s.providers);
  const enabled = useSetUpProviders();
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
          {MODE_APPS.map((app) => (
            <button
              key={app.kind}
              className={mode === app.kind ? "on" : ""}
              onClick={() => useUI.setState({ mode: app.kind })}
              title={`${app.mode.hint} (Alt+${VIEW_MODES.indexOf(app.kind) + 1}). Drag onto the canvas to make it a window.`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_APP, app.kind);
                e.dataTransfer.effectAllowed = "copy";
              }}
            >
              <app.icon size={13} /> {app.name}
              {app.Badge && <app.Badge />}
            </button>
          ))}
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
          if (!st || st.state === "running") return null;
          const name = PROVIDERS[p].name;
          const label =
            st.state === "starting" ? `Starting ${name}…` : st.state === "missing" ? "Installing Codex…" : `${name} offline`;
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
