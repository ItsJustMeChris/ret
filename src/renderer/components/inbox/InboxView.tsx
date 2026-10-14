import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Check, CheckCheck, Inbox as InboxIcon } from "lucide-react";
import { markSeen, useThreads, type PendingRequest } from "../../state/threads";
import { PROVIDERS } from "../../agents";
import { useUI } from "../../state/ui";
import { buildProjects, recencyOf, threadTitle, type ThreadNode } from "../../state/projects";
import { plainText, timeAgo, unwrapCommand } from "../../lib/format";
import { StatusDot, threadStateOf, type ThreadState } from "../StatusDot";
import { ThreadPane } from "../thread/ThreadPane";
import { isPermissionAsk } from "../../state/computerUse";

type Section = "attention" | "unread" | "error" | "running";

const SECTIONS: { key: Section; title: string; hint: string }[] = [
  { key: "attention", title: "Needs you", hint: "Waiting on an answer or an approval" },
  { key: "unread", title: "Ready to review", hint: "Finished while you were elsewhere" },
  { key: "error", title: "Failed", hint: "Stopped with an error" },
  { key: "running", title: "Working", hint: "In progress here or in another app" },
];

/** What a pending request is asking, in a line. */
function askFor(req: PendingRequest | undefined): string | null {
  if (!req) return null;
  const p = req.params ?? {};
  switch (req.method) {
    case "item/commandExecution/requestApproval":
    case "execCommandApproval":
      return `Run ${p.command ? unwrapCommand(Array.isArray(p.command) ? p.command.join(" ") : p.command) : "a command"}?`;
    case "item/fileChange/requestApproval":
    case "applyPatchApproval":
      return "Apply these edits?";
    case "item/permissions/requestApproval":
      return "Grant extra permissions?";
    case "item/tool/requestUserInput":
      return p.questions?.[0]?.question ?? `${PROVIDERS[req.provider].name} has a question`;
    case "mcpServer/elicitation/request":
      return isPermissionAsk(p) ? (p.message ?? "Allow a tool?") : `${p.serverName ?? "A tool"} needs input: ${p.message ?? ""}`;
    case "item/tool/requestApproval":
      return p.title ?? `Use ${p.tool ?? "a tool"}?`;
  }
  return "Needs your input";
}

/** Counts for the title bar badge: things that want you (not ones merely working). */
export function useInboxCount(): number {
  return useThreads((s) => {
    let n = 0;
    for (const id of Object.keys(s.threads)) {
      const st = threadStateOf(s, id);
      if (st === "attention" || st === "unread" || st === "error") n++;
    }
    return n;
  });
}

/**
 * Inbox mode: every thread that wants something from you, across all projects, in one list.
 * Pick one to read it (and answer or reply) on the right; j/k or ↑/↓ move, e clears a finished one.
 */
