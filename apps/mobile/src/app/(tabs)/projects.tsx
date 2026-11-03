import { router } from "expo-router";
import { Bot, ChevronDown, ChevronRight, FolderGit2, FolderOpen, FolderTree, GitFork, Plus, type LucideIcon } from "lucide-react-native";
import { memo, useMemo, useState } from "react";
import { Pressable, SectionList, Text, View } from "react-native";
import Animated, { cubicBezier, useReducedMotion } from "react-native-reanimated";
import { hostOf } from "@shared/bridge";
import { useActivityCounts, useThreadState } from "@ret/components/StatusDot";
import { timeAgo } from "@ret/lib/format";
import { FORK, forkNumbers, forkTitle } from "@ret/lib/forks";
import { hostName } from "@ret/state/hosts";
import type { ProjectNode, ThreadNode } from "@ret/state/projects";
import { flattenNode, recencyOf, scopedKey, spawnedBy, threadTitle } from "@ret/state/projects";
import { useProjectTree } from "@ret/state/projectTree";
import { useThreads } from "@ret/state/threads";
import { useUI } from "@ret/state/ui";
import { startThread } from "../../drafts";
import { openFolder } from "../../files";
import { HostBanner, useRemoteState } from "../../ui/HostBanner";
import { Count, Empty, Icon, Pill, Spinner } from "../../ui/primitives";
import { StatusDot } from "../../ui/StatusDot";

const SHOWN = 6;
/** A row's own inset (px-3). */
const INSET = 12;
/** Each level of forks sits this much further in (the desktop's .fork-body: 10px margin, 8px padding). */
const STEP = 18;
const EASE = cubicBezier(0.2, 0.8, 0.2, 1);

/**
 * One line of a project: a thread, or a thread with forks or subagents as a group that opens to list
 * it ("Original") and them, numbered as the desktop's sidebar numbers them (its ForkGroup).
 */
interface Row {
  key: string;
  node: ThreadNode;
  depth: number;
  group: boolean;
  /** Its number among its parent's forks; none for a top-level thread or a subagent. */
  fork?: number;
  parentName?: string | null;
  /** The group's own thread, first inside it. */
  original?: boolean;
}

/** A project's threads as lines on screen: an open group (`expanded`, the desktop's too) lists what's in it. */
function rowsOf(roots: ThreadNode[], expanded: Record<string, boolean>): Row[] {
  const out: Row[] = [];
  const walk = (node: ThreadNode, depth: number, fork?: number, parentName?: string | null) => {
    const id = node.thread.id;
    if (!node.children.length) return void out.push({ key: id, node, depth, group: false, fork, parentName });
    out.push({ key: `group:${id}`, node, depth, group: true, fork, parentName });
    if (!expanded[id]) return;
    out.push({ key: id, node, depth: depth + 1, group: false, original: true });
    for (const [child, n] of forkNumbers(node.children)) walk(child, depth + 1, n, node.thread.name);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

/**
 * The desktop's sidebar, as a list: each project (a folder on a paired computer) with its threads,
 * most recent first, and their forks and subagents in groups under the thread they came from.
 */
export default function ProjectsScreen() {
  const remote = useRemoteState();
  const tree = useProjectTree();
  const loaded = useThreads((s) => s.listLoaded);
  const groups = useUI((s) => s.expanded);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});

  const sections = useMemo(
    () =>
      tree
        .filter((p) => !p.conf?.hidden && p.roots.length)
        .map((p) => {
          const closed = !!collapsed[p.key];
          const shown = showAll[p.key] ? p.roots : p.roots.slice(0, SHOWN);
          return {
            project: p,
            data: closed ? [] : rowsOf(shown, groups),
            more: closed ? 0 : p.roots.length - shown.length,
            less: !closed && !!showAll[p.key] && p.roots.length > SHOWN,
          };
        }),
    [tree, collapsed, showAll, groups],
  );

  return (
    <SectionList
      className="flex-1 bg-bg"
      sections={sections}
      keyExtractor={(row) => row.key}
      stickySectionHeadersEnabled={false}
      ListHeaderComponent={<HostBanner state={remote} />}
      renderSectionHeader={({ section }) => (
        <ProjectHead project={section.project} collapsed={!!collapsed[section.project.key]} onToggle={() => setCollapsed((c) => ({ ...c, [section.project.key]: !c[section.project.key] }))} />
      )}
      renderSectionFooter={({ section }) =>
        section.more > 0 || section.less ? (
          <Pressable onPress={() => setShowAll((e) => ({ ...e, [section.project.key]: !section.less }))} className="mx-2 rounded-lg px-3 py-2 active:bg-bg-3">
            <Text className="pl-5 text-[14px] text-text-3">{section.less ? "Show less" : `Show ${section.more} more`}</Text>
          </Pressable>
        ) : null
      }
      renderItem={({ item }) => (item.group ? <GroupHead row={item} /> : <ThreadRow row={item} />)}
      ListEmptyComponent={
        !loaded && remote?.hosts.some((h) => h.connected) ? (
          <View className="items-center py-16">
            <Spinner colorClassName="accent-text-3" />
          </View>
        ) : (
          <Empty icon={FolderTree} title="No threads yet">
            Threads you start on your computer, in Ret, Codex or Claude Code, show up here by project.
          </Empty>
        )
      }
      contentContainerClassName="pb-6"
    />
  );
}

