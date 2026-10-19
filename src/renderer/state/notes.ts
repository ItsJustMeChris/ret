import { create } from "zustand";
import { persist } from "zustand/middleware";
import { bridge } from "../bridge";
import { fsClient } from "../rpc/client";
import { readText, writeText } from "../lib/fileText";
import { baseName, hostOfKey, pathOfKey, scopedKey, type ProjectNode } from "./projects";
import { hostName } from "./hosts";
import { toast } from "./toasts";
import { newId } from "./ui";

/**
 * Notes, kept in three kinds of place, side by side in the Notes app (apps/notes.tsx): in Ret itself;
 * as Markdown files, one per note and named for its title, in a folder you add (an existing notes
 * folder or vault works); or the same in a project's .ret/notes, where its agents can read them.
 */

/** A place notes live. */
export interface Notebook {
  /** "ret", "folder:<dir>" or "project:<key>". */
  id: string;
  kind: "ret" | "folder" | "project";
  name: string;
  /** Where its files are (not for "ret"), on this computer or the paired device `host`. */
  dir?: string;
  host: string | null;
  /** A project's: where a thread started from one of its notes runs. */
  project?: { key: string; path: string };
}

/** A note file a folder or project has: its title is its name. */
export interface FileNote {
  name: string;
  path: string;
  /** Last saved (ms), when the engine says. */
  modifiedAt: number | null;
}

interface LocalNote {
  title: string;
  body: string;
  /** Last edited (ms). */
  updatedAt: number;
}

interface NotesState {
  /** The notes kept in Ret, by id. */
  local: Record<string, LocalNote>;
  /** Folders added as places for notes. */
  folders: string[];
  /** The note showing in the Notes app. */
  open: string | null;
  /** Each folder's and project's notes, as last listed (not kept: they're listed again when the app shows). */
  listed: Record<string, FileNote[] | { error: string }>;
}

export const useNotes = create<NotesState>()(
  persist(() => ({ local: {}, folders: [], open: null, listed: {} }) as NotesState, {
    name: "ret-notes",
    version: 1,
    partialize: ({ listed: _l, ...rest }) => rest,
  }),
);

// A note's id: `ret:<id>` for one kept in Ret, `fs:<path>` (scoped to its device) for a file.
export const isFileNote = (id: string) => id.startsWith("fs:");
export const notePath = (id: string) => pathOfKey(id.slice(3));
export const noteHost = (id: string) => hostOfKey(id.slice(3));
const fileNoteId = (path: string, host: string | null) => `fs:${scopedKey(host, path)}`;
const localKey = (id: string) => id.slice(4);

const join = (dir: string, name: string) => (/[\\/]$/.test(dir) ? dir + name : dir + (dir.includes("\\") ? "\\" : "/") + name);
const dirOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")));
const titleOfFile = (name: string) => name.replace(/\.md$/i, "");

/** A title as a file name: without the characters Windows and macOS won't take, and not too long. */
function fileTitle(title: string) {
  return title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .slice(0, 120);
}

/**
 * Every place notes can be: Ret, the folders added, and each project (whose notes are in its
 * .ret/notes), most recent first. One folder is one place, however many projects name it.
 */
export function notebooksOf(folders: string[], projects: ProjectNode[]): Notebook[] {
  const books: Notebook[] = [
    { id: "ret", kind: "ret", name: "In Ret", host: null },
    ...folders.map((dir): Notebook => ({ id: `folder:${dir}`, kind: "folder", name: baseName(dir), dir, host: null })),
    ...projects.map(
      (p): Notebook => ({
        id: `project:${p.key}`,
        kind: "project",
        name: p.host ? `${p.name} on ${hostName(p.host)}` : p.name,
        dir: join(join(p.path, ".ret"), "notes"),
        host: p.host,
        project: { key: p.key, path: p.path },
      }),
    ),
  ];
  const seen = new Set<string>();
  return books.filter((b) => {
    const where = scopedKey(b.host, b.dir ?? b.id);
    if (seen.has(where)) return false;
    seen.add(where);
    return true;
  });
}

/** A note's title, as the list shows it. */
export function noteTitle(s: NotesState, id: string): string {
  if (isFileNote(id)) return titleOfFile(baseName(notePath(id)));
  return s.local[localKey(id)]?.title.trim() || "Untitled";
}

/** The notes in a place, most recently changed first. */
export function notesIn(s: Pick<NotesState, "local" | "listed">, book: Notebook): { id: string; title: string; preview: string | null; updatedAt: number | null }[] | { error: string } {
  if (book.kind === "ret") {
    return Object.entries(s.local)
      .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
      .map(([key, n]) => ({ id: `ret:${key}`, title: n.title.trim() || "Untitled", preview: n.body.trim().slice(0, 200) || null, updatedAt: n.updatedAt }));
  }
  const files = s.listed[book.id];
  if (!files) return [];
  if (!Array.isArray(files)) return files;
  return files
    .slice()
    .sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0) || a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((f) => ({ id: fileNoteId(f.path, book.host), title: titleOfFile(f.name), preview: null, updatedAt: f.modifiedAt }));
}

/** Read what's in a folder or project (its .md files) into the list. */
export async function listNotebook(book: Notebook) {
  if (!book.dir) return;
  const dir = book.dir;
  const rpc = fsClient(book.host);
  let listed: FileNote[] | { error: string };
  try {
    const res = (await rpc.request("fs/readDirectory", { path: dir })) as { entries: { fileName: string; isDirectory: boolean }[] };
    const md = res.entries.filter((e) => !e.isDirectory && /\.md$/i.test(e.fileName));
    listed = await Promise.all(
      md.map(async (e) => {
        const path = join(dir, e.fileName);
        const meta = (await rpc.request("fs/getMetadata", { path }).catch(() => null)) as { modifiedAtMs?: number } | null;
        return { name: e.fileName, path, modifiedAt: meta?.modifiedAtMs ?? null };
      }),
    );
  } catch (err) {
    // A project nobody has written a note in has no .ret/notes: nothing to list, not an error.
    listed = book.kind === "project" ? [] : { error: (err as Error).message };
  }
  useNotes.setState((s) => ({ listed: { ...s.listed, [book.id]: listed } }));
}

