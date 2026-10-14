import { memo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Bot, Columns2, FileCode2, GitFork, Plus, X } from "lucide-react";
import { useUI, isDraft, isFile, isThread, filePath, type FocusSplit } from "../state/ui";
import { useFiles } from "../state/files";
import { FilePane } from "./code/FilePane";
import { useThreads } from "../state/threads";
import { closePane, closeTab, newThreadNear, openThread, setSplitRatio } from "../state/actions";
import { spawnedBy, threadTitle } from "../state/projects";
import type { Thread } from "@shared/protocol";
import { StatusDot } from "./StatusDot";
import { ThreadPane } from "./thread/ThreadPane";
import { EmptyState } from "./EmptyState";

const DRAG_THREAD = "application/x-ret-thread";
const DRAG_TAB = "application/x-ret-tab";

function titleOf(id: string, t: Thread | undefined) {
  if (isFile(id)) return filePath(id).split(/[\\/]/).pop() ?? "File";
  return isDraft(id) ? "New thread" : threadTitle(t);
}

/** A thread's status, or a file's icon (with a dot while it has unsaved edits). */
function Marker({ id }: { id: string }) {
  const dirty = useFiles((s) => !!s.dirty[id]);
  if (!isFile(id)) return <StatusDot threadId={id} />;
  return (
    <span className="tab-file">
      <FileCode2 size={12} />
      {dirty && <span className="cv-dirty" />}
    </span>
  );
}

/** What a tab or split side shows: a thread, a draft, or a file. */
function Pane({ id, focused, windowControls }: { id: string; focused: boolean; windowControls?: React.ReactNode }) {
  return isFile(id) ? (
    <FilePane key={id} id={id} chrome="focus" focused={focused} windowControls={windowControls} />
  ) : (
    <ThreadPane key={id} threadId={id} chrome="focus" focused={focused} windowControls={windowControls} />
  );
}

const Tab = memo(function Tab({ id, active, index }: { id: string; active: boolean; index: number }) {
  const thread = useThreads((s) => s.threads[id]);
  const split = useUI((s) => s.splits[id]);
  const right = useThreads((s) => (split ? s.threads[split.right] : undefined));
  const title = titleOf(id, thread);
  const rightTitle = split ? titleOf(split.right, right) : null;
  const related = !!split && (right?.forkedFromId === id || thread?.forkedFromId === split.right);
  return (
    <div
      className={`tab ${active ? "active" : ""} ${split ? "tab-split" : ""}`}
      onClick={() => useUI.setState({ activeTab: id })}
      onAuxClick={(e) => e.button === 1 && closeTab(id)}
      title={`${title}${rightTitle ? `  ⇆  ${rightTitle}` : ""}${index < 9 ? `  (Ctrl+${index + 1})` : ""}`}
      draggable
      onDragStart={(e) => {
        if (isThread(id)) e.dataTransfer.setData(DRAG_THREAD, id);
        e.dataTransfer.setData(DRAG_TAB, id);
      }}
      onDragOver={(e) => e.dataTransfer.types.includes(DRAG_TAB) && e.preventDefault()}
      onDrop={(e) => {
        const from = e.dataTransfer.getData(DRAG_TAB);
        if (!from || from === id) return;
        e.stopPropagation();
        useUI.setState((s) => {
          const tabs = s.tabs.filter((t) => t !== from);
          tabs.splice(tabs.indexOf(id), 0, from);
          return { tabs };
        });
      }}
    >
      <Marker id={id} />
      {!split && (spawnedBy(thread) ? <Bot size={11} className="muted" /> : thread?.forkedFromId && <GitFork size={11} className="muted" />)}
      <span className="tab-title">{title}</span>
      {split && (
        <>
          <span className={`tab-join ${related ? "fork" : ""}`}>{related ? <GitFork size={11} /> : <Columns2 size={11} />}</span>
          <Marker id={split.right} />
          <span className="tab-title">{rightTitle}</span>
        </>
      )}
      <button
        className="tab-close"
        onClick={(e) => {
          e.stopPropagation();
          closeTab(id);
        }}
      >
        <X size={12} />
      </button>
    </div>
  );
});

