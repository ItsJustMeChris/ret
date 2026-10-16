import * as Haptics from "expo-haptics";
import { Check, type LucideIcon } from "lucide-react-native";
import type { ReactNode } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Icon } from "./primitives";

/** A sheet from the bottom of the screen; tapping outside closes it. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title?: string; children: ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={open} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View className="flex-1 justify-end">
        <Pressable className="absolute inset-0 bg-black/50" onPress={onClose} accessibilityLabel="Close" />
        <View className="max-h-[80%] rounded-t-2xl border border-line-2 bg-bg-1" style={{ paddingBottom: insets.bottom + 8 }}>
          <View className="items-center pb-1 pt-2">
            <View className="h-1 w-9 rounded-full bg-line-2" />
          </View>
          {title ? <Text className="px-5 pb-2 pt-1 text-[13px] font-semibold uppercase tracking-wider text-text-3">{title}</Text> : null}
          <ScrollView contentContainerClassName="px-2 pb-2">{children}</ScrollView>
        </View>
      </View>
    </Modal>
  );
}

export interface SheetOption {
  value: string;
  label: string;
  description?: string;
  group?: string;
  icon?: LucideIcon;
  /** Shown in the accent colour (or red, for a danger). */
  tone?: "accent" | "danger";
}

/** A sheet of choices (the desktop's Select menus, for a finger): the current one ticked. */
export function OptionSheet({
  open,
  onClose,
  title,
  options,
  value,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  options: SheetOption[];
  value?: string | null;
  onPick: (value: string) => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      {options.map((o, i) => (
        <View key={o.value}>
          {o.group && o.group !== options[i - 1]?.group ? <Text className="px-3 pb-1 pt-3 text-[12px] font-semibold text-text-3">{o.group}</Text> : null}
          <Pressable
            onPress={() => {
              void Haptics.selectionAsync();
              onClose();
              onPick(o.value);
            }}
            className={`min-h-[48px] flex-row items-center gap-3 rounded-xl px-3 py-2.5 active:bg-bg-3 ${o.value === value ? "bg-bg-2" : ""}`}
          >
            {o.icon ? <Icon icon={o.icon} size={17} colorClassName={o.tone === "danger" ? "accent-red" : o.tone === "accent" ? "accent-accent" : "accent-text-2"} /> : null}
            <View className="flex-1 gap-0.5">
              <Text className={`text-[16px] ${o.tone === "danger" ? "text-red" : o.tone === "accent" ? "text-accent" : "text-text"}`}>{o.label}</Text>
              {o.description ? <Text className="text-[13px] leading-[18px] text-text-3">{o.description}</Text> : null}
            </View>
            {o.value === value ? <Icon icon={Check} size={17} colorClassName="accent-accent" /> : null}
          </Pressable>
        </View>
      ))}
    </Sheet>
  );
}
