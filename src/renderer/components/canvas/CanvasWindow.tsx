import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2, X, GitFork, FolderGit2, Copy } from "lucide-react";
import { activeBoard, updateBoard, useUI, isApp, isDraft, isFile, isThread, filePath, type CanvasWin } from "../../state/ui";
import { FilePane, FileTile } from "../code/FilePane";
import { AppPane, AppTile } from "./AppPane";
import { copyText } from "../../lib/files";
import { markAttended, useThreads } from "../../state/threads";
import { closeWindow, focusWindow, forkThread, renameThread } from "../../state/actions";
import { threadTitle } from "../../state/projects";
import { ThreadPane, threadMoreItems } from "../thread/ThreadPane";
import { Menu, type MenuItem } from "../Menu";
import { promptText } from "../ui/Dialog";
import { isDesktop } from "../../bridge";
import { StatusDot, useThreadState } from "../StatusDot";
import { toggleMaximize, viewport, viewportSize } from "./viewport";
import { setLiveRect } from "./live";
import { plainText } from "../../lib/format";

const MIN_W = 220;
const MIN_H = 130;
const GRID = 8;
const GAP = 16;

type Rect = { x: number; y: number; w: number; h: number };

/** Snap a moving rect's edges to the grid and to nearby windows (flush or with a gap). */
function snapMove(r: Rect, others: Rect[], threshold: number): { x: number; y: number } {
  let bestX = { d: threshold, v: Math.round(r.x / GRID) * GRID };
  let bestY = { d: threshold, v: Math.round(r.y / GRID) * GRID };
  for (const o of others) {
    const xs = [o.x, o.x + o.w + GAP, o.x - r.w - GAP, o.x + o.w - r.w];
    for (const v of xs) {
      const d = Math.abs(r.x - v);
      if (d < bestX.d) bestX = { d, v };
    }
    const ys = [o.y, o.y + o.h + GAP, o.y - r.h - GAP, o.y + o.h - r.h];
    for (const v of ys) {
      const d = Math.abs(r.y - v);
      if (d < bestY.d) bestY = { d, v };
    }
  }
  return { x: bestX.v, y: bestY.v };
}

function snapEdge(v: number, candidates: number[], threshold: number) {
  let best = { d: threshold, v: Math.round(v / GRID) * GRID };
  for (const c of candidates) {
    const d = Math.abs(v - c);
    if (d < best.d) best = { d, v: c };
  }
  return best.v;
}

function applyRect(el: HTMLElement, r: Rect) {
  el.style.transform = `translate(${r.x}px, ${r.y}px)`;
  el.style.width = `${r.w}px`;
  el.style.height = `${r.h}px`;
}

const HANDLES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;

/** The window that had focus before the current press (a press focuses what it lands on first). */
let focusBeforePress: string | null = null;

/** Things that keep their own pointer behavior inside a window: controls and selectable text. */
const NOT_BACKGROUND = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "label",
  "[role=option]",
  "[contenteditable]",
  ".composer",
  ".rz",
  ".approval",
  ".sel-menu",
  ".menu",
  // selectable text (shows the I-beam cursor)
  ".md",
  ".user-text",
  "pre",
  "code",
  ".output",
  ".diff",
  ".glance-text",
  ".hook",
  // a file window's editor: select and scroll code, don't drag the window
  ".monaco-editor",
  // an Inbox or Code window: its lists, tree and editor are for using, not dragging
  ".app-win-body",
  ".cv-state",
].join(",");

function isWindowBackground(e: React.PointerEvent): boolean {
  const target = e.target as HTMLElement;
  if (target.closest(NOT_BACKGROUND)) return false;
  // A press on a scrollbar lands on the scrolling element itself: let it scroll.
  if (e.nativeEvent.offsetX > target.clientWidth || e.nativeEvent.offsetY > target.clientHeight) return false;
  return true;
}

