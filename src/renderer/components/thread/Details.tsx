import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { CornerLeftUp } from "lucide-react";
import { useShallow } from "../../lib/shallow";
import { NO_AGENTS, useThreads } from "../../state/threads";
import { useThread } from "../../state/useThread";
import { isThread, setDetails, useUI } from "../../state/ui";
import { openThread } from "../../state/actions";
import { baseName, threadTitle } from "../../state/projects";
import { engineName } from "../../state/hosts";
import { compactNumber } from "../../lib/format";
import {
  DETAILS,
  changeTotals,
  contextUse,
  fileChanges,
  forkLabel,
  forksOf,
  latestDiff,
  latestPlan,
  modelLabel,
  originOf,
  planProgress,
  startedLabel,
  usageRows,
} from "../../lib/threadDetails";
import { useConn } from "../../state/conn";
import type { SizeClass } from "../../lib/useSize";
import { Markdown } from "../Markdown";
import { StatusDot } from "../StatusDot";
import { useVisibility } from "../ui/Kept";
import { FileRow } from "./Items";
import { openFrom } from "./Subagents";

/**
 * A thread's details: its plan, what it last changed, its subagents, how full its context is, and
 * where it came from, worked out in lib/threadDetails. Docked, it's a column beside the transcript
 * (a wide pane, while the thread has it open); as a peek, a card hung from the header over the
 * transcript, while you look. The phone's twin is its details sheet (apps/mobile thread/Details):
 * change both.
 *
 * It slides in when it opens (not when its view is built with it open), and slides out when it
 * closes: docked, it leaves the flow at once, so the transcript takes its room back while it goes.
 */
export function Details({ threadId, docked, open }: { threadId: string; docked: boolean; open: boolean }) {
  const { shown, motion, settled } = usePresence(open);
  const ref = useRef<HTMLElement>(null);
  // A peek reaches down to where the transcript ends, as it is when it opens: what's on the composer stays in sight.
  useLayoutEffect(() => {
    const el = ref.current;
    if (docked || !open || !el) return;
    const room = el.parentElement?.querySelector<HTMLElement>(":scope > .pane-main > :is(.transcript-wrap, .transcript)");
    if (room) el.style.maxHeight = `min(${Math.max(160, room.offsetTop + room.offsetHeight - el.offsetTop - 6)}px, calc(100% - 12px))`;
  }, [docked, open]);
  if (!shown) return null;
  return (
    <aside
      ref={ref}
      className={`details ${docked ? "docked" : "peek"} ${motion ?? ""}`}
      inert={!open || undefined}
      onAnimationEnd={(e) => e.target === e.currentTarget && settled()}
    >
      <PlanSection threadId={threadId} />
      <ChangesSection threadId={threadId} />
      <AgentsSection threadId={threadId} />
      <ContextSection threadId={threadId} />
      <ThreadSection threadId={threadId} />
      <ForksSection threadId={threadId} />
    </aside>
  );
}

const TOGGLE = "ret:toggle-details";

/** Show or hide the details of a thread that's on screen (Ctrl+Alt+B, the palette): its pane decides how. */
export function toggleDetails(threadId: string | null) {
  if (threadId && isThread(threadId)) window.dispatchEvent(new CustomEvent(TOGGLE, { detail: threadId }));
}

/**
 * Whether a pane shows its thread's details, and their switch (the header's button). A wide pane
 * docks them, open or closed as the thread has them, wherever it's shown; a narrower one peeks at
 * them, until you click elsewhere or press Escape.
 */
