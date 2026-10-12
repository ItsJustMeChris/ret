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
} from "lucide-react";
import { useThreads, markVisible } from "../../state/threads";
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

  return (
    <div ref={ref} className={`thread-pane size-${size} chrome-${props.chrome} ${props.focused ? "focused" : ""}`} data-cwd={cwd}>
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

  const moreMenu = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.right - 200,
      y: r.bottom + 4,
      items: [
        { label: "Rename", icon: <Pencil size={14} />, onClick: startRename },
        { label: "Compact context", icon: <Layers size={14} />, onClick: () => void compactThread(threadId) },
        {
          label: useUI.getState().showDetails ? "Hide details panel" : "Show details panel",
          icon: <PanelRight size={14} />,
          hint: "wide panes",
          onClick: () => useUI.setState((s) => ({ showDetails: !s.showDetails })),
        },
        ...(isDesktop ? [{ label: "Open folder", icon: <FolderOpen size={14} />, onClick: () => void bridge.shell.openPath(cwd) }] : []),
        { label: "Archive", icon: <Archive size={14} />, onClick: () => void archiveThread(threadId), danger: true },
      ],
    });
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
  if (!thread) return null;
  return (
    <section>
      <h4>Thread</h4>
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
  const projects = useUI((s) => s.projects);
  const threadProject = useUI((s) => s.threadProject);
  const tree = useMemo(() => buildProjects(threads, projects, threadProject), [threads, projects, threadProject]);
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
