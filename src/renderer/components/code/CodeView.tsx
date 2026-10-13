import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronRight, File as FileIcon, FileCode2, Folder, FolderOpen, MessageSquarePlus, RefreshCw, X } from "lucide-react";
import { fsClient } from "../../rpc/client";
import { useThreads } from "../../state/threads";
import { useUI, filePath, isDraft, isFile } from "../../state/ui";
import { useFiles } from "../../state/files";
import { buildProjects, projectIndex, projectKeyFor, recencyOf, threadTitle } from "../../state/projects";
import { closeCodeTab, newThread, openFile } from "../../state/actions";
import { timeAgo } from "../../lib/format";
import { ThreadPane } from "../thread/ThreadPane";
import { FilePane } from "./FilePane";
import { Select } from "../ui/Select";

type Change = "add" | "update" | "delete";
type Entry = { name: string; dir: boolean };

/** Folders that are usually noise: listed, but dimmed. */
const QUIET = /^(node_modules|\.git|dist|build|out|target|\.venv|venv|__pycache__|\.next|\.turbo|\.cache|release)$/;

const sep = (root: string) => (root.includes("\\") ? "\\" : "/");
const join = (dir: string, name: string) => (dir.endsWith("\\") || dir.endsWith("/") ? dir + name : dir + sep(dir) + name);
const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

/**
 * Code mode: the project's files on the left, open files in the middle (Monaco), and one of the
 * project's threads on the right to talk to. Files the agent touches in that thread are marked in the
 * tree, and open files reload as it edits them.
 */
export function CodeView() {
  const code = useUI((s) => s.code);
  const projects = useUI((s) => s.projects);
  const threadProject = useUI((s) => s.threadProject);
  const drafts = useUI((s) => s.drafts);
  const threads = useThreads((s) => s.threads);
  const workspaces = useThreads((s) => s.workspaces);

  // Coming in with nothing to talk to: pick up where Focus mode was, else the latest thread.
  useEffect(() => {
    const ui = useUI.getState();
    if (ui.code.chat && (isDraft(ui.code.chat) ? ui.drafts[ui.code.chat] : threads[ui.code.chat])) return;
    const tab = ui.activeTab && !isFile(ui.activeTab) ? ui.activeTab : null;
    const latest = Object.values(threads).sort((a, b) => recencyOf(b) - recencyOf(a))[0]?.id ?? null;
    const chat = tab ?? latest;
    if (chat && chat !== ui.code.chat) useUI.setState((s) => ({ code: { ...s.code, chat } }));
  }, [threads]);

  const list = useMemo(() => buildProjects(threads, projects, threadProject, workspaces), [threads, projects, threadProject, workspaces]);

  // The project shown: picked explicitly, else the chat thread's.
  const project = useMemo(() => {
    if (code.project) return list.find((p) => p.key === code.project) ?? null;
    const chat = code.chat;
    if (!chat) return null;
    if (isDraft(chat)) {
      const d = drafts[chat];
      return d ? (list.find((p) => p.key === d.projectKey) ?? { key: d.projectKey, path: d.cwd, name: d.cwd, roots: [], threadCount: 0, recency: 0, conf: null }) : null;
    }
    const t = threads[chat];
    if (!t) return null;
    const key = projectKeyFor(t, threads, projectIndex(projects, workspaces), threadProject);
    return list.find((p) => p.key === key) ?? null;
  }, [code.project, code.chat, list, drafts, threads, projects, threadProject, workspaces]);
  const root = project?.path ?? null;

  // What the chat thread has changed, for the tree's markers.
  const changeList = useThreads(
    useShallow((s) => {
      const lt = code.chat ? s.live[code.chat] : undefined;
      if (!lt) return [] as string[];
      const out: string[] = [];
      for (const it of Object.values(lt.items)) {
        if (it?.type !== "fileChange") continue;
        for (const c of it.changes) out.push(`${c.kind.type}|${c.path}`);
      }
      return out;
    }),
  );
  const changed = useMemo(() => {
    const m = new Map<string, Change>();
    for (const row of changeList) {
      const i = row.indexOf("|");
      m.set(norm(row.slice(i + 1)), row.slice(0, i) as Change);
    }
    return m;
  }, [changeList]);

  const setWidth = (key: "explorerWidth" | "chatWidth", px: number) => useUI.setState((s) => ({ code: { ...s.code, [key]: px } }));

  return (
    <div className="code-view" style={{ gridTemplateColumns: `${code.explorerWidth}px 6px minmax(0, 1fr) 6px ${code.chatWidth}px` }}>
      <aside className="code-explorer">
        <div className="code-explorer-head">
          <Select
            variant="field"
            value={project?.key ?? ""}
            placeholder="Choose a project"
            options={list.map((p) => ({ value: p.key, label: p.name, description: p.path }))}
            onChange={(key) => {
              // Switching projects brings that project's latest thread into the chat.
              const p = list.find((x) => x.key === key);
              const latest = p?.roots.map((r) => r.thread).sort((a, b) => recencyOf(b) - recencyOf(a))[0];
              useUI.setState((s) => ({ code: { ...s.code, project: key, chat: latest?.id ?? s.code.chat } }));
            }}
            menuMinWidth={280}
          />
        </div>
        {root ? <Tree root={root} changed={changed} chat={code.chat} /> : <div className="code-empty">Pick a project to see its files.</div>}
      </aside>
      <Gutter onDrag={(dx) => setWidth("explorerWidth", Math.max(180, Math.min(520, useUI.getState().code.explorerWidth + dx)))} />
      <section className="code-editor">
        <CodeTabs />
        {code.active && isFile(code.active) ? (
          <FilePane key={code.active} id={code.active} chrome="focus" focused />
        ) : (
          <div className="code-empty big">
            <FileCode2 size={28} />
            <strong>Open a file from the explorer</strong>
            <span>…or click one the agent mentions in the chat. Files reload as it edits them.</span>
          </div>
        )}
      </section>
      <Gutter onDrag={(dx) => setWidth("chatWidth", Math.max(320, Math.min(900, useUI.getState().code.chatWidth - dx)))} />
      <aside className="code-chat">
        <ChatHead project={project} chat={code.chat} />
        {code.chat ? <ThreadPane key={code.chat} threadId={code.chat} chrome="focus" focused /> : <div className="code-empty">No thread yet.</div>}
      </aside>
    </div>
  );
}

