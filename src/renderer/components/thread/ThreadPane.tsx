import { memo, useEffect, useRef, useState } from "react";
import {
  Archive,
  ChevronDown,
  FolderGit2,
  Folder,
  FolderOpen,
  Monitor,
  FolderPlus,
  GitBranch,
  GitFork,
  Layers,
  Pencil,
  PanelRight,
  Paperclip,
  SquareTerminal,
} from "lucide-react";
import { hostOfThread, useThreads, markAttended, markVisible } from "../../state/threads";
import { useThread } from "../../state/useThread";
import { addFilesToThread } from "../../state/attach";
import { viewFile } from "../../lib/viewFile";
import { openFileRef, resolvePath } from "../../lib/files";
import { useUI, isDraft } from "../../state/ui";
import { addProject, archiveThread, compactThread, forkThread, hydrateThread, renameThread, retargetDraft } from "../../state/actions";
import { baseName, takesDirectInput, threadTitle } from "../../state/projects";
import { useProjectTree } from "../../state/projectTree";
import { hostOfView } from "../../state/projectTree";
import { hostName, useHosts } from "../../state/hosts";
import { useSizeClass, type SizeClass } from "../../lib/useSize";
import { Transcript } from "./Transcript";
import { Composer } from "./Composer";
import { SubagentBar } from "./Subagents";
import { Details, useDetails } from "./Details";
import { DETAILS } from "../../lib/threadDetails";
import { RequestCard } from "./Approvals";
import { ScreenGlance, useLiveScreen } from "./ComputerUse";
import { bridge, isDesktop } from "../../bridge";
import { Menu, type MenuItem } from "../Menu";
import { StatusDot } from "../StatusDot";
import { compactNumber, plainText } from "../../lib/format";
import { Select, type SelectOption } from "../ui/Select";
import { useShown, useVisibility } from "../ui/Kept";
import { TerminalDock } from "../terminal/TerminalDock";
import { openThreadTerminalWindow, toggleDock, useThreadTerminalRunning } from "../../state/terminals";

interface Props {
  threadId: string;
  chrome: "focus" | "window";
  focused?: boolean;
  onHeaderPointerDown?: (e: React.PointerEvent) => void;
  onHeaderDoubleClick?: () => void;
  windowControls?: React.ReactNode;
  /** The size class it'll most likely have, when it's built before it's shown (a canvas window off screen). */
  initialSize?: SizeClass;
  /** Its terminal panel goes elsewhere (Code mode puts it under the editor). */
  dockless?: boolean;
}

export const ThreadPane = memo(function ThreadPane(props: Props) {
  const { threadId } = props;
  const ref = useRef<HTMLDivElement>(null);
  const size = useSizeClass(ref, props.initialSize);
  const details = useDetails(threadId, size, ref);
  // A subagent that asks you something still gets the composer, which is where questions are answered.
  const directInput = useThread(
    threadId,
    (s) => takesDirectInput(s.threads[threadId]) || Object.values(s.requests).some((r) => r.threadId === threadId && r.method === "item/tool/requestUserInput"),
  );
  // Relative file references in this thread resolve against its working directory.
  const cwd = useThread(threadId, (s) => s.threads[threadId]?.cwd) ?? useUI.getState().drafts[threadId]?.cwd;

  useEffect(() => {
    if (isDraft(threadId)) return;
    markVisible(threadId, 1);
    void hydrateThread(threadId); // panes restored from a previous session load lazily
    return () => markVisible(threadId, -1);
  }, [threadId]);

  // A focus-mode pane is what you're reading (while it shows); canvas windows count once clicked (CanvasWindow).
  const shown = useShown(props.chrome === "focus");
  const attends = props.chrome === "focus" && !isDraft(threadId) && shown;
  useEffect(() => {
    if (!attends) return;
    markAttended(threadId, 1);
    return () => markAttended(threadId, -1);
  }, [threadId, attends]);

  // Files dragged in from the file manager (or a browser) drop anywhere on the pane.
  const [dropping, setDropping] = useState(false);
  const dragDepth = useRef(0);
  // (Not on a subagent's: there's no message to add them to.)
  const carriesFiles = (e: React.DragEvent) => directInput && e.dataTransfer.types.includes("Files");
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

  // A file path anywhere in the transcript (tool steps, edits, attachments, paths written as code),
  // or in the details' changes, opens in Ret's viewer; Ctrl+click opens it in VS Code or its app,
  // Alt+click reveals it. Runs before the path's row would fold or unfold. File links in replies
  // handle themselves.
  const onPathClick = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const el = (e.target as Element).closest<HTMLElement>(":is(.transcript, .details-files) [data-path]");
    if (!el?.dataset.path || el.closest("a.file-link, .thread-img")) return;
    if (!window.getSelection()?.isCollapsed) return; // finishing a text selection, not a click
    e.preventDefault();
    e.stopPropagation();
    const fileRef = { path: el.dataset.path, line: Number(el.dataset.line) || undefined, col: Number(el.dataset.col) || undefined };
    const host = hostOfView(threadId);
    if (e.altKey) void bridge.shell.reveal(resolvePath(fileRef.path, cwd), host);
    else if (e.ctrlKey || e.metaKey) void openFileRef(fileRef, cwd, host);
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
      <Header {...props} size={size} details={details} />
      {isDraft(threadId) ? (
        <DraftBody threadId={threadId} size={size} />
      ) : size === "glance" ? (
        <Glance threadId={threadId} />
      ) : (
        <div className="pane-body">
          <div className="pane-main">
            <TranscriptFor threadId={threadId} />
            {directInput ? (
              <Composer
                threadId={threadId}
                compact={size === "compact"}
                autoFocus={props.focused && props.chrome === "focus"}
                // The docked details list the subagents; the Dynamic Island keeps its room for the rest.
                agentsListed={details.docked && details.open}
              />
            ) : (
              <SubagentBar threadId={threadId} />
            )}
          </div>
          {/* Docked and peeking are different panels: going from one to the other, neither animates. */}
          <Details key={details.docked ? "docked" : "peek"} threadId={threadId} docked={details.docked} open={details.open} />
        </div>
      )}
      {/* On the canvas a thread's terminal is a window of its own. */}
      {props.chrome === "focus" && !props.dockless && size !== "glance" && <TerminalDock threadId={threadId} />}
    </div>
  );
});

