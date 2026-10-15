import { memo, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minimize2, X, GitFork, FolderGit2, Copy } from "lucide-react";
import { activeBoard, updateBoard, useUI, isApp, isDraft, isFile, isThread, filePath, type CanvasWin } from "../../state/ui";
import { FilePane, FileTile } from "../code/FilePane";
import { AppPane, AppTile } from "./AppPane";
import { copyText } from "../../lib/files";
import { markAttended, markSeen, useThreads } from "../../state/threads";
import { FreezeContext, FreezeGate, holdViews, useThread } from "../../state/useThread";
import { closeWindow, focusWindow, forkThread, renameThread } from "../../state/actions";
import { threadTitle } from "../../state/projects";
import { ThreadPane, threadMoreItems } from "../thread/ThreadPane";
import { Menu, type MenuItem } from "../Menu";
import { promptText } from "../ui/Dialog";
import { isDesktop } from "../../bridge";
import { StatusDot, useThreadState } from "../StatusDot";
import { toggleMaximize, viewport, viewportSize } from "./viewport";
import { setLiveRect } from "./live";
import { lodAtMount, registerWindow, type Lod } from "./lod";
import { plainText } from "../../lib/format";
import { classify } from "../../lib/useSize";
import { holdCursor } from "../../lib/cursorShield";

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