export const CanvasWindow = memo(function CanvasWindow({ win, card, focused }: { win: CanvasWin; card: boolean; focused: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const state = useThreadState(win.threadId);
  const selected = useUI((s) => s.selectedWindows.includes(win.id));

  // On a canvas everything is on screen; only the window you've clicked counts as seen.
  useEffect(() => {
    if (!focused || !isThread(win.threadId)) return;
    markAttended(win.threadId, 1);
    return () => markAttended(win.threadId, -1);
  }, [focused, win.threadId]);

  const commit = useCallback(
    (r: Rect) => updateBoard((b) => ({ ...b, windows: b.windows.map((w) => (w.id === win.id ? { ...w, ...r, prev: undefined } : w)) })),
    [win.id],
  );

  /** Space+drag and the middle button pan the canvas, even over a window. */
  const panning = (e: React.PointerEvent) => e.button === 1 || !!ref.current?.closest(".space-pan");

  /** Shift+press: add this window to the selection, or take it out. */
  const toggleSelected = () =>
    useUI.setState((s) => {
      const cur = s.selectedWindows;
      if (cur.includes(win.id)) return { selectedWindows: cur.filter((id) => id !== win.id) };
      // Starting a selection takes in the window you were already on.
      const onBoard = (id: string | null) => !!id && id !== win.id && activeBoard(s).windows.some((w) => w.id === id);
      const base = cur.length ? cur : onBoard(focusBeforePress) ? [focusBeforePress!] : [];
      return { selectedWindows: [...base, win.id] };
    });

  const startGesture = (e: React.PointerEvent, mode: "move" | (typeof HANDLES)[number]) => {
    if (e.button !== 0 || panning(e)) return;
    e.preventDefault();
    e.stopPropagation();
    if (mode === "move" && e.shiftKey) toggleSelected();
    focusWindow(win.id);
    const el = ref.current!;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const zoom = viewport.vp.zoom;
    const start = { x: e.clientX, y: e.clientY };
    const orig: Rect = { x: win.x, y: win.y, w: win.w, h: win.h };
    const board = activeBoard();
    // Dragging one of several selected windows moves the lot, snapping as one to everything else.
    const sel = useUI.getState().selectedWindows;
    const group = mode === "move" && sel.length > 1 && sel.includes(win.id) ? new Set(sel) : new Set([win.id]);
    const mates = board.windows
      .filter((w) => group.has(w.id) && w.id !== win.id)
      .map((w) => ({ id: w.id, orig: { x: w.x, y: w.y, w: w.w, h: w.h }, el: document.querySelector<HTMLElement>(`.cwin[data-win="${w.id}"]`) }));
    const others = board.windows.filter((w) => !group.has(w.id));
    const threshold = 10 / zoom;
    const xEdges = others.flatMap((o) => [o.x, o.x + o.w, o.x - GAP, o.x + o.w + GAP]);
    const yEdges = others.flatMap((o) => [o.y, o.y + o.h, o.y - GAP, o.y + o.h + GAP]);
    let rect = orig;
    el.classList.add("gesturing");
    mates.forEach((m) => m.el?.classList.add("gesturing"));
    document.body.classList.add(mode === "move" ? "dragging" : "resizing");

    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / zoom;
      const dy = (ev.clientY - start.y) / zoom;
      if (mode === "move") {
        const raw = { ...orig, x: orig.x + dx, y: orig.y + dy };
        const s = ev.altKey ? raw : { ...raw, ...snapMove(raw, others, threshold) };
        rect = s;
        for (const m of mates) {
          const r = { ...m.orig, x: m.orig.x + (s.x - orig.x), y: m.orig.y + (s.y - orig.y) };
          if (m.el) applyRect(m.el, r);
          setLiveRect(m.id, r);
        }
      } else {
        let { x, y, w, h } = orig;
        if (mode.includes("e")) w = snapEdge(orig.x + orig.w + dx, xEdges, threshold) - x;
        if (mode.includes("s")) h = snapEdge(orig.y + orig.h + dy, yEdges, threshold) - y;
        if (mode.includes("w")) {
          const nx = snapEdge(orig.x + dx, xEdges, threshold);
          w = orig.x + orig.w - nx;
          x = nx;
        }
        if (mode.includes("n")) {
          const ny = snapEdge(orig.y + dy, yEdges, threshold);
          h = orig.y + orig.h - ny;
          y = ny;
        }
        if (w < MIN_W) {
          if (mode.includes("w")) x -= MIN_W - w;
          w = MIN_W;
        }
        if (h < MIN_H) {
          if (mode.includes("n")) y -= MIN_H - h;
          h = MIN_H;
        }
        rect = { x, y, w, h };
      }
      applyRect(el, rect);
      setLiveRect(win.id, rect);
    };
    let ended = false;
    const up = () => {
      if (ended) return;
      ended = true;
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", up);
      target.removeEventListener("pointercancel", up);
      target.removeEventListener("lostpointercapture", up);
      el.classList.remove("gesturing");
      mates.forEach((m) => m.el?.classList.remove("gesturing"));
      document.body.classList.remove("dragging", "resizing");
      if (rect !== orig) {
        if (mates.length) {
          const ddx = rect.x - orig.x, ddy = rect.y - orig.y;
          updateBoard((b) => ({
            ...b,
            windows: b.windows.map((w) =>
              w.id === win.id ? { ...w, ...rect, prev: undefined } : group.has(w.id) ? { ...w, x: w.x + ddx, y: w.y + ddy, prev: undefined } : w,
            ),
          }));
        } else commit(rect);
      }
      setLiveRect(win.id, null);
      mates.forEach((m) => setLiveRect(m.id, null));
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", up);
    target.addEventListener("pointercancel", up);
    // Capture can vanish mid-gesture (element re-rendered as a card, window closed): end cleanly.
    target.addEventListener("lostpointercapture", up);
  };

  // Right-click on the window itself (title bar, background, zoomed-out card): its "…" menu plus
  // window actions. Text, links and files inside keep their own (copy, open, fork with selection).
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const onContextMenu = (e: React.MouseEvent) => {
    if (!card && (e.target as HTMLElement).closest(NOT_BACKGROUND)) return;
    e.preventDefault();
    const id = win.threadId;
    const rename = () => {
      if (!card) {
        window.dispatchEvent(new CustomEvent("ret:rename-thread", { detail: id }));
        return;
      }
      const t = useThreads.getState().threads[id];
      void promptText({ title: "Rename thread", label: "Name", initial: t?.name ?? threadTitle(t), confirmLabel: "Rename" }).then(
        (name) => name?.trim() && void renameThread(id, name.trim()),
      );
    };
    const thread = useThreads.getState().threads[id];
    const items: MenuItem[] = [
      ...(isApp(id)
        ? []
        : isFile(id)
        ? [{ label: "Copy path", icon: <Copy size={14} />, onClick: () => copyText(filePath(id), "Path copied") }, { separator: true as const }]
        : isDraft(id)
        ? []
        : [
            ...threadMoreItems(id, rename),
            { separator: true as const },
            { label: "Fork conversation", icon: <GitFork size={14} />, hint: "Ctrl+Shift+F", onClick: () => void forkThread(id) },
            ...(isDesktop && thread?.gitInfo
              ? [{ label: "Fork into new worktree", icon: <FolderGit2 size={14} />, onClick: () => void forkThread(id, { worktree: true }) }]
              : []),
            { separator: true as const },
          ]),
      { label: win.prev ? "Restore size" : "Maximize", icon: win.prev ? <Minimize2 size={14} /> : <Maximize2 size={14} />, onClick: () => toggleMaximize(win.id) },
      { label: "Close window", icon: <X size={14} />, hint: "Ctrl+W", onClick: () => closeWindow(win.id) },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const controls = (
    <>
      <button className="icon-btn" title={win.prev ? "Restore" : "Maximize (double-click title)"} onClick={() => toggleMaximize(win.id)}>
        {win.prev ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
      </button>
      <button className="icon-btn" title="Close window (Ctrl+W)" onClick={() => closeWindow(win.id)}>
        <X size={14} />
      </button>
    </>
  );

  return (
    <div
      ref={ref}
      className={`cwin ${focused ? "focused" : ""} ${card ? "card" : ""} ${selected ? "selected" : ""} ${menu ? "menu-open" : ""} state-${state}`}
      style={{ transform: `translate(${win.x}px, ${win.y}px)`, width: win.w, height: win.h, zIndex: win.z }}
      onPointerDownCapture={(e) => {
        // Only a left press picks a window: the middle button and Space+drag pan, and a right
        // press opens the window's menu (it's highlighted while open) without moving focus.
        if (panning(e) || e.button !== 0) return;
        // A plain click on a window outside the selection ends the selection.
        if (e.button === 0 && !e.shiftKey && !selected && useUI.getState().selectedWindows.length) useUI.setState({ selectedWindows: [] });
        focusBeforePress = useUI.getState().focusedWindow;
        if (!focused) focusWindow(win.id);
      }}
      onPointerDown={(e) => {
        // Grab the window by any background: not text (select/copy) and not controls.
        if (e.button !== 0 || card || !isWindowBackground(e)) return;
        startGesture(e, "move");
      }}
      onContextMenu={onContextMenu}
      data-win={win.id}
    >
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
      {card && isApp(win.threadId) ? (
        <AppTile id={win.threadId} onPointerDown={(e) => startGesture(e, "move")} onDoubleClick={() => zoomToWindow(win.id)} />
      ) : isApp(win.threadId) ? (
        <AppPane
          id={win.threadId}
          focused={focused}
          onHeaderPointerDown={(e) => startGesture(e, "move")}
          onHeaderDoubleClick={() => toggleMaximize(win.id)}
          windowControls={controls}
        />
      ) : card && isFile(win.threadId) ? (
        <FileTile id={win.threadId} onPointerDown={(e) => startGesture(e, "move")} onDoubleClick={() => zoomToWindow(win.id)} />
      ) : card ? (
        <ThreadCard threadId={win.threadId} onPointerDown={(e) => startGesture(e, "move")} winId={win.id} />
      ) : isFile(win.threadId) ? (
        <FilePane
          id={win.threadId}
          chrome="window"
          focused={focused}
          onHeaderPointerDown={(e) => startGesture(e, "move")}
          onHeaderDoubleClick={() => toggleMaximize(win.id)}
          windowControls={controls}
        />
      ) : (
        <ThreadPane
          threadId={win.threadId}
          chrome="window"
          focused={focused}
          onHeaderPointerDown={(e) => startGesture(e, "move")}
          onHeaderDoubleClick={() => toggleMaximize(win.id)}
          windowControls={controls}
        />
      )}
      {!card &&
        HANDLES.map((h) => <div key={h} className={`rz rz-${h}`} onPointerDown={(e) => startGesture(e, h)} />)}
    </div>
  );
});

/** Fly to a window and fit it on screen (double-clicking a zoomed-out card). */
function zoomToWindow(winId: string) {
  const win = activeBoard().windows.find((w) => w.id === winId);
  if (!win) return;
  const { w, h } = viewportSize();
  viewport.animateTo(viewport.fitRect(win, w, h, 40, 1));
  useUI.setState({ focusedWindow: winId });
}

/** Zoomed-out representation: big, glanceable, cheap to render. */
function ThreadCard({ threadId, winId, onPointerDown }: { threadId: string; winId: string; onPointerDown: (e: React.PointerEvent) => void }) {
  const thread = useThreads((s) => s.threads[threadId]);
  const state = useThreadState(threadId);
  const lastText = useThreads((s) => {
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
  const title = isDraft(threadId) ? "New thread" : threadTitle(thread);
  const zoomIn = () => zoomToWindow(winId);
  return (
    <div className={`tcard state-${state}`} onPointerDown={onPointerDown} onDoubleClick={zoomIn}>
      <div className="tcard-head">
        <StatusDot threadId={threadId} />
        {thread?.forkedFromId && <GitFork className="tcard-fork" />}
        <span className="tcard-title">{title}</span>
      </div>
      <div className="tcard-body">{plainText(lastText ?? thread?.preview ?? "")}</div>
      <div className="tcard-state">{state === "attention" ? "Needs input" : state === "running" ? "Working…" : state === "unread" ? "New activity" : ""}</div>
    </div>
  );
}