export function useDetails(threadId: string, size: SizeClass, pane: RefObject<HTMLElement | null>) {
  const docked = size === "wide";
  const kept = useUI((s) => !!s.details[threadId]);
  const [peek, setPeek] = useState(false);
  // A peek lasts while the pane is narrower: it doesn't come back once the pane's had room for the column.
  if (peek && (docked || size === "glance")) setPeek(false);
  const toggle = () => (docked ? setDetails(threadId, !kept) : setPeek(!peek));

  const visibility = useVisibility();
  useEffect(() => {
    const onToggle = (e: Event) => visibility.shown && (e as CustomEvent<string>).detail === threadId && toggle();
    window.addEventListener(TOGGLE, onToggle);
    return () => window.removeEventListener(TOGGLE, onToggle);
  });

  useEffect(() => {
    if (!peek) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element;
      // Its own menus (a path's) and the button (which toggles it) don't count as elsewhere.
      if (t.closest(".menu, .sel-menu") || (pane.current?.contains(t) && t.closest(".details, .details-btn"))) return;
      setPeek(false);
    };
    // Not from a text field: Escape there is the composer's (it stops the turn).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector(".menu, .sel-menu")) return;
      if (!(e.target as Element).closest?.("input, textarea, [contenteditable]")) setPeek(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [peek, pane]);

  return { docked, open: docked ? kept : peek, toggle };
}

/**
 * Something that comes and goes: kept while it animates out, and animated in only when it opens.
 * Out of sight (its view hidden, as by the click on another mode that closed it), it's simply there
 * or gone: its animations wait while it's hidden, and one going would still be going when you're back.
 */
function usePresence(open: boolean) {
  const [was, setWas] = useState(open);
  const [motion, setMotion] = useState<"in" | "out" | null>(null);
  if (was !== open) {
    setWas(open);
    setMotion(open ? "in" : "out");
  }
  const visibility = useVisibility();
  useEffect(() => {
    if (!motion) return;
    const unseen = () => !visibility.shown && setMotion(null);
    unseen();
    return visibility.subscribe(unseen);
  }, [motion, visibility]);
  return { shown: open || motion === "out", motion, settled: () => setMotion(null) };
}

function Section({ title, meta, hint, children }: { title: string; meta?: ReactNode; hint?: string; children: ReactNode }) {
  return (
    <section className="details-sec">
      <h4 title={hint}>
        {title}
        {meta != null && <span className="details-meta">{meta}</span>}
      </h4>
      {children}
    </section>
  );
}

function PlanSection({ threadId }: { threadId: string }) {
  const plan = useThread(threadId, (s) => latestPlan(s.live[threadId]));
  if (!plan) return null;
  return (
    <Section title={DETAILS.plan} meta={planProgress(plan)}>
      {plan.explanation && <Markdown text={plan.explanation} className="md-muted" />}
      <div className="details-plan">
        {plan.steps.map((s, i) => (
          <div key={i} className={`plan-step ${s.status}`}>
            <span className="plan-dot" />
            <span>{s.step}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function ChangesSection({ threadId }: { threadId: string }) {
  const diff = useThread(threadId, (s) => latestDiff(s.live[threadId]));
  const cwd = useThread(threadId, (s) => s.threads[threadId]?.cwd ?? null);
  const files = useMemo(() => (diff ? fileChanges(diff) : []), [diff]);
  if (!files.length) return null;
  const { add, del } = changeTotals(files);
  return (
    <Section
      title={DETAILS.changes}
      hint={DETAILS.changesHint}
      meta={
        <span className="stat">
          <span className="add">+{add}</span>
          <span className="del">−{del}</span>
        </span>
      }
    >
      <div className="details-files">
        {files.map((f) => (
          <FileRow key={f.path} change={f} cwd={cwd} />
        ))}
      </div>
    </Section>
  );
}

function AgentsSection({ threadId }: { threadId: string }) {
  const agents = useThread(threadId, (s) => s.agents[threadId] ?? NO_AGENTS);
  if (!agents.length) return null;
  return (
    <Section title={DETAILS.subagents} meta={agents.length}>
      {agents.map((id) => (
        <AgentLink key={id} agentId={id} from={threadId} />
      ))}
    </Section>
  );
}

function AgentLink({ agentId, from }: { agentId: string; from: string }) {
  const title = useThread(agentId, (s) => threadTitle(s.threads[agentId]));
  return (
    <button className="lineage" onClick={(e) => openFrom(e, agentId, from)}>
      <StatusDot threadId={agentId} />
      <span>{title}</span>
    </button>
  );
}

function ContextSection({ threadId }: { threadId: string }) {
  const usage = useThread(threadId, (s) => s.live[threadId]?.tokenUsage);
  if (!usage) return null;
  const use = contextUse(usage);
  return (
    <Section title={DETAILS.context} meta={use ? `${use.pct}%` : undefined} hint={DETAILS.contextHint}>
      {use && (
        <>
          <div className="details-bar">
            <span style={{ transform: `scaleX(${use.pct / 100})` }} />
          </div>
          <Row label={DETAILS.inContext}>
            {compactNumber(use.used)} of {compactNumber(use.size)}
          </Row>
        </>
      )}
      {usageRows(usage).map((r) => (
        <Row key={r.label} label={r.label}>
          {r.value}
        </Row>
      ))}
    </Section>
  );
}

function Row({ label, children, title, path, mono }: { label: string; children: ReactNode; title?: string; path?: string; mono?: boolean }) {
  return (
    <div className="kv-row">
      <span>{label}</span>
      <span className={mono ? "mono" : undefined} title={title} data-path={path}>
        {children}
      </span>
    </div>
  );
}

/** Thread facts, and the thread it came from: jump there without hunting in the sidebar. */
function ThreadSection({ threadId }: { threadId: string }) {
  const thread = useThread(threadId, (s) => s.threads[threadId]);
  const owner = useThread(threadId, (s) => s.owner[threadId] ?? "codex");
  // What it runs as its settings say once it's open (a reloaded thread's record may not know).
  const model = useThread(threadId, (s) => s.live[threadId]?.settings?.model ?? s.threads[threadId]?.model ?? null);
  const effort = useThread(threadId, (s) => s.live[threadId]?.settings?.effort ?? s.threads[threadId]?.reasoningEffort ?? null);
  const models = useConn((s) => s.providers[owner]?.models);
  const worktree = useUI((s) => s.worktrees[threadId]);
  const origin = originOf(thread);
  const source = useThread(origin?.id ?? "", (s) => (origin ? s.threads[origin.id] : undefined));
  if (!thread) return null;
  const branch = worktree?.branch ?? thread.gitInfo?.branch;
  return (
    <Section title={DETAILS.thread}>
      <Row label={DETAILS.agent}>{engineName(owner)}</Row>
      <Row label={DETAILS.model}>{modelLabel(model, effort, models)}</Row>
      <Row label={DETAILS.started}>{startedLabel(thread)}</Row>
      {branch && (
        <Row label={DETAILS.branch} mono>
          {branch}
        </Row>
      )}
      <Row label={DETAILS.folder} mono title={thread.cwd} path={thread.cwd}>
        {baseName(thread.cwd)}
      </Row>
      {origin && (
        <button className="lineage" onClick={() => openThread(origin.id)} disabled={!source}>
          <CornerLeftUp size={12} /> {origin.label} <span>{source ? threadTitle(source) : DETAILS.unavailable}</span>
        </button>
      )}
    </Section>
  );
}

function ForksSection({ threadId }: { threadId: string }) {
  const name = useThread(threadId, (s) => s.threads[threadId]?.name);
  const forks = useThreads(useShallow((s) => forksOf(s.threads, threadId)));
  if (!forks.length) return null;
  return (
    <Section title={DETAILS.forks} meta={forks.length}>
      {forks.map((f, i) => (
        <button key={f.id} className="lineage" onClick={() => openThread(f.id)}>
          <StatusDot threadId={f.id} />
          <span>{forkLabel(f, i, name)}</span>
        </button>
      ))}
    </Section>
  );
}
