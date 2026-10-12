import { startTransition, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, Command, Copy, Folder, GitFork, LayoutGrid, MessageSquarePlus, Minus, Pencil, Plus, Scan, SquareDashed, Trash2, X, Code2, Inbox } from "lucide-react";
import { activeBoard, appId, newId, updateBoard, useUI, type AppKind, type Board } from "../../state/ui";
import { DRAG_APP } from "../Titlebar";
import { closeWindow, focusWindow, newThread, openThread } from "../../state/actions";
import { useThreads } from "../../state/threads";
import { buildProjects, explicitKeys, projectKeyFor, type ProjectNode } from "../../state/projects";
import { Links } from "./Links";
import { CanvasWindow } from "./CanvasWindow";
import { Minimap } from "./Minimap";
import { Beacons } from "./Beacons";
import { CARD_ZOOM, MAX_ZOOM, fitAll, revealWindow, tidy, viewport, type Viewport } from "./viewport";
import { Menu, type MenuItem } from "../Menu";
import { promptText } from "../ui/Dialog";

/** Dot spacing at 100%. */
const GRID = 24;
/** The dot layer overhangs the view by one spacing at the largest zoom, so sliding it never shows an edge. */
const GRID_PAD = GRID * MAX_ZOOM;
const mod = (v: number, m: number) => ((v % m) + m) % m;

