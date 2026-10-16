import { router, Stack, useFocusEffect, useLocalSearchParams } from "expo-router";
import { CircleAlert, FolderOpen, MessageSquarePlus, RotateCw } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { KeyboardAvoidingView, Platform, Pressable, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useHeaderHeight } from "expo-router/react-navigation";
import { hostOf } from "@shared/bridge";
import { hydrateThread } from "@ret/state/actions";
import { hostName } from "@ret/state/hosts";
import { baseName, hostOfKey, threadTitle } from "@ret/state/projects";
import { markAttended, markVisible, patchLive } from "@ret/state/threads";
import { isDraft, useUI } from "@ret/state/ui";
import { useThread } from "@ret/state/useThread";
import { agentOf } from "@ret/agents";
import { dropDraftIfUnused } from "../../drafts";
import { FileScopeContext, openFolder } from "../../files";
import { Empty, Icon, Spinner } from "../../ui/primitives";
import { StatusDot } from "../../ui/StatusDot";
import { Approvals } from "../../thread/Approvals";
import { Composer } from "../../thread/Composer";
import { Transcript } from "../../thread/Transcript";

export default function ThreadScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return isDraft(id) ? <DraftScreen id={id} /> : <ThreadView id={id} />;
}

/** Reserve system-gesture space before keyboard avoidance measures its overlap. */
function ThreadKeyboardView({ children }: { children: ReactNode }) {
  const headerHeight = useHeaderHeight();
  return (
    <SafeAreaView edges={["left", "right", "bottom"]} style={{ flex: 1 }}>
      <KeyboardAvoidingView className="flex-1 bg-bg" behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={headerHeight}>
        {children}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function ThreadView({ id }: { id: string }) {
  const thread = useThread(id, (s) => s.threads[id]);
  const owner = useThread(id, (s) => s.owner[id]);
  const cwd = useThread(id, (s) => s.live[id]?.settings?.cwd ?? s.threads[id]?.cwd ?? null);
  const hydrating = useThread(id, (s) => !s.live[id]?.hydrated && !s.live[id]?.error);
  const error = useThread(id, (s) => (!s.live[id]?.hydrated ? (s.live[id]?.error ?? null) : null));
  const notice = useThread(id, (s) => s.live[id]?.notice ?? null);
  const host = owner ? hostOf(owner) : null;
  const scope = useMemo(() => ({ cwd, host }), [cwd, host]);

  // On screen: kept subscribed and fresh, loaded on first sight (as a desktop pane).
  useEffect(() => {
    markVisible(id, 1);
    void hydrateThread(id);
    return () => markVisible(id, -1);
  }, [id]);
  // In front: what finishes here doesn't count as unread.
  useFocusEffect(
    useCallback(() => {
      markAttended(id, 1);
      return () => markAttended(id, -1);
    }, [id]),
  );

  const retry = () => {
    patchLive(id, { error: null });
    void hydrateThread(id);
  };

  return (
    <FileScopeContext.Provider value={scope}>
      <ThreadKeyboardView>
        <Stack.Screen
          options={{
            headerTitle: () => (
              <View className="max-w-[230px] items-center">
                <View className="flex-row items-center gap-2">
                  <StatusDot threadId={id} size={7} />
                  <Text numberOfLines={1} className="text-[16px] font-semibold text-text">
                    {threadTitle(thread)}
                  </Text>
                </View>
                <Text numberOfLines={1} className="text-[12px] text-text-3">
                  {[cwd ? baseName(cwd) : null, owner ? agentOf(owner).name : null, host ? hostName(host) : null].filter(Boolean).join(" · ")}
                </Text>
              </View>
            ),
            headerRight: () =>
              cwd && host ? (
                <Pressable hitSlop={10} onPress={() => openFolder(cwd, host)} accessibilityLabel="Browse the thread's folder">
                  <Icon icon={FolderOpen} size={19} colorClassName="accent-text-2" />
                </Pressable>
              ) : null,
          }}
        />
        <View className="flex-1">
          {error ? (
            <View className="flex-1 items-center justify-center gap-3 px-8">
              <Icon icon={CircleAlert} size={26} colorClassName="accent-red" />
              <Text className="text-center text-[15px] text-text-2">{error}</Text>
              <Pressable onPress={retry} className="flex-row items-center gap-1.5 rounded-lg border border-line px-3.5 py-2 active:bg-bg-3">
                <Icon icon={RotateCw} size={14} colorClassName="accent-text" />
                <Text className="text-[14px] text-text">Try again</Text>
              </Pressable>
            </View>
          ) : hydrating ? (
            <View className="flex-1 items-center justify-center">
              <Spinner colorClassName="accent-text-3" />
            </View>
          ) : (
            <Transcript ctx={{ threadId: id, cwd, host }} />
          )}
        </View>
        {notice ? (
          <Text numberOfLines={2} className="px-4 pb-1 text-[12px] text-amber">
            {notice}
          </Text>
        ) : null}
        <Approvals threadId={id} />
        <Composer threadId={id} />
      </ThreadKeyboardView>
    </FileScopeContext.Provider>
  );
}

/** A new thread, before its first message: which project it's in, and the box to start it. */
function DraftScreen({ id }: { id: string }) {
  // The draft as it was opened: sending the first message turns it into a thread (and deletes it)
  // before the thread's id comes back, and the box must stay until then.
  const [opened] = useState(() => useUI.getState().drafts[id]);
  const draft = useUI((s) => s.drafts[id]) ?? opened;
  const project = useUI((s) => (draft ? s.projects[draft.projectKey] : undefined));
  const host = draft ? hostOfKey(draft.projectKey) : null;
  const name = project?.name ?? (draft ? baseName(draft.cwd) : "");

  // Left without sending: the draft goes.
  useEffect(() => () => dropDraftIfUnused(id), [id]);

  return (
    <ThreadKeyboardView>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View className="max-w-[250px] items-center">
              <Text className="text-[16px] font-semibold text-text">New thread</Text>
              <Text numberOfLines={1} className="text-[12px] text-text-3">
                {[name, host ? hostName(host) : null].filter(Boolean).join(" · ")}
              </Text>
            </View>
          ),
        }}
      />
      {draft ? (
        <>
          <View className="flex-1">
            <Empty icon={MessageSquarePlus} title={`New thread in ${name}`}>
              {draft.cwd}
              {host ? `\non ${hostName(host)}` : ""}
            </Empty>
          </View>
          <Composer threadId={id} onStarted={(threadId) => router.replace({ pathname: "/thread/[id]", params: { id: threadId } })} />
        </>
      ) : (
        <Empty icon={MessageSquarePlus} title="This new thread is gone" />
      )}
    </ThreadKeyboardView>
  );
}