function Gutter({ onDrag }: { onDrag: (dx: number) => void }) {
  return (
    <div
      className="code-gutter"
      onPointerDown={(e) => {
        e.preventDefault();
        const el = e.currentTarget;
        el.setPointerCapture(e.pointerId);
        let last = e.clientX;
        const move = (ev: PointerEvent) => {
          onDrag(ev.clientX - last);
          last = ev.clientX;
        };
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
      }}
    />
  );
}

/** The project's threads to talk to (most recent first), and a new one. */
function ChatHead({ project, chat }: { project: { key: string; path: string; roots: { thread: { id: string } }[] } | null; chat: string | null }) {
  const threads = useThreads((s) => s.threads);
  const options = useMemo(() => {
    const own = project ? project.roots.map((r) => threads[r.thread.id]).filter(Boolean) : [];
    const sorted = own.sort((a, b) => recencyOf(b) - recencyOf(a)).slice(0, 40);
    const opts = sorted.map((t) => ({ value: t.id, label: threadTitle(t), description: timeAgo(recencyOf(t)) }));
    if (chat && !opts.some((o) => o.value === chat)) opts.unshift({ value: chat, label: isDraft(chat) ? "New thread" : threadTitle(threads[chat]), description: "" });
    return opts;
  }, [project, threads, chat]);
  return (
    <div className="code-chat-head">
      <Select variant="field" value={chat ?? ""} options={options} placeholder="Choose a thread" onChange={(id) => useUI.setState((s) => ({ code: { ...s.code, chat: id } }))} menuMinWidth={320} />
      {project && (
        <button className="icon-btn" title="New thread in this project" onClick={() => newThread(project.key, project.path, { mode: "code" })}>
          <MessageSquarePlus size={15} />
        </button>
      )}
    </div>
  );
}