export function InboxView({ active = true }: { active?: boolean } = {}) {
  const activeRef = useRef(active);
  activeRef.current = active;
  const selected = useUI((s) => s.inbox.selected);
  const projects = useUI((s) => s.projects);
  const threadProject = useUI((s) => s.threadProject);
  const threads = useThreads((s) => s.threads);
  const workspaces = useThreads((s) => s.workspaces);

  // Each thread's state, recomputed when anything relevant moves.
  const states = useThreads(
    useShallow((s) => {
      const out: Record<string, ThreadState> = {};
      for (const id of Object.keys(s.threads)) {
        const st = threadStateOf(s, id);
        if (st !== "idle") out[id] = st;
      }
      return out;
    }),
  );

  // Like email: reading something marks it seen, but it stays listed (dimmed) until you clear it
  // with e / Done, or leave the Inbox. So you can go back to what you just read.
  const [kept, setKept] = useState<Map<string, Section>>(() => new Map());
  useEffect(() => {
    if (!selected) return;
    const st = states[selected];
    if (st && st !== "idle" && kept.get(selected) !== st) setKept((m) => new Map(m).set(selected, st as Section));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);
  const forget = (id: string) =>
    setKept((m) => {
      if (!m.has(id)) return m;
      const next = new Map(m);
      next.delete(id);
      return next;
    });

  const projectName = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of buildProjects(threads, projects, threadProject, workspaces)) {
      const walk = (nodes: ThreadNode[]) => {
        for (const n of nodes) {
          map.set(n.thread.id, p.name);
          walk(n.children);
        }
      };
      walk(p.roots);
    }
    return map;
  }, [threads, projects, threadProject, workspaces]);

  const sections = useMemo(() => {
    const by: Record<Section, string[]> = { attention: [], unread: [], error: [], running: [] };
    for (const [id, st] of Object.entries(states)) if (st in by) by[st as Section].push(id);
    const listed = new Set(Object.values(by).flat());
    for (const [id, sec] of kept) if (!listed.has(id) && threads[id]) by[sec].push(id);
    for (const key of Object.keys(by) as Section[]) by[key].sort((a, b) => recencyOf(threads[b]) - recencyOf(threads[a]));
    return by;
  }, [states, kept, threads]);

  const order = SECTIONS.flatMap((s) => sections[s.key]);
  const orderRef = useRef(order);
  orderRef.current = order;

  // Nothing picked yet: start at the top.
  useEffect(() => {
    if (!selected && order[0]) useUI.setState((s) => ({ inbox: { ...s.inbox, selected: order[0] } }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order[0]]);

  const select = (id: string) => useUI.setState((s) => ({ inbox: { ...s.inbox, selected: id } }));
  const clear = (id: string) => {
    forget(id);
    markSeen(id);
  };
  const clearRef = useRef(clear);
  clearRef.current = clear;

  // j/k and the arrows move through the list; e clears a finished one. Not while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!activeRef.current) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.("input, textarea, [contenteditable], .monaco-editor, .menu, .overlay") || e.ctrlKey || e.metaKey || e.altKey) return;
      const list = orderRef.current;
      const cur = useUI.getState().inbox.selected;
      const i = cur ? list.indexOf(cur) : -1;
      if (e.key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        if (list[i + 1]) select(list[i + 1]);
      } else if (e.key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        if (i > 0) select(list[i - 1]);
      } else if (e.key === "e" && cur) {
        clearRef.current(cur);
        const next = list[i + 1] ?? list[i - 1];
        if (next) select(next);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const empty = order.length === 0;
  return (
    <div className="inbox-view">
      <aside className="inbox-list">
        <div className="inbox-head">
          <InboxIcon size={15} />
          <span>Inbox</span>
          <span className="inbox-keys">
            <kbd>j</kbd>
            <kbd>k</kbd> move · <kbd>e</kbd> done
          </span>
        </div>
        {empty ? (
          <div className="inbox-empty">
            <CheckCheck size={26} />
            <strong>All clear</strong>
            <span>Nothing needs you right now. Threads that ask for input, finish, or fail show up here.</span>
          </div>
        ) : (
          SECTIONS.map((sec) =>
            sections[sec.key].length ? (
              <div key={sec.key} className="inbox-section">
                <div className="inbox-section-title" title={sec.hint}>
                  {sec.title}
                  <span className="inbox-count">{sections[sec.key].length}</span>
                </div>
                {sections[sec.key].map((id) => (
                  <InboxRow
                    key={id}
                    id={id}
                    selected={id === selected}
                    seen={states[id] !== sec.key}
                    project={projectName.get(id) ?? null}
                    onSelect={() => select(id)}
                    onClear={sec.key === "unread" || states[id] !== sec.key ? () => clear(id) : undefined}
                  />
                ))}
              </div>
            ) : null,
          )
        )}
      </aside>
      <section className="inbox-read">
        {selected && threads[selected] ? (
          <ThreadPane key={selected} threadId={selected} chrome="focus" focused />
        ) : (
          <div className="inbox-empty">
            <InboxIcon size={26} />
            <span>Pick something on the left.</span>
          </div>
        )}
      </section>
    </div>
  );
}

const InboxRow = memo(function InboxRow({
  id,
  selected,
  seen,
  project,
  onSelect,
  onClear,
}: {
  id: string;
  selected: boolean;
  /** Read (or answered) already; still listed until cleared. */
  seen: boolean;
  project: string | null;
  onSelect: () => void;
  onClear?: () => void;
}) {
  const thread = useThreads((s) => s.threads[id]);
  const req = useThreads((s) => Object.values(s.requests).find((r) => r.threadId === id));
  // The latest thing the agent said, if the thread is loaded; else what you asked.
  const said = useThreads((s) => {
    const lt = s.live[id];
    if (!lt) return null;
    for (let i = lt.turnOrder.length - 1; i >= 0; i--) {
      const turn = lt.turns[lt.turnOrder[i]];
      for (let j = (turn?.itemIds.length ?? 0) - 1; j >= 0; j--) {
        const it = lt.items[turn.itemIds[j]];
        if (it?.type === "agentMessage" && it.text) return it.text;
      }
    }
    return null;
  });
  const ask = askFor(req);
  const preview = ask ?? plainText(said ?? thread?.preview ?? "", 180);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return (
    <div ref={ref} className={`inbox-row ${selected ? "selected" : ""} ${seen ? "seen" : ""}`} onClick={onSelect} data-card="thread" data-id={id}>
      <StatusDot threadId={id} />
      <div className="inbox-row-main">
        <div className="inbox-row-top">
          <span className="inbox-title">{threadTitle(thread)}</span>
          <span className="inbox-time">{thread ? timeAgo(recencyOf(thread)) : ""}</span>
        </div>
        <div className={`inbox-preview ${ask ? "ask" : ""}`}>{preview}</div>
        {project && <span className="inbox-project">{project}</span>}
      </div>
      {onClear && (
        <button
          className="icon-btn inbox-done"
          title="Done (e)"
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
        >
          <Check size={14} />
        </button>
      )}
    </div>
  );
});
