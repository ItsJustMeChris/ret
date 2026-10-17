import { memo, useLayoutEffect, useRef, useState } from "react";
import { ClipboardPaste, Copy, Eraser, RotateCcw, TextSelect, Trash2 } from "lucide-react";
import { newId } from "../../state/ui";
import { closeTerminal, restartTerminal, terminalSession, useTerms } from "../../state/terminals";
import { bridge } from "../../bridge";
import { useShown, useVisibility } from "../ui/Kept";
import { Menu, type MenuItem } from "../Menu";

/**
 * Where a terminal shows. The terminal itself (its shell, its screen) lives outside React and moves
 * to the view that shows it last: going to another mode, tab or window and back never restarts it.
 * A view that's on screen while another one has it offers to bring it over.
 */
export const TerminalView = memo(function TerminalView({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [token] = useState(newId);
  const visibility = useVisibility();
  const shown = useShown();
  const mine = useTerms((s) => s.holders[id] === token);
  const elsewhere = useTerms((s) => !!s.holders[id] && s.holders[id] !== token);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current!;
    let active = false;
    let frame = 0;
    // It takes the terminal when it comes on screen (shown, and laid out), or when nobody has it;
    // while it has it, the terminal follows its size.
    const check = () => {
      const s = terminalSession(id);
      if (!s) return;
      const now = visibility.shown && el.isConnected && el.clientWidth > 0 && el.clientHeight > 0;
      const holder = useTerms.getState().holders[id];
      if (now && (!active || !holder)) s.attach(el, token);
      else if (now && holder === token) {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => s.refit());
      }
      active = now;
    };
    const ro = new ResizeObserver(check);
    ro.observe(el);
    const offVisibility = visibility.subscribe(check);
    const offHolders = useTerms.subscribe((s, prev) => s.holders[id] !== prev.holders[id] && !s.holders[id] && check());
    check();
    return () => {
      ro.disconnect();
      offVisibility();
      offHolders();
      cancelAnimationFrame(frame);
      terminalSession(id)?.release(token);
    };
  }, [id, token, visibility]);

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const term = terminalSession(id)?.term;
    if (!term) return;
    const selected = term.hasSelection();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        {
          label: "Copy",
          icon: <Copy size={14} />,
          disabled: !selected,
          onClick: () => {
            void bridge.copy(term.getSelection());
            term.clearSelection();
          },
        },
        {
          label: "Paste",
          icon: <ClipboardPaste size={14} />,
          onClick: () => {
            term.focus();
            bridge.edit("paste");
          },
        },
        { label: "Select all", icon: <TextSelect size={14} />, onClick: () => term.selectAll() },
        { label: "Clear", icon: <Eraser size={14} />, onClick: () => term.clear() },
        { separator: true },
        { label: "New shell", icon: <RotateCcw size={14} />, hint: "restart", onClick: () => restartTerminal(id) },
        { label: "End terminal", icon: <Trash2 size={14} />, danger: true, onClick: () => closeTerminal(id) },
      ],
    });
  };

  // Files dropped on it go in as their paths (quoted), as a terminal would take them.
  const onDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => bridge.files.pathFor(f))
      .filter((p): p is string => !!p);
    if (!paths.length) return;
    const s = terminalSession(id);
    s?.term?.paste(paths.map((p) => (/[\s'"$`&|;()<>]/.test(p) ? `"${p}"` : p)).join(" "));
    s?.focus();
  };

  return (
    <div
      ref={ref}
      className={`term-view ${mine ? "mine" : ""}`}
      onContextMenu={onContextMenu}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
      }}
      // Not the thread's own drop (onto your message) while over the terminal.
      onDragEnter={(e) => e.dataTransfer.types.includes("Files") && e.stopPropagation()}
      onDragLeave={(e) => e.dataTransfer.types.includes("Files") && e.stopPropagation()}
      onDrop={onDrop}
    >
      {shown && elsewhere && (
        <div className="term-elsewhere">
          <span>Showing in another view</span>
          <button className="btn" onClick={() => ref.current && terminalSession(id)?.attach(ref.current, token)}>
            Show here
          </button>
        </div>
      )}
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
    </div>
  );
});
