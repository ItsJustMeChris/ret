import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import {
  Archive,
  ChevronDown,
  CornerLeftUp,
  FolderGit2,
  Folder,
  FolderOpen,
  FolderPlus,
  GitBranch,
  GitFork,
  Layers,
  Pencil,
  PanelRight,
  Paperclip,
} from "lucide-react";
import { useThreads, markAttended, markVisible } from "../../state/threads";
import { addFilesToThread } from "../../state/attach";
import { viewFile } from "../../lib/viewFile";
import { openFileRef, resolvePath } from "../../lib/files";
import { useUI, isDraft } from "../../state/ui";
import { addProject, archiveThread, compactThread, forkThread, hydrateThread, openThread, renameThread, retargetDraft } from "../../state/actions";
import { baseName, buildProjects, threadTitle } from "../../state/projects";
import { useSizeClass, type SizeClass } from "../../lib/useSize";
import { Transcript } from "./Transcript";
import { Composer } from "./Composer";
import { DiffView } from "./Items";
import { RequestCard } from "./Approvals";
import { bridge, isDesktop } from "../../bridge";
import { Menu, type MenuItem } from "../Menu";
import { StatusDot } from "../StatusDot";
import { PROVIDERS } from "../../agents";
import { diffStats, compactNumber, plainText } from "../../lib/format";
import { Markdown } from "../Markdown";
import { Select, type SelectOption } from "../ui/Select";

interface Props {
  threadId: string;
  chrome: "focus" | "window";
  focused?: boolean;
  onHeaderPointerDown?: (e: React.PointerEvent) => void;
  onHeaderDoubleClick?: () => void;
  windowControls?: React.ReactNode;
}

export const ThreadPane = memo(function ThreadPane(props: Props) {
  const { threadId } = props;
  const ref = useRef<HTMLDivElement>(null);
  const size = useSizeClass(ref);
  const showDetails = useUI((s) => s.showDetails);
  // Relative file references in this thread resolve against its working directory.
  const cwd = useThreads((s) => s.threads[threadId]?.cwd) ?? useUI.getState().drafts[threadId]?.cwd;

  useEffect(() => {
    if (isDraft(threadId)) return;
    markVisible(threadId, 1);
    void hydrateThread(threadId); // panes restored from a previous session load lazily
    return () => markVisible(threadId, -1);
  }, [threadId]);

  // A focus-mode pane is what you're reading; canvas windows count once clicked (CanvasWindow).
  const attends = props.chrome === "focus" && !isDraft(threadId);
  useEffect(() => {
    if (!attends) return;
    markAttended(threadId, 1);
    return () => markAttended(threadId, -1);
  }, [threadId, attends]);

  // Files dragged in from the file manager (or a browser) drop anywhere on the pane.
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  const carriesFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");
  const drop = {
    onDragEnter: (e: React.DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      dragDepth.current++;
      setDropping(true);
    },
    onDragOver: (e: React.DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!carriesFiles(e)) return;
      if (--dragDepth.current <= 0) {
        dragDepth.current = 0;
        setDropping(false);
      }
    },
    onDrop: (e: React.DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepth.current = 0;
      setDropping(false);
      void addFilesToThread(threadId, Array.from(e.dataTransfer.files));
    },
  };

  // A file path anywhere in the transcript (tool steps, edits, attachments, paths written as code)
  // opens in Ret's viewer; Ctrl+click opens it in VS Code or its app, Alt+click reveals it. Runs
  // before the path's row would fold or unfold. File links in replies handle themselves.
  const onPathClick = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const el = (e.target as Element).closest<HTMLElement>(".transcript [data-path]");
    if (!el?.dataset.path || el.closest("a.file-link, .thread-img")) return;
    if (!window.getSelection()?.isCollapsed) return; // finishing a text selection, not a click
    e.preventDefault();
    e.stopPropagation();
    const fileRef = { path: el.dataset.path, line: Number(el.dataset.line) || undefined, col: Number(el.dataset.col) || undefined };
    if (e.altKey) void bridge.shell.reveal(resolvePath(fileRef.path, cwd));
    else if (e.ctrlKey || e.metaKey) void openFileRef(fileRef, cwd);
    else void viewFile(fileRef, cwd, threadId);
  };

  return (
    <div
      ref={ref}
      className={`thread-pane size-${size} chrome-${props.chrome} ${props.focused ? "focused" : ""}`}
      data-cwd={cwd}
      data-thread={threadId}
      onClickCapture={onPathClick}
      {...drop}
    >
      {dropping && (
        <div className="drop-zone">
          <div className="drop-card">
            <Paperclip size={18} />
            <strong>Drop to add to your message</strong>
            <span>Images are attached; other files and folders are added as paths.</span>
          </div>
        </div>
      )}
      <Header {...props} size={size} />
      {isDraft(threadId) ? (
        <DraftBody threadId={threadId} size={size} />
      ) : size === "glance" ? (
        <Glance threadId={threadId} />
      ) : (
        <div className="pane-body">
          <div className="pane-main">
            <TranscriptFor threadId={threadId} />
            <Composer threadId={threadId} compact={size === "compact"} autoFocus={props.focused && props.chrome === "focus"} />
          </div>
          {size === "wide" && showDetails && <SidePanel threadId={threadId} />}
        </div>
      )}
    </div>
  );
});

