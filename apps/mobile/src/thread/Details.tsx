import { router } from "expo-router";
import { CornerLeftUp } from "lucide-react-native";
import { useMemo, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { compactNumber } from "@ret/lib/format";
import { useShallow } from "@ret/lib/shallow";
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
} from "@ret/lib/threadDetails";
import { engineName } from "@ret/state/hosts";
import { baseName, threadTitle } from "@ret/state/projects";
import { NO_AGENTS, useThreads } from "@ret/state/threads";
import { useUI } from "@ret/state/ui";
import { useThread } from "@ret/state/useThread";
import { Markdown } from "../ui/Markdown";
import { Icon, Mono } from "../ui/primitives";
import { Sheet } from "../ui/Sheet";
import { StatusDot } from "../ui/StatusDot";
import { FileRow, type Ctx } from "./Items";
import { PlanSteps } from "./Transcript";

/**
 * A thread's details, in a sheet from its header's button: the desktop's details panel
 * (components/thread/Details), section for section, with the same words and the same workings
 * (lib/threadDetails). Change both.
 */
export function DetailsSheet({ ctx, open, onClose }: { ctx: Ctx; open: boolean; onClose: () => void }) {
  const { threadId } = ctx;
  // Going to another thread from here: the sheet goes first.
  const go = (id: string) => {
    onClose();
    router.push({ pathname: "/thread/[id]", params: { id } });
  };
  return (
    <Sheet open={open} onClose={onClose}>
      {/* Each section has a rule above it but the first. */}
      <View className="overflow-hidden">
        <View className="-mt-px">
          <PlanSection threadId={threadId} />
          <ChangesSection ctx={ctx} />
          <AgentsSection threadId={threadId} go={go} />
          <ContextSection threadId={threadId} />
          <ThreadSection threadId={threadId} go={go} />
          <ForksSection threadId={threadId} go={go} />
        </View>
      </View>
    </Sheet>
  );
}

function Section({ title, meta, children }: { title: string; meta?: ReactNode; children: ReactNode }) {
  return (
    <View className="gap-1.5 border-t border-line px-3 pb-4 pt-3.5">
      <View className="mb-1 flex-row items-baseline justify-between gap-2">
        <Text className="text-[12px] font-semibold uppercase tracking-wider text-text-3">{title}</Text>
        {typeof meta === "string" || typeof meta === "number" ? <Text className="text-[13px] text-text-3">{meta}</Text> : meta}
      </View>
      {children}
    </View>
  );
}

function PlanSection({ threadId }: { threadId: string }) {
  const plan = useThread(threadId, (s) => latestPlan(s.live[threadId]));
  if (!plan) return null;
  return (
    <Section title={DETAILS.plan} meta={planProgress(plan)}>
      {plan.explanation ? <Markdown text={plan.explanation} muted size={14} /> : null}
      <PlanSteps steps={plan.steps} />
    </Section>
  );
}

function ChangesSection({ ctx }: { ctx: Ctx }) {
  const diff = useThread(ctx.threadId, (s) => latestDiff(s.live[ctx.threadId]));
  const files = useMemo(() => (diff ? fileChanges(diff) : []), [diff]);
  if (!files.length) return null;
  const { add, del } = changeTotals(files);
  return (
    <Section
      title={DETAILS.changes}
      meta={
        <View className="flex-row gap-1.5">
          <Mono className="text-[12px] text-green">+{add}</Mono>
          <Mono className="text-[12px] text-red">−{del}</Mono>
        </View>
      }
    >
      {/* The transcript's file rows, edge to edge, each opening its diff. */}
      <View className="-mx-3 -mb-4 mt-0.5">
        {files.map((f) => (
          <FileRow key={f.path} change={f} cwd={ctx.cwd} host={ctx.host} />
        ))}
      </View>
    </Section>
  );
}

function AgentsSection({ threadId, go }: { threadId: string; go: (id: string) => void }) {
  const agents = useThread(threadId, (s) => s.agents[threadId] ?? NO_AGENTS);
  if (!agents.length) return null;
  return (
    <Section title={DETAILS.subagents} meta={agents.length}>
      {agents.map((id) => (
        <Link key={id} threadId={id} go={go} />
      ))}
    </Section>
  );
}

