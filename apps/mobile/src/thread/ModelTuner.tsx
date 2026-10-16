import * as Haptics from "expo-haptics";
import { ChevronRight, Gauge, RotateCcw, Rocket, Zap, type LucideIcon } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Pressable, Text, View, type GestureResponderEvent } from "react-native";
import Animated, { cubicBezier, useReducedMotion } from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useCSSVariable } from "uniwind";
import { barHeight, fillDelay, heatOf, useFillFrom, useRoll } from "@ret/lib/effortMeter";
import type { ComposerSettings } from "@ret/state/composerSettings";
import { Icon } from "../ui/primitives";
import { Sheet } from "../ui/Sheet";

// The desktop's ModelTuner (components/thread/ModelTuner.tsx, app.css .tuner-*) for a finger: the
// composer's chip shows the model and a glyph of its effort; its sheet has the same staircase of
// bars (tap or drag along them), the name that rolls as it changes and the segmented speed switch.
// They look and move the same, from the same lib/effortMeter: change both.

export const SPEED_ICON: Record<string, LucideIcon> = { default: Gauge, priority: Zap, ultrafast: Rocket };
export const speedIcon = (tier: string) => SPEED_ICON[tier] ?? Zap;

// The desktop's keyframes and easings (app.css), in pixels.
const EASE = cubicBezier(0.2, 0.8, 0.2, 1);
const SPRING = cubicBezier(0.34, 1.56, 0.64, 1);
const ROLL_UP = { from: { opacity: 0, transform: [{ translateY: 28 }] }, to: { opacity: 1, transform: [{ translateY: 0 }] } };
const ROLL_DOWN = { from: { opacity: 0, transform: [{ translateY: -28 }] }, to: { opacity: 1, transform: [{ translateY: 0 }] } };
const BUMP = { from: { transform: [{ scaleY: 0.84 }] }, to: { transform: [{ scaleY: 1 }] } };
const ZAP = { from: { transform: [{ scale: 0.6 }, { rotate: "-14deg" }] }, to: { transform: [{ scale: 1 }, { rotate: "0deg" }] } };

/** Bars rise from this to the meter's height (the desktop's 10 to 30, a size up). */
const BAR_MIN = 14;
const METER_H = 42;
const GAP = 7;

/** `a` mixed into `b` by `t`, as the desktop's color-mix(in srgb, a t, b). Hex colours; anything else is `a`. */
function mix(a: string | undefined, b: string | undefined, t: number): string {
  const pa = /^#([0-9a-f]{6})$/i.exec(a ?? "");
  const pb = /^#([0-9a-f]{6})$/i.exec(b ?? "");
  if (!pa || !pb) return a ?? "#888888";
  const ca = parseInt(pa[1], 16);
  const cb = parseInt(pb[1], 16);
  const ch = (shift: number) => Math.round(((ca >> shift) & 255) * t + ((cb >> shift) & 255) * (1 - t));
  return `rgb(${ch(16)}, ${ch(8)}, ${ch(0)})`;
}
function alpha(hex: string | undefined, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return "transparent";
  const c = parseInt(m[1], 16);
  return `rgba(${c >> 16}, ${(c >> 8) & 255}, ${c & 255}, ${a})`;
}

/** The chip's glyph: n bars rising left to right, lit up to `level` (the desktop's .power-glyph). */
export function PowerGlyph({ level, of }: { level: number; of: number }) {
  const [accent, text3, line2] = useCSSVariable(["--color-accent", "--color-text-3", "--color-line-2"]) as string[];
  return (
    <View className="flex-row items-end" style={{ gap: 2, height: 13 }} pointerEvents="none">
      {Array.from({ length: of }, (_, k) => (
        <View
          key={k}
          style={{
            width: 2.5,
            height: barHeight(k, of, 5, 13),
            borderRadius: 1,
            backgroundColor: k <= level ? mix(accent, text3, 0.55 + 0.45 * heatOf(k, of)) : line2,
          }}
        />
      ))}
    </View>
  );
}

