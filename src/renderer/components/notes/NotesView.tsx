import { memo, useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, Folder, FolderPlus, LoaderCircle, MessageSquarePlus, MessageSquareShare, NotebookPen, PenLine, Plus, RefreshCw, Trash2, X } from "lucide-react";
import {
  addNotesFolder,
  createNote,
  deleteNote,
  isFileNote,
  listNotebook,
  noteHost,
  noteMessage,
  notePath,
  noteRenamed,
  noteTitle,
  notebooksOf,
  notesIn,
  openNote,
  readNote,
  removeNotesFolder,
  retitleNote,
  saveNote,
  useNotes,
  type Notebook,
} from "../../state/notes";
import { projectTreeNow, useProjectTree } from "../../state/projectTree";
import { recencyOf, threadTitle } from "../../state/projects";
import { useThreads } from "../../state/threads";
import { activeBoard, isApp, isDraft, isFile, useUI } from "../../state/ui";
import { focusWindow, newThread, openThread } from "../../state/actions";
import { composerDrafts, fillComposer } from "../../state/composerDrafts";
import { watchPath } from "../../state/files";
import { timeAgo } from "../../lib/format";
import { toast } from "../../state/toasts";
import { Markdown } from "../Markdown";
import { Menu, type MenuItem } from "../Menu";

type SetMenu = (m: { x: number; y: number; items: MenuItem[] } | null) => void;
const at = (e: React.MouseEvent) => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return { x: r.left, y: r.bottom + 4 };
};

/**
 * Notes: every note, from Ret, the folders you've added and your projects, listed by where it's
 * kept; pick one to write it on the right. A note can start a thread, or go into one's composer.
 */