export function FocusView() {
  const tabs = useUI((s) => s.tabs);
  const active = useUI((s) => s.activeTab);
  const split = useUI((s) => (s.activeTab ? s.splits[s.activeTab] : undefined));
  const focusedSide = useUI((s) => s.focusedSide);
  const strip = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState<"side" | "tab" | null>(null);

  const dropZone = (e: React.DragEvent): "side" | "tab" | null => {
    if (!e.dataTransfer.types.includes(DRAG_THREAD)) return null;
    const r = body.current!.getBoundingClientRect();
    return active && e.clientX > r.left + r.width / 2 ? "side" : "tab";
  };

  return (
    <div className="focus-view">
      {tabs.length > 0 && (
        <div
          className="tab-strip"
          ref={strip}
          onWheel={(e) => {
            if (strip.current && Math.abs(e.deltaY) > Math.abs(e.deltaX)) strip.current.scrollLeft += e.deltaY;
          }}
          onDragOver={(e) => e.dataTransfer.types.includes(DRAG_THREAD) && e.preventDefault()}
          onDrop={(e) => {
            const id = e.dataTransfer.getData(DRAG_THREAD);
            if (id && !e.dataTransfer.getData(DRAG_TAB)) openThread(id, { mode: "focus" });
          }}
        >
          {tabs.map((id, i) => (
            <Tab key={id} id={id} active={id === active} index={i} />
          ))}
          <button className="icon-btn tab-new" title="New thread in this project (Ctrl+N)" onClick={() => newThreadNear(useUI.getState().activeTab)}>
            <Plus size={14} />
          </button>
        </div>
      )}
      <div
        className="focus-body"
        ref={body}
        onDragOver={(e) => {
          const zone = dropZone(e);
          if (!zone) return;
          e.preventDefault();
          if (zone !== drop) setDrop(zone);
        }}
        onDragLeave={(e) => {
          if (!body.current?.contains(e.relatedTarget as Node | null)) setDrop(null);
        }}
        onDrop={(e) => {
          const zone = dropZone(e);
          setDrop(null);
          const id = e.dataTransfer.getData(DRAG_THREAD);
          if (!zone || !id) return;
          e.preventDefault();
          openThread(id, { mode: "focus", side: zone === "side" });
        }}
      >
        {active ? (
          split ? (
            <SplitView left={active} split={split} focusedSide={focusedSide} />
          ) : (
            <Pane id={active} focused />
          )
        ) : (
          <EmptyState />
        )}
        {drop && (
          <div className={`drop-hint ${drop}`}>
            <span>{drop === "side" ? "Open beside" : "Open as tab"}</span>
          </div>
        )}
      </div>
    </div>
  );
}

type Relation = "fork" | "parent" | "sibling" | null;

/** How the right pane relates to the left: drives the badge on the divider. */
function useRelation(left: string, right: string): Relation {
  return useThreads((s) => {
    const l = s.threads[left];
    const r = s.threads[right];
    if (r?.forkedFromId === left) return "fork";
    if (l?.forkedFromId === right) return "parent";
    if (l?.forkedFromId && l.forkedFromId === r?.forkedFromId) return "sibling";
    return null;
  });
}

function SplitView({ left, split, focusedSide }: { left: string; split: FocusSplit; focusedSide: "left" | "right" }) {
  const box = useRef<HTMLDivElement>(null);
  const relation = useRelation(left, split.right);
  const leftTitle = useThreads((s) => titleOf(left, s.threads[left]));

  const setGrid = (ratio: number) => {
    if (box.current) box.current.style.gridTemplateColumns = `${ratio}fr 12px ${1 - ratio}fr`;
  };

  const onGutterDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !box.current) return;
    e.preventDefault();
    const gutter = e.currentTarget as HTMLElement;
    gutter.setPointerCapture(e.pointerId);
    const rect = box.current.getBoundingClientRect();
    let ratio = split.ratio;
    document.body.classList.add("resizing");
    const move = (ev: PointerEvent) => {
      ratio = Math.min(0.8, Math.max(0.2, (ev.clientX - rect.left) / rect.width));
      setGrid(ratio);
    };
    const up = () => {
      gutter.removeEventListener("pointermove", move);
      gutter.removeEventListener("pointerup", up);
      gutter.removeEventListener("lostpointercapture", up);
      document.body.classList.remove("resizing");
      setSplitRatio(left, ratio);
    };
    gutter.addEventListener("pointermove", move);
    gutter.addEventListener("pointerup", up);
    gutter.addEventListener("lostpointercapture", up);
  };

  const close = (side: "left" | "right") => (
    <button className="icon-btn" title="Close this pane" onClick={() => closePane(side)}>
      <X size={14} />
    </button>
  );

  const badgeTitle =
    relation === "fork"
      ? `Right is a fork of “${leftTitle}”`
      : relation === "parent"
        ? "Left is a fork of the thread on the right"
        : relation === "sibling"
          ? "Both are forks of the same thread"
          : "Drag to resize · double-click to even out";

  return (
    <div className="split" ref={box} style={{ gridTemplateColumns: `${split.ratio}fr 12px ${1 - split.ratio}fr` }}>
      <div className={`split-pane ${focusedSide === "left" ? "on" : ""}`} onPointerDownCapture={(e) => e.button === 0 && focusedSide !== "left" && useUI.setState({ focusedSide: "left" })}>
        <Pane id={left} focused={focusedSide === "left"} windowControls={close("left")} />
      </div>
      <div
        className={`split-gutter ${relation ? "related" : ""}`}
        onPointerDown={onGutterDown}
        onDoubleClick={() => {
          setGrid(0.5);
          setSplitRatio(left, 0.5);
        }}
        title={badgeTitle}
      >
        {relation && (
          <span className="split-link">
            {relation === "parent" && <ArrowLeft size={10} />}
            <GitFork size={12} />
            {relation === "fork" && <ArrowRight size={10} />}
          </span>
        )}
      </div>
      <div className={`split-pane ${focusedSide === "right" ? "on" : ""}`} onPointerDownCapture={(e) => e.button === 0 && focusedSide !== "right" && useUI.setState({ focusedSide: "right" })}>
        <Pane id={split.right} focused={focusedSide === "right"} windowControls={close("right")} />
      </div>
    </div>
  );
}
