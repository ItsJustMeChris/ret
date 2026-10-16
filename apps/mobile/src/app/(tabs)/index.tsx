import { router } from "expo-router";
import { Check, CheckCheck, Laptop } from "lucide-react-native";
import { memo, useMemo } from "react";
import { Pressable, SectionList, Text, View } from "react-native";
import { create } from "zustand";
import { hostOf } from "@shared/bridge";
import { plainText, timeAgo } from "@ret/lib/format";
import { useShallow } from "@ret/lib/shallow";
import { threadStateOf, type ThreadState } from "@ret/components/StatusDot";
import { hostName } from "@ret/state/hosts";
import { SECTIONS, askFor, type Section } from "@ret/state/inbox";
import { recencyOf, spawnedBy, threadTitle, type ThreadNode } from "@ret/state/projects";
import { useProjectTree } from "@ret/state/projectTree";
import { markSeen, useThreads } from "@ret/state/threads";
import { HostBanner, useRemoteState } from "../../ui/HostBanner";
import { Button, Count, Empty, Icon, SectionTitle } from "../../ui/primitives";
import { StatusDot } from "../../ui/StatusDot";

/**
 * Like the desktop's Inbox, reading something marks it seen, but it stays listed (dimmed) until you
 * clear it, so you can go back to what you just read.
 */
const useKept = create<Record<string, Section>>(() => ({}));

export default function InboxScreen() {
  const remote = useRemoteState();
  const threads = useThreads((s) => s.threads);
  const tree = useProjectTree();
  const kept = useKept();

  // Each thread's state; a subagent working, done or failed is its parent's to report.
  const states = useThreads(
    useShallow((s) => {
      const out: Record<string, ThreadState> = {};
      for (const id of Object.keys(s.threads)) {
        const st = threadStateOf(s, id);
        if (st === "attention" || (st !== "idle" && !spawnedBy(s.threads[id]))) out[id] = st;
      }
      return out;
    }),
  );

  const projectName = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of tree) {
      const walk = (nodes: ThreadNode[]) => {
        for (const n of nodes) {
          map.set(n.thread.id, p.name);
          walk(n.children);
        }
      };
      walk(p.roots);
    }
    return map;
  }, [tree]);

  const sections = useMemo(() => {
    const by: Record<Section, string[]> = { attention: [], unread: [], error: [], running: [] };
    for (const [id, st] of Object.entries(states)) if (st in by) by[st as Section].push(id);
    const listed = new Set(Object.values(by).flat());
    for (const [id, sec] of Object.entries(kept)) if (!listed.has(id) && threads[id]) by[sec].push(id);
    for (const key of Object.keys(by) as Section[]) by[key].sort((a, b) => recencyOf(threads[b]) - recencyOf(threads[a]));
    return SECTIONS.filter((s) => by[s.key].length).map((s) => ({ ...s, data: by[s.key] }));
  }, [states, kept, threads]);

  const open = (id: string) => {
    const st = states[id];
    if (st && st !== "idle") useKept.setState({ [id]: st as Section });
    router.push({ pathname: "/thread/[id]", params: { id } });
  };
  const clear = (id: string) => {
    useKept.setState((s) => {
      const next = { ...s };
      delete next[id];
      return next;
    }, true);
    markSeen(id);
  };

  if (remote && !remote.hosts.length) return <Welcome />;
  return (
    <SectionList
      className="flex-1 bg-bg"
      sections={sections}
      keyExtractor={(id) => id}
      stickySectionHeadersEnabled={false}
      ListHeaderComponent={<HostBanner state={remote} />}
      renderSectionHeader={({ section }) => <SectionTitle right={<Count n={section.data.length} />}>{section.title}</SectionTitle>}
      renderItem={({ item: id, section }) => (
        <InboxRow
          id={id}
          seen={states[id] !== section.key}
          project={projectName.get(id) ?? null}
          onOpen={() => open(id)}
          onClear={section.key === "unread" || states[id] !== section.key ? () => clear(id) : undefined}
        />
      )}
      ListEmptyComponent={
        <Empty icon={CheckCheck} title="All clear">
          Nothing needs you right now. Threads that ask for input, finish, or fail show up here.
        </Empty>
      }
      contentContainerClassName="pb-6"
    />
  );
}

const InboxRow = memo(function InboxRow({ id, seen, project, onOpen, onClear }: { id: string; seen: boolean; project: string | null; onOpen: () => void; onClear?: () => void }) {
  const thread = useThreads((s) => s.threads[id]);
  const host = useThreads((s) => (s.owner[id] ? hostOf(s.owner[id]) : null));
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
  return (
    <Pressable onPress={onOpen} className="mx-2 flex-row items-start gap-3 rounded-xl px-3 py-3 active:bg-bg-3">
      <View className="pt-[7px]">
        <StatusDot threadId={id} />
      </View>
      <View className="flex-1 gap-1">
        <View className="flex-row items-baseline gap-2">
          <Text numberOfLines={1} className="flex-1 text-[15px] font-semibold text-text">
            {threadTitle(thread)}
          </Text>
          <Text className="text-[12px] text-text-3">{thread ? timeAgo(recencyOf(thread)) : ""}</Text>
        </View>
        {preview ? (
          <Text numberOfLines={2} className={`text-[14px] leading-[19px] ${ask ? "text-amber" : seen ? "text-text-3" : "text-text-2"}`}>
            {preview}
          </Text>
        ) : null}
        {project && (
          <View className="flex-row">
            <View className="rounded-[5px] bg-bg-3 px-1.5 py-px">
              <Text className="text-[11px] text-text-3">{host ? `${project} · ${hostName(host)}` : project}</Text>
            </View>
          </View>
        )}
      </View>
      {onClear && (
        <Pressable onPress={onClear} hitSlop={10} accessibilityLabel="Done" className="mt-1 h-7 w-7 items-center justify-center rounded-md active:bg-bg-4">
          <Icon icon={Check} size={16} colorClassName="accent-text-3" />
        </Pressable>
      )}
    </Pressable>
  );
});

/** Nothing paired yet: what the app is for, and the way in. */
function Welcome() {
  return (
    <View className="flex-1 bg-bg">
      <Empty icon={Laptop} title="Use Ret from your phone" action={<Button big kind="primary" label="Pair with a computer" onPress={() => router.push("/pair")} />}>
        Ret on your phone works with the agents on your computer: their threads, approvals and questions. Pair once, on the same network.
      </Empty>
    </View>
  );
}