function ProjectHead({ project, collapsed, onToggle }: { project: ProjectNode; collapsed: boolean; onToggle: () => void }) {
  const path = project.conf?.path ?? project.path;
  const ids = useMemo(() => project.roots.flatMap((r) => flattenNode(r).map((t) => t.id)), [project.roots]);
  const { running, attention } = useActivityCounts(ids);
  return (
    <Pressable onPress={onToggle} className="mt-3 flex-row items-center gap-2 bg-bg py-2 pl-4 pr-2 active:opacity-70">
      <Icon icon={collapsed ? ChevronRight : ChevronDown} size={14} colorClassName="accent-text-3" />
      <View className="flex-1">
        <Text numberOfLines={1} className="text-[15px] font-semibold text-text-2">
          {project.conf?.name ?? project.name}
        </Text>
        {project.host ? (
          <Text numberOfLines={1} className="text-[12px] text-text-3">
            {hostName(project.host)}
          </Text>
        ) : null}
      </View>
      {attention > 0 && <Pill n={attention} tone="attention" />}
      {running > 0 && <Pill n={running} tone="running" />}
      <Count n={project.threadCount} />
      {project.host ? (
        <>
          <Pressable hitSlop={6} onPress={() => openFolder(path, project.host!)} accessibilityLabel={`Browse ${project.name}`} className="h-9 w-9 items-center justify-center rounded-lg active:bg-bg-3">
            <Icon icon={FolderOpen} size={17} colorClassName="accent-text-3" />
          </Pressable>
          <Pressable hitSlop={6} onPress={() => startThread(project.key, path)} accessibilityLabel={`New thread in ${project.name}`} className="h-9 w-9 items-center justify-center rounded-lg active:bg-bg-3">
            <Icon icon={Plus} size={19} colorClassName="accent-accent" />
          </Pressable>
        </>
      ) : null}
    </Pressable>
  );
}

/** The lines down an open group's left, one per level: the desktop's .fork-body border (solid: React Native won't dash one side). */
function Guides({ depth }: { depth: number }) {
  return Array.from({ length: depth }, (_, i) => <View key={i} className="absolute bottom-0 top-0 w-px bg-accent opacity-35" style={{ left: INSET + i * STEP + 7 }} />);
}

/** Forks or subagents in a group, with their glyph. */
function Tally({ icon, n, label }: { icon: LucideIcon; n: number; label: string }) {
  return (
    <View accessible accessibilityLabel={label} className="flex-row items-center gap-0.5">
      <Icon icon={icon} size={12} colorClassName="accent-text-3" />
      <Text className="text-[12px] text-text-3">{n}</Text>
    </View>
  );
}