/** The sheet the chip opens. `onModels`: the model list, a sheet of its own. */
export function TunerSheet({ open, onClose, s, onModels }: { open: boolean; onClose: () => void; s: ComposerSettings; onModels: () => void }) {
  return (
    <Sheet open={open} onClose={onClose}>
      <TunerBody s={s} onModels={onModels} />
    </Sheet>
  );
}

/**
 * One light crossing the whole meter, seen through the lit bars (deepest effort: now and then;
 * Fast: an amber one, running): each bar draws the same band from the meter's left edge (back by
 * `offset`, its place in the row), all moving in step, so it passes from bar to bar. As the
 * desktop's .tuner-fill::after.
 */
function Sweep({ id, meter, offset, h, color, peak, duration, timing, until }: { id: string; meter: number; offset: number; h: number; color: string; peak: number; duration: number; timing: typeof EASE | "linear"; until: number }) {
  const w = meter * 0.3;
  // From off the meter's left to off its right, then a rest (`until`: where in the loop it's across).
  const frames = useMemo(() => {
    const at = (x: number) => ({ transform: [{ translateX: x }] });
    return { "0%": at(-w), [`${until}%`]: at(meter), "100%": at(meter) };
  }, [w, meter, until]);
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: 0,
        left: -offset,
        width: w,
        height: h,
        transform: [{ translateX: -w }],
        animationName: frames,
        animationDuration: duration,
        animationTimingFunction: timing,
        animationIterationCount: "infinite",
      }}
    >
      <Svg width={w} height={h}>
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="1" y2="0.25">
            <Stop offset="0.25" stopColor={color} stopOpacity={0} />
            <Stop offset="0.5" stopColor={color} stopOpacity={peak} />
            <Stop offset="0.75" stopColor={color} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Rect width={w} height={h} fill={`url(#${id})`} />
      </Svg>
    </Animated.View>
  );
}

