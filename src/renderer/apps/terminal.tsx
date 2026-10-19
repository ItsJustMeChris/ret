import { FolderOpen, MessageSquare, Monitor, RotateCcw, SquareTerminal, Trash2 } from "lucide-react";
import { useUI } from "../state/ui";
import { closeTerminal, restartTerminal, terminalTitle, useTerms, type TermLive } from "../state/terminals";
import { useThreads } from "../state/threads";
import { useHosts } from "../state/hosts";
import { baseName, threadTitle } from "../state/projects";
import { openThread } from "../state/actions";
import { TerminalView } from "../components/terminal/TerminalView";
import type { Instance, RetApp } from "./app";

// A terminal window's instance is its terminal's id.
const useConf = (id: string | null) => useUI((s) => (id ? s.terminals[id] : undefined));
const useLive = (id: string | null) => useTerms((s) => (id ? s.live[id] : undefined));

function useTitle(id: string | null) {
  return terminalTitle(useLive(id), useConf(id));
}

function TerminalChips({ instance: id }: Instance) {
  const conf = useConf(id);
  const owner = conf?.thread ?? null;
  const ownerTitle = useThreads((s) => (owner ? threadTitle(s.threads[owner]) : null));
  const hostLabel = useHosts((s) => (conf?.host ? (s.hosts[conf.host]?.name ?? "another device") : null));
  return (
    <>
      {hostLabel && (
        <span className="chip host-chip" title={`Runs on ${hostLabel}`}>
          <Monitor size={11} />
          {hostLabel}
        </span>
      )}
      {conf && (
        <span className="chip path-chip" title={conf.cwd} data-path={conf.cwd}>
          <FolderOpen size={11} />
          {baseName(conf.cwd)}
        </span>
      )}
      {owner && (
        <button className="chip term-owner" title={`${ownerTitle}: go to its thread`} onPointerDown={(e) => e.stopPropagation()} onClick={() => openThread(owner, { mode: "canvas" })}>
          <MessageSquare size={11} />
          <span>{ownerTitle}</span>
        </button>
      )}
    </>
  );
}

function TerminalActions({ instance: id }: Instance) {
  const conf = useConf(id);
  if (!conf || !id) return null;
  return (
    <>
      <button className="icon-btn" title="New shell" onClick={() => restartTerminal(id)}>
        <RotateCcw size={13} />
      </button>
      <button className="icon-btn" title="End this terminal" onClick={() => closeTerminal(id)}>
        <Trash2 size={13} />
      </button>
    </>
  );
}

function TerminalBody({ instance: id }: Instance) {
  const conf = useConf(id);
  return conf && id ? <TerminalView id={id} /> : <div className="term-gone">This terminal has ended.</div>;
}

function stateText(live: TermLive | undefined): string {
  switch (live?.state) {
    case "running":
      return "Running";
    case "starting":
      return "Starting…";
    case "exited":
      return live.exitCode ? `Exited with code ${live.exitCode}` : "Exited";
    case "failed":
      return "Couldn't start";
    default:
      return "Starts when you look at it";
  }
}

/** Zoomed out: where it is, and whether its shell is running. */
function TerminalCard({ instance: id }: Instance) {
  const conf = useConf(id);
  const live = useLive(id);
  return (
    <>
      <div className="tcard-body term-tile-path">{conf?.cwd ?? "Ended"}</div>
      <div className="tcard-state">{conf ? stateText(live) : ""}</div>
    </>
  );
}

/**
 * A terminal as a window on the canvas, as many as you like. One opened from a thread is that
 * thread's terminal (the same shell its panel shows in Focus) and links back to it; closing the
 * window leaves it with the thread. One opened on the canvas itself ends with its window.
 */
export const terminal: RetApp<"terminal"> = {
  kind: "terminal",
  name: "Terminal",
  icon: SquareTerminal,
  instances: "many",
  size: { w: 760, h: 440 },
  View: TerminalBody,
  Card: TerminalCard,
  useTitle,
  Chips: TerminalChips,
  Actions: TerminalActions,
  useCwd: (id) => useConf(id)?.cwd,
  menu: (id) =>
    id
      ? [
          { label: "New shell", icon: <RotateCcw size={14} />, onClick: () => restartTerminal(id) },
          { label: "End terminal", icon: <Trash2 size={14} />, danger: true, onClick: () => closeTerminal(id) },
        ]
      : [],
};