/** A thread with forks or subagents: a tap opens or closes the group (the desktop's ForkGroup). */
const GroupHead = memo(function GroupHead({ row }: { row: Row }) {
  const { node, depth } = row;
  const id = node.thread.id;
  const open = useUI((s) => !!s.expanded[id]);
  const ids = useMemo(() => flattenNode(node).map((t) => t.id), [node]);
  const { running, attention } = useActivityCounts(ids);
  const reduce = useReducedMotion();
  const toggle = () => useUI.setState((s) => ({ expanded: { ...s.expanded, [id]: !open } }));
  return (
    <Pressable
      onPress={toggle}
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      className="mx-2 min-h-[44px] flex-row items-center gap-2 rounded-lg py-2 pr-3 active:bg-bg-3"
      style={{ paddingLeft: INSET + depth * STEP }}
    >
      <Guides depth={depth} />
      {/* Turns as the desktop's .chev does. */}
      <Animated.View
        style={[{ transform: [{ rotate: open ? "90deg" : "0deg" }] }, !reduce && { transitionProperty: "transform", transitionDuration: "150ms", transitionTimingFunction: EASE }]}
      >
        <Icon icon={ChevronRight} size={14} colorClassName="accent-text-3" />
      </Animated.View>
      <Icon icon={node.forkCount ? FolderGit2 : Bot} size={15} colorClassName="accent-accent" />
      <Text numberOfLines={1} className="flex-1 text-[15px] font-medium text-text-2">
        {row.fork != null ? forkTitle(node.thread, row.fork, row.parentName) : threadTitle(node.thread)}
      </Text>
      {attention > 0 && <Pill n={attention} tone="attention" />}
      {running > 0 && <Pill n={running} tone="running" />}
      {node.forkCount > 0 && <Tally icon={GitFork} n={node.forkCount} label={`${node.forkCount} ${node.forkCount === 1 ? "fork" : "forks"}`} />}
      {node.agentCount > 0 && <Tally icon={Bot} n={node.agentCount} label={`${node.agentCount} ${node.agentCount === 1 ? "subagent" : "subagents"}`} />}
    </Pressable>
  );
});

const ThreadRow = memo(function ThreadRow({ row }: { row: Row }) {
  const { node, depth, fork, original } = row;
  const t = node.thread;
  const state = useThreadState(t.id);
  const host = useThreads((s) => hostOf(s.owner[t.id] ?? "codex"));
  const worktree = useUI((s) => !!s.worktrees[t.id] || !!s.checkouts[scopedKey(host, t.cwd)]);
  const agent = !original && !!spawnedBy(t);
  // Forks inherit their parent's name; they're numbered unless they were renamed.
  const title = original ? FORK.original : fork != null ? forkTitle(t, fork, row.parentName) : threadTitle(t);
  return (
    <Pressable
      onPress={() => router.push({ pathname: "/thread/[id]", params: { id: t.id } })}
      className="mx-2 min-h-[44px] flex-row items-center gap-2.5 rounded-lg py-2 pr-3 active:bg-bg-3"
      style={{ paddingLeft: INSET + depth * STEP }}
    >
      <Guides depth={depth} />
      <StatusDot threadId={t.id} />
      {(fork != null || agent || worktree) && (
        <View className="flex-row items-center gap-1 opacity-80">
          {fork != null && <Icon icon={GitFork} size={13} colorClassName="accent-accent" />}
          {agent && <Icon icon={Bot} size={13} colorClassName="accent-accent" />}
          {worktree && <Icon icon={FolderGit2} size={13} colorClassName="accent-accent" />}
        </View>
      )}
      <Text
        numberOfLines={1}
        className={`flex-1 text-[15px] ${state === "unread" ? "font-semibold text-text" : state === "running" || state === "attention" ? "text-text" : "text-text-2"}`}
      >
        {title}
      </Text>
      <Text className="w-9 text-right text-[12px] text-text-3">{timeAgo(original ? recencyOf(t) : node.recency)}</Text>
    </Pressable>
  );
});
