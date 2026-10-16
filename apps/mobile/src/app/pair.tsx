import * as Haptics from "expo-haptics";
import { router, useLocalSearchParams } from "expo-router";
import { Laptop, Radar } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View, type TextInputInstance } from "react-native";
import { REMOTE_DEFAULT_PORT } from "@shared/remote";
import { bridge } from "@ret/bridge";
import { toast } from "@ret/state/toasts";
import { offerNotifications } from "../platform/notifications";
import { useRemoteState } from "../ui/HostBanner";
import { Button, Icon, MONO, Spinner } from "../ui/primitives";

/**
 * Pairing, the phone's side of the desktop's Settings → Remote access → Pair a device: pick the
 * computer (found on the network, or by address) and type the code it shows. A link
 * ret://pair?address=…&port=…&code=… fills it in.
 */
export default function PairScreen() {
  const params = useLocalSearchParams<{ address?: string; port?: string; code?: string }>();
  const remote = useRemoteState();
  const [address, setAddress] = useState(params.address ?? "");
  const [port, setPort] = useState(params.port ?? String(REMOTE_DEFAULT_PORT));
  const [code, setCode] = useState((params.code ?? "").replace(/\D/g, "").slice(0, 6));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeInput = useRef<TextInputInstance>(null);

  useEffect(() => bridge.remoteAccess.discover(), []);

  const nearby = remote?.nearby.filter((n) => !n.paired) ?? [];
  const ready = !!address.trim() && /^\d+$/.test(port) && code.length === 6 && !busy;

  const pair = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const host = await bridge.remoteAccess.pair({ address: address.trim(), port: Number(port) }, code);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      toast(`Paired with ${host.name}`);
      offerNotifications();
      if (router.canGoBack()) router.back();
      else router.replace("/");
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError((err as Error).message);
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView className="flex-1 bg-bg" behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={80}>
      <ScrollView contentContainerClassName="gap-5 p-5" keyboardShouldPersistTaps="handled">
        <Text className="text-[15px] leading-[22px] text-text-2">
          On your computer, open Ret, then <Text className="font-semibold text-text">Settings → Remote access</Text>. Turn it on and choose{" "}
          <Text className="font-semibold text-text">Pair a device</Text> for a code.
        </Text>

        <View className="gap-2">
          <View className="flex-row items-center gap-2">
            <Icon icon={Radar} size={14} colorClassName="accent-text-3" />
            <Text className="text-[13px] font-semibold uppercase tracking-wider text-text-3">On this network</Text>
            <Spinner size="small" colorClassName="accent-text-3" />
          </View>
          {nearby.length ? (
            nearby.map((n) => (
              <Pressable
                key={n.id}
                onPress={() => {
                  setAddress(n.address);
                  setPort(String(n.port));
                  codeInput.current?.focus();
                }}
                className={`flex-row items-center gap-3 rounded-xl border px-4 py-3 active:bg-bg-3 ${address === n.address && port === String(n.port) ? "border-accent bg-accent-soft" : "border-line bg-bg-1"}`}
              >
                <Icon icon={Laptop} size={18} colorClassName="accent-text-2" />
                <View className="flex-1">
                  <Text className="text-[16px] text-text">{n.name}</Text>
                  <Text className="text-[13px] text-text-3">
                    {n.address}:{n.port}
                  </Text>
                </View>
              </Pressable>
            ))
          ) : (
            <Text className="text-[14px] text-text-3">Looking for computers with remote access on… You can also type the address it shows.</Text>
          )}
        </View>

        <View className="flex-row gap-2">
          <View className="flex-[3] gap-1">
            <Text className="text-[13px] text-text-3">Address</Text>
            <TextInput
              value={address}
              onChangeText={setAddress}
              placeholder="192.168.1.20"
              placeholderTextColorClassName="accent-text-3"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
              className="h-12 rounded-xl border border-line bg-bg-2 px-3.5 text-[16px] text-text"
            />
          </View>
          <View className="flex-[1.4] gap-1">
            <Text className="text-[13px] text-text-3">Port</Text>
            <TextInput value={port} onChangeText={(t) => setPort(t.replace(/\D/g, ""))} keyboardType="number-pad" className="h-12 rounded-xl border border-line bg-bg-2 px-3.5 text-[16px] text-text" />
          </View>
        </View>

        <View className="gap-1">
          <Text className="text-[13px] text-text-3">Pairing code</Text>
          <TextInput
            ref={codeInput}
            value={code}
            onChangeText={(t) => setCode(t.replace(/\D/g, "").slice(0, 6))}
            placeholder="000000"
            placeholderTextColorClassName="accent-text-3"
            keyboardType="number-pad"
            textContentType="oneTimeCode"
            maxLength={6}
            onSubmitEditing={() => void pair()}
            style={{ fontFamily: MONO, letterSpacing: 10 }}
            className="h-16 rounded-xl border border-line bg-bg-2 text-center text-[30px] text-text"
          />
        </View>

        {error ? <Text className="text-[14px] leading-5 text-red">{error}</Text> : null}

        <Button big kind="primary" label={busy ? "Pairing…" : "Pair"} disabled={!ready} onPress={() => void pair()} />
        <Text className="text-[13px] leading-[19px] text-text-3">
          The code is good for one try: a wrong one ends it, and your computer shows a new one. Once paired, this phone connects with its own key; nothing else is shared.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