/** The thread's "…" menu; canvas windows show the same on right-click. */
export function threadMoreItems(threadId: string, rename: () => void): MenuItem[] {
  const cwd = useThreads.getState().threads[threadId]?.cwd ?? "";
  return [
    { label: "Rename", icon: <Pencil size={14} />, onClick: rename },
    { label: "Compact context", icon: <Layers size={14} />, onClick: () => void compactThread(threadId) },
    {
      label: useUI.getState().showDetails ? "Hide details panel" : "Show details panel",
      icon: <PanelRight size={14} />,
      hint: "wide panes",
      onClick: () => useUI.setState((s) => ({ showDetails: !s.showDetails })),
    },
    ...(isDesktop && cwd ? [{ label: "Open folder", icon: <FolderOpen size={14} />, onClick: () => void bridge.shell.openPath(cwd) }] : []),
    { label: "Archive", icon: <Archive size={14} />, onClick: () => void archiveThread(threadId), danger: true },
  ];
}

function TranscriptFor({ threadId }: { threadId: string }) {
  const cwd = useThreads((s) => s.threads[threadId]?.cwd ?? null);
  return <Transcript threadId={threadId} cwd={cwd} />;
}

function Header({ threadId, chrome, onHeaderPointerDown, onHeaderDoubleClick, windowControls, size }: Props & { size: SizeClass }) {
  const thread = useThreads((s) => s.threads[threadId]);
  const draft = useUI((s) => s.drafts[threadId]);
  const worktree = useUI((s) => s.worktrees[threadId]);
  const usage = useThreads((s) => s.live[threadId]?.tokenUsage);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const title = draft ? "New thread" : threadTitle(thread);
  const cwd = thread?.cwd ?? draft?.cwd ?? "";
  const branch = worktree?.branch ?? thread?.gitInfo?.branch;

  const startRename = () => {
    if (!thread) return;
    setName(thread.name ?? title);
    setEditing(true);
  };

  const forkMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.left,
      y: r.bottom + 4,
      items: [
        { label: "Fork conversation", icon: <GitFork size={14} />, onClick: () => void forkThread(threadId), hint: "Ctrl+Shift+F" },
        ...(isDesktop && thread?.gitInfo
          ? [{ label: "Fork into new worktree", icon: <FolderGit2 size={14} />, onClick: () => void forkThread(threadId, { worktree: true }) }]
          : []),
      ],
    });
  };

  // A canvas window's right-click menu asks its header to start the inline rename.
  useEffect(() => {
    const onRename = (e: Event) => (e as CustomEvent<string>).detail === threadId && startRename();
    window.addEventListener("ret:rename-thread", onRename);
    return () => window.removeEventListener("ret:rename-thread", onRename);
  });

  const moreMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ x: r.right - 200, y: r.bottom + 4, items: threadMoreItems(threadId, startRename) });
  };

  const ctxPct =
    usage?.modelContextWindow && usage.last ? Math.min(100, Math.round((usage.last.inputTokens / usage.modelContextWindow) * 100)) : null;

  return (
    <div
      className={`pane-header ${onHeaderPointerDown ? "draggable" : ""}`}
      onPointerDown={onHeaderPointerDown}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest("button, input")) return;
        onHeaderDoubleClick?.();
      }}
    >
      <StatusDot threadId={threadId} />
      {editing ? (
        <input
          className="title-input"
          autoFocus
          value={name}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && name.trim()) {
              void renameThread(threadId, name.trim());
              setEditing(false);
            } else if (e.key === "Escape") setEditing(false);
          }}
        />
      ) : (
        <div className="pane-title" onDoubleClick={chrome === "focus" ? startRename : undefined} title={title}>
          {title}
        </div>
      )}
      {!draft && size !== "glance" && size !== "compact" && cwd && (
        <span className="chip path-chip" title={cwd} data-path={cwd}>
          {worktree ? <FolderGit2 size={11} /> : <FolderOpen size={11} />}
          {baseName(cwd)}
          {branch && (
            <>
              <GitBranch size={11} />
              {branch}
            </>
          )}
        </span>
      )}
      <div className="pane-header-actions" onPointerDown={(e) => e.stopPropagation()}>
        {ctxPct != null && size !== "glance" && (
          <span className="ctx-meter" title={`Context: ${compactNumber(usage!.last.inputTokens)} / ${compactNumber(usage!.modelContextWindow!)} tokens`}>
            <svg viewBox="0 0 20 20" width="16" height="16">
              <circle cx="10" cy="10" r="8" className="ctx-track" />
              <circle cx="10" cy="10" r="8" className="ctx-fill" strokeDasharray={`${(ctxPct / 100) * 50.27} 50.27`} />
            </svg>
            {size === "wide" && <span>{ctxPct}%</span>}
          </span>
        )}
        {!draft && (
          <button className="icon-btn" title="Fork" onClick={forkMenu}>
            <GitFork size={14} />
            {size !== "compact" && size !== "glance" && <ChevronDown size={11} />}
          </button>
        )}
        {!draft && (
          <button className="icon-btn" title="More" onClick={moreMenu}>
            <span className="dots">⋯</span>
          </button>
        )}
        {windowControls}
      </div>
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** Tiny windows: just enough to monitor and unblock a thread. */
function Glance({ threadId }: { threadId: string }) {
  const last = useThreads((s) => {
    const lt = s.live[threadId];
    if (!lt) return null;
    for (let i = lt.turnOrder.length - 1; i >= 0; i--) {
      const turn = lt.turns[lt.turnOrder[i]];
      for (let j = turn.itemIds.length - 1; j >= 0; j--) {
        const it = lt.items[turn.itemIds[j]];
        if (it?.type === "agentMessage" && it.text) return it.text;
      }
    }
    return null;
  });
  const preview = useThreads((s) => s.threads[threadId]?.preview);
  const req = useThreads((s) => Object.values(s.requests).find((r) => r.threadId === threadId));
  return (
    <div className="glance">
      {req ? (
        <RequestCard req={req} compact />
      ) : (
        <div className="glance-text">{plainText(last ?? preview ?? "", 600)}</div>
      )}
    </div>
  );
}

