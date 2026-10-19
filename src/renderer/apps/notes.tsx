import { NotebookPen } from "lucide-react";
import { NotesView } from "../components/notes/NotesView";
import { noteTitle, useNotes } from "../state/notes";
import type { RetApp } from "./app";

/** Zoomed out: the note you're on, and how many there are. */
function NotesCard() {
  const open = useNotes((s) => (s.open ? noteTitle(s, s.open) : null));
  const count = useNotes((s) => Object.keys(s.local).length + Object.values(s.listed).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0));
  return (
    <>
      <div className="tcard-body">{open ?? "No note open"}</div>
      <div className="tcard-state">{count ? `${count} note${count === 1 ? "" : "s"}` : ""}</div>
    </>
  );
}

/** Notes: kept in Ret, in folders of Markdown files, or in projects; any of them can start a thread or go into one. */
export const notes: RetApp<"notes"> = {
  kind: "notes",
  name: "Notes",
  icon: NotebookPen,
  instances: "one",
  size: { w: 880, h: 620 },
  View: NotesView,
  Card: NotesCard,
};
