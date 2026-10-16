import { ChevronRight, CircleAlert, FileDiff } from "lucide-react-native";
import { memo, useMemo, useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import Animated, { cubicBezier } from "react-native-reanimated";
import type { ThreadItem } from "@shared/protocol";
import { activitySummary, isActivity } from "@ret/lib/activity";
import { diffStats, duration } from "@ret/lib/format";
import { shallowEqual } from "@ret/lib/shallow";
import { loadOlder, resendUnanswered } from "@ret/state/actions";
import { takesDirectInput } from "@ret/state/projects";
import { ownerOf } from "@ret/state/threads";
import { useThread } from "@ret/state/useThread";
import { agentOf } from "@ret/agents";
import { useWork } from "@ret/components/thread/useWork";
import { Badge, Icon, Spinner, useNow } from "../ui/primitives";
import { RetBot } from "../ui/RetBot";
import { DiffView, ItemView, type Ctx } from "./Items";

const NO_TURNS: string[] = [];

/**
 * A thread's conversation, newest at the bottom, as the desktop's Transcript: each turn's steps
 * folded into one line ("Read 3 files, ran 2 commands") unless it's running, its messages and
 * edits standing alone. Scrolling up loads older turns.
 */
export function Transcript({ ctx, header }: { ctx: Ctx; header?: React.ReactElement | null }) {
  const turnOrder = useThread(ctx.threadId, (s) => s.live[ctx.threadId]?.turnOrder ?? NO_TURNS, shallowEqual);
  const older = useThread(ctx.threadId, (s) => !!s.live[ctx.threadId]?.olderCursor);
  const loadingOlder = useThread(ctx.threadId, (s) => !!s.live[ctx.threadId]?.loadingOlder);
  const data = useMemo(() => [...turnOrder].reverse(), [turnOrder]);
  return (
    <FlatList
      inverted
      data={data}
      keyExtractor={(id) => id}
      renderItem={({ item }) => <Turn turnId={item} ctx={ctx} />}
      ListHeaderComponent={header ?? undefined}
      ListFooterComponent={older ? <View className="items-center py-4">{loadingOlder ? <Spinner colorClassName="accent-text-3" /> : null}</View> : undefined}
      onEndReached={() => older && void loadOlder(ctx.threadId)}
      onEndReachedThreshold={0.4}
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      contentContainerClassName="px-3.5 pb-3 pt-2"
    />
  );
}

function ActivityGroup({ ids, ctx, live }: { ids: string[]; ctx: Ctx; live: boolean }) {
  const items = useThread(ctx.threadId, (s) => ids.map((id) => s.live[ctx.threadId]?.items[id]).filter(Boolean) as ThreadItem[], shallowEqual);
  const [open, setOpen] = useState(false);
  if (live) {
    // While the agent works, show the most recent steps live.
    const hidden = Math.max(0, ids.length - 3);
    return (
      <View>
        {hidden > 0 && !open && (
          <Pressable onPress={() => setOpen(true)} className="px-1.5 py-1">
            <Text className="text-[13px] text-text-3">
              {hidden} earlier {hidden === 1 ? "step" : "steps"}
            </Text>
          </Pressable>
        )}
        {(open ? ids : ids.slice(-3)).map((id) => (
          <ItemView key={id} itemId={id} ctx={ctx} live={id === ids[ids.length - 1]} />
        ))}
      </View>
    );
  }
  if (ids.length === 1) return <ItemView itemId={ids[0]} ctx={ctx} live={false} />;
  const failed = items.some((i) => i.type === "commandExecution" && i.exitCode != null && i.exitCode !== 0);
  return (
    <View>
      <Pressable onPress={() => setOpen(!open)} className="min-h-[32px] flex-row items-center gap-2 rounded-lg px-1.5 active:bg-bg-2">
        <View style={{ transform: [{ rotate: open ? "90deg" : "0deg" }] }}>
          <Icon icon={ChevronRight} size={14} colorClassName="accent-text-3" />
        </View>
        <Text numberOfLines={1} className="flex-1 text-[14px] text-text-3">
          {activitySummary(items, undefined, ctx.host)}
        </Text>
        {failed && <Badge label="failed step" tone="err" />}
      </Pressable>
      {open && (
        <View className="ml-2 border-l border-line pl-1.5">
          {ids.map((id) => (
            <ItemView key={id} itemId={id} ctx={ctx} live={false} />
          ))}
        </View>
      )}
    </View>
  );
}

const Turn = memo(function Turn({ turnId, ctx }: { turnId: string; ctx: Ctx }) {
  const turn = useThread(ctx.threadId, (s) => s.live[ctx.threadId]?.turns[turnId]);
  const types = useThread(ctx.threadId, (s) => (turn ? turn.itemIds.map((id) => s.live[ctx.threadId]?.items[id]?.type ?? "") : []), shallowEqual);
  const elsewhere = useThread(ctx.threadId, (s) => s.external[ctx.threadId]?.turnId === turnId);
  const background = useThread(ctx.threadId, (s) => s.background[ctx.threadId]?.length ?? 0);
  const [showDiff, setShowDiff] = useState(false);
  if (!turn) return null;
  const live = turn.status === "inProgress" && !turn.stale;

  // Activity steps are grouped; messages and edits stand alone (as the desktop's Turn).
  const segments: { kind: "item" | "group"; ids: string[] }[] = [];
  turn.itemIds.forEach((id, i) => {
    const activity = isActivity({ type: types[i] } as ThreadItem);
    const last = segments[segments.length - 1];
    if (activity && last?.kind === "group") last.ids.push(id);
    else segments.push({ kind: activity ? "group" : "item", ids: [id] });
  });
  const stats = turn.diff ? diffStats(turn.diff) : null;
  const pending = turnId.startsWith("pending:");
  const agent = agentOf(ownerOf(ctx.threadId)).name;

  return (
    <View className="gap-1.5 pb-5">
      {segments.map((seg, i) =>
        seg.kind === "group" ? (
          <ActivityGroup key={seg.ids[0]} ids={seg.ids} ctx={ctx} live={live && i === segments.length - 1} />
        ) : (
          <ItemView key={seg.ids[0]} itemId={seg.ids[0]} ctx={ctx} live={live && i === segments.length - 1} />
        ),
      )}
      {turn.plan && turn.plan.steps.length > 0 && (
        <View className="gap-1.5 px-1.5 py-1">
          {turn.plan.steps.map((s, i) => (
            <View key={i} className="flex-row items-center gap-2.5">
              <View
                className={`h-2.5 w-2.5 rounded-full border-[1.5px] ${s.status === "completed" ? "border-green bg-green" : s.status === "inProgress" ? "border-accent bg-accent-soft" : "border-text-3"}`}
              />
              <Text className={`flex-1 text-[14px] ${s.status === "completed" ? "text-text-3 line-through" : s.status === "inProgress" ? "text-text" : "text-text-2"}`}>{s.step}</Text>
            </View>
          ))}
        </View>
      )}
      {live && !pending && <Working threadId={ctx.threadId} turnId={turnId} lastItemId={turn.itemIds[turn.itemIds.length - 1]} since={turn.startedAt} elsewhere={elsewhere ? agent : null} />}
      {!live && !pending && turn.status !== "interrupted" && <UnansweredNotice threadId={ctx.threadId} lastItemId={turn.itemIds[turn.itemIds.length - 1]} count={turn.itemIds.length} />}
      {turn.error && (
        <View className="flex-row items-start gap-2 rounded-lg bg-red-soft px-3 py-2">
          <Icon icon={CircleAlert} size={14} colorClassName="accent-red" />
          <Text selectable className="flex-1 text-[14px] text-red">
            {turn.error.message}
          </Text>
        </View>
      )}
      {!live && !pending && (
        <View className="min-h-[20px] flex-row items-center gap-3 px-1.5">
          {turn.status === "interrupted" && <Badge label="interrupted" tone="warn" />}
          {turn.stale && (background ? <Badge label={background === 1 ? "1 background task" : `${background} background tasks`} /> : <Badge label="unfinished" tone="warn" />)}
          {turn.durationMs != null && <Text className="text-[12px] text-text-3">{duration(turn.durationMs)}</Text>}
          {stats && (stats.add > 0 || stats.del > 0) && (
            <Pressable onPress={() => setShowDiff(!showDiff)} hitSlop={8} className="flex-row items-center gap-1">
              <Icon icon={FileDiff} size={12} colorClassName="accent-text-3" />
              <Text className="text-[12px] text-green">+{stats.add}</Text>
              <Text className="text-[12px] text-red">−{stats.del}</Text>
            </Pressable>
          )}
        </View>
      )}
      {showDiff && turn.diff && (
        <View className="overflow-hidden rounded-lg border border-line">
          <DiffView diff={turn.diff} />
        </View>
      )}
    </View>
  );
});

/** A steer that landed after the final answer: the turn ended with your message unanswered. */
function UnansweredNotice({ threadId, lastItemId, count }: { threadId: string; lastItemId: string | undefined; count: number }) {
  const item = useThread(threadId, (s) => (lastItemId ? s.live[threadId]?.items[lastItemId] : undefined));
  const direct = useThread(threadId, (s) => takesDirectInput(s.threads[threadId]));
  if (!item || item.type !== "userMessage" || count < 2 || !direct) return null;
  return (
    <View className="flex-row items-center gap-2 rounded-lg bg-amber-soft px-3 py-2">
      <Icon icon={CircleAlert} size={13} colorClassName="accent-amber" />
      <Text className="flex-1 text-[13px] text-amber">{"This message arrived as the turn was ending and wasn't answered."}</Text>
      <Pressable onPress={() => resendUnanswered(threadId, item)} hitSlop={8}>
        <Text className="text-[13px] font-semibold text-amber">Send again</Text>
      </Pressable>
    </View>
  );
}

/** A new verb rolls in from below, as on the desktop (.working-verb). */
const VERB_IN = { from: { opacity: 0, transform: [{ translateY: 8 }] }, to: { opacity: 1, transform: [{ translateY: 0 }] } };

/**
 * The live turn's Working row, as the desktop's: the Ret bot in the mood of what the turn's doing
 * and a verb for it (useWork). `lastItemId`: the turn's latest item; `elsewhere` names the agent
 * when the turn runs in another of its apps.
 */
function Working({ threadId, turnId, lastItemId, since, elsewhere }: { threadId: string; turnId: string; lastItemId: string | undefined; since: number | null; elsewhere?: string | null }) {
  const now = useNow();
  const secs = since ? Math.max(0, Math.floor(now / 1000 - since)) : 0;
  const work = useWork(threadId, turnId, lastItemId, elsewhere, secs);
  return (
    <View className="flex-row items-center gap-2.5 px-1.5 py-1" accessible accessibilityLabel={`${work.label}, ${duration(secs * 1000)}`}>
      <RetBot mood={work.mood} />
      <Animated.View key={work.verb} style={{ flexShrink: 1, animationName: VERB_IN, animationDuration: "0.34s", animationTimingFunction: cubicBezier(0.2, 0.8, 0.2, 1) }}>
        <Text numberOfLines={1} className="text-[14px] text-text-2">
          {work.verb}
        </Text>
      </Animated.View>
      <Text className="text-[13px] text-text-3">{duration(secs * 1000)}</Text>
    </View>
  );
}