function TunerBody({ s, onModels }: { s: ComposerSettings; onModels: () => void }) {
  const { effortOptions: efforts, speedOptions, speed, setPrefs } = s;
  const n = efforts.length;
  const level = efforts.findIndex((o) => o.value === s.effort);
  const dir = useRoll(level);
  const from = useFillFrom(level);
  const reduce = useReducedMotion();
  const [accent, accentStrong, bg4, text, amber] = useCSSVariable(["--color-accent", "--color-accent-strong", "--color-bg-4", "--color-text", "--color-amber"]) as string[];
  const [meterW, setMeterW] = useState(0);
  const [segW, setSegW] = useState(0);

  const defaultIndex = efforts.findIndex((o) => o.value === s.defaultEffort);
  const current = level >= 0 ? efforts[level] : undefined;
  const heat = heatOf(level, n);
  const top = n > 1 && level === n - 1;
  const fast = speed !== "default";
  const barW = n ? (meterW - GAP * (n - 1)) / n : 0;
  const speedIndex = Math.max(0, speedOptions.findIndex((o) => o.value === speed));
  const tier = speedOptions[speedIndex];

  const pick = (k: number) => {
    const o = efforts[Math.max(0, Math.min(n - 1, k))];
    if (!o || o.value === s.effort) return;
    void Haptics.selectionAsync();
    setPrefs({ effort: o.value });
  };
  // Bars don't take touches, so locationX is along the meter.
  const touch = (e: GestureResponderEvent) => {
    if (meterW) pick(Math.floor((e.nativeEvent.locationX / meterW) * n));
  };

  return (
    <View className="px-2 pb-1">
      <View className="flex-row items-center gap-1">
        <Pressable
          onPress={onModels}
          accessibilityLabel={s.modelsGrouped ? "Choose the model, and the agent that runs it" : "Choose the model"}
          className="min-h-[44px] flex-1 flex-row items-center gap-2 rounded-xl px-2 active:bg-bg-3"
        >
          <Text numberOfLines={1} className="shrink text-[16px] font-semibold text-text">
            {s.modelLabel ?? "Model"}
          </Text>
          <Text className="text-[13px] text-text-3">{s.agent.name}</Text>
          <View className="flex-1" />
          <Icon icon={ChevronRight} size={16} colorClassName="accent-text-3" />
        </Pressable>
        {defaultIndex >= 0 && level >= 0 && level !== defaultIndex && (
          <Pressable
            onPress={() => pick(defaultIndex)}
            hitSlop={6}
            accessibilityLabel={`Back to ${efforts[defaultIndex].label}, this model's default`}
            className="h-10 w-10 items-center justify-center rounded-xl active:bg-bg-3"
          >
            <Icon icon={RotateCcw} size={15} colorClassName="accent-text-3" />
          </Pressable>
        )}
      </View>

      {n > 0 ? (
        <View className="px-2 pt-2">
          <View className="h-[30px] flex-row items-center gap-2.5">
            <View className="h-[30px] justify-center overflow-hidden">
              <Animated.View
                key={current?.value ?? ""}
                style={dir && !reduce ? { animationName: dir > 0 ? ROLL_UP : ROLL_DOWN, animationDuration: "0.26s", animationTimingFunction: EASE } : undefined}
              >
                <Text
                  className="text-[22px] font-semibold"
                  style={{
                    letterSpacing: -0.2,
                    color: mix(accentStrong, text, heat),
                    textShadowColor: top ? alpha(accent, 0.65) : "transparent",
                    textShadowRadius: top ? 14 : 0,
                  }}
                >
                  {current?.label ?? "Effort"}
                </Text>
              </Animated.View>
            </View>
            {level >= 0 && level === defaultIndex && (
              <View className="rounded border border-line-2 px-1.5 py-px">
                <Text className="text-[10px] font-semibold uppercase tracking-wider text-text-3">Default</Text>
              </View>
            )}
            <View className="flex-1" />
            {level >= 0 && n > 1 && (
              <Text className="text-[13px] font-semibold text-text-2" style={{ fontVariant: ["tabular-nums"] }}>
                {level + 1}
                <Text className="font-normal text-text-3">/{n}</Text>
              </Text>
            )}
          </View>
          <Text numberOfLines={2} className="mt-0.5 text-[13px] leading-[18px] text-text-3">
            {current?.description ?? "Reasoning effort"}
          </Text>
          {n > 1 && (
            <View
              accessible
              accessibilityRole="adjustable"
              accessibilityLabel="Reasoning effort"
              accessibilityValue={{ min: 1, max: n, now: level + 1, text: current?.label }}
              accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
              onAccessibilityAction={(e) => pick(level + (e.nativeEvent.actionName === "increment" ? 1 : -1))}
              onLayout={(e) => setMeterW(e.nativeEvent.layout.width)}
              onStartShouldSetResponder={() => true}
              onMoveShouldSetResponder={() => true}
              // A drag along the bars stays with them, rather than going to the sheet's scrolling.
              onResponderTerminationRequest={() => false}
              onResponderGrant={touch}
              onResponderMove={touch}
              className="mb-4 mt-4 flex-row items-end"
              style={{ height: METER_H, gap: GAP }}
            >
              {efforts.map((o, k) => {
                const h = barHeight(k, n, BAR_MIN, METER_H);
                const on = k <= level;
                const cur = k === level;
                const delay = fillDelay(k, level, from);
                return (
                  <Animated.View
                    key={o.value}
                    pointerEvents="none"
                    style={[
                      { flex: 1, height: h, borderRadius: 6, transformOrigin: "bottom" },
                      cur && { boxShadow: `0px 0px 16px -3px ${alpha(accent, 0.35 + 0.55 * heat)}` },
                      cur && !reduce && { animationName: BUMP, animationDuration: "0.4s", animationTimingFunction: SPRING },
                    ]}
                  >
                    <View className="flex-1 overflow-hidden rounded-md bg-bg-4">
                      <Animated.View
                        style={[
                          { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: mix(accent, bg4, 0.5 + 0.5 * heatOf(k, n)), transform: [{ translateY: on ? 0 : h + 1 }] },
                          !reduce && { transitionProperty: "transform", transitionDuration: "300ms", transitionTimingFunction: EASE, transitionDelay: `${delay}ms` },
                        ]}
                      >
                        {/* Unlit bars run it too (their fill is out of sight), so one that lights up joins in step. */}
                        {!reduce && barW > 0 && fast && (
                          <Sweep
                            id={`streak${k}`}
                            meter={meterW}
                            offset={k * (barW + GAP)}
                            h={h}
                            color={mix(amber, "#ffffff", 0.75)}
                            peak={0.7}
                            duration={speed === "ultrafast" ? 750 : 1300}
                            timing="linear"
                            until={70}
                          />
                        )}
                        {!reduce && barW > 0 && !fast && top && (
                          <Sweep id={`glint${k}`} meter={meterW} offset={k * (barW + GAP)} h={h} color="#ffffff" peak={0.45} duration={2800} timing={EASE} until={55} />
                        )}
                      </Animated.View>
                    </View>
                    {/* The model's default, a dot under its bar. */}
                    {k === defaultIndex && <View className="absolute left-1/2 h-1 w-1 rounded-full bg-text-3" style={{ bottom: -9, marginLeft: -2 }} />}
                  </Animated.View>
                );
              })}
            </View>
          )}
        </View>
      ) : (
        <Text className="px-2 pt-2 text-[14px] text-text-3">{"This model doesn't take a reasoning effort."}</Text>
      )}

      {speedOptions.length > 0 && (
        <View className="mx-1 mt-2 border-t border-line px-1 pt-3">
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel="Speed"
            onLayout={(e) => setSegW((e.nativeEvent.layout.width - 6) / speedOptions.length)}
            className="flex-row rounded-[10px] border border-line bg-bg-1 p-0.5"
          >
            <Animated.View
              pointerEvents="none"
              style={[
                {
                  position: "absolute",
                  top: 2,
                  bottom: 2,
                  left: 2,
                  width: segW,
                  borderRadius: 8,
                  borderWidth: 1,
                  transform: [{ translateX: segW * speedIndex }],
                },
                speed === "ultrafast"
                  ? { backgroundColor: alpha(amber, 0.24), borderColor: alpha(amber, 0.65), boxShadow: `0px 0px 14px -4px ${amber}` }
                  : fast
                    ? { backgroundColor: alpha(amber, 0.14), borderColor: alpha(amber, 0.4) }
                    : { backgroundColor: bg4, borderColor: "transparent" },
                !reduce && { transitionProperty: ["transform", "backgroundColor", "borderColor"], transitionDuration: "320ms", transitionTimingFunction: cubicBezier(0.34, 1.3, 0.64, 1) },
              ]}
            />
            {speedOptions.map((o) => {
              const on = o.value === speed;
              const tone = on ? (o.value === "default" ? "text" : "amber") : "text-3";
              return (
                <Pressable
                  key={o.value}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                  accessibilityHint={o.description}
                  onPress={() => {
                    if (on) return;
                    void Haptics.selectionAsync();
                    setPrefs({ speed: o.value });
                  }}
                  className="h-10 flex-1 flex-row items-center justify-center gap-1.5"
                >
                  <Animated.View key={on ? "on" : "off"} style={on && !reduce ? { animationName: ZAP, animationDuration: "0.4s", animationTimingFunction: SPRING } : undefined}>
                    <Icon icon={speedIcon(o.value)} size={14} colorClassName={`accent-${tone}`} />
                  </Animated.View>
                  <Text numberOfLines={1} className={`text-[14px] ${on ? "font-semibold" : ""} text-${tone}`}>
                    {o.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {tier?.description ? <Text className="mt-2 px-0.5 text-[13px] text-text-3">{tier.description}</Text> : null}
        </View>
      )}
    </View>
  );
}