/** Open files, like an editor's tab bar. */
function CodeTabs() {
  const tabs = useUI((s) => s.code.tabs);
  const active = useUI((s) => s.code.active);
  const dirty = useFiles((s) => s.dirty);
  if (!tabs.length) return null;
  return (
    <div className="code-tabs" role="tablist">
      {tabs.map((id) => {
        const path = filePath(id);
        return (
          <div
            key={id}
            role="tab"
            aria-selected={id === active}
            className={`code-tab ${id === active ? "active" : ""}`}
            data-path={path}
            onClick={() => useUI.setState((s) => ({ code: { ...s.code, active: id } }))}
            onAuxClick={(e) => e.button === 1 && closeCodeTab(id)}
          >
            <FileCode2 size={12} />
            <span>{path.split(/[\\/]/).pop()}</span>
            {dirty[id] ? <span className="cv-dirty" /> : null}
            <button
              className="code-tab-close"
              aria-label="Close"
              onClick={(e) => {
                e.stopPropagation();
                closeCodeTab(id);
              }}
            >
              <X size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** The project's folder tree, read lazily through the app-server. */
function Tree({ root, changed, chat }: { root: string; changed: Map<string, Change>; chat: string | null }) {
  const expanded = useUI((s) => s.code.expanded);
  const active = useUI((s) => s.code.active);
  const [dirs, setDirs] = useState<Record<string, Entry[] | "loading" | { error: string }>>({});
  const loaded = useRef(dirs);
  loaded.current = dirs;

  const read = async (dir: string) => {
    setDirs((d) => ({ ...d, [dir]: d[dir] && d[dir] !== "loading" ? d[dir] : "loading" }));
    try {
      const res = (await fsClient().request("fs/readDirectory", { path: dir })) as { entries: { fileName: string; isDirectory: boolean }[] };
      const entries = res.entries
        .map((e) => ({ name: e.fileName, dir: e.isDirectory }))
        .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.dir ? -1 : 1));
      setDirs((d) => ({ ...d, [dir]: entries }));
    } catch (err) {
      setDirs((d) => ({ ...d, [dir]: { error: (err as Error).message } }));
    }
  };

  // The root, and every folder left open.
  useEffect(() => {
    setDirs({});
    void read(root);
    for (const dir of Object.keys(useUI.getState().code.expanded)) if (norm(dir).startsWith(norm(root) + "/")) void read(dir);
  }, [root]);

  // The agent added or removed files: refresh the folders they're in.
  const changeKey = [...changed.keys()].join("\n");
  useEffect(() => {
    const parents = new Set<string>();
    for (const p of changed.keys()) parents.add(p.slice(0, p.lastIndexOf("/")));
    for (const dir of Object.keys(loaded.current)) if (parents.has(norm(dir))) void read(dir);
  }, [changeKey]);

  const toggle = (dir: string) => {
    const open = !!useUI.getState().code.expanded[dir];
    useUI.setState((s) => {
      const next = { ...s.code.expanded };
      if (open) delete next[dir];
      else next[dir] = true;
      return { code: { ...s.code, expanded: next } };
    });
    if (!open && !loaded.current[dir]) void read(dir);
  };

  /** Folders holding changed files get a dot. */
  const dirtyDirs = useMemo(() => {
    const set = new Set<string>();
    for (const p of changed.keys()) {
      let d = p.slice(0, p.lastIndexOf("/"));
      while (d.length > norm(root).length) {
        set.add(d);
        d = d.slice(0, d.lastIndexOf("/"));
      }
    }
    return set;
  }, [changed, root]);

  const activePath = active && isFile(active) ? norm(filePath(active)) : null;
  const rows: React.ReactNode[] = [];
  const walk = (dir: string, depth: number) => {
    const entries = dirs[dir];
    if (entries === "loading" || entries === undefined) {
      rows.push(<div key={dir + "…"} className="tree-row muted" style={{ paddingLeft: 10 + depth * 14 }}>Loading…</div>);
      return;
    }
    if ("error" in entries) {
      rows.push(<div key={dir + "!"} className="tree-row err" style={{ paddingLeft: 10 + depth * 14 }}>{entries.error}</div>);
      return;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      const key = norm(path);
      const quiet = QUIET.test(e.name) || e.name.startsWith(".");
      if (e.dir) {
        const open = !!expanded[path];
        rows.push(
          <div key={path} className={`tree-row dir ${quiet ? "quiet" : ""}`} style={{ paddingLeft: 6 + depth * 14 }} onClick={() => toggle(path)} data-path={path}>
            <ChevronRight size={12} className={`tree-chev ${open ? "open" : ""}`} />
            {open ? <FolderOpen size={13} className="tree-icon" /> : <Folder size={13} className="tree-icon" />}
            <span className="tree-name">{e.name}</span>
            {dirtyDirs.has(key) && <span className="tree-dot" />}
          </div>,
        );
        if (open) walk(path, depth + 1);
      } else {
        const change = changed.get(key);
        rows.push(
          <div
            key={path}
            className={`tree-row file ${quiet ? "quiet" : ""} ${key === activePath ? "active" : ""} ${change ? `changed-${change}` : ""}`}
            style={{ paddingLeft: 6 + depth * 14 + 16 }}
            onClick={() => openFile(path, { from: chat })}
            data-path={path}
          >
            <FileIcon size={13} className="tree-icon" />
            <span className="tree-name">{e.name}</span>
            {change && <span className="tree-change">{change === "add" ? "A" : change === "delete" ? "D" : "M"}</span>}
          </div>,
        );
      }
    }
  };
  walk(root, 0);

  return (
    <div className="code-tree">
      <div className="tree-root">
        <span className="tree-root-name" title={root}>
          {root.split(/[\\/]/).filter(Boolean).pop()}
        </span>
        <button className="icon-btn" title="Refresh" onClick={() => Object.keys(loaded.current).forEach((d) => void read(d))}>
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="tree-rows">{rows}</div>
    </div>
  );
}