export function NotesView({ active = true }: { active?: boolean }) {
  const folders = useNotes((s) => s.folders);
  const open = useNotes((s) => s.open);
  // A new editor for each note you pick, the same one while the note you're on is renamed.
  const picked = useNotes((s) => s.picked);
  const projects = useProjectTree();
  const books = useMemo(() => notebooksOf(folders, projects), [folders, projects]);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  // What's in each folder and project: listed when the places change, and again whenever you come
  // back to the app (an agent may have written one meanwhile).
  const placesKey = books.map((b) => b.id).join("\n");
  const booksRef = useRef(books);
  booksRef.current = books;
  const refresh = () => booksRef.current.forEach((b) => void listNotebook(b));
  useEffect(() => {
    if (active) refresh();
  }, [placesKey, active]);

  const local = useNotes((s) => s.local);
  const listed = useNotes((s) => s.listed);
  const sections = useMemo(() => books.map((book) => ({ book, notes: notesIn({ local, listed }, book) })), [books, local, listed]);
  // Ret's own and the folders you added always show (so you can see where a new note goes and
  // stop showing a folder); a project, once it has notes.
  const shown = sections.filter(({ book, notes }) => book.kind === "folder" || (Array.isArray(notes) ? notes.length > 0 : true) || book.kind === "ret");
  const empty = sections.every(({ notes }) => Array.isArray(notes) && notes.length === 0) && !folders.length;
  const openBook = open ? bookOf(open, books) : undefined;

  return (
    <div className="notes-view">
      <aside className="notes-list">
        <div className="notes-head">
          <NotebookPen size={15} />
          <span>Notes</span>
          <div className="notes-head-actions">
            <button className="icon-btn" title="Look again for notes in folders and projects" onClick={refresh}>
              <RefreshCw size={13} />
            </button>
            <button className="icon-btn" title="New note" onClick={(e) => setMenu({ ...at(e), items: newNoteItems(books) })}>
              <Plus size={15} />
            </button>
          </div>
        </div>
        {empty ? (
          <div className="notes-empty">
            <NotebookPen size={26} />
            <strong>No notes yet</strong>
            <span>Keep them in Ret, in a folder of Markdown files, or in a project, where its agents can read them.</span>
            <button className="btn sm" onClick={(e) => setMenu({ ...at(e), items: newNoteItems(books) })}>
              <Plus size={13} /> New note
            </button>
          </div>
        ) : (
          shown.map(({ book, notes }) => (
            <div key={book.id} className="notes-section">
              <div className="notes-section-title" title={book.dir}>
                <span className="notes-section-name">{book.name}</span>
                {Array.isArray(notes) && <span className="inbox-count">{notes.length}</span>}
                {book.kind === "folder" && (
                  <button className="icon-btn notes-section-off" title="Stop showing this folder here (its files stay)" onClick={() => removeNotesFolder(book.dir!)}>
                    <X size={12} />
                  </button>
                )}
              </div>
              {!Array.isArray(notes) ? (
                <div className="notes-error">{notes.error}</div>
              ) : !notes.length ? (
                <div className="notes-none">No notes here yet</div>
              ) : (
                notes.map((n) => <NoteRow key={n.id} id={n.id} title={n.title} preview={n.preview} updatedAt={n.updatedAt} selected={n.id === open} />)
              )}
            </div>
          ))
        )}
      </aside>
      <section className="notes-read">
        {open && openBook ? (
          <NoteEditor key={picked} id={open} book={openBook} setMenu={setMenu} />
        ) : (
          <div className="inbox-empty">
            <NotebookPen size={26} />
            <span>{empty ? "Make a note to start." : "Pick a note on the left."}</span>
          </div>
        )}
      </section>
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** The place a note is kept in. */
function bookOf(id: string, books: Notebook[]): Notebook | undefined {
  if (!isFileNote(id)) return books[0];
  const path = notePath(id);
  const host = noteHost(id);
  return books.find((b) => b.dir && b.host === host && path.length > b.dir.length && path.startsWith(b.dir) && !/[\\/]/.test(path.slice(b.dir.length + 1)));
}

/** Where a new note can go: Ret, a folder, a project (the most recent few), or a folder to add. */
function newNoteItems(books: Notebook[]): MenuItem[] {
  const folders = books.filter((b) => b.kind === "folder");
  const projects = books.filter((b) => b.kind === "project").slice(0, 12);
  const item = (b: Notebook, icon: React.ReactNode): MenuItem => ({ label: b.kind === "ret" ? "In Ret" : `In ${b.name}`, icon, hint: b.kind === "project" ? ".ret/notes" : undefined, onClick: () => void createNote(b) });
  return [
    item(books[0], <NotebookPen size={14} />),
    ...folders.map((b) => item(b, <Folder size={14} />)),
    ...(projects.length ? [{ separator: true }, ...projects.map((b) => item(b, <Folder size={14} />))] : []),
    { separator: true },
    { label: "Add a notes folder…", icon: <FolderPlus size={14} />, onClick: () => void addNotesFolder() },
  ];
}

const NoteRow = memo(function NoteRow({ id, title, preview, updatedAt, selected }: { id: string; title: string; preview: string | null; updatedAt: number | null; selected: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return (
    <div ref={ref} className={`notes-row ${selected ? "selected" : ""}`} onClick={() => openNote(id)}>
      <div className="inbox-row-top">
        <span className="inbox-title">{title}</span>
        <span className="inbox-time">{updatedAt ? timeAgo(updatedAt / 1000) : ""}</span>
      </div>
      {preview && <div className="inbox-preview">{preview}</div>}
    </div>
  );
});

/** One note, to write: its title, its Markdown (or how it reads), and what to do with it. */
function NoteEditor({ id, book, setMenu }: { id: string; book: Notebook; setMenu: SetMenu }) {
  const [load, setLoad] = useState<"loading" | { error: string } | "ready">("loading");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [reading, setReading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const file = isFileNote(id);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // What's on disk (or in Ret) as of the last load or save, and a save waiting to go.
  const saved = useRef({ title: "", body: "" });
  const latest = useRef({ title: "", body: "" });
  latest.current = { title, body };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Renaming a file note gives it a new id but keeps this editor (NotesView keys it by the note
  // you picked), so what you type meanwhile isn't lost: saves wait for the rename, then go to the
  // new file, never the old one.
  const idRef = useRef(id);
  const renaming = useRef(false);
  const renamedTo = useRef<string | null>(null);
  if (!renaming.current) idRef.current = id;

  const load_ = async (quiet = false) => {
    try {
      const n = await readNote(idRef.current);
      saved.current = n;
      setTitle(n.title);
      setBody(n.body);
      setLoad("ready");
      // A new, empty note: straight to writing it.
      if (!quiet && !n.body) requestAnimationFrame(() => textRef.current?.focus());
    } catch (err) {
      setLoad({ error: (err as Error).message });
    }
  };
  useEffect(() => {
    // Our own rename: what's here is already the note.
    if (id === renamedTo.current) return;
    void load_();
  }, [id]);

  const flush = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (renaming.current) return schedule();
    const { title: t, body: b } = latest.current;
    const change = { ...(b !== saved.current.body ? { body: b } : {}), ...(!file && t !== saved.current.title ? { title: t } : {}) };
    if (!Object.keys(change).length) return;
    saved.current = { title: file ? saved.current.title : t, body: b };
    saveNote(idRef.current, change).catch((err) => toast(`Couldn't save the note: ${(err as Error).message}`, "error"));
  };
  const schedule = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, 400);
  };
  // Leaving the note (another one, or closing the window) saves what's waiting.
  useEffect(() => () => flush(), []);

  // A file changed by something else (an agent, another editor) while you're not mid-edit: take it.
  useEffect(() => {
    if (!file) return;
    let stop = () => {};
    let gone = false;
    void watchPath(notePath(id), () => {
      if (latest.current.body === saved.current.body) void load_(true);
    }, noteHost(id)).then((s) => (gone ? s() : (stop = s)));
    return () => {
      gone = true;
      stop();
    };
  }, [id]);

  const commitTitle = async () => {
    if (!file || renaming.current) return;
    flush();
    const from = idRef.current;
    const body = latest.current.body;
    renaming.current = true;
    const next = await retitleNote(from, latest.current.title, body, book).catch((err) => {
      toast(`Couldn't rename the note: ${(err as Error).message}`, "error");
      return from;
    });
    // The new file has the text as it was when the rename started; anything typed since saves next.
    if (next !== from) {
      renamedTo.current = next;
      idRef.current = next;
      saved.current = { title: noteTitle(useNotes.getState(), next), body };
      noteRenamed(from, next);
    }
    renaming.current = false;
    if (next === from) setTitle(saved.current.title);
    else if (latest.current.body !== body) flush();
  };

  const message = () => noteMessage(latest.current.title, latest.current.body);
  const startThread = (e: React.MouseEvent) => {
    const go = (p: { key: string; path: string }) => {
      if (!message()) return toast("The note is empty.", "info");
      const draft = newThread(p.key, p.path);
      fillComposer(draft, message(), { focus: true });
    };
    if (book.project) return go(book.project);
    const projects = projectTreeNow().slice(0, 14);
    setMenu({
      ...at(e),
      items: projects.length
        ? projects.map((p) => ({ label: `New thread in ${p.name}`, icon: <Folder size={14} />, onClick: () => go(p) }))
        : [{ label: "Add a project first", disabled: true }],
    });
  };
  const addToThread = (e: React.MouseEvent) => setMenu({ ...at(e), items: threadItems(message) });

  return (
    <div className="note-editor" data-cwd={file ? notePath(id).replace(/[\\/][^\\/]*$/, "") : undefined}>
      <div className="notes-bar">
        <span className="chip" title={book.dir ?? "Kept in Ret"}>
          {book.kind === "ret" ? <NotebookPen size={11} /> : <Folder size={11} />}
          {book.name}
        </span>
        <div className="notes-bar-actions">
          <button className={`icon-btn ${reading ? "on" : ""}`} title={reading ? "Write" : "Read (rendered Markdown)"} onClick={() => setReading((r) => !r)}>
            {reading ? <PenLine size={14} /> : <BookOpen size={14} />}
          </button>
          <button className="icon-btn" title={book.project ? `Start a thread in ${book.name} from this note` : "Start a thread from this note"} onClick={startThread}>
            <MessageSquarePlus size={14} />
          </button>
          <button className="icon-btn" title="Add this note to a thread's message" onClick={addToThread}>
            <MessageSquareShare size={14} />
          </button>
          <button className="icon-btn" title="Delete note" onClick={() => setConfirmDelete(true)}>
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      {confirmDelete && (
        <div className="cv-confirm">
          <span>{file ? "Delete this note's file from the disk?" : "Delete this note?"}</span>
          <button
            className="btn sm danger"
            onClick={() => {
              // Nothing left to save: a save still waiting would write the file back.
              if (timer.current) clearTimeout(timer.current);
              timer.current = null;
              saved.current = latest.current;
              void deleteNote(idRef.current, book).catch((err) => toast(`Couldn't delete the note: ${(err as Error).message}`, "error"));
            }}
          >
            Delete
          </button>
          <button className="btn sm ghost" onClick={() => setConfirmDelete(false)}>
            Keep it
          </button>
        </div>
      )}
      {load === "loading" ? (
        <div className="inbox-empty">
          <LoaderCircle size={20} className="spin" />
        </div>
      ) : load !== "ready" ? (
        <div className="inbox-empty">
          <span>{load.error}</span>
        </div>
      ) : (
        <div className="note-page">
          <input
            className="note-title"
            value={title}
            placeholder="Untitled"
            spellCheck
            onChange={(e) => {
              setTitle(e.target.value);
              if (!file) schedule();
            }}
            onBlur={() => void commitTitle()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                textRef.current?.focus();
              } else if (e.key === "Escape" && file) setTitle(saved.current.title);
            }}
          />
          {reading ? (
            <div className="note-rendered">{body.trim() ? <Markdown text={body} /> : <span className="muted">Nothing written yet.</span>}</div>
          ) : (
            <textarea
              ref={textRef}
              className="note-text"
              value={body}
              placeholder="Write in Markdown…"
              spellCheck
              onChange={(e) => {
                setBody(e.target.value);
                schedule();
              }}
              onBlur={flush}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Threads a note can go into: the ones on this board (most recently used first), then other recent ones. */
function threadItems(message: () => string): MenuItem[] {
  const ui = useUI.getState();
  const threads = useThreads.getState().threads;
  const add = (threadId: string, winId?: string) => {
    const text = message();
    if (!text) return toast("The note is empty.", "info");
    // Under what's written there already, a blank line apart (fillComposer starts a new line).
    fillComposer(threadId, composerDrafts.get(threadId)?.trim() ? `\n${text}` : text, { focus: true });
    if (winId) focusWindow(winId, true);
    else openThread(threadId);
  };
  const label = (id: string) => (isDraft(id) ? "New thread" : threadTitle(threads[id]));
  const onBoard = activeBoard(ui)
    .windows.filter((w) => !isApp(w.threadId) && !isFile(w.threadId) && (isDraft(w.threadId) ? !!ui.drafts[w.threadId] : !!threads[w.threadId]))
    .sort((a, b) => b.z - a.z);
  const shown = new Set(onBoard.map((w) => w.threadId));
  const recent = Object.values(threads)
    .filter((t) => !shown.has(t.id))
    .sort((a, b) => recencyOf(b) - recencyOf(a))
    .slice(0, 6);
  const items: MenuItem[] = onBoard.slice(0, 10).map((w) => ({ label: label(w.threadId), icon: <MessageSquareShare size={14} />, hint: "on this board", onClick: () => add(w.threadId, w.id) }));
  if (recent.length) {
    if (items.length) items.push({ separator: true });
    items.push(...recent.map((t) => ({ label: threadTitle(t), icon: <MessageSquareShare size={14} />, onClick: () => add(t.id) })));
  }
  return items.length ? items : [{ label: "No threads yet", disabled: true }];
}
