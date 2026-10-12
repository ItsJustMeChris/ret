import { memo, useEffect, useRef, useState } from "react";
import { Check, Copy, ExternalLink, FileCode2, FileWarning, FolderOpen, LoaderCircle, Pencil, RotateCw, Save } from "lucide-react";
import type * as Monaco from "monaco-editor/editor/editor.api.js";
import { rpc } from "../../rpc/client";
import { bridge, isDesktop } from "../../bridge";
import { copyText, openFileRef, revealLabel } from "../../lib/files";
import { shortPath } from "../../lib/format";
import { toast } from "../../state/toasts";
import { filePath } from "../../state/ui";
import { fileBuffers, setFileDirty, useFiles, watchPath } from "../../state/files";
import { useConn } from "../../state/conn";

const MAX_BYTES = 8 * 1024 * 1024;

type MonacoModule = typeof import("../../lib/monaco");
let monacoModule: Promise<MonacoModule> | null = null;
const loadMonaco = () => (monacoModule ??= import("../../lib/monaco"));

/** Through the app-server, so it works in the desktop app and the web build alike. */
async function readText(path: string): Promise<{ text: string } | { binary: true } | { large: number }> {
  if (isDesktop) {
    const st = await bridge.files.stat(path);
    if (!st.exists) throw new Error("File not found");
    if (st.isDir) throw new Error("That's a folder");
    if (st.size && st.size > MAX_BYTES) return { large: st.size };
  }
  const res = (await rpc.request("fs/readFile", { path })) as { dataBase64: string };
  const raw = atob(res.dataBase64);
  if (raw.length > MAX_BYTES) return { large: raw.length };
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  if (bytes.subarray(0, 8000).includes(0)) return { binary: true };
  return { text: new TextDecoder("utf-8").decode(bytes) };
}

async function writeText(path: string, text: string) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  await rpc.request("fs/writeFile", { path, dataBase64: btoa(bin) });
}

const fmtSize = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const theme = () => (document.documentElement.dataset.theme === "light" ? "ret-light" : "ret-dark");

/** The lines that differ between two versions: everything between the common start and end. */
function changedLines(before: string, after: string): { from: number; to: number } | null {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--;
    endB--;
  }
  if (start > endB) return start < b.length ? { from: start + 1, to: start + 1 } : null; // only deletions
  return { from: start + 1, to: endB + 1 };
}

type Load =
  | { kind: "loading" }
  | { kind: "ready"; lines: number; language: string }
  | { kind: "binary" }
  | { kind: "large"; size: number }
  | { kind: "error"; message: string };

interface Props {
  id: string;
  chrome: "focus" | "window";
  focused?: boolean;
  onHeaderPointerDown?: (e: React.PointerEvent) => void;
  onHeaderDoubleClick?: () => void;
  windowControls?: React.ReactNode;
}

/**
 * A file open as its own view: a tab or split side in Focus mode, a window on the canvas. The
 * file is in Monaco (VS Code's editor), read-only until you choose Edit; Ctrl+S saves. Unsaved
 * edits and the scroll position survive switching away and back.
 */