function SidePanel({ threadId }: { threadId: string }) {
  const lastTurn = useThreads((s) => {
    const lt = s.live[threadId];
    if (!lt) return null;
    for (let i = lt.turnOrder.length - 1; i >= 0; i--) {
      const t = lt.turns[lt.turnOrder[i]];
      if (t.plan || t.diff) return t;
    }
    return null;
  });
  const usage = useThreads((s) => s.live[threadId]?.tokenUsage);
  const [openDiff, setOpenDiff] = useState(false);
  const files = lastTurn?.diff ? splitDiff(lastTurn.diff) : [];
  return (
    <aside className="side-panel">
      {lastTurn?.plan && (
        <section>
          <h4>Plan</h4>
          {lastTurn.plan.explanation && <Markdown text={lastTurn.plan.explanation} className="md-muted" />}
          {lastTurn.plan.steps.map((s, i) => (
            <div key={i} className={`plan-step ${s.status}`}>
              <span className="plan-dot" />
              {s.step}
            </div>
          ))}
        </section>
      )}
      {files.length > 0 && (
        <section>
          <h4>
            Changes <span className="muted">· last turn</span>
          </h4>
          {files.map((f) => {
            const st = diffStats(f.diff);
            return (
              <div key={f.path} className="side-file">
                <span className="path">{f.path}</span>
                <span className="stat">
                  <span className="add">+{st.add}</span>
                  <span className="del">−{st.del}</span>
                </span>
              </div>
            );
          })}
          <button className="link" onClick={() => setOpenDiff(!openDiff)}>
            {openDiff ? "Hide diff" : "Show full diff"}
          </button>
          {openDiff && lastTurn?.diff && <DiffView diff={lastTurn.diff} />}
        </section>
      )}
      {usage && (
        <section>
          <h4>Tokens</h4>
          <div className="kv-row">
            <span>Total</span>
            <span>{compactNumber(usage.total.totalTokens)}</span>
          </div>
          <div className="kv-row">
            <span>Cached input</span>
            <span>{compactNumber(usage.total.cachedInputTokens)}</span>
          </div>
          <div className="kv-row">
            <span>Reasoning</span>
            <span>{compactNumber(usage.total.reasoningOutputTokens)}</span>
          </div>
        </section>
      )}
      <ThreadInfo threadId={threadId} />
    </aside>
  );
}

