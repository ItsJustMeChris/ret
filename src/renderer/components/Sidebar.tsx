import { memo, useCallback, useMemo, useState } from "react";
import { useShallow } from "../lib/shallow";
import { holdCursor } from "../lib/cursorShield";
import {
  Archive,
  Bot,
  ChevronRight,
  EyeOff,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  GitFork,
  AppWindow,
  Columns2,
  Pencil,
  Pin,
  Plus,
  Search,
  X,
  Rows3,
} from "lucide-react";
import { useThreads } from "../state/threads";
import { activeBoard, useUI } from "../state/ui";
import { buildProjects, flattenNode, recencyOf, spawnedBy, threadTitle, type ProjectNode, type ThreadNode } from "../state/projects";
import { addProject, archiveThread, forkThread, newThread, openThread, renameThread, updateProject } from "../state/actions";
import { StatusDot, useThreadState, type ThreadState } from "./StatusDot";
import { Menu, type MenuItem } from "./Menu";
import { bridge, isDesktop } from "../bridge";
import { SidebarFooter } from "./SidebarFooter";
import { ThreadTime } from "./ThreadTime";

const RECENT_LIMIT = 6;

export function Sidebar() {
  const threads = useThreads((s) => s.threads);
  const workspaces = useThreads((s) => s.workspaces);
  const listLoaded = useThreads((s) => s.listLoaded);
  const { projects, threadProject, checkouts } = useUI(useShallow((s) => ({ projects: s.projects, threadProject: s.threadProject, checkouts: s.checkouts })));
  const docked = useUI((s) => s.sidebarOpen);
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const tree = useMemo(() => buildProjects(threads, projects, threadProject, workspaces, checkouts), [threads, projects, threadProject, workspaces, checkouts]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return tree;
    const match = (n: ThreadNode): boolean =>
      threadTitle(n.thread).toLowerCase().includes(q) || n.thread.preview?.toLowerCase().includes(q) || n.children.some(match);
    return tree
      .map((p) => ({ ...p, roots: p.name.toLowerCase().includes(q) ? p.roots : p.roots.filter(match) }))
      .filter((p) => p.roots.length || p.name.toLowerCase().includes(q));
  }, [tree, filter]);

  const showMenu = useCallback((e: React.MouseEvent, items: MenuItem[]) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items });
  }, []);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="search-box">
          <Search size={13} />
          <input placeholder="Filter threads" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {filter && (
            <button className="icon-btn tiny" onClick={() => setFilter("")}>
              <X size={12} />
            </button>
          )}
        </div>
        <button className="icon-btn" title="Add project folder" onClick={() => void addProject()}>
          <FolderPlus size={15} />
        </button>
        {!docked && (
          <button className="icon-btn" title="Pin sidebar (Ctrl+B)" onClick={() => useUI.setState({ sidebarOpen: true })}>
            <Pin size={14} />
          </button>
        )}
      </div>
      <div className="sidebar-scroll">
        {!listLoaded && tree.length === 0 && <div className="sidebar-empty loading-pulse">Loading threads…</div>}
        {listLoaded && tree.length === 0 && (
          <div className="sidebar-empty">
            No threads yet.
            <button className="btn primary" onClick={() => void addProject()}>
              <FolderPlus size={14} /> Add a project
            </button>
          </div>
        )}
        {filtered.map((p) => (
          <ProjectFolder key={p.key} project={p} forceOpen={!!filter} showMenu={showMenu} />
        ))}
      </div>
      <SidebarFooter />
      <ResizeHandle />
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
    </aside>
  );
}

function ResizeHandle() {
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = useUI.getState().sidebarWidth;
    const move = (ev: PointerEvent) => {
      const w = Math.max(220, Math.min(520, startW + ev.clientX - startX));
      useUI.setState({ sidebarWidth: w });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("resizing");
      release();
    };
    document.body.classList.add("resizing");
    const release = holdCursor("col-resize");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return <div className="sidebar-resize" onPointerDown={onPointerDown} />;
}