/** A note's title and text. */
export async function readNote(id: string): Promise<{ title: string; body: string }> {
  if (!isFileNote(id)) {
    const n = useNotes.getState().local[localKey(id)];
    if (!n) throw new Error("This note was deleted.");
    return { title: n.title, body: n.body };
  }
  const res = await readText(notePath(id), noteHost(id));
  if (!("text" in res)) throw new Error("binary" in res ? "This file isn't text." : "This file is too big to edit here.");
  return { title: titleOfFile(baseName(notePath(id))), body: res.text };
}

/** Change a note's text (and a note kept in Ret's title: a file's is its name, see `retitleNote`). */
export async function saveNote(id: string, change: { body?: string; title?: string }) {
  if (!isFileNote(id)) {
    useNotes.setState((s) => {
      const key = localKey(id);
      const n = s.local[key];
      return n ? { local: { ...s.local, [key]: { ...n, ...change, updatedAt: Date.now() } } } : s;
    });
    return;
  }
  if (change.body === undefined) return;
  await writeText(notePath(id), change.body, noteHost(id));
  touchFile(id);
}

/** A file note just saved: it moves to the top of its place's list. */
function touchFile(id: string) {
  const path = notePath(id);
  useNotes.setState((s) => {
    const listed = { ...s.listed };
    for (const [book, files] of Object.entries(listed)) {
      if (Array.isArray(files) && files.some((f) => f.path === path)) listed[book] = files.map((f) => (f.path === path ? { ...f, modifiedAt: Date.now() } : f));
    }
    return { listed };
  });
}

/**
 * Rename a file note for its new title (moving its text, `body`, to the new name). Returns its id
 * after: the same if the name didn't change or is taken.
 */
export async function retitleNote(id: string, title: string, body: string, book: Notebook): Promise<string> {
  const name = fileTitle(title) || "Untitled";
  const from = notePath(id);
  if (titleOfFile(baseName(from)) === name) return id;
  const files = useNotes.getState().listed[book.id];
  const taken = Array.isArray(files) && files.some((f) => f.path !== from && titleOfFile(f.name).toLowerCase() === name.toLowerCase());
  if (taken) {
    toast(`There's already a note called “${name}” there.`, "error");
    return id;
  }
  const host = noteHost(id);
  const to = join(dirOf(from), `${name}.md`);
  await writeText(to, body, host);
  await fsClient(host).request("fs/remove", { path: from, recursive: false });
  const next = fileNoteId(to, host);
  useNotes.setState((s) => ({ open: s.open === id ? next : s.open }));
  await listNotebook(book);
  return next;
}

/** A new, empty note in `book`, opened. */
export async function createNote(book: Notebook) {
  if (!book.dir) {
    const key = newId();
    useNotes.setState((s) => ({ local: { ...s.local, [key]: { title: "", body: "", updatedAt: Date.now() } }, open: `ret:${key}` }));
    return;
  }
  try {
    await fsClient(book.host).request("fs/createDirectory", { path: book.dir, recursive: true });
    await listNotebook(book);
    const files = useNotes.getState().listed[book.id];
    const taken = new Set(Array.isArray(files) ? files.map((f) => titleOfFile(f.name).toLowerCase()) : []);
    let name = "Untitled";
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `Untitled ${n}`;
    const path = join(book.dir, `${name}.md`);
    await writeText(path, "", book.host);
    await listNotebook(book);
    useNotes.setState({ open: fileNoteId(path, book.host) });
  } catch (err) {
    toast(`Couldn't make a note in ${book.name}: ${(err as Error).message}`, "error");
  }
}

/** Delete a note: from Ret, or its file from the disk. */
export async function deleteNote(id: string, book: Notebook | undefined) {
  if (isFileNote(id)) {
    await fsClient(noteHost(id)).request("fs/remove", { path: notePath(id), recursive: false });
    if (book) await listNotebook(book);
  }
  useNotes.setState((s) => {
    const local = { ...s.local };
    if (!isFileNote(id)) delete local[localKey(id)];
    return { local, open: s.open === id ? null : s.open };
  });
}

export const openNote = (id: string | null) => useNotes.setState({ open: id });

/** Add a folder of notes (picked in the system's dialog). */
export async function addNotesFolder() {
  const dir = (await bridge.dialog.pickFolder())?.trim();
  if (!dir) return;
  useNotes.setState((s) => (s.folders.includes(dir) ? s : { folders: [...s.folders, dir] }));
}

/** Stop showing a folder's notes here (its files stay where they are). */
export function removeNotesFolder(dir: string) {
  useNotes.setState((s) => {
    const listed = { ...s.listed };
    delete listed[`folder:${dir}`];
    const open = s.open && isFileNote(s.open) && dirOf(notePath(s.open)) === dir ? null : s.open;
    return { folders: s.folders.filter((d) => d !== dir), listed, open };
  });
}

/** A note as a message to an agent: its title as a heading over its text. */
export function noteMessage(title: string, body: string) {
  const t = title.trim();
  const b = body.trim();
  return t && !b.startsWith(t) && !b.startsWith(`# ${t}`) ? `# ${t}\n\n${b}` : b;
}