/** A thread to go to: its status and title (the desktop's .lineage rows). */
function Link({ threadId, label, go }: { threadId: string; label?: string; go: (id: string) => void }) {
  const title = useThread(threadId, (s) => threadTitle(s.threads[threadId]));
  return (
    <Pressable onPress={() => go(threadId)} className="-mx-2 min-h-[40px] flex-row items-center gap-2.5 rounded-lg px-2 active:bg-bg-3">
      <StatusDot threadId={threadId} />
      <Text numberOfLines={1} className="flex-1 text-[14px] text-text">
        {label ?? title}
      </Text>
    </Pressable>
  );
}

function ContextSection({ threadId }: { threadId: string }) {
  const usage = useThread(threadId, (s) => s.live[threadId]?.tokenUsage);
  if (!usage) return null;
  const use = contextUse(usage);
  return (
    <Section title={DETAILS.context} meta={use ? `${use.pct}%` : undefined}>
      {use && (
        <>
          <View className="mb-1.5 mt-0.5 h-1 overflow-hidden rounded-full bg-bg-4">
            <View className="h-full rounded-full bg-accent" style={{ width: `${use.pct}%` }} />
          </View>
          <Row label={DETAILS.inContext}>
            {compactNumber(use.used)} of {compactNumber(use.size)}
          </Row>
        </>
      )}
      <Row label={DETAILS.allTurns}>{compactNumber(usage.total.totalTokens)}</Row>
      <Row label={DETAILS.cached}>{compactNumber(usage.total.cachedInputTokens)}</Row>
      <Row label={DETAILS.reasoning}>{compactNumber(usage.total.reasoningOutputTokens)}</Row>
    </Section>
  );
}

function Row({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  const Value = mono ? Mono : Text;
  return (
    <View className="flex-row items-baseline justify-between gap-3">
      <Text className="text-[13px] text-text-3">{label}</Text>
      <Value selectable numberOfLines={1} className="flex-shrink text-right text-[14px] text-text">
        {children}
      </Value>
    </View>
  );
}

/** Thread facts, and the thread it came from: go there without hunting through the projects. */
function ThreadSection({ threadId, go }: { threadId: string; go: (id: string) => void }) {
  const thread = useThread(threadId, (s) => s.threads[threadId]);
  const owner = useThread(threadId, (s) => s.owner[threadId] ?? "codex");
  const worktree = useUI((s) => s.worktrees[threadId]);
  const origin = originOf(thread);
  const source = useThread(origin?.id ?? "", (s) => (origin ? s.threads[origin.id] : undefined));
  if (!thread) return null;
  const branch = worktree?.branch ?? thread.gitInfo?.branch;
  return (
    <Section title={DETAILS.thread}>
      <Row label={DETAILS.agent}>{engineName(owner)}</Row>
      <Row label={DETAILS.model}>{modelLabel(thread)}</Row>
      <Row label={DETAILS.started}>{startedLabel(thread)}</Row>
      {branch ? (
        <Row label={DETAILS.branch} mono>
          {branch}
        </Row>
      ) : null}
      <Row label={DETAILS.folder} mono>
        {baseName(thread.cwd)}
      </Row>
      {origin && (
        <Pressable
          onPress={() => go(origin.id)}
          disabled={!source}
          className="-mx-2 mt-1 min-h-[40px] flex-row items-center gap-2 rounded-lg px-2 active:bg-bg-3"
        >
          <Icon icon={CornerLeftUp} size={14} colorClassName="accent-accent" />
          <Text className="text-[14px] text-text-2">{origin.label}</Text>
          <Text numberOfLines={1} className="flex-1 text-[14px] text-text">
            {source ? threadTitle(source) : DETAILS.unavailable}
          </Text>
        </Pressable>
      )}
    </Section>
  );
}

function ForksSection({ threadId, go }: { threadId: string; go: (id: string) => void }) {
  const name = useThread(threadId, (s) => s.threads[threadId]?.name);
  const forks = useThreads(useShallow((s) => forksOf(s.threads, threadId)));
  if (!forks.length) return null;
  return (
    <Section title={DETAILS.forks} meta={forks.length}>
      {forks.map((f, i) => (
        <Link key={f.id} threadId={f.id} label={forkLabel(f, i, name)} go={go} />
      ))}
    </Section>
  );
}