type ShowMenu = (e: React.MouseEvent, items: MenuItem[]) => void;

const ProjectFolder = memo(function ProjectFolder({ project, forceOpen, showMenu }: { project: ProjectNode; forceOpen: boolean; showMenu: ShowMenu }) {
  const collapsed = useUI((s) => s.projects[project.key]?.collapsed ?? false);
  const showAll = useUI((s) => !!s.showAll[project.key]);
  const [renaming, setRenaming] = useState(false);
  const open = forceOpen || !collapsed;
  const roots = showAll || forceOpen ? project.roots : project.roots.slice(0, RECENT_LIMIT);
  const hidden = project.roots.length - roots.length;

  const toggle = () => updateProject(project.key, { collapsed: !collapsed }, project.path);
  const create = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    newThread(project.key, project.path);
  };

  const menuItems: MenuItem[] = [
    { label: "New thread", icon: <Plus size={14} />, onClick: () => create(), hint: "Ctrl+N" },
    { label: project.conf?.pinned ? "Unpin" : "Pin to top", icon: <Pin size={14} />, onClick: () => updateProject(project.key, { pinned: !project.conf?.pinned }, project.path) },
    { label: "Rename", icon: <Pencil size={14} />, onClick: () => setRenaming(true) },
    ...(isDesktop ? [{ label: "Open folder", icon: <FolderOpen size={14} />, onClick: () => void bridge.shell.openPath(project.path) }] : []),
    {
      label: "Open all in canvas",
      icon: <AppWindow size={14} />,
      onClick: () => {
        useUI.setState({ mode: "canvas" });
        project.roots.slice(0, 8).forEach((r) => openThread(r.thread.id, { mode: "canvas" }));
      },
    },
    { separator: true },
    { label: "Hide project", icon: <EyeOff size={14} />, onClick: () => updateProject(project.key, { hidden: true }, project.path) },
  ];

  return (
    <div className={`project ${open ? "open" : ""}`}>
      <div className="project-head" onClick={toggle} onContextMenu={(e) => showMenu(e, menuItems)} title={project.path}>
        <ChevronRight className="chev" size={13} />
        {open ? <FolderOpen size={14} className="folder-icon" /> : <Folder size={14} className="folder-icon" />}
        {renaming ? (
          <input
            className="title-input"
            autoFocus
            defaultValue={project.name}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              updateProject(project.key, { name: e.target.value.trim() || undefined }, project.path);
              setRenaming(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <span className="project-name">{project.name}</span>
        )}
        {project.conf?.pinned && <Pin size={11} className="muted" />}
        <ProjectActivity project={project} />
        <span className="count">{project.threadCount || ""}</span>
        <button className="icon-btn tiny hover-only" title="New thread" onClick={create}>
          <Plus size={13} />
        </button>
      </div>
      {open && (
        <div className="project-body">
          {roots.map((n) =>
            n.children.length ? (
              <ForkGroup key={n.thread.id} node={n} depth={0} showMenu={showMenu} forceOpen={forceOpen} />
            ) : (
              <ThreadRow key={n.thread.id} node={n} depth={0} showMenu={showMenu} />
            ),
          )}
          {hidden > 0 && (
            <button className="show-more" onClick={() => useUI.setState((s) => ({ showAll: { ...s.showAll, [project.key]: true } }))}>
              Show {hidden} more
            </button>
          )}
          {showAll && project.roots.length > RECENT_LIMIT && !forceOpen && (
            <button className="show-more" onClick={() => useUI.setState((s) => ({ showAll: { ...s.showAll, [project.key]: false } }))}>
              Show less
            </button>
          )}
          {project.roots.length === 0 && (
            <button className="show-more" onClick={() => create()}>
              <Plus size={12} /> Start a thread
            </button>
          )}
        </div>
      )}
    </div>
  );
});

