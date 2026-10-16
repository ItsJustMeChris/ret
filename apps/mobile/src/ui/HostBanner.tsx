import { WifiOff } from "lucide-react-native";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { RemoteState } from "@shared/remote";
import { bridge } from "@ret/bridge";
import { Icon } from "./primitives";

/** The phone's remote-access state, kept current. */
export function useRemoteState(): RemoteState | null {
  const [state, setState] = useState<RemoteState | null>(null);
  useEffect(() => {
    let live = true;
    void bridge.remoteAccess.getState().then((s) => live && setState(s));
    const off = bridge.remoteAccess.onState((s) => live && setState(s));
    return () => {
      live = false;
      off();
    };
  }, []);
  return state;
}

/** A line for each paired computer that isn't connected, so a quiet list isn't mistaken for an idle one. */
export function HostBanner({ state }: { state: RemoteState | null }) {
  const down = state?.hosts.filter((h) => !h.connected) ?? [];
  if (!down.length) return null;
  return (
    <View className="mx-3 mt-2 gap-1 rounded-xl border border-amber/30 bg-amber-soft px-3 py-2.5">
      {down.map((h) => (
        <View key={h.id} className="flex-row items-center gap-2">
          <Icon icon={WifiOff} size={14} colorClassName="accent-amber" />
          <Text className="flex-1 text-[13px] text-amber" numberOfLines={2}>
            {h.online ? `Connecting to ${h.name}…` : `Can't reach ${h.name}. Is Ret open there, with remote access on?`}
          </Text>
        </View>
      ))}
    </View>
  );
}
