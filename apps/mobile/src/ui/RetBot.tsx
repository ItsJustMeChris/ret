import { memo, useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { cubicBezier, useReducedMotion } from "react-native-reanimated";
import Svg, { Circle, Path } from "react-native-svg";
import { useCSSVariable } from "uniwind";
import { botShape } from "@ret/lib/retBot";
import type { BotMood } from "@ret/lib/working";

/** 20 px tall, beside 14 px text (the desktop's is 18 beside 12.5). */
const S = botShape(20);
const u = S.unit;
const fill = StyleSheet.absoluteFill;
const origin = (p: { x: number; y: number }): [number, number, number] => [p.x, p.y, 0];
/** A move by grid units. */
const by = (x: number, y: number) => ({ transform: [{ translateX: x * u }, { translateY: y * u }] });
const turn = (deg: number) => ({ transform: [{ rotate: `${deg}deg` }] });

// The desktop's keyframes (app.css, .retbot), in pixels: the bot moves the same on both.
const SWAY_L = { from: turn(-8), to: turn(6) };
const SWAY_R = { from: turn(8), to: turn(-6) };
const SCRATCH = { from: turn(-16), to: turn(-5) };
const LED = { "0%": { opacity: 0 }, "49%": { opacity: 0 }, "50%": { opacity: 1 }, "100%": { opacity: 1 } };
const BOB = { from: by(0, 0), to: by(0, -1.6) };
const BLINK = { "0%": { transform: [{ scaleY: 0 }] }, "94%": { transform: [{ scaleY: 0 }] }, "97%": { transform: [{ scaleY: 1 }] }, "100%": { transform: [{ scaleY: 0 }] } };
const PONDER = { "0%": by(1.1, -1.3), "45%": by(1.1, -1.3), "55%": by(-0.9, -1.4), "90%": by(-0.9, -1.4), "100%": by(1.1, -1.3) };
const READ = { "0%": by(-1.4, -0.6), "40%": by(1.4, -0.6), "50%": by(-1.4, 0.4), "90%": by(1.4, 0.4), "100%": by(-1.4, -0.6) };
const RISE = {
  "0%": { opacity: 0, transform: [{ translateX: 0 }, { translateY: 3 * u }, { scale: 0.5 }] },
  "25%": { opacity: 1 },
  "100%": { opacity: 0, transform: [{ translateX: 3 * u }, { translateY: -6 * u }, { scale: 1 }] },
};
const BREATHE = { "0%": { transform: [{ scale: 1 }] }, "50%": { transform: [{ scale: 1.04 }] }, "100%": { transform: [{ scale: 1 }] } };
const HOP = { "0%": by(0, 0), "62%": by(0, 0), "70%": by(0, -2.5), "78%": by(0, 0), "84%": by(0, -1), "90%": by(0, 0), "100%": by(0, 0) };
const PERK = { "0%": turn(0), "64%": turn(0), "70%": turn(-12), "76%": turn(10), "82%": turn(-5), "88%": turn(0), "100%": turn(0) };

type Timing = "ease" | "ease-in-out" | "ease-out" | "linear" | ReturnType<typeof cubicBezier>;
function loop(name: object, duration: string, timing: Timing, alternate = false, delay = "0s") {
  return {
    animationName: name,
    animationDuration: duration,
    animationTimingFunction: timing,
    animationIterationCount: "infinite" as const,
    animationDirection: alternate ? ("alternate" as const) : ("normal" as const),
    animationDelay: delay,
  };
}

type Part = "body" | "antL" | "antR" | "ledL" | "ledR" | "pupils" | "lids" | "puff" | "z";

/** Each part's motion in a mood (`beat`: when its blinks fall), as the desktop's .retbot rules. */
function motion(mood: BotMood, beat: string): Partial<Record<Part, object>> {
  const lids = loop(BLINK, "4.4s", "ease", false, beat);
  switch (mood) {
    case "work":
      return { body: loop(BOB, "0.45s", "ease-in-out", true), antL: loop(SWAY_L, "0.9s", "ease-in-out", true), antR: loop(SWAY_R, "0.9s", "ease-in-out", true), ledL: loop(LED, "0.9s", "linear"), ledR: loop(LED, "0.9s", "linear", false, "0.45s"), lids };
    case "think":
      return { antL: loop(SWAY_L, "3s", "ease-in-out", true), antR: loop(SCRATCH, "1.4s", "ease-in-out", true), pupils: loop(PONDER, "4s", "ease-in-out"), puff: loop(RISE, "2.4s", "ease-out"), lids };
    case "tool":
      return { antL: loop(SWAY_L, "2.4s", "ease-in-out", true), antR: loop(SWAY_R, "2.4s", "ease-in-out", true), pupils: loop(READ, "2.2s", "linear"), lids };
    case "doze":
      return { body: loop(BREATHE, "3.2s", "ease-in-out"), antL: turn(-20), antR: turn(20), lids: { transform: [{ scaleY: 0.78 }] }, z: loop(RISE, "3s", "ease-out") };
    case "ask":
      return { body: loop(HOP, "2.4s", cubicBezier(0.3, 0.7, 0.4, 1)), antL: loop(PERK, "2.4s", "ease-in-out"), antR: loop(PERK, "2.4s", "ease-in-out"), pupils: by(0, 0.9), ledL: loop(LED, "1.2s", "linear"), ledR: loop(LED, "1.2s", "linear"), lids };
  }
}

/** Without motion: only where parts rest (drooped antennae, lids half down). */
const still = (m: Partial<Record<Part, object>>) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, "animationName" in v ? {} : v])) as Partial<Record<Part, object>>;