/** Running/attention counts for a collapsed project or fork group. */
function useAggregate(ids: string[]): { running: number; attention: number } {
  return useThreads(
    useShallow((s) => {
      let running = 0;
      let attention = 0;
      const reqThreads = new Set(Object.values(s.requests).map((r) => r.threadId));
      for (const id of ids) {
        if (reqThreads.has(id)) attention++;
        else if (s.live[id]?.activeTurnId || s.external[id] || s.threads[id]?.status.type === "active") running++;
      }
      return { running, attention };
    }),
  );
}

function ProjectActivity({ project }: { project: ProjectNode }) {
  const ids = useMemo(() => project.roots.flatMap((r) => flattenNode(r).map((t) => t.id)), [project.roots]);
  const { running, attention } = useAggregate(ids);
  return (
    <>
      {attention > 0 && <span className="pill attention">{attention}</span>}
      {running > 0 && <span className="pill running">{running}</span>}
    </>
  );
}

function useIsActive(threadId: string) {
  return useUI((s) => {
    if (s.mode === "focus") return s.activeTab === threadId || (!!s.activeTab && s.splits[s.activeTab]?.right === threadId);
    const b = activeBoard(s);
    return b.windows.find((w) => w.id === s.focusedWindow)?.threadId === threadId;
  });
}

function threadMenu(threadId: string, rename: () => void): MenuItem[] {
  return [
    { label: "Open in focus tab", icon: <Rows3 size={14} />, onClick: () => { useUI.setState({ mode: "focus" }); openThread(threadId, { mode: "focus" }); } },
    {
      label: "Open to the side",
      icon: <Columns2 size={14} />,
      hint: "Alt+click",
      onClick: () => {
        useUI.setState({ mode: "focus" });
        openThread(threadId, { mode: "focus", side: true });
      },
    },
    { label: "Open in canvas", icon: <AppWindow size={14} />, onClick: () => { useUI.setState({ mode: "canvas" }); openThread(threadId, { mode: "canvas" }); } },
    { separator: true },
    { label: "Fork", icon: <GitFork size={14} />, onClick: () => void forkThread(threadId) },
    ...(isDesktop && useThreads.getState().threads[threadId]?.gitInfo ? [{ label: "Fork into new worktree", icon: <FolderGit2 size={14} />, onClick: () => void forkThread(threadId, { worktree: true }) }] : []),
    { label: "Rename", icon: <Pencil size={14} />, onClick: rename },
    { separator: true },
    { label: "Archive", icon: <Archive size={14} />, danger: true, onClick: () => void archiveThread(threadId) },
  ];
}

