import { useEffect, useMemo, useRef, useState } from "react";
import { AppWindow, FolderPlus, GitFork, LayoutGrid, MessageSquarePlus, PanelLeft, RefreshCw, Rows3, Scan, Settings, FolderGit2 } from "lucide-react";
import { useUI, activeBoard, isDraft } from "../state/ui";
import { useThreads } from "../state/threads";
import { buildProjects, flattenNode, threadTitle } from "../state/projects";
import { addProject, forkThread, newThread, openThread } from "../state/actions";
import { timeAgo } from "../lib/format";
import { StatusDot } from "./StatusDot";
import { bridge, isDesktop } from "../bridge";
import { fitAll, tidy } from "./canvas/viewport";

interface Entry {
  id: string;
  kind: "thread" | "project" | "command";
  title: string;
  sub?: string;
  icon?: React.ReactNode;
  threadId?: string;
  run: () => void;
}

/** Subsequence fuzzy score; higher is better, -1 means no match. */
function score(q: string, text: string): number {
  if (!q) return 0;
  const t = text.toLowerCase();
  const idx = t.indexOf(q);
  if (idx >= 0) return 100 - idx + (idx === 0 ? 50 : 0);
  let ti = 0;
  let s = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    s += found === ti ? 3 : 1;
    ti = found + 1;
  }
  return s;
}

export function currentThreadId(): string | null {
  const ui = useUI.getState();
  if (ui.mode === "focus") {
    const split = ui.activeTab ? ui.splits[ui.activeTab] : undefined;
    return split && ui.focusedSide === "right" ? split.right : ui.activeTab;
  }
  return activeBoard(ui).windows.find((w) => w.id === ui.focusedWindow)?.threadId ?? null;
}

export function CommandPalette() {
  const open = useUI((s) => s.paletteOpen);
  if (!open) return null;
  return <PaletteInner />;
}

function PaletteInner() {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const threads = useThreads((s) => s.threads);
  const projects = useUI((s) => s.projects);
  const threadProject = useUI((s) => s.threadProject);
  const close = () => useUI.setState({ paletteOpen: false });

  const entries = useMemo<Entry[]>(() => {
    const cur = currentThreadId();
    const curReal = cur && !isDraft(cur) ? cur : null;
    const tree = buildProjects(threads, projects, threadProject);
    const commands: Entry[] = [
      ...tree.slice(0, 30).map((p) => ({
        id: `new:${p.key}`,
        kind: "command" as const,
        title: `New thread in ${p.name}`,
        sub: p.path,
        icon: <MessageSquarePlus size={14} />,
        run: () => newThread(p.key, p.path),
      })),
      { id: "add", kind: "command", title: "Add project folder…", icon: <FolderPlus size={14} />, run: () => void addProject() },
      ...(curReal
        ? [
            { id: "fork", kind: "command" as const, title: "Fork current thread", icon: <GitFork size={14} />, run: () => void forkThread(curReal) },
            ...(isDesktop && threads[curReal]?.gitInfo
              ? [{ id: "forkwt", kind: "command" as const, title: "Fork current thread into new worktree", icon: <FolderGit2 size={14} />, run: () => void forkThread(curReal, { worktree: true }) }]
              : []),
          ]
        : []),
      { id: "focus", kind: "command", title: "Switch to Focus mode", icon: <Rows3 size={14} />, run: () => useUI.setState({ mode: "focus" }) },
      { id: "canvas", kind: "command", title: "Switch to Canvas mode", icon: <AppWindow size={14} />, run: () => useUI.setState({ mode: "canvas" }) },
      { id: "fit", kind: "command", title: "Canvas: fit all windows", icon: <Scan size={14} />, run: () => { useUI.setState({ mode: "canvas" }); requestAnimationFrame(() => fitAll()); } },
      { id: "tidy", kind: "command", title: "Canvas: tidy windows", icon: <LayoutGrid size={14} />, run: () => { useUI.setState({ mode: "canvas" }); requestAnimationFrame(tidy); } },
      { id: "sidebar", kind: "command", title: "Toggle sidebar", icon: <PanelLeft size={14} />, run: () => useUI.setState((s) => ({ sidebarOpen: !s.sidebarOpen })) },
      { id: "update", kind: "command", title: "Check for codex updates", icon: <RefreshCw size={14} />, run: () => void bridge.updater.check() },
      ...(isDesktop
        ? [{ id: "appupdate", kind: "command" as const, title: "Check for Ret updates", icon: <RefreshCw size={14} />, run: () => void bridge.appUpdate.check() }]
        : []),
      { id: "settings", kind: "command", title: "Settings", icon: <Settings size={14} />, run: () => useUI.setState({ settingsOpen: true }) },
    ];
    const projectName = new Map<string, string>();
    for (const p of tree) for (const r of p.roots) for (const t of flattenNode(r)) projectName.set(t.id, p.name);
    const threadEntries: Entry[] = Object.values(threads)
      .sort((a, b) => (b.recencyAt ?? b.updatedAt) - (a.recencyAt ?? a.updatedAt))
      .map((t) => ({
        id: t.id,
        kind: "thread",
        title: threadTitle(t),
        sub: `${projectName.get(t.id) ?? t.cwd} · ${timeAgo(t.recencyAt ?? t.updatedAt)}${t.forkedFromId ? " · fork" : ""}`,
        threadId: t.id,
        run: () => openThread(t.id),
      }));
    return [...threadEntries, ...commands];
  }, [threads, projects, threadProject]);

  const results = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) {
      return [...entries.filter((e) => e.kind === "thread").slice(0, 8), ...entries.filter((e) => e.kind === "command" && !e.id.startsWith("new:")).slice(0, 12)];
    }
    return entries
      .map((e) => ({ e, s: Math.max(score(query, e.title), e.sub ? score(query, e.sub) - 20 : -1) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((x) => x.e);
  }, [entries, q]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    list.current?.querySelector(".pal-item.sel")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const run = (e: Entry | undefined, alt = false) => {
    if (!e) return;
    close();
    if (alt && e.threadId) {
      const other = useUI.getState().mode === "focus" ? "canvas" : "focus";
      useUI.setState({ mode: other });
      openThread(e.threadId, { mode: other });
    } else e.run();
  };

  return (
    <div className="overlay" onPointerDown={close}>
      <div className="palette" onPointerDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          className="pal-input"
          placeholder="Jump to a thread, start one in a project, or run a command…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(results.length - 1, s + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(0, s - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(results[sel], e.altKey);
            } else if (e.key === "Escape") close();
          }}
        />
        <div className="pal-list" ref={list}>
          {results.map((e, i) => (
            <button key={e.id} className={`pal-item ${i === sel ? "sel" : ""}`} onMouseMove={() => setSel(i)} onClick={() => run(e)}>
              <span className="pal-icon">{e.threadId ? <StatusDot threadId={e.threadId} /> : e.icon}</span>
              <span className="pal-title">{e.title}</span>
              {e.sub && <span className="pal-sub">{e.sub}</span>}
            </button>
          ))}
          {results.length === 0 && <div className="pal-empty">No matches</div>}
        </div>
        <div className="pal-foot">
          <span><kbd>↵</kbd> open</span>
          <span><kbd>Alt ↵</kbd> open in {useUI.getState().mode === "focus" ? "canvas" : "focus"}</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