/** `hex` mixed with white, as the desktop's `color-mix(in srgb, currentColor 35%, #fff)`. */
function lighter(hex: string | undefined, amount = 0.65): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex ?? "");
  if (!m) return "#ffffff";
  const c = parseInt(m[1], 16);
  const mix = (v: number) => Math.round(v + (255 - v) * amount);
  return `rgb(${mix(c >> 16)}, ${mix((c >> 8) & 255)}, ${mix(c & 255)})`;
}

function Layer({ children }: { children: React.ReactNode }) {
  return (
    <Svg width={S.width} height={S.height} viewBox={S.box} style={fill}>
      {children}
    </Svg>
  );
}

/**
 * The desktop's Ret bot (components/ui/RetBot), drawn from the same shapes and moving the same way:
 * each moving part a layer of its own, animated on the UI thread by Reanimated's CSS animations.
 */
export const RetBot = memo(function RetBot({ mood }: { mood: BotMood }) {
  const [accent, green, amber] = useCSSVariable(["--color-accent", "--color-green", "--color-amber"]) as string[];
  const color = mood === "doze" ? green : mood === "ask" ? amber : accent;
  // Each one blinks on its own beat.
  const [beat] = useState(() => `${(Math.random() * 4.4).toFixed(2)}s`);
  const reduce = useReducedMotion();
  const m = reduce ? still(motion(mood, beat)) : motion(mood, beat);
  const lit = lighter(color);
  return (
    <View style={{ width: S.width, height: S.height }} pointerEvents="none">
      <Animated.View style={[fill, { transformOrigin: origin(S.pivots.body) }, m.body]}>
        {[0, 1].map((i) => (
          <Animated.View key={i} style={[fill, { transformOrigin: origin(i ? S.pivots.antR : S.pivots.antL) }, i ? m.antR : m.antL]}>
            <Layer>
              <Path d={S.stalks[i]} fill="none" stroke={color} strokeWidth={S.stroke.stalk} strokeLinecap="round" />
              <Circle cx={S.tips[i].x} cy={S.tips[i].y} r={S.tipR} fill={color} />
            </Layer>
            <Animated.View style={[fill, { opacity: 0 }, i ? m.ledR : m.ledL]}>
              <Layer>
                <Circle cx={S.tips[i].x} cy={S.tips[i].y} r={S.ledR} fill={lit} />
              </Layer>
            </Animated.View>
          </Animated.View>
        ))}
        <Layer>
          <Path d={S.head} fill={color} fillRule="evenodd" />
        </Layer>
        <Animated.View style={[fill, by(0.6, -0.3), m.pupils]}>
          <Layer>
            {S.eyes.map((e, i) => (
              <Circle key={i} cx={e.x} cy={e.y} r={S.pupilR} fill={color} />
            ))}
          </Layer>
        </Animated.View>
        <Animated.View style={[fill, { transformOrigin: origin(S.pivots.lids), transform: [{ scaleY: 0 }] }, m.lids]}>
          <Layer>
            {S.eyes.map((e, i) => (
              <Circle key={i} cx={e.x} cy={e.y} r={S.lidR} fill={color} />
            ))}
          </Layer>
        </Animated.View>
      </Animated.View>
      {mood === "think" &&
        S.puffR.map((r, i) => (
          <Animated.View key={r} style={[fill, { opacity: 0, transformOrigin: origin(S.pivots.puff) }, m.puff, m.puff && "animationName" in m.puff && { animationDelay: `${i * 0.8}s` }]}>
            <Layer>
              <Circle cx={S.puff.x} cy={S.puff.y} r={r} fill="none" stroke={color} strokeWidth={S.stroke.puff} />
            </Layer>
          </Animated.View>
        ))}
      {mood === "doze" &&
        [0, 1, 2].map((i) => (
          <Animated.View key={i} style={[fill, { opacity: 0, transformOrigin: origin(S.pivots.z) }, m.z, m.z && "animationName" in m.z && { animationDelay: `${i}s` }]}>
            <Layer>
              <Path d={S.z} fill="none" stroke={color} strokeWidth={S.stroke.z} strokeLinecap="round" strokeLinejoin="round" />
            </Layer>
          </Animated.View>
        ))}
    </View>
  );
});