export const FilePane = memo(function FilePane({ id, chrome, focused, onHeaderPointerDown, onHeaderDoubleClick, windowControls }: Props) {
  const path = filePath(id);
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const mod = useRef<MonacoModule | null>(null);
  const hit = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const saved = useRef("");
  const [load, setLoad] = useState<Load>({ kind: "loading" });
  const [editing, setEditing] = useState(() => !!fileBuffers.get(id)?.editing);
  const [reloads, setReloads] = useState(0);
  const [confirmReload, setConfirmReload] = useState(false);
  /** The file changed on disk while you had unsaved edits: its new text, waiting on your call. */
  const [external, setExternal] = useState<string | null>(null);
  const generation = useConn((s) => s.codex?.generation);
  const flash = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const dirty = useFiles((s) => !!s.dirty[id]);
  const target = useFiles((s) => s.targets[id]);
  const [editorAvailable, setEditorAvailable] = useState(false);

  useEffect(() => {
    if (isDesktop) void bridge.editor.available().then(setEditorAvailable);
  }, []);

  /** Mark the requested line (and take the view there). */
  const reveal = (line?: number, col?: number) => {
    const ed = editor.current;
    const model = ed?.getModel();
    const m = mod.current;
    if (!ed || !model || !m) return;
    hit.current?.clear();
    if (!line || line > model.getLineCount()) return;
    ed.revealLineInCenter(line);
    ed.setPosition({ lineNumber: line, column: col ?? 1 });
    hit.current = ed.createDecorationsCollection([
      { range: new m.monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: "cv-hit", linesDecorationsClassName: "cv-hit-gutter" } },
    ]);
  };

  const save = async () => {
    const model = editor.current?.getModel();
    if (!model) return;
    const text = model.getValue();
    try {
      await writeText(path, text);
      saved.current = text;
      setFileDirty(id, false);
      toast("Saved");
    } catch (err) {
      toast(`Couldn't save: ${(err as Error).message}`, "error");
    }
  };
  const saveRef = useRef(save);
  saveRef.current = save;

  // Load the file (or what was left unsaved) into an editor of its own.
  useEffect(() => {
    let cancelled = false;
    const buffer = fileBuffers.get(id);
    setLoad({ kind: "loading" });
    (async () => {
      try {
        const [m, file] = await Promise.all([loadMonaco(), buffer?.text !== undefined && reloads === 0 ? Promise.resolve({ text: buffer.text }) : readText(path)]);
        if (cancelled || !host.current) return;
        mod.current = m;
        if ("binary" in file) return setLoad({ kind: "binary" });
        if ("large" in file) return setLoad({ kind: "large", size: file.large });
        const { monaco, languageFor } = m;
        const language = languageFor(path);
        if (!editor.current) {
          editor.current = monaco.editor.create(host.current, {
            readOnly: !editing,
            readOnlyMessage: { value: "Read-only. Choose **Edit** to change this file." },
            automaticLayout: true,
            theme: theme(),
            fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "Consolas, monospace",
            fontSize: 13,
            lineHeight: 20,
            fontLigatures: true,
            minimap: { enabled: true, renderCharacters: false },
            stickyScroll: { enabled: true },
            bracketPairColorization: { enabled: true },
            guides: { bracketPairs: "active", indentation: true },
            smoothScrolling: true,
            cursorSmoothCaretAnimation: "on",
            scrollBeyondLastLine: false,
            renderWhitespace: "selection",
            padding: { top: 10, bottom: 10 },
          });
          editor.current.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current());
        }
        const ed = editor.current;
        const old = ed.getModel();
        const model = monaco.editor.createModel(file.text, language);
        ed.setModel(model);
        old?.dispose();
        // Unsaved text came back from the buffer: compare against what's on disk, as left.
        saved.current = buffer?.text !== undefined && reloads === 0 ? (buffer.saved ?? file.text) : file.text;
        setFileDirty(id, model.getValue() !== saved.current);
        model.onDidChangeContent(() => setFileDirty(id, model.getValue() !== saved.current));
        setLoad({ kind: "ready", lines: model.getLineCount(), language });
        if (buffer?.view && reloads === 0) ed.restoreViewState(buffer.view as Monaco.editor.ICodeEditorViewState);
        const t = useFiles.getState().targets[id];
        if (t?.line) reveal(t.line, t.col);
      } catch (err) {
        if (!cancelled) setLoad({ kind: "error", message: (err as Error).message });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, reloads]);

  // A new "show line N" request for a file that's already open.
  const lastTarget = useRef(target?.n);
  useEffect(() => {
    if (!target || target.n === lastTarget.current) return;
    lastTarget.current = target.n;
    if (load.kind === "ready") reveal(target.line, target.col);
  }, [target?.n]);

  useEffect(() => {
    editor.current?.updateOptions({ readOnly: !editing });
    if (editing) editor.current?.focus();
  }, [editing]);

  /** Put new text from disk into the editor, keeping your place, and flash what changed. */
  const takeFromDisk = (text: string) => {
    const ed = editor.current;
    const model = ed?.getModel();
    const m = mod.current;
    if (!ed || !model || !m) return;
    const before = model.getValue();
    const view = ed.saveViewState();
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
    if (view) ed.restoreViewState(view);
    saved.current = text;
    setFileDirty(id, false);
    setExternal(null);
    setLoad((l) => (l.kind === "ready" ? { ...l, lines: model.getLineCount() } : l));
    const changed = changedLines(before, text);
    flash.current?.clear();
    if (!changed) return;
    flash.current = ed.createDecorationsCollection([
      {
        range: new m.monaco.Range(changed.from, 1, changed.to, 1),
        options: { isWholeLine: true, className: "cv-changed", linesDecorationsClassName: "cv-changed-gutter" },
      },
    ]);
    ed.revealLinesInCenterIfOutsideViewport(changed.from, changed.to);
    window.setTimeout(() => flash.current?.clear(), 4000);
  };
  const takeRef = useRef(takeFromDisk);
  takeRef.current = takeFromDisk;

  // Live: when the file changes on disk (Codex editing it, a build, git), reload it in place.
  // With unsaved edits of your own, it asks instead.
  useEffect(() => {
    if (load.kind !== "ready") return;
    let stop: (() => void) | null = null;
    let cancelled = false;
    let timer = 0;
    void watchPath(path, () => {
      clearTimeout(timer);
      timer = window.setTimeout(async () => {
        try {
          const file = await readText(path);
          const model = editor.current?.getModel();
          if (cancelled || !("text" in file) || !model) return;
          if (file.text === model.getValue() || file.text === saved.current) return; // our own save, or nothing new
          if (model.getValue() !== saved.current) setExternal(file.text);
          else takeRef.current(file.text);
        } catch {
          /* deleted or unreadable: leave the view as it is */
        }
      }, 150);
    }).then((unwatch) => {
      if (cancelled) unwatch();
      else stop = unwatch;
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      stop?.();
    };
  }, [id, load.kind === "ready", generation]);

  // Follow the app's light/dark theme.
  useEffect(() => {
    const mo = new MutationObserver(() => mod.current?.monaco.editor.setTheme(theme()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

  // Leaving (tab switch, window closed): keep the scroll position, and the text if unsaved.
  useEffect(
    () => () => {
      const ed = editor.current;
      const model = ed?.getModel();
      if (ed && model) {
        const text = model.getValue();
        const unsaved = text !== saved.current;
        fileBuffers.set(id, { view: ed.saveViewState() ?? undefined, text: unsaved ? text : undefined, saved: unsaved ? saved.current : undefined, editing: unsaved });
      }
      model?.dispose();
      ed?.dispose();
      editor.current = null;
    },
    [id],
  );

  const reload = (force = false) => {
    if (dirty && !force) {
      setConfirmReload(true);
      return;
    }
    setConfirmReload(false);
    fileBuffers.delete(id);
    setFileDirty(id, false);
    setReloads((n) => n + 1);
  };

  const name = baseName(path);
  return (
    <div className={`thread-pane file-pane chrome-${chrome} ${focused ? "focused" : ""}`} data-file={path}>
      <div
        className={`pane-header ${onHeaderPointerDown ? "draggable" : ""}`}
        onPointerDown={onHeaderPointerDown}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest("button, input")) return;
          onHeaderDoubleClick?.();
        }}
      >
        <FileCode2 size={14} className="file-pane-icon" />
        <div className="pane-title file-title" title={path}>
          <span>{name}</span>
          {dirty && <span className="cv-dirty" title="Unsaved changes" />}
          <span className="file-dir mono">{shortPath(path).replace(/[^\\/]*$/, "")}</span>
        </div>
        <div className="pane-header-actions" onPointerDown={(e) => e.stopPropagation()}>
          {load.kind === "ready" && <span className="cv-meta">{load.language === "plaintext" ? "Plain text" : load.language} · {load.lines.toLocaleString()} lines</span>}
          {load.kind === "ready" &&
            (editing ? (
              <>
                <button className="btn primary sm" disabled={!dirty} onClick={() => void save()} title="Save (Ctrl+S)">
                  <Save size={13} /> Save
                </button>
                <button className="icon-btn" title="Done editing" onClick={() => setEditing(false)}>
                  <Check size={14} />
                </button>
              </>
            ) : (
              <button className="btn sm" onClick={() => setEditing(true)} title="Make changes to this file">
                <Pencil size={13} /> Edit
              </button>
            ))}
          <button className="icon-btn" title="Reload from disk" onClick={() => reload()}>
            <RotateCw size={14} />
          </button>
          {isDesktop && (
            <button
              className="icon-btn"
              title={editorAvailable ? "Open in VS Code" : "Open with default app"}
              onClick={() => void openFileRef({ path, line: editor.current?.getPosition()?.lineNumber }, null)}
            >
              <ExternalLink size={14} />
            </button>
          )}
          {isDesktop && (
            <button className="icon-btn" title={revealLabel} onClick={() => void bridge.shell.reveal(path)}>
              <FolderOpen size={14} />
            </button>
          )}
          <button className="icon-btn" title="Copy path" onClick={() => copyText(path, "Path copied")}>
            <Copy size={14} />
          </button>
          {windowControls}
        </div>
      </div>
      {external !== null && (
        <div className="cv-confirm">
          <span>This file changed on disk while you were editing it.</span>
          <button className="btn sm danger" onClick={() => takeFromDisk(external)}>
            Take the new version
          </button>
          <button
            className="btn sm ghost"
            onClick={() => {
              // The disk's version is the baseline now: saving overwrites it, on purpose.
              saved.current = external;
              setFileDirty(id, editor.current?.getModel()?.getValue() !== external);
              setExternal(null);
            }}
          >
            Keep mine
          </button>
        </div>
      )}
      {confirmReload && (
        <div className="cv-confirm">
          <span>Reloading drops your unsaved changes.</span>
          <button className="btn sm danger" onClick={() => reload(true)}>
            Discard and reload
          </button>
          <button className="btn sm ghost" onClick={() => setConfirmReload(false)}>
            Keep them
          </button>
        </div>
      )}
      <div className="cv-body">
        <div ref={host} className={`cv-editor ${load.kind === "ready" ? "" : "hidden"}`} />
        {load.kind === "loading" && (
          <div className="cv-state">
            <LoaderCircle size={18} className="spin" />
          </div>
        )}
        {load.kind !== "loading" && load.kind !== "ready" && (
          <div className="cv-state">
            <FileWarning size={22} />
            <strong>
              {load.kind === "binary" ? "This looks like a binary file" : load.kind === "large" ? `Too large to show here (${fmtSize(load.size)})` : "Couldn't open this file"}
            </strong>
            {load.kind === "error" && <span>{load.message}</span>}
            {isDesktop && (
              <button className="btn sm" onClick={() => void openFileRef({ path }, null)}>
                <ExternalLink size={13} /> Open it with another app
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

/** A file window zoomed out on the canvas: just enough to recognise it. */
export function FileTile({ id, onPointerDown, onDoubleClick }: { id: string; onPointerDown: (e: React.PointerEvent) => void; onDoubleClick: () => void }) {
  const path = filePath(id);
  const dirty = useFiles((s) => !!s.dirty[id]);
  return (
    <div className="tcard file-tile" onPointerDown={onPointerDown} onDoubleClick={onDoubleClick}>
      <div className="tcard-head">
        <FileCode2 className="tcard-fork" />
        <span className="tcard-title">{baseName(path)}</span>
      </div>
      <div className="tcard-body mono">{shortPath(path)}</div>
      <div className="tcard-state">{dirty ? "Unsaved changes" : ""}</div>
    </div>
  );
}
