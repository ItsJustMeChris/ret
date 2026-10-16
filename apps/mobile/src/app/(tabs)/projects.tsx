import { router } from "expo-router";
import { Bot, ChevronDown, ChevronRight, FolderOpen, FolderTree, GitFork, Plus } from "lucide-react-native";
import { memo, useMemo, useState } from "react";
import { Pressable, SectionList, Text, View } from "react-native";
import { timeAgo } from "@ret/lib/format";
import { hostName } from "@ret/state/hosts";
import type { ProjectNode, ThreadNode } from "@ret/state/projects";
import { threadTitle } from "@ret/state/projects";
import { useProjectTree } from "@ret/state/projectTree";
import { useThreads } from "@ret/state/threads";
import { startThread } from "../../drafts";
import { openFolder } from "../../files";
import { HostBanner, useRemoteState } from "../../ui/HostBanner";
import { Count, Empty, Icon, Spinner } from "../../ui/primitives";
import { StatusDot } from "../../ui/StatusDot";

const SHOWN = 6;

/**
 * The desktop's sidebar, as a list: each project (a folder on a paired computer) with its threads,
 * most recent first. Forks and subagents are counted on the thread they came from.
 */
export default function ProjectsScreen() {
  const remote = useRemoteState();
  const tree = useProjectTree();
  const loaded = useThreads((s) => s.listLoaded);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const sections = useMemo(
    () =>
      tree
        .filter((p) => !p.conf?.hidden && p.roots.length)
        .map((p) => {
          const all = expanded[p.key] ? p.roots : p.roots.slice(0, SHOWN);
          return { project: p, data: collapsed[p.key] ? [] : all, more: collapsed[p.key] ? 0 : p.roots.length - all.length };
        }),
    [tree, collapsed, expanded],
  );

  return (
    <SectionList
      className="flex-1 bg-bg"
      sections={sections}
      keyExtractor={(n) => n.thread.id}
      stickySectionHeadersEnabled={false}
      ListHeaderComponent={<HostBanner state={remote} />}
      renderSectionHeader={({ section }) => (
        <ProjectHead project={section.project} collapsed={!!collapsed[section.project.key]} onToggle={() => setCollapsed((c) => ({ ...c, [section.project.key]: !c[section.project.key] }))} />
      )}
      renderSectionFooter={({ section }) =>
        section.more > 0 ? (
          <Pressable onPress={() => setExpanded((e) => ({ ...e, [section.project.key]: true }))} className="mx-2 rounded-lg px-3 py-2 active:bg-bg-3">
            <Text className="pl-5 text-[14px] text-text-3">Show {section.more} more</Text>
          </Pressable>
        ) : null
      }
      renderItem={({ item }) => <ThreadRow node={item} />}
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

const ThreadRow = memo(function ThreadRow({ node }: { node: ThreadNode }) {
  const id = node.thread.id;
  const unread = useThreads((s) => !!s.unread[id]);
  return (
    <Pressable onPress={() => router.push({ pathname: "/thread/[id]", params: { id } })} className="mx-2 min-h-[44px] flex-row items-center gap-3 rounded-lg px-3 py-2 active:bg-bg-3">
      <StatusDot threadId={id} />
      <Text numberOfLines={1} className={`flex-1 text-[15px] ${unread ? "font-semibold text-text" : "text-text-2"}`}>
        {threadTitle(node.thread)}
      </Text>
      {node.forkCount > 0 && (
        <View className="flex-row items-center gap-0.5">
          <Icon icon={GitFork} size={12} colorClassName="accent-text-3" />
          <Text className="text-[12px] text-text-3">{node.forkCount}</Text>
        </View>
      )}
      {node.agentCount > 0 && (
        <View className="flex-row items-center gap-0.5">
          <Icon icon={Bot} size={12} colorClassName="accent-text-3" />
          <Text className="text-[12px] text-text-3">{node.agentCount}</Text>
        </View>
      )}
      <Text className="w-9 text-right text-[12px] text-text-3">{timeAgo(node.recency)}</Text>
    </Pressable>
  );
});