const ForkGroup = memo(function ForkGroup({
  node,
  depth,
  showMenu,
  forceOpen,
  fork,
  parentName,
}: {
  node: ThreadNode;
  depth: number;
  showMenu: ShowMenu;
  forceOpen: boolean;
  fork?: number;
  parentName?: string | null;
}) {
  const id = node.thread.id;
  const expanded = useUI((s) => s.expanded[id] ?? false);
  const open = expanded || forceOpen;
  const ids = useMemo(() => flattenNode(node).map((t) => t.id), [node]);
  const { running, attention } = useAggregate(ids);
  const active = useIsActive(id);
  const [renaming, setRenaming] = useState(false);
  const toggle = () => useUI.setState((s) => ({ expanded: { ...s.expanded, [id]: !expanded } }));

  return (
    <div className={`fork-group ${open ? "open" : ""}`} style={{ "--depth": depth } as React.CSSProperties}>
      <div
        className={`fork-head ${active ? "active" : ""}`}
        onClick={toggle}
        onDoubleClick={() => openThread(id)}
        onContextMenu={(e) => showMenu(e, threadMenu(id, () => setRenaming(true)))}
        data-card="thread"
        data-id={id}
        data-forks={node.forkCount}
      >
        <ChevronRight className="chev" size={12} />
        {node.forkCount ? <FolderGit2 size={13} className="fork-folder" /> : <Bot size={13} className="fork-folder" />}
        {renaming ? (
          <input
            className="title-input"
            autoFocus
            defaultValue={node.thread.name ?? threadTitle(node.thread)}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              const v = e.target.value.trim();
              if (v && v !== node.thread.name) void renameThread(id, v);
              setRenaming(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <span className="row-title">
            {fork != null && (!node.thread.name || node.thread.name === parentName) ? `Fork ${fork}` : threadTitle(node.thread)}
          </span>
        )}
        {attention > 0 && <span className="pill attention">{attention}</span>}
        {running > 0 && <span className="pill running">{running}</span>}
        {node.forkCount > 0 && (
          <span className="count">
            <GitFork size={10} />
            {node.forkCount}
          </span>
        )}
        {node.agentCount > 0 && (
          <span className="count" title={`${node.agentCount} ${node.agentCount === 1 ? "subagent" : "subagents"}`}>
            <Bot size={10} />
            {node.agentCount}
          </span>
        )}
      </div>
      {open && (
        <div className="fork-body">
          <ThreadRow node={node} depth={depth + 1} showMenu={showMenu} label="Original" />
          {forkNumbers(node.children).map(([c, fork]) =>
            c.children.length ? (
              <ForkGroup
                key={c.thread.id}
                node={c}
                depth={depth + 1}
                showMenu={showMenu}
                forceOpen={forceOpen}
                fork={fork}
                parentName={node.thread.name}
              />
            ) : (
              <ThreadRow key={c.thread.id} node={c} depth={depth + 1} showMenu={showMenu} fork={fork} parentName={node.thread.name} />
            ),
          )}
        </div>
      )}
    </div>
  );
});

/** Forks are numbered in the order they were made; subagents go by their own names. */
function forkNumbers(children: ThreadNode[]): [ThreadNode, number | undefined][] {
  let n = 0;
  return children.map((c) => [c, spawnedBy(c.thread) ? undefined : ++n]);
}

const ThreadRow = memo(function ThreadRow({
  node,
  depth,
  showMenu,
  label,
  fork,
  parentName,
}: {
  node: ThreadNode;
  depth: number;
  showMenu: ShowMenu;
  label?: string;
  fork?: number;
  parentName?: string | null;
}) {
  const t = node.thread;
  const active = useIsActive(t.id);
  const worktree = useUI((s) => !!s.worktrees[t.id] || !!s.checkouts[t.cwd]);
  const state: ThreadState = useThreadState(t.id);
  const [renaming, setRenaming] = useState(false);

  // Forks inherit their parent's name; number them unless they were renamed.
  const inherited = fork != null && (!t.name || t.name === parentName);
  const title = label ?? (inherited ? `Fork ${fork}` : threadTitle(t));

  return (
    <div
      className={`thread-row ${active ? "active" : ""} state-${state}`}
      style={{ "--depth": depth } as React.CSSProperties}
      onClick={(e) => openThread(t.id, { side: e.altKey && useUI.getState().mode === "focus" })}
      onContextMenu={(e) => showMenu(e, threadMenu(t.id, () => setRenaming(true)))}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-ret-thread", t.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
      data-card="thread"
      data-id={t.id}
    >
      <StatusDot threadId={t.id} />
      {fork != null && <GitFork size={11} className="fork-glyph" />}
      {spawnedBy(t) && !label && <Bot size={11} className="fork-glyph" />}
      {worktree && <FolderGit2 size={11} className="fork-glyph" />}
      {renaming ? (
        <input
          className="title-input"
          autoFocus
          defaultValue={t.name ?? threadTitle(t)}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== t.name) void renameThread(t.id, v);
            setRenaming(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") setRenaming(false);
          }}
        />
      ) : (
        <span className="row-title">{title}</span>
      )}
      <ThreadTime threadId={t.id} seconds={label ? recencyOf(t) : node.recency} />
    </div>
  );
});
