import Constants from "expo-constants";
import { router } from "expo-router";
import { Laptop, Plus } from "lucide-react-native";
import { useState } from "react";
import { Alert, Linking, Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { PROVIDER_IDS, engineId } from "@shared/bridge";
import { shortDeviceId, type RemoteHost } from "@shared/remote";
import { bridge } from "@ret/bridge";
import { useShallow } from "@ret/lib/shallow";
import { useConn } from "@ret/state/conn";
import { toast } from "@ret/state/toasts";
import { useUI, type Theme } from "@ret/state/ui";
import { PROVIDERS } from "@ret/agents";
import { setNotifications, useNotify } from "../../platform/notifications";
import { useRemoteState } from "../../ui/HostBanner";
import { Button, Icon, SectionTitle } from "../../ui/primitives";

export default function SettingsScreen() {
  const remote = useRemoteState();
  const theme = useUI((s) => s.theme);
  // What's typed, until it's saved; the saved name otherwise.
  const [draft, setDraft] = useState<string | null>(null);
  const name = draft ?? remote?.name ?? "";

  return (
    <ScrollView className="flex-1 bg-bg" contentContainerClassName="pb-10">
      <SectionTitle>Computers</SectionTitle>
      <View className="mx-3 overflow-hidden rounded-xl border border-line bg-bg-1">
        {remote?.hosts.map((h, i) => <HostRow key={h.id} host={h} first={i === 0} />)}
        <Pressable onPress={() => router.push("/pair")} className={`min-h-[48px] flex-row items-center gap-3 px-4 active:bg-bg-3 ${remote?.hosts.length ? "border-t border-line" : ""}`}>
          <Icon icon={Plus} size={16} colorClassName="accent-accent" />
          <Text className="text-[15px] text-accent">Pair a computer</Text>
        </Pressable>
      </View>
      {remote?.error ? <Text className="mx-4 mt-2 text-[13px] text-red">{remote.error}</Text> : null}

      <SectionTitle>This phone</SectionTitle>
      <View className="mx-3 gap-3 rounded-xl border border-line bg-bg-1 px-4 py-3">
        <View className="gap-1">
          <Text className="text-[13px] text-text-3">Name your computers see</Text>
          <TextInput
            value={name}
            onChangeText={setDraft}
            onEndEditing={() => {
              if (draft?.trim() && draft !== remote?.name) void bridge.remoteAccess.setName(draft.trim()).then(() => setDraft(null));
              else setDraft(null);
            }}
            className="h-10 rounded-lg border border-line bg-bg-2 px-3 text-[16px] text-text"
            returnKeyType="done"
          />
        </View>
        {remote?.deviceId ? (
          <View className="gap-0.5">
            <Text className="text-[13px] text-text-3">Device ID</Text>
            <Text selectable className="text-[15px] text-text-2">
              {shortDeviceId(remote.deviceId)}
            </Text>
          </View>
        ) : null}
      </View>

      <SectionTitle>Notifications</SectionTitle>
      <NotificationsRow />

      <SectionTitle>Appearance</SectionTitle>
      <View className="mx-3 flex-row rounded-xl border border-line bg-bg-1 p-1">
        {(["system", "dark", "light"] as Theme[]).map((t) => (
          <Pressable key={t} onPress={() => useUI.setState({ theme: t })} className={`h-9 flex-1 items-center justify-center rounded-lg ${theme === t ? "bg-bg-3" : ""}`}>
            <Text className={`text-[14px] ${theme === t ? "font-semibold text-text" : "text-text-2"}`}>{t === "system" ? "System" : t === "dark" ? "Dark" : "Light"}</Text>
          </Pressable>
        ))}
      </View>

      <Text className="mx-4 mt-8 text-center text-[12px] text-text-3">Ret {Constants.expoConfig?.version ?? ""}</Text>
    </ScrollView>
  );
}

function HostRow({ host, first }: { host: RemoteHost; first: boolean }) {
  const statuses = useConn(useShallow((s) => PROVIDER_IDS.map((p) => s.providers[engineId(p, host.key)]?.status)));
  const forget = () =>
    Alert.alert(`Forget ${host.name}?`, "This phone stops using its agents. Pair again to use them.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Forget",
        style: "destructive",
        onPress: () => void bridge.remoteAccess.forget(host.id).catch((err: Error) => toast(err.message, "error")),
      },
    ]);
  const dot = host.connected ? "bg-green" : host.online ? "bg-amber" : "bg-text-3";
  return (
    <View className={`gap-2 px-4 py-3 ${first ? "" : "border-t border-line"}`}>
      <View className="flex-row items-center gap-3">
        <Icon icon={Laptop} size={18} colorClassName="accent-text-2" />
        <View className="flex-1">
          <Text className="text-[16px] font-semibold text-text">{host.name}</Text>
          <View className="flex-row items-center gap-1.5">
            <View className={`h-1.5 w-1.5 rounded-full ${dot}`} />
            <Text className="text-[13px] text-text-3">
              {host.connected ? "Connected" : host.online ? "Connecting…" : "Not reachable"} · {host.address}:{host.port}
            </Text>
          </View>
        </View>
        <Button label="Forget" kind="danger" onPress={forget} />
      </View>
      {host.connected && (
        <View className="gap-1 pl-[30px]">
          {PROVIDER_IDS.map((p, i) => [p, statuses[i]] as const).map(([p, status]) => (
            <Text key={p} className="text-[13px] text-text-2">
              {PROVIDERS[p].name}
              <Text className="text-text-3">
                {" "}
                · {status?.state === "running" ? (status.version ? `running ${status.version}` : "running") : (status?.state ?? "…")}
              </Text>
            </Text>
          ))}
        </View>
      )}
    </View>
  );
}

/** Notices from your computers while the app is away: finished, failed, or waiting on you. */
function NotificationsRow() {
  const { state, error } = useNotify();
  const note =
    state === "unavailable"
      ? "This build of Ret isn't set up for push notifications."
      : state === "denied"
        ? "Turned off for Ret in the iPhone's Settings."
        : state === "error"
          ? `Couldn't turn them on: ${error}`
          : "When a thread finishes, fails or needs your input while Ret is in the background. Thread names go through Apple's and Expo's push services.";
  return (
    <View className="mx-3 gap-2 rounded-xl border border-line bg-bg-1 px-4 py-3">
      <View className="flex-row items-center gap-3">
        <Text className="flex-1 text-[16px] text-text">Notify me</Text>
        <Switch value={state === "on"} disabled={state === "unavailable"} onValueChange={(on) => (state === "denied" ? void Linking.openSettings() : void setNotifications(on))} />
      </View>
      <Text className={`text-[13px] leading-[18px] ${state === "error" ? "text-red" : "text-text-3"}`}>{note}</Text>
    </View>
  );
}
