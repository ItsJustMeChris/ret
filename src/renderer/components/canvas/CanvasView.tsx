import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, Command, Copy, Folder, GitFork, LayoutGrid, MessageSquarePlus, Minus, Pencil, Plus, Scan, SquareDashed, Trash2, X } from "lucide-react";
import { activeBoard, newId, updateBoard, useUI, type Board } from "../../state/ui";
import { closeWindow, newThread, openThread } from "../../state/actions";
import { useThreads } from "../../state/threads";
import { buildProjects, explicitKeys, projectKeyFor, type ProjectNode } from "../../state/projects";
import { Links } from "./Links";
import { CanvasWindow } from "./CanvasWindow";
import { Minimap } from "./Minimap";
import { Beacons } from "./Beacons";
import { CARD_ZOOM, fitAll, revealWindow, tidy, viewport } from "./viewport";
import { Menu, type MenuItem } from "../Menu";
import { promptText } from "../ui/Dialog";

export function CanvasView() {
  const board = useUI((s) => activeBoard(s));
  const focused = useUI((s) => s.focusedWindow);
  const vpRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const [card, setCard] = useState(board.viewport.zoom < CARD_ZOOM);
  const [zoomLabel, setZoomLabel] = useState(Math.round(board.viewport.zoom * 100));
  const spaceDown = useRef(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const showLinks = useUI((s) => s.showLinks);
  const selectedCount = useUI((s) => s.selectedWindows.length);

  // Load this board's saved viewport when switching boards.
  useLayoutEffect(() => {
    viewport.load(board.viewport);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.id]);

  // Paint viewport changes straight to the DOM.
  useLayoutEffect(
    () =>
      viewport.subscribe((vp) => {
        const world = worldRef.current;
        const el = vpRef.current;
        if (!world || !el) return;
        world.style.transform = `translate3d(${vp.x}px, ${vp.y}px, 0) scale(${vp.zoom})`;
        world.style.setProperty("--inv-zoom", String(1 / vp.zoom));
        const grid = 24 * vp.zoom;
        el.style.backgroundSize = `${grid}px ${grid}px`;
        el.style.backgroundPosition = `${vp.x}px ${vp.y}px`;
        el.classList.toggle("grid-faint", vp.zoom < 0.45);
        setCard(vp.zoom < CARD_ZOOM);
        setZoomLabel(Math.round(vp.zoom * 100));
      }),
    [],
  );

  useEffect(() => {
    const onReveal = (e: Event) => requestAnimationFrame(() => revealWindow((e as CustomEvent<string>).detail));
    window.addEventListener("ret:reveal-window", onReveal);
    return () => window.removeEventListener("ret:reveal-window", onReveal);
  }, []);

  // Wheel: ctrl/pinch zooms around the cursor; plain wheel pans unless a window's content wants to scroll.
  useEffect(() => {
    const el = vpRef.current!;
    const onWheel = (e: WheelEvent) => {
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022));
        viewport.zoomAt(factor, e.clientX - rect.left, e.clientY - rect.top);
        return;
      }
      const inWindow = (e.target as HTMLElement).closest(".cwin:not(.card)");
      if (inWindow && !e.shiftKey) return; // let transcripts scroll natively
      e.preventDefault();
      const k = e.deltaMode === 1 ? 32 : 1;
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      const vp = viewport.vp;
      viewport.set({ ...vp, x: vp.x - dx * k, y: vp.y - dy * k });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && !isTyping()) {
        spaceDown.current = true;
        vpRef.current?.classList.add("space-pan");
        e.preventDefault();
      }
    };
    const release = () => {
      spaceDown.current = false;
      vpRef.current?.classList.remove("space-pan");
    };
    const up = (e: KeyboardEvent) => e.code === "Space" && release();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    // Alt-tabbing away while holding Space never delivers the keyup.
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
    };
  }, []);

  // Escape lets go of a multi-selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || isTyping() || !useUI.getState().selectedWindows.length) return;
      if (document.querySelector(".menu, .overlay, .dialog")) return;
      useUI.setState({ selectedWindows: [] });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Selections belong to a board.
  useEffect(() => {
    useUI.setState({ selectedWindows: [] });
  }, [board.id]);

  /** Shift+drag on empty canvas: rubber-band select, adding to what's already selected. */
  const marquee = useRef<HTMLDivElement>(null);
  const startMarquee = (e: React.PointerEvent) => {
    const el = vpRef.current!;
    const box = marquee.current!;
    const origin = el.getBoundingClientRect();
    const base = useUI.getState().selectedWindows;
    const sx = e.clientX - origin.left, sy = e.clientY - origin.top;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* capture is a nicety (keeps the band tracking outside the canvas) */
    }
    const move = (ev: PointerEvent) => {
      const x0 = Math.min(sx, ev.clientX - origin.left), y0 = Math.min(sy, ev.clientY - origin.top);
      const x1 = Math.max(sx, ev.clientX - origin.left), y1 = Math.max(sy, ev.clientY - origin.top);
      Object.assign(box.style, { display: "block", transform: `translate(${x0}px, ${y0}px)`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
      const a = viewport.toWorld(x0, y0), b = viewport.toWorld(x1, y1);
      const hits = activeBoard()
        .windows.filter((w) => w.x < b.x && w.x + w.w > a.x && w.y < b.y && w.y + w.h > a.y)
        .map((w) => w.id);
      const next = [...new Set([...base, ...hits])];
      const cur = useUI.getState().selectedWindows;
      if (next.length !== cur.length || next.some((id, i) => id !== cur[i])) useUI.setState({ selectedWindows: next });
    };
    const up = () => {
      box.style.display = "none";
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  // Drag-to-pan on empty canvas, middle mouse anywhere, or space+drag.
  const onPointerDown = (e: React.PointerEvent) => {
    const onBackground = e.target === vpRef.current || e.target === worldRef.current;
    if (onBackground && e.button === 0 && e.shiftKey && !spaceDown.current) {
      e.preventDefault();
      startMarquee(e);
      return;
    }
    if (!(e.button === 1 || (e.button === 0 && (onBackground || spaceDown.current)))) return;
    e.preventDefault();
    if (onBackground && e.button === 0 && !spaceDown.current) useUI.setState({ focusedWindow: null, selectedWindows: [] });
    const el = vpRef.current!;
    el.setPointerCapture(e.pointerId);
    el.classList.add("panning");
    const start = { x: e.clientX, y: e.clientY, vx: viewport.vp.x, vy: viewport.vp.y };
    const move = (ev: PointerEvent) => viewport.set({ ...viewport.vp, x: start.vx + ev.clientX - start.x, y: start.vy + ev.clientY - start.y });
    const up = () => {
      el.classList.remove("panning");
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };

  const onDrop = (e: React.DragEvent) => {
    const id = e.dataTransfer.getData("application/x-ret-thread");
    if (!id) return;
    e.preventDefault();
    const rect = vpRef.current!.getBoundingClientRect();
    const p = viewport.toWorld(e.clientX - rect.left, e.clientY - rect.top);
    const existing = activeBoard().windows.find((w) => w.threadId === id);
    if (existing) {
      updateBoard((b) => ({ ...b, windows: b.windows.map((w) => (w.id === existing.id ? { ...w, x: p.x - 40, y: p.y - 16 } : w)) }));
      return;
    }
    openThread(id, { mode: "canvas" });
    // Move the freshly placed window under the cursor.
    updateBoard((b) => {
      const w = b.windows.find((x) => x.threadId === id);
      return w ? { ...b, windows: b.windows.map((x) => (x === w ? { ...x, x: p.x - 40, y: p.y - 16 } : x)) } : b;
    });
  };

  const zoomBy = (f: number) => {
    const el = vpRef.current!;
    const vp = viewport.vp;
    const cx = el.clientWidth / 2;
    const cy = el.clientHeight / 2;
    const next = Math.max(0.15, Math.min(2, vp.zoom * f));
    const k = next / vp.zoom;
    viewport.animateTo({ zoom: next, x: cx - (cx - vp.x) * k, y: cy - (cy - vp.y) * k }, 160);
  };

  return (
    <div className="canvas-view">
      <div
        ref={vpRef}
        className="canvas-viewport"
        onPointerDown={onPointerDown}
        onDragOver={(e) => e.dataTransfer.types.includes("application/x-ret-thread") && e.preventDefault()}
        onDrop={onDrop}
        onContextMenu={(e) => {
          const t = e.target as Element;
          if (t !== vpRef.current && t !== worldRef.current && !t.closest(".links")) return;
          e.preventDefault();
          const rect = vpRef.current!.getBoundingClientRect();
          const at = viewport.toWorld(e.clientX - rect.left, e.clientY - rect.top);
          setMenu({ x: e.clientX, y: e.clientY, items: canvasMenu(at, e.clientX, e.clientY, setMenu) });
        }}
      >
        <div ref={worldRef} className={`canvas-world ${card ? "lod-card" : ""}`}>
          <Links board={board} />
          {board.windows.map((w) => (
            <CanvasWindow key={w.id} win={w} card={card} focused={focused === w.id} />
          ))}
        </div>
        <div ref={marquee} className="marquee" />
        {board.windows.length === 0 && (
          <div className="canvas-empty">
            <p>Drag threads here from the sidebar, or open them with <kbd>Ctrl K</kbd>.</p>
            <p className="muted">Right-click for a new thread here · Scroll to pan · Ctrl+scroll to zoom</p>
          </div>
        )}
      </div>
      <div className="canvas-toolbar">
        <BoardSwitcher />
        {selectedCount > 1 && (
          <>
            <span className="tb-sep" />
            <button className="sel-chip" title="Drag any of them to move them together · Esc to clear" onClick={() => useUI.setState({ selectedWindows: [] })}>
              {selectedCount} selected
              <X size={12} />
            </button>
          </>
        )}
        <span className="tb-sep" />
        <button className="icon-btn" title="Zoom out (Ctrl -)" onClick={() => zoomBy(1 / 1.25)}>
          <Minus size={14} />
        </button>
        <button className="zoom-label" title="Reset to 100%" onClick={() => zoomBy(1 / viewport.vp.zoom)}>
          {zoomLabel}%
        </button>
        <button className="icon-btn" title="Zoom in (Ctrl +)" onClick={() => zoomBy(1.25)}>
          <Plus size={14} />
        </button>
        <span className="tb-sep" />
        <button className="icon-btn" title="Fit all windows (Ctrl 0)" onClick={() => fitAll()}>
          <Scan size={14} />
        </button>
        <button className="icon-btn" title="Tidy windows into rows" onClick={tidy}>
          <LayoutGrid size={14} />
        </button>
        <button
          className={`icon-btn ${showLinks ? "on" : ""}`}
          title={showLinks ? "Hide fork links" : "Show fork links"}
          onClick={() => useUI.setState((s) => ({ showLinks: !s.showLinks }))}
        >
          <GitFork size={14} />
        </button>
      </div>
      <Beacons board={board} viewportEl={vpRef} />
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
      <Minimap board={board} viewportEl={vpRef} />
    </div>
  );
}

type SetMenu = (m: { x: number; y: number; items: MenuItem[] } | null) => void;

/** The project a "new thread here" most likely belongs to: the focused window's, else the most recent. */
function contextProject(projects: ProjectNode[]): ProjectNode | undefined {
  const ui = useUI.getState();
  const focused = activeBoard(ui).windows.find((w) => w.id === ui.focusedWindow);
  const threads = useThreads.getState().threads;
  const t = focused ? threads[focused.threadId] : undefined;
  const draft = focused ? ui.drafts[focused.threadId] : undefined;
  const key = draft?.projectKey ?? (t ? projectKeyFor(t, threads, explicitKeys(ui.projects), ui.threadProject) : undefined);
  return projects.find((p) => p.key === key) ?? projects[0];
}

function canvasMenu(at: { x: number; y: number }, x: number, y: number, setMenu: SetMenu): MenuItem[] {
  const ui = useUI.getState();
  const projects = buildProjects(useThreads.getState().threads, ui.projects, ui.threadProject);
  const here = contextProject(projects);
  const board = activeBoard(ui);
  const create = (p: ProjectNode) => newThread(p.key, p.path, { mode: "canvas", at });
  return [
    ...(here
      ? [{ label: `New thread in ${here.name}`, icon: <MessageSquarePlus size={14} />, hint: "here", onClick: () => create(here) }]
      : []),
    {
      label: "New thread in…",
      icon: <Folder size={14} />,
      // Re-open in place as a project picker (menus don't nest).
      onClick: () =>
        setTimeout(() =>
          setMenu({
            x,
            y,
            items: projects.slice(0, 14).map((p) => ({ label: p.name, icon: <Folder size={14} />, hint: String(p.threadCount || ""), onClick: () => create(p) })),
          }),
        ),
    },
    { label: "Open a thread…", icon: <Command size={14} />, hint: "Ctrl+K", onClick: () => useUI.setState({ paletteOpen: true }) },
    { separator: true },
    { label: "Fit all windows", icon: <Scan size={14} />, hint: "Ctrl+0", disabled: !board.windows.length, onClick: () => fitAll() },
    { label: "Tidy windows", icon: <LayoutGrid size={14} />, disabled: !board.windows.length, onClick: tidy },
    {
      label: "Zoom to 100%",
      icon: <SquareDashed size={14} />,
      onClick: () => {
        const el = document.querySelector<HTMLElement>(".canvas-viewport");
        const k = 1 / viewport.vp.zoom;
        viewport.zoomAt(k, (el?.clientWidth ?? 0) / 2, (el?.clientHeight ?? 0) / 2);
      },
    },
    {
      label: "Fork links",
      icon: ui.showLinks ? <Check size={14} /> : <GitFork size={14} />,
      hint: ui.showLinks ? "on" : "off",
      onClick: () => useUI.setState((s) => ({ showLinks: !s.showLinks })),
    },
    { separator: true },
    {
      label: "New board",
      icon: <Plus size={14} />,
      onClick: () => {
        viewport.commit();
        const b: Board = { id: newId(), name: `Board ${useUI.getState().boards.length + 1}`, windows: [], viewport: { x: 40, y: 40, zoom: 1 } };
        useUI.setState((s) => ({ boards: [...s.boards, b], activeBoard: b.id, focusedWindow: null }));
      },
    },
    {
      label: "Close all windows",
      icon: <X size={14} />,
      danger: true,
      disabled: !board.windows.length,
      onClick: () => board.windows.forEach((w) => closeWindow(w.id)),
    },
  ];
}

function isTyping() {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

function BoardSwitcher() {
  const boards = useUI((s) => s.boards);
  const current = useUI((s) => activeBoard(s));
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);

  const switchTo = (b: Board) => {
    viewport.commit();
    useUI.setState({ activeBoard: b.id, focusedWindow: null });
  };

  const open = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({
      x: r.left,
      y: r.top - 8 - (boards.length + 5) * 32,
      items: [
        ...boards.map((b) => ({
          label: `${b.name}  ·  ${b.windows.length}`,
          icon: b.id === current.id ? <span className="dot-sel" /> : <span />,
          onClick: () => switchTo(b),
        })),
        { separator: true },
        {
          label: "New board",
          icon: <Plus size={14} />,
          onClick: () => {
            viewport.commit();
            const b: Board = { id: newId(), name: `Board ${boards.length + 1}`, windows: [], viewport: { x: 40, y: 40, zoom: 1 } };
            useUI.setState((s) => ({ boards: [...s.boards, b], activeBoard: b.id, focusedWindow: null }));
          },
        },
        {
          label: "Duplicate board",
          icon: <Copy size={14} />,
          onClick: () => {
            viewport.commit();
            const src = activeBoard();
            const b: Board = { ...structuredClone(src), id: newId(), name: `${src.name} copy`, windows: src.windows.map((w) => ({ ...w, id: newId() })) };
            useUI.setState((s) => ({ boards: [...s.boards, b], activeBoard: b.id }));
          },
        },
        {
          label: "Rename board",
          icon: <Pencil size={14} />,
          onClick: async () => {
            const name = await promptText({ title: "Rename board", initial: current.name, confirmLabel: "Rename" });
            if (name) updateBoard((b) => ({ ...b, name }));
          },
        },
        {
          label: "Delete board",
          icon: <Trash2 size={14} />,
          danger: true,
          disabled: boards.length < 2,
          onClick: () =>
            useUI.setState((s) => {
              const rest = s.boards.filter((b) => b.id !== s.activeBoard);
              return { boards: rest, activeBoard: rest[0].id, focusedWindow: null };
            }),
        },
      ],
    });
  };

  return (
    <>
      <button className="board-btn" onClick={open} title="Boards">
        <span>{current.name}</span>
        <ChevronDown size={12} />
      </button>
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
    </>
  );
}
