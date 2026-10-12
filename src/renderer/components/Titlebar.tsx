import { AppWindow, Command, PanelLeft, Rows3 } from "lucide-react";
import { useUI } from "../state/ui";
import { useConn } from "../state/conn";
import { useThreads } from "../state/threads";
import { bridge } from "../bridge";

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
  const codex = useConn((s) => s.codex);
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
        </div>
      </div>
      <button className="tb-search" onClick={() => useUI.setState({ paletteOpen: true })}>
        <Command size={12} />
        <span>Search threads, projects, commands</span>
        <kbd>Ctrl K</kbd>
      </button>
      <div className="tb-right">
        <GlobalActivity />
        {codex && codex.state !== "running" && (
          <span className={`conn conn-${codex.state}`} data-card="codex">
            {codex.state === "starting" ? "Starting codex…" : codex.state === "missing" ? "Installing codex…" : "codex offline"}
          </span>
        )}
      </div>
    </header>
  );
}