/** The thread's "…" menu; canvas windows show the same on right-click. */
export function threadMoreItems(threadId: string, rename: () => void): MenuItem[] {
  const thread = useThreads.getState().threads[threadId];
  const cwd = thread?.cwd ?? "";
  return [
    { label: "Rename", icon: <Pencil size={14} />, onClick: rename },
    // Compacting starts a turn: a subagent only takes those from the agent that spawned it.
    ...(takesDirectInput(thread) ? [{ label: "Compact context", icon: <Layers size={14} />, onClick: () => void compactThread(threadId) }] : []),
    // A paired device's folder can't be opened here.
    ...(isDesktop && cwd && !hostOfView(threadId) ? [{ label: "Open folder", icon: <FolderOpen size={14} />, onClick: () => void bridge.shell.openPath(cwd) }] : []),
    { label: "Archive", icon: <Archive size={14} />, onClick: () => void archiveThread(threadId), danger: true },
  ];
}

function TranscriptFor({ threadId }: { threadId: string }) {
  const cwd = useThread(threadId, (s) => s.threads[threadId]?.cwd ?? null);
  return <Transcript threadId={threadId} cwd={cwd} />;
}

function Header({
  threadId,
  chrome,
  onHeaderPointerDown,
  onHeaderDoubleClick,
  windowControls,
  size,
  details,
}: Props & { size: SizeClass; details: { open: boolean; toggle: () => void } }) {
  const thread = useThread(threadId, (s) => s.threads[threadId]);
  const draft = useUI((s) => s.drafts[threadId]);
  const worktree = useUI((s) => s.worktrees[threadId]);
  const usage = useThread(threadId, (s) => s.live[threadId]?.tokenUsage);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const title = draft ? "New thread" : threadTitle(thread);
  const cwd = thread?.cwd ?? draft?.cwd ?? "";
  const branch = worktree?.branch ?? thread?.gitInfo?.branch;
  // A paired device's thread says where it runs, wherever it's shown.
  const host = useThread(threadId, () => hostOfView(threadId));
  const hostLabel = useHosts((s) => (host ? (s.hosts[host]?.name ?? "another device") : null));

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
  const visibility = useVisibility();
  useEffect(() => {
    const onRename = (e: Event) => visibility.shown && (e as CustomEvent<string>).detail === threadId && startRename();
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
      {hostLabel && size !== "glance" && (
        <span className="chip host-chip" title={`Runs on ${hostLabel}`}>
          <Monitor size={11} />
          {size !== "compact" && hostLabel}
        </span>
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
        {size !== "glance" && <TerminalButton threadId={threadId} chrome={chrome} />}
        {!draft && size !== "glance" && (
          <button
            className={`icon-btn details-btn ${details.open ? "on" : ""}`}
            title={`${details.open ? DETAILS.hide : DETAILS.show} (Ctrl+Alt+B)`}
            aria-pressed={details.open}
            onClick={details.toggle}
          >
            <PanelRight size={14} />
          </button>
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

/**
 * The thread's terminal: its panel, below (Focus, Code, the Inbox), or its window beside it (canvas).
 * A dot says one is running while it's out of sight.
 */
function TerminalButton({ threadId, chrome }: { threadId: string; chrome: Props["chrome"] }) {
  const open = useUI((s) => chrome === "focus" && !!s.termDocks[threadId]?.open);
  const running = useThreadTerminalRunning(threadId);
  return (
    <button
      className={`icon-btn term-btn ${open ? "on" : ""}`}
      title={chrome === "focus" ? `${open ? "Hide" : "Show"} terminal (Ctrl+\`)` : "Open its terminal beside it (Ctrl+`)"}
      onClick={() => (chrome === "focus" ? toggleDock(threadId) : openThreadTerminalWindow(threadId))}
    >
      <SquareTerminal size={14} />
      {running && !open && <span className="term-btn-dot" />}
    </button>
  );
}

/** Tiny windows: just enough to monitor and unblock a thread. */
function Glance({ threadId }: { threadId: string }) {
  const last = useThread(threadId, (s) => {
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
  const preview = useThread(threadId, (s) => s.threads[threadId]?.preview);
  const req = useThread(threadId, (s) => Object.values(s.requests).find((r) => r.threadId === threadId));
  const screen = useLiveScreen(threadId);
  return (
    <div className="glance">
      {req ? (
        <RequestCard req={req} compact />
      ) : screen?.shot ? (
        <ScreenGlance screen={screen.screen} shot={screen.shot} host={hostOfThread(threadId)} />
      ) : (
        <div className="glance-text">{plainText(last ?? preview ?? "", 600)}</div>
      )}
    </div>
  );
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
  const tree = useProjectTree();
  // With paired devices, each device's projects come under its name (a draft moved to one runs there).
  const multi = tree.some((p) => p.host);
  const options: SelectOption[] = tree.map((p) => ({
    value: p.key,
    label: p.name,
    description: p.path,
    icon: <Folder size={13} />,
    ...(multi ? { group: hostName(p.host) } : {}),
  }));
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