/** Thread facts plus fork lineage: jump to the parent or any fork without hunting in the sidebar. */
function ThreadInfo({ threadId }: { threadId: string }) {
  const thread = useThreads((s) => s.threads[threadId]);
  const parent = useThreads((s) => (thread?.forkedFromId ? s.threads[thread.forkedFromId] : undefined));
  const forks = useThreads(
    useShallow((s) =>
      Object.values(s.threads)
        .filter((t) => t.forkedFromId === threadId)
        .sort((a, b) => a.createdAt - b.createdAt),
    ),
  );
  const worktree = useUI((s) => s.worktrees[threadId]);
  const owner = useThreads((s) => s.owner[threadId] ?? "codex");
  if (!thread) return null;
  return (
    <section>
      <h4>Thread</h4>
      <div className="kv-row">
        <span>Agent</span>
        <span>{PROVIDERS[owner].name}</span>
      </div>
      <div className="kv-row">
        <span>Model</span>
        <span>
          {thread.model ?? "—"}
          {thread.reasoningEffort ? ` · ${thread.reasoningEffort}` : ""}
        </span>
      </div>
      <div className="kv-row">
        <span>Started</span>
        <span>{new Date(thread.createdAt * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
      </div>
      {(worktree?.branch ?? thread.gitInfo?.branch) && (
        <div className="kv-row">
          <span>Branch</span>
          <span className="mono">{worktree?.branch ?? thread.gitInfo?.branch}</span>
        </div>
      )}
      <div className="kv-row">
        <span>Folder</span>
        <span className="mono ellipsis" title={thread.cwd} data-path={thread.cwd}>
          {baseName(thread.cwd)}
        </span>
      </div>
      {thread.forkedFromId && (
        <button className="lineage" onClick={() => openThread(thread.forkedFromId!)} disabled={!parent}>
          <CornerLeftUp size={12} /> Forked from <span>{parent ? threadTitle(parent) : "an unavailable thread"}</span>
        </button>
      )}
      {forks.length > 0 && (
        <>
          <h4 className="sub-h">Forks · {forks.length}</h4>
          {forks.map((f, i) => (
            <button key={f.id} className="lineage" onClick={() => openThread(f.id)}>
              <StatusDot threadId={f.id} />
              <span>{f.name && f.name !== thread.name ? f.name : `Fork ${i + 1}`}</span>
            </button>
          ))}
        </>
      )}
    </section>
  );
}

function splitDiff(diff: string): { path: string; diff: string }[] {
  const out: { path: string; diff: string }[] = [];
  const chunks = diff.split(/^(?=diff --git )/m);
  for (const c of chunks) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(c);
    if (m) out.push({ path: m[2], diff: c });
  }
  return out;
}

/** A thread that hasn't started yet: pick the project, write the first message. */
function DraftBody({ threadId, size }: { threadId: string; size: SizeClass }) {
  const draft = useUI((s) => s.drafts[threadId]);
  if (!draft) return <div className="pane-body center muted">This draft was closed.</div>;
  const compact = size === "compact";
  return (
    <div className={`pane-body draft ${compact ? "compact" : ""}`}>
      <div className="draft-inner">
        <div className="draft-head">
          <span className="draft-label">New thread in</span>
          <ProjectPicker threadId={threadId} projectKey={draft.projectKey} cwd={draft.cwd} />
        </div>
        {!compact && (
          <div className="draft-cwd" title={draft.cwd} data-path={draft.cwd}>
            {draft.cwd}
          </div>
        )}
        <Composer threadId={threadId} autoFocus compact={compact} />
        {!compact && (
          <div className="draft-hint">
            <kbd>Enter</kbd> to start · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
          </div>
        )}
      </div>
    </div>
  );
}

const PICK_FOLDER = "\u0000pick";

function ProjectPicker({ threadId, projectKey, cwd }: { threadId: string; projectKey: string; cwd: string }) {
  const threads = useThreads((s) => s.threads);
  const workspaces = useThreads((s) => s.workspaces);
  const projects = useUI((s) => s.projects);
  const threadProject = useUI((s) => s.threadProject);
  const tree = useMemo(() => buildProjects(threads, projects, threadProject, workspaces), [threads, projects, threadProject, workspaces]);
  const options: SelectOption[] = tree.map((p) => ({ value: p.key, label: p.name, description: p.path, icon: <Folder size={13} /> }));
  if (!options.some((o) => o.value === projectKey)) {
    options.unshift({ value: projectKey, label: baseName(cwd), description: cwd, icon: <Folder size={13} /> });
  }
  if (isDesktop) options.push({ value: PICK_FOLDER, label: "Other folder…", icon: <FolderPlus size={13} /> });
  return (
    <Select
      value={projectKey}
      options={options}
      menuMinWidth={320}
      className="draft-project"
      title="Project"
      onChange={async (key) => {
        if (key === PICK_FOLDER) {
          const added = await addProject();
          const conf = added ? useUI.getState().projects[added] : null;
          if (added && conf) retargetDraft(threadId, added, conf.path);
          return;
        }
        const p = tree.find((x) => x.key === key);
        if (p) retargetDraft(threadId, p.key, p.path);
      }}
    />
  );
}