export function CanvasView() {
  const board = useUI((s) => activeBoard(s));
  const focused = useUI((s) => s.focusedWindow);
  const vpRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const itemsRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const zoomLabelRef = useRef<HTMLButtonElement>(null);
  const [card, setCard] = useState(board.viewport.zoom < CARD_ZOOM);
  const spaceDown = useRef(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const showLinks = useUI((s) => s.showLinks);
  const selectedCount = useUI((s) => s.selectedWindows.length);

  // Load this board's saved viewport when switching boards.
  useLayoutEffect(() => {
    viewport.load(board.viewport);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board.id]);

  // Paint viewport changes straight to the DOM. Everything here is compositor work (a transform)
  // except when the zoom changes, and even then the windows' contents aren't restyled or redrawn.
  useLayoutEffect(() => {
    const world = worldRef.current!;
    const items = itemsRef.current!;
    const grid = gridRef.current!;
    let last: Viewport | null = null;
    let settle = 0;
    let undo = 0;
    /**
     * Zoom the windows' contents were last drawn at. The world is will-change: transform, so the
     * compositor scales that drawing to the current zoom instead of redrawing every window each
     * frame (and pans don't re-layer the page).
     */
    let drawnAt = 0;
    const counterScale = (zoom: number) => items.style.setProperty("--inv-zoom", String(1 / zoom));
    /** Draw the windows afresh at the current zoom: will-change off for a frame (two, from a timer). */
    const redraw = () => {
      drawnAt = viewport.vp.zoom;
      world.classList.add("redraw");
      cancelAnimationFrame(undo);
      undo = requestAnimationFrame(() => (undo = requestAnimationFrame(() => world.classList.remove("redraw"))));
    };
    const settled = () => {
      counterScale(viewport.vp.zoom);
      if (viewport.vp.zoom !== drawnAt) redraw();
    };
    const off = viewport.subscribe((vp) => {
      // Whole device pixels: a fractional offset makes the browser redraw every glyph to re-align it.
      const r = window.devicePixelRatio || 1;
      const x = Math.round(vp.x * r) / r;
      const y = Math.round(vp.y * r) / r;
      world.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${vp.zoom})`;
      const g = GRID * vp.zoom;
      grid.style.transform = `translate3d(${mod(x, g)}px, ${mod(y, g)}px, 0)`;
      if (vp.zoom === last?.zoom) return;

      grid.style.backgroundSize = `${g}px ${g}px`;
      grid.style.backgroundPosition = `${GRID_PAD % g}px ${GRID_PAD % g}px`;
      grid.hidden = vp.zoom < 0.45;
      zoomLabelRef.current!.textContent = `${Math.round(vp.zoom * 100)}%`;
      const nextCard = vp.zoom < CARD_ZOOM;
      if (!last || nextCard !== last.zoom < CARD_ZOOM) {
        // Back to full windows: render them without holding up the zoom (they're usually ready already).
        if (nextCard) setCard(true);
        else startTransition(() => setCard(false));
      }
      const gesture = !!last && !viewport.jumping;
      // Things kept the same size on screen (window outlines and glows, link badges, card text)
      // follow a zoom live only on cards. Full windows catch up when it settles: restyling every
      // window each frame costs more than a moment of slightly-off outline shows.
      if (nextCard || !gesture) counterScale(vp.zoom);
      // Redraw sharp once a zoom settles, along the way when it has drifted far enough to look
      // soft (in) or cost memory (out), and straight away on a jump to another board.
      if (!last) drawnAt = vp.zoom;
      else if (!gesture || vp.zoom > drawnAt * 2 || vp.zoom < drawnAt / 1.6) redraw();
      if (gesture) {
        clearTimeout(settle);
        settle = window.setTimeout(settled, 150);
      }
      last = vp;
    });
    return () => {
      off();
      clearTimeout(settle);
      cancelAnimationFrame(undo);
    };
  }, []);

  useLayoutEffect(() => {
    const el = vpRef.current!;
    const measure = () => {
      viewport.size = { w: el.clientWidth, h: el.clientHeight };
    };
    measure();
    viewport.flush(); // the minimap and beacons subscribed (as children) before the size was known
    const ro = new ResizeObserver(() => {
      measure();
      viewport.flush();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
      if (document.querySelector(".menu, .overlay:not(.monaco-editor *), .dialog")) return;
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
    // A thread from the sidebar, or a mode (Inbox, Code) from the title bar to have as a window.
    const app = e.dataTransfer.getData(DRAG_APP) as AppKind | "";
    const id = app ? appId(app) : e.dataTransfer.getData("application/x-ret-thread");
    if (!id) return;
    e.preventDefault();
    const rect = vpRef.current!.getBoundingClientRect();
    const p = viewport.toWorld(e.clientX - rect.left, e.clientY - rect.top);
    const existing = activeBoard().windows.find((w) => w.threadId === id);
    if (existing) {
      updateBoard((b) => ({ ...b, windows: b.windows.map((w) => (w.id === existing.id ? { ...w, x: p.x - 40, y: p.y - 16 } : w)) }));
      focusWindow(existing.id);
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
        onDragOver={(e) => (e.dataTransfer.types.includes("application/x-ret-thread") || e.dataTransfer.types.includes(DRAG_APP)) && e.preventDefault()}
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
        <div ref={gridRef} className="canvas-grid" />
        <div ref={worldRef} className={`canvas-world ${card ? "lod-card" : ""}`}>
          {/* Carries --inv-zoom. Not on the world itself: its transform changes every pan frame, and
              the windows opt in to inheriting --inv-zoom, so they'd be restyled every frame too. */}
          <div ref={itemsRef} className="canvas-items">
            <Links board={board} />
            {board.windows.map((w) => (
              <CanvasWindow key={w.id} win={w} card={card} focused={focused === w.id} />
            ))}
          </div>
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
        {/* Text written by the viewport listener: zooming doesn't re-render the canvas. */}
        <button ref={zoomLabelRef} className="zoom-label" title="Reset to 100%" onClick={() => zoomBy(1 / viewport.vp.zoom)} />
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

/** Inbox or Code as a window at `at`. There's one of each: if it's open already, it moves there. */
function placeApp(kind: AppKind, at: { x: number; y: number }) {
  const id = appId(kind);
  const existing = activeBoard().windows.find((w) => w.threadId === id);
  if (!existing) return openThread(id, { mode: "canvas", at });
  updateBoard((b) => ({ ...b, windows: b.windows.map((w) => (w.id === existing.id ? { ...w, x: at.x, y: at.y } : w)) }));
  focusWindow(existing.id);
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
    ...(["inbox", "code"] as const).map((kind) => ({
      label: kind === "inbox" ? "Inbox window" : "Code window",
      icon: kind === "inbox" ? <Inbox size={14} /> : <Code2 size={14} />,
      hint: board.windows.some((w) => w.threadId === appId(kind)) ? "move here" : "here",
      onClick: () => placeApp(kind, at),
    })),
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
