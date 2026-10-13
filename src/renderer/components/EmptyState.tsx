import { useMemo } from "react";
import { Command, FolderPlus, AppWindow } from "lucide-react";
import { useThreads } from "../state/threads";
import { useUI } from "../state/ui";
import { buildProjects, threadTitle } from "../state/projects";
import { addProject, newThread, openThread } from "../state/actions";
import { StatusDot } from "./StatusDot";
import { ThreadTime } from "./ThreadTime";
import { TokenUsageChart } from "./TokenUsageChart";

export function EmptyState() {
  const threads = useThreads((s) => s.threads);
  const workspaces = useThreads((s) => s.workspaces);
  const projects = useUI((s) => s.projects);
  const threadProject = useUI((s) => s.threadProject);
  const checkouts = useUI((s) => s.checkouts);
  const tree = useMemo(() => buildProjects(threads, projects, threadProject, workspaces, checkouts).slice(0, 6), [threads, projects, threadProject, workspaces, checkouts]);
  const recent = useMemo(
    () =>
      Object.values(threads)
        .sort((a, b) => (b.recencyAt ?? b.updatedAt) - (a.recencyAt ?? a.updatedAt))
        .slice(0, 6),
    [threads],
  );

  return (
    <div className="empty-state">
      <div className="empty-inner">
        <div className="brand-mark">ret</div>
        <p className="muted">A fast workbench for coding agents. Pick up a thread, start one in a project, or lay several out on the canvas.</p>
        <div className="empty-actions">
          <button className="btn" onClick={() => useUI.setState({ paletteOpen: true })}>
            <Command size={14} /> Search everything <kbd>Ctrl K</kbd>
          </button>
          <button className="btn" onClick={() => void addProject()}>
            <FolderPlus size={14} /> Add project
          </button>
          <button className="btn" onClick={() => useUI.setState({ mode: "canvas" })}>
            <AppWindow size={14} /> Canvas <kbd>Ctrl \</kbd>
          </button>
        </div>
        {tree.length > 0 && (
          <div className="empty-grid">
            <div>
              <h4>Start in a project</h4>
              {tree.map((p) => (
                <button key={p.key} className="empty-row" onClick={() => newThread(p.key, p.path)}>
                  <span className="row-title">{p.name}</span>
                  <span className="muted">{p.threadCount}</span>
                </button>
              ))}
            </div>
            <div>
              <h4>Recent threads</h4>
              {recent.map((t) => (
                <button key={t.id} className="empty-row" onClick={() => openThread(t.id)}>
                  <StatusDot threadId={t.id} />
                  <span className="row-title">{threadTitle(t)}</span>
                  <ThreadTime threadId={t.id} seconds={t.recencyAt ?? t.updatedAt} className="muted" />
                </button>
              ))}
            </div>
          </div>
        )}
        <TokenUsageChart />
      </div>
    </div>
  );
}
