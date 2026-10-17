import { memo, useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { cubicBezier, useReducedMotion } from "react-native-reanimated";
import Svg, { Circle, Path } from "react-native-svg";
import { useCSSVariable } from "uniwind";
import { botShape } from "@ret/lib/retBot";
import {
  BLINK,
  BLINK_TWICE,
  BOT_LOOPS,
  LOOP_BY_NAME,
  REST,
  blinks,
  leadOf,
  stepsOf,
  usesPart,
  type BotPart,
  type Easing,
  type Loop,
  type Move,
  type Pose,
  type TransformStep,
} from "@ret/lib/retBotMotion";
import type { BotMood } from "@ret/lib/working";

/** 20 px tall, beside 14 px text (the desktop's is 18 beside 12.5). */
const S = botShape(20);
const fill = StyleSheet.absoluteFill;

// The loops (lib/retBotMotion) as Reanimated's CSS animations, which run on the UI thread: the
// same keyframes, durations and easings as the desktop's, in this size's pixels.

const moved = (p: Pose) => p.x !== undefined || p.y !== undefined || p.rotate !== undefined || p.sx !== undefined || p.sy !== undefined;

function styleOf(p: Pose, steps: TransformStep[]) {
  const out: { transform?: object[]; opacity?: number } = {};
  if (steps.length && moved(p)) {
    out.transform = steps.flatMap((s): object[] =>
      s === "translate" ? [{ translateX: (p.x ?? 0) * S.unit }, { translateY: (p.y ?? 0) * S.unit }] : s === "rotate" ? [{ rotate: `${p.rotate ?? 0}deg` }] : [{ scaleX: p.sx ?? 1 }, { scaleY: p.sy ?? 1 }],
    );
  }
  if (p.opacity !== undefined) out.opacity = p.opacity;
  return out;
}

const timing = (e: Easing) => (typeof e === "string" ? e : cubicBezier(e[0], e[1], e[2], e[3]));

/** Each move's keyframes, made once: Reanimated starts an animation over when they're a new object. */
const made = new WeakMap<Move, object>();
function keyframesOf(move: Move): object {
  let k = made.get(move);
  if (!k) {
    const steps = stepsOf(Object.values(move.frames));
    k = Object.fromEntries(Object.entries(move.frames).map(([at, pose]) => [`${at}%`, styleOf(pose, steps)]));
    made.set(move, k);
  }
  return k;
}

function animation(move: Move, lead: number, duration = move.duration) {
  return {
    animationName: keyframesOf(move),
    animationDuration: `${duration}s`,
    animationTimingFunction: timing(move.easing),
    animationIterationCount: "infinite" as const,
    animationDirection: move.alternate ? ("alternate" as const) : ("normal" as const),
    animationDelay: `${-lead}s`,
  };
}

function origin(part: BotPart, copy: number): [number, number, number] | undefined {
  const p = part === "led" || part === "ring" ? S.tips[copy] : part === "pupils" ? undefined : S.pivots[part as keyof typeof S.pivots];
  return p && [p.x, p.y, 0];
}

/** This bot's place in its cycles and its own blink: a list of them never moves in step. */
interface Own {
  phase: number;
  blink: number;
  twice: boolean;
}

/** A part's style in a loop: where it turns from, where it rests, and how it moves (not with motion turned down). */
function partStyle(loop: Loop, part: BotPart, copy: number, own: Own, still: boolean) {
  const style: object[] = [fill];
  const o = origin(part, copy);
  if (o) style.push({ transformOrigin: o });
  const rest = loop.rest?.[part] ?? REST[part];
  if (rest) style.push(styleOf(rest, stepsOf([rest])));
  if (still) return style;
  const blink = part === "lids" && !loop.moves.lids && blinks(loop);
  const move = blink ? (own.twice ? BLINK_TWICE : BLINK) : loop.moves[part];
  if (move) style.push(animation(move, leadOf(move, own.phase, copy), blink ? own.blink : undefined));
  return style;
}

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
 * The desktop's Ret bot (components/ui/RetBot): drawn from the same shapes, in the mood of what the
 * thread's doing, moving in the same loop (`loop`, see botLoop). Each moving part is a layer of its
 * own.
 */
export const RetBot = memo(function RetBot({ mood, loop }: { mood: BotMood; loop: string }) {
  const l = LOOP_BY_NAME[loop] ?? BOT_LOOPS[mood][0];
  const [accent, green, amber] = useCSSVariable(["--color-accent", "--color-green", "--color-amber"]) as string[];
  const color = mood === "doze" ? green : mood === "ask" ? amber : accent;
  const lit = lighter(color);
  const [own] = useState<Own>(() => ({ phase: Math.random() * 3, blink: 3.6 + Math.random() * 2.8, twice: Math.random() < 0.4 }));
  const still = useReducedMotion();
  const at = (part: BotPart, copy = 0) => partStyle(l, part, copy, own, still);
  const has = (part: BotPart) => usesPart(l, part);
  return (
    <View style={{ width: S.width, height: S.height }} pointerEvents="none">
      <Animated.View style={at("body")}>
        {(["antL", "antR"] as const).map((part, i) => (
          <Animated.View key={part} style={at(part)}>
            <Layer>
              <Path d={S.stalks[i]} fill="none" stroke={color} strokeWidth={S.stroke.stalk} strokeLinecap="round" />
              <Circle cx={S.tips[i].x} cy={S.tips[i].y} r={S.tipR} fill={color} />
            </Layer>
            {has("led") && (
              <Animated.View style={at("led", i)}>
                <Layer>
                  <Circle cx={S.tips[i].x} cy={S.tips[i].y} r={S.ledR} fill={lit} />
                </Layer>
              </Animated.View>
            )}
            {has("ring") && (
              <Animated.View style={at("ring", i)}>
                <Layer>
                  <Circle cx={S.tips[i].x} cy={S.tips[i].y} r={S.tipR} fill="none" stroke={color} strokeWidth={S.stroke.ring} />
                </Layer>
              </Animated.View>
            )}
          </Animated.View>
        ))}
        <Layer>
          <Path d={S.head} fill={color} fillRule="evenodd" />
        </Layer>
        <Animated.View style={at("pupils")}>
          <Layer>
            {S.eyes.map((e, i) => (
              <Circle key={i} cx={e.x} cy={e.y} r={S.pupilR} fill={color} />
            ))}
          </Layer>
        </Animated.View>
        <Animated.View style={at("lids")}>
          <Layer>
            {S.eyes.map((e, i) => (
              <Circle key={i} cx={e.x} cy={e.y} r={S.lidR} fill={color} />
            ))}
          </Layer>
        </Animated.View>
      </Animated.View>
      {has("puff") &&
        S.puffR.map((r, i) => (
          <Animated.View key={r} style={at("puff", i)}>
            <Layer>
              <Circle cx={S.puff.x} cy={S.puff.y} r={r} fill="none" stroke={color} strokeWidth={S.stroke.puff} />
            </Layer>
          </Animated.View>
        ))}
      {has("z") &&
        [0, 1, 2].map((i) => (
          <Animated.View key={i} style={at("z", i)}>
            <Layer>
              <Path d={S.z} fill="none" stroke={color} strokeWidth={S.stroke.z} strokeLinecap="round" strokeLinejoin="round" />
            </Layer>
          </Animated.View>
        ))}
      {has("note") &&
        [0, 1].map((i) => (
          <Animated.View key={i} style={at("note", i)}>
            <Layer>
              <Circle cx={S.note.head.x} cy={S.note.head.y} r={S.note.headR} fill={color} />
              <Path d={S.note.stem} fill="none" stroke={color} strokeWidth={S.stroke.note} strokeLinecap="round" />
            </Layer>
          </Animated.View>
        ))}
      {has("spark") && (
        <Animated.View style={at("spark")}>
          <Layer>
            <Path d={S.spark} fill={color} />
          </Layer>
        </Animated.View>
      )}
    </View>
  );
});
