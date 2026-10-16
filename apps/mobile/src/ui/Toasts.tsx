import { Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { dismissToast, useToasts } from "@ret/state/toasts";

/** The desktop's toasts (state/toasts.ts), over everything near the top of the screen. */
export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  const insets = useSafeAreaInsets();
  if (!toasts.length) return null;
  return (
    <View pointerEvents="box-none" className="absolute inset-x-0 items-center gap-2 px-4" style={{ top: insets.top + 8 }}>
      {toasts.map((t) => (
        <Pressable
          key={t.id}
          onPress={() => dismissToast(t.id)}
          className={`uw-entering-fade-in-down uw-exiting-fade-out max-w-full rounded-xl border px-4 py-3 ${t.kind === "error" ? "border-red/40 bg-bg-2" : "border-line-2 bg-bg-2"}`}
        >
          <Text className={`text-[14px] ${t.kind === "error" ? "text-red" : "text-text"}`}>{t.message}</Text>
        </Pressable>
      ))}
    </View>
  );
}