export const CanvasWindow = memo(function CanvasWindow({ win, focused }: { win: CanvasWin; focused: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const state = useThreadState(win.threadId);
  const selected = useUI((s) => s.selectedWindows.includes(win.id));

  // How much of the window is drawn (see lod.ts): set on the DOM as the view moves, never by a render.
  // The full view renders into a host element of its own, which is in the window only while the full
  // view shows (or lingers, just culled): zoomed out to its card, or culled a while, the view stays
  // built (React keeps it, scroll and all) but is out of the document, so the browser has nothing of
  // it to style, lay out or walk. A view that hasn't been shown yet (zoomed out, or opened away from
  // the view on a big board) is built when the app is idle, or as soon as the view comes near it, so
  // zooming in or panning over never has to build every window's transcript in one frame.
  const [start] = useState(() => lodAtMount(win, activeBoard().id, activeBoard().viewport));
  const lod = useRef<Lod>(start);
  const [host] = useState(() => {
    const el = document.createElement("div");
    el.className = "cwin-body";
    return el;
  });
  const [warm, setWarm] = useState(!start.card && !start.culled);
  const warmNow = useRef(warm);
  warmNow.current = warm;
  // A view nobody can see (culled, or the full view under the card, or the card over the full view)
  // is frozen: it stops following the store, catches up now and then when the app is idle, and all
  // at once when it's back.
  const gate = useMemo(() => new FreezeGate(), []);
  // The card only shows zoomed out, and catches up then: no idle catch-ups behind the full view.
  const cardGate = useMemo(() => new FreezeGate(false), []);
  useLayoutEffect(() => gate.connect(), [gate]);
  useLayoutEffect(() => cardGate.connect(), [cardGate]);
  useLayoutEffect(() => {
    const el = ref.current!;
    /** Take the full view out of the document. */
    const detach = () => {
      if (!host.isConnected) return;
      // The hidden view mustn't keep taking keystrokes.
      const active = document.activeElement;
      if (active instanceof HTMLElement && host.contains(active)) active.blur();
      host.remove();
    };
    const apply = ({ culled, card }: Lod) => {
      lod.current = { culled, card };
      const full = !culled && !card;
      // Back in front of the resize handles (React keeps the rest of the window's children in order).
      if (full && !host.isConnected) el.insertBefore(host, el.querySelector(":scope > .rz"));
      if (card) detach();
      // Attributes, not classes: React owns className and would drop them on the next render.
      // Culled with its full view still laid out, it stays displayed (off screen) until lod.ts lets
      // it go (`release`); with nothing laid out to keep, it goes at once.
      if (!culled) el.removeAttribute("data-culled");
      else if (!host.isConnected) el.setAttribute("data-culled", "");
      if (card) el.setAttribute("data-lod", "card");
      else el.removeAttribute("data-lod");
      gate.set(!full);
      cardGate.set(culled || !card);
      if (full && !warmNow.current) startTransition(() => setWarm(true));
    };
    const release = () => {
      detach();
      el.setAttribute("data-culled", "");
    };
    apply(lod.current);
    const off = registerWindow(win.id, { apply, release, attached: () => host.isConnected }, lod.current);
    return () => {
      off();
      host.remove();
    };
  }, [win.id, gate, cardGate, host]);
  useEffect(() => {
    if (warm) return;
    if (!lod.current.card && !lod.current.culled) return void startTransition(() => setWarm(true));
    const idle = requestIdleCallback(() => startTransition(() => setWarm(true)), { timeout: 5000 });
    return () => cancelIdleCallback(idle);
  }, [warm]);
  const isCard = () => lod.current.card;

  // On a canvas everything is on screen; only the window you've clicked counts as seen.
  useEffect(() => {
    if (!focused || !isThread(win.threadId)) return;
    markAttended(win.threadId, 1);
    return () => markAttended(win.threadId, -1);
  }, [focused, win.threadId]);
  // ...and it stays seen: whatever marks it as new activity while you're on it, it never shimmers
  // for a click (before paint, so not even for a frame).
  useLayoutEffect(() => {
    if (focused && state === "unread") markSeen(win.threadId);
  }, [focused, state, win.threadId]);

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
    const releaseCursor = holdCursor(mode === "move" ? "grabbing" : getComputedStyle(target).cursor);
    holdViews("window", true);
    // A drag moves windows by animations whose keyframes are set on each move: the compositor takes
    // an animated transform as is, where a new transform style re-layerizes the whole canvas on every
    // move. It's made a plain style again when the drag ends. (A resize lays out anyway.)
    const moving = new Map<HTMLElement, { anim: Animation; rect: Rect }>();
    const moveTo = (target: HTMLElement, r: Rect) => {
      const t = `translate(${r.x}px, ${r.y}px)`;
      const frames = [{ transform: t }, { transform: t }];
      const m = moving.get(target);
      if (m) {
        (m.anim.effect as KeyframeEffect).setKeyframes(frames);
        m.rect = r;
      } else moving.set(target, { anim: target.animate(frames, { duration: 1e9, fill: "forwards" }), rect: r });
    };

    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / zoom;
      const dy = (ev.clientY - start.y) / zoom;
      if (mode === "move") {
        const raw = { ...orig, x: orig.x + dx, y: orig.y + dy };
        const s = ev.altKey ? raw : { ...raw, ...snapMove(raw, others, threshold) };
        rect = s;
        for (const m of mates) {
          const r = { ...m.orig, x: m.orig.x + (s.x - orig.x), y: m.orig.y + (s.y - orig.y) };
          if (m.el) moveTo(m.el, r);
          setLiveRect(m.id, r);
        }
        moveTo(el, rect);
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
        applyRect(el, rect);
      }
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
      releaseCursor();
      holdViews("window", false);
      // Where the drag left them, as plain styles, in the frame the animations go.
      for (const [target, m] of moving) {
        applyRect(target, m.rect);
        m.anim.cancel();
      }
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
    if (!isCard() && (e.target as HTMLElement).closest(NOT_BACKGROUND)) return;
    e.preventDefault();
    const id = win.threadId;
    const rename = () => {
      if (!isCard()) {
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

  // Stable props for the (memoized) full view, so a window re-rendering for its card, selection or
  // state doesn't re-render a whole transcript.
  const gesture = useRef(startGesture);
  gesture.current = startGesture;
  const onHeaderPointerDown = useCallback((e: React.PointerEvent) => gesture.current(e, "move"), []);
  const onHeaderDoubleClick = useCallback(() => toggleMaximize(win.id), [win.id]);
  const onCardPointerDown = useCallback((e: React.PointerEvent) => gesture.current(e, "move"), []);
  const onCardDoubleClick = useCallback(() => zoomToWindow(win.id), [win.id]);
  const maximized = !!win.prev;
  const controls = useMemo(
    () => (
      <>
        <button className="icon-btn" title={maximized ? "Restore" : "Maximize (double-click title)"} onClick={() => toggleMaximize(win.id)}>
          {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
        <button className="icon-btn" title="Close window (Ctrl+W)" onClick={() => closeWindow(win.id)}>
          <X size={14} />
        </button>
      </>
    ),
    [win.id, maximized],
  );
  // The size class the view will have: it may be built out of the document, where it can't measure.
  const [initialSize] = useState(() => classify(win.w - 2, win.h - 2));
  // Not `focused`: the window's frame shows that, and a chat or file view doesn't need it, so a click
  // between windows re-renders neither view. (An Inbox or Code window takes keys when focused.)
  const paneProps = { onHeaderPointerDown, onHeaderDoubleClick, windowControls: controls };

  return (
    <div
      ref={ref}
      className={`cwin ${focused ? "focused" : ""} ${selected ? "selected" : ""} ${menu ? "menu-open" : ""} state-${state}`}
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
        if (e.button !== 0 || isCard() || !isWindowBackground(e)) return;
        startGesture(e, "move");
      }}
      onContextMenu={onContextMenu}
      data-win={win.id}
      // Set once here; lod.ts changes them from then on (React leaves an unchanged prop alone).
      data-culled={start.culled ? "" : undefined}
      data-lod={start.card ? "card" : undefined}
    >
      {menu && <Menu {...menu} onClose={() => setMenu(null)} />}
      {/* The card is always there (shown zoomed out, by CSS), so zooming across never renders. */}
      <FreezeContext.Provider value={cardGate}>
        {isApp(win.threadId) ? (
          <AppTile id={win.threadId} onPointerDown={onCardPointerDown} onDoubleClick={onCardDoubleClick} />
        ) : isFile(win.threadId) ? (
          <FileTile id={win.threadId} onPointerDown={onCardPointerDown} onDoubleClick={onCardDoubleClick} />
        ) : (
          <ThreadCard threadId={win.threadId} onPointerDown={onCardPointerDown} winId={win.id} />
        )}
      </FreezeContext.Provider>
      {(warm || (!lod.current.card && !lod.current.culled)) &&
        createPortal(
          <FreezeContext.Provider value={gate}>
            {isApp(win.threadId) ? (
              <AppPane id={win.threadId} focused={focused} {...paneProps} />
            ) : isFile(win.threadId) ? (
              <FilePane id={win.threadId} chrome="window" {...paneProps} />
            ) : (
              <ThreadPane threadId={win.threadId} chrome="window" initialSize={initialSize} {...paneProps} />
            )}
          </FreezeContext.Provider>,
          host,
        )}
      {HANDLES.map((h) => (
        <div key={h} className={`rz rz-${h}`} onPointerDown={(e) => startGesture(e, h)} />
      ))}
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
  const thread = useThread(threadId, (s) => s.threads[threadId]);
  const state = useThreadState(threadId);
  const lastText = useThread(threadId, (s) => {
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
