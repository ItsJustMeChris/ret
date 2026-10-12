import { useEffect, useState } from "react";
import {
  ClipboardPaste,
  Copy,
  ExternalLink,
  FileCode2,
  FolderOpen,
  Link2,
  Scissors,
  SpellCheck,
  TextSelect,
  Undo2,
  BookPlus,
  FileQuestion,
  GitFork,
} from "lucide-react";
import { bridge } from "../bridge";
import { copyText, looksLikePath, parseFileRef, resolvePath, revealLabel, type FileRef } from "../lib/files";
import { forkThread } from "../state/actions";
import { quoteText } from "../state/composerDrafts";
import { isDraft } from "../state/ui";
import { Menu, type MenuItem } from "./Menu";

type Spell = { word: string; suggestions: string[]; at: number };

/**
 * App-wide right-click menu for content that doesn't define its own: links (open/copy),
 * file references (open in editor, default app, reveal, copy path), selected text, and
 * text fields (spelling, undo, cut/copy/paste). Menus defined by components (sidebar rows,
 * canvas background, fork links) call preventDefault and take precedence.
 */
export function ContextMenuHost() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  useEffect(() => {
    let spell: Spell | null = null;
    const offSpell = bridge.onSpelling((s) => (spell = { ...s, at: Date.now() }));

    const onContextMenu = (e: MouseEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as Element;
      const selection = window.getSelection()?.toString() ?? "";
      const editable = target.closest<HTMLInputElement | HTMLTextAreaElement>("input, textarea, [contenteditable=true]");
      const link = target.closest<HTMLAnchorElement>("a");
      const pathEl = target.closest<HTMLElement>("[data-path]");
      const code = !link && !pathEl ? target.closest("code") : null;
      const cwd = target.closest("[data-cwd]")?.getAttribute("data-cwd") ?? null;

      let file: FileRef | null = null;
      if (pathEl?.dataset.path) {
        file = { path: pathEl.dataset.path, line: Number(pathEl.dataset.line) || undefined, col: Number(pathEl.dataset.col) || undefined };
      } else if (code && looksLikePath(code.textContent ?? "")) {
        file = parseFileRef(code.textContent ?? "");
      }
      const href = link?.getAttribute("href");
      const url = href && /^(https?:|mailto:)/i.test(href) ? href : null;

      if (!url && !file && !selection.trim() && !editable) return;
      e.preventDefault();
      const { clientX: x, clientY: y } = e;

      void (async () => {
        const items: MenuItem[] = [];
        if (url) {
          items.push(
            { label: url.startsWith("mailto:") ? "Send email" : "Open link", icon: <ExternalLink size={14} />, onClick: () => void bridge.shell.openExternal(url) },
            { label: url.startsWith("mailto:") ? "Copy email address" : "Copy link address", icon: <Link2 size={14} />, onClick: () => copyText(url.replace(/^mailto:/i, ""), "Link copied") },
          );
          const text = link?.textContent?.trim();
          if (text && text !== url) items.push({ label: "Copy link text", icon: <Copy size={14} />, onClick: () => copyText(text) });
        }

        if (file) {
          const abs = resolvePath(file.path, cwd);
          const [st, editor] = await Promise.all([bridge.files.stat(abs), bridge.editor.available()]);
          if (items.length) items.push({ separator: true });
          if (!st.exists) {
            items.push({ label: "File not found", icon: <FileQuestion size={14} />, disabled: true });
          } else if (st.isDir) {
            items.push({ label: "Open folder", icon: <FolderOpen size={14} />, onClick: () => void bridge.shell.openPath(abs) });
          } else {
            if (editor) {
              items.push({
                label: file.line ? `Open in VS Code at line ${file.line}` : "Open in VS Code",
                icon: <FileCode2 size={14} />,
                onClick: () => void bridge.editor.open(abs, file!.line, file!.col),
              });
            }
            items.push({ label: "Open with default app", icon: <ExternalLink size={14} />, onClick: () => void openWithDefault(abs) });
          }
          if (st.exists) items.push({ label: revealLabel, icon: <FolderOpen size={14} />, hint: "Alt+click", onClick: () => void bridge.shell.reveal(abs) });
          items.push({ label: "Copy path", icon: <Copy size={14} />, onClick: () => copyText(abs, "Path copied") });
          if (!file.line && file.path !== abs) items.push({ label: "Copy relative path", icon: <Copy size={14} />, onClick: () => copyText(file!.path, "Path copied") });
        }

        if (editable) {
          // The spellchecker reports the word under the click a moment after the DOM event.
          await new Promise((r) => setTimeout(r, 40));
          const fresh = spell && Date.now() - spell.at < 400 ? spell : null;
          if (items.length) items.push({ separator: true });
          if (fresh) {
            const s = fresh;
            for (const word of s.suggestions) items.push({ label: word, icon: <SpellCheck size={14} />, onClick: () => bridge.edit("replaceMisspelling", word) });
            if (!s.suggestions.length) items.push({ label: "No spelling suggestions", disabled: true });
            items.push({ label: `Add “${s.word}” to dictionary`, icon: <BookPlus size={14} />, onClick: () => bridge.edit("addToDictionary", s.word) }, { separator: true });
          }
          const hasSel = hasFieldSelection(editable);
          items.push(
            { label: "Undo", icon: <Undo2 size={14} />, hint: "Ctrl+Z", onClick: () => refocus(editable, () => bridge.edit("undo")) },
            { separator: true },
            { label: "Cut", icon: <Scissors size={14} />, hint: "Ctrl+X", disabled: !hasSel, onClick: () => refocus(editable, () => bridge.edit("cut")) },
            { label: "Copy", icon: <Copy size={14} />, hint: "Ctrl+C", disabled: !hasSel, onClick: () => refocus(editable, () => bridge.edit("copy")) },
            { label: "Paste", icon: <ClipboardPaste size={14} />, hint: "Ctrl+V", onClick: () => refocus(editable, () => bridge.edit("paste")) },
            { label: "Select all", icon: <TextSelect size={14} />, hint: "Ctrl+A", onClick: () => refocus(editable, () => bridge.edit("selectAll")) },
          );
        } else if (selection.trim()) {
          if (items.length) items.push({ separator: true });
          items.push({ label: "Copy", icon: <Copy size={14} />, hint: "Ctrl+C", onClick: () => copyText(selection) });
          // Text selected in a turn can seed a fork: branch at that turn, quote it in the new prompt.
          const turn = target.closest<HTMLElement>("section.turn[data-turn]");
          const threadId = turn?.closest<HTMLElement>("[data-thread]")?.dataset.thread;
          if (turn && threadId && !isDraft(threadId) && window.getSelection()?.containsNode(turn, true)) {
            let next = turn.nextElementSibling;
            while (next && !next.matches("section.turn")) next = next.nextElementSibling;
            // A turn still running (or not yet confirmed) can't be a fork point; fork everything so far.
            const id = turn.dataset.turn!;
            const atTurnId = turn.classList.contains("live") || id.startsWith("pending:") ? undefined : id;
            items.push({
              label: "Fork with selection",
              icon: <GitFork size={14} />,
              hint: next && atTurnId ? "from this turn" : undefined,
              onClick: () => void forkThread(threadId, { atTurnId, prompt: quoteText(selection) }),
            });
          }
        }

        setMenu({ x, y, items });
      })();
    };

    window.addEventListener("contextmenu", onContextMenu);
    return () => {
      window.removeEventListener("contextmenu", onContextMenu);
      offSpell();
    };
  }, []);

  return menu ? <Menu {...menu} onClose={() => setMenu(null)} /> : null;
}

async function openWithDefault(path: string) {
  const err = await bridge.shell.openPath(path);
  if (err) {
    const { toast } = await import("../state/toasts");
    toast(err, "error");
  }
}

function hasFieldSelection(el: Element): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return (el.selectionEnd ?? 0) > (el.selectionStart ?? 0);
  }
  return !!window.getSelection()?.toString();
}

/** Editing commands act on the focused field; the menu took focus, so give it back first. */
function refocus(el: Element, run: () => void) {
  (el as HTMLElement).focus();
  requestAnimationFrame(run);
}

