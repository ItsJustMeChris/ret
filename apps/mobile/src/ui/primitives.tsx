import type { LucideIcon } from "lucide-react-native";
import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Platform, Pressable, Text, View, type PressableProps, type TextProps } from "react-native";
import { withUniwind } from "uniwind";

/** The desktop's --mono stack, as the phone has it. */
export const MONO = Platform.select({ ios: "Menlo", default: "monospace" });

/** Monospaced text (paths, commands, code). */
export function Mono({ className, style, ...props }: TextProps & { className?: string }) {
  return <Text {...props} className={className} style={[{ fontFamily: MONO }, style]} />;
}

function IconBase({ icon: Glyph, size = 14, color, strokeWidth = 2 }: { icon: LucideIcon; size?: number; color?: string; strokeWidth?: number }) {
  return <Glyph size={size} color={color} strokeWidth={strokeWidth} />;
}

/** A lucide icon (the desktop's set) coloured by a theme class: `colorClassName="accent-text-3"`. */
export const Icon = withUniwind(IconBase);

export const Spinner = withUniwind(ActivityIndicator);

type ButtonKind = "default" | "primary" | "ghost" | "danger";

const BUTTON: Record<ButtonKind, string> = {
  default: "bg-bg-3 border-line active:bg-bg-4",
  primary: "bg-accent border-transparent active:bg-accent-strong",
  ghost: "bg-transparent border-line active:bg-bg-3",
  danger: "bg-transparent border-transparent active:bg-red-soft",
};

const BUTTON_TEXT: Record<ButtonKind, string> = {
  default: "text-text",
  primary: "text-[#0b0b18] font-semibold",
  ghost: "text-text",
  danger: "text-red",
};

/** The desktop's .btn, sized for a finger. */
export function Button({
  label,
  kind = "default",
  icon,
  big,
  className,
  ...props
}: PressableProps & { label: string; kind?: ButtonKind; icon?: LucideIcon; big?: boolean; className?: string }) {
  return (
    <Pressable
      {...props}
      accessibilityRole="button"
      className={`flex-row items-center justify-center gap-1.5 rounded-lg border ${big ? "h-12 px-5" : "h-10 px-3.5"} ${BUTTON[kind]} ${props.disabled ? "opacity-50" : ""} ${className ?? ""}`}
    >
      {icon && <Icon icon={icon} size={big ? 16 : 14} colorClassName={kind === "primary" ? "accent-[#0b0b18]" : kind === "danger" ? "accent-red" : "accent-text"} />}
      <Text className={`${big ? "text-[16px]" : "text-[14px]"} ${BUTTON_TEXT[kind]}`}>{label}</Text>
    </Pressable>
  );
}

/** The desktop's .badge. */
export function Badge({ label, tone }: { label: string; tone?: "ok" | "err" | "warn" }) {
  const bg = tone === "ok" ? "bg-green-soft" : tone === "err" ? "bg-red-soft" : tone === "warn" ? "bg-amber-soft" : "bg-bg-4";
  const fg = tone === "ok" ? "text-green" : tone === "err" ? "text-red" : tone === "warn" ? "text-amber" : "text-text-2";
  return (
    <View className={`h-[18px] justify-center rounded-[5px] px-1.5 ${bg}`}>
      <Text className={`text-[11px] font-semibold ${fg}`}>{label}</Text>
    </View>
  );
}

/** Small uppercase heading over a group (the inbox's section titles, settings groups). */
export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <View className="flex-row items-center gap-1.5 bg-bg px-4 pb-1.5 pt-5">
      <Text className="text-[12px] font-semibold uppercase tracking-wider text-text-3">{children}</Text>
      {right}
    </View>
  );
}

/** A count pill beside a heading (the desktop's .inbox-count). */
export function Count({ n }: { n: number }) {
  return (
    <View className="rounded-lg bg-bg-3 px-1.5">
      <Text className="text-[11px] text-text-2">{n}</Text>
    </View>
  );
}

/** A centred empty state: an icon, a line in bold, and what to do about it. */
export function Empty({ icon, title, children, action }: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <View className="flex-1 items-center justify-center gap-2.5 px-8 py-16">
      <Icon icon={icon} size={30} colorClassName="accent-text-3" />
      <Text className="text-[16px] font-semibold text-text-2">{title}</Text>
      {children ? <Text className="text-center text-[14px] leading-5 text-text-3">{children}</Text> : null}
      {action ? <View className="mt-3">{action}</View> : null}
    </View>
  );
}

/** The time now (ms), ticking every second while `active`: for clocks that count. */
export function useNow(active = true): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}
