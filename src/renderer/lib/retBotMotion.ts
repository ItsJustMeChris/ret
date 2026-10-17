import { hash, type BotMood } from "./working";

/**
 * How the Ret bot moves, written once for both apps: the desktop's RetBot (components/ui) makes CSS
 * animations of it, the phone's (apps/mobile/src/ui) Reanimated's CSS animations. Each mood has a
 * pool of loops; a bot shows one at a time and changes it with the verb beside it (botLoop).
 *
 * Poses are on the bot's 36×32 grid (lib/retBot): moves in grid units, turns in degrees. Only
 * transforms and opacity move, so the compositor (the UI thread, on the phone) runs it all.
 */

/**
 * The bot's moving parts. `led` and `ring` come one per antenna (left first) and move with it;
 * `puff`, `z` and `note` come in a few copies, each starting `stagger` seconds after the last.
 */
export type BotPart = "body" | "antL" | "antR" | "led" | "ring" | "pupils" | "lids" | "puff" | "z" | "note" | "spark";

export const PART_COPIES: Partial<Record<BotPart, number>> = { led: 2, ring: 2, puff: 3, z: 3, note: 2 };

/** A part's pose: moved (grid units), turned (degrees), stretched, faded. */
export interface Pose {
  x?: number;
  y?: number;
  rotate?: number;
  sx?: number;
  sy?: number;
  opacity?: number;
}

export type Easing = "ease" | "ease-in" | "ease-out" | "ease-in-out" | "linear" | readonly [number, number, number, number];

export interface Move {
  /** Poses by how far through the cycle (0–100). */
  frames: Record<number, Pose>;
  /** Seconds a cycle takes (one way, when it goes back and forth). */
  duration: number;
  easing: Easing;
  alternate?: boolean;
  /** How far ahead of the rest of the bot it runs, in seconds. */
  shift?: number;
  /** How far ahead each further copy of the part runs, in seconds. */
  stagger?: number;
}

export interface Loop {
  name: string;
  moves: Partial<Record<BotPart, Move>>;
  /** Where parts rest instead of their usual place (and with motion turned down). Resting lids don't blink. */
  rest?: Partial<Record<BotPart, Pose>>;
}

/** Where parts are when nothing moves them: eyes open, looking a little up and right; the extras hidden. */
export const REST: Partial<Record<BotPart, Pose>> = {
  pupils: { x: 0.6, y: -0.3 },
  lids: { sy: 0 },
  led: { opacity: 0 },
  ring: { opacity: 0 },
  puff: { opacity: 0 },
  z: { opacity: 0 },
  note: { opacity: 0 },
  spark: { opacity: 0 },
};

/** A blink, and two in a row: each bot blinks on its own beat (the duration is its own too). */
export const BLINK: Move = { frames: { 0: { sy: 0 }, 94: { sy: 0 }, 97: { sy: 1 }, 100: { sy: 0 } }, duration: 4.4, easing: "ease" };
export const BLINK_TWICE: Move = { frames: { 0: { sy: 0 }, 86: { sy: 0 }, 88.5: { sy: 1 }, 91: { sy: 0.1 }, 93.5: { sy: 1 }, 96: { sy: 0 }, 100: { sy: 0 } }, duration: 4.4, easing: "ease" };

const turn = (from: number, to: number, duration: number, easing: Easing = "ease-in-out"): Move => ({ frames: { 0: { rotate: from }, 100: { rotate: to } }, duration, easing, alternate: true });
const swayL = (duration: number) => turn(-8, 6, duration);
const swayR = (duration: number) => turn(8, -6, duration);
const bob = (duration: number): Move => ({ frames: { 0: { y: 0 }, 100: { y: -1.6 } }, duration, easing: "ease-in-out", alternate: true });
const blinkLights = (duration: number, stagger = 0): Move => ({ frames: { 0: { opacity: 0 }, 49: { opacity: 0 }, 50: { opacity: 0.9 }, 100: { opacity: 0.9 } }, duration, easing: "linear", stagger });
/** Puffs and z's: up and away, growing as they fade. */
const rise = (duration: number, stagger: number): Move => ({
  frames: { 0: { x: 0, y: 3, sx: 0.4, sy: 0.4, opacity: 0 }, 25: { opacity: 1 }, 100: { x: 3, y: -6, sx: 1, sy: 1, opacity: 0 } },
  duration,
  easing: "ease-out",
  stagger,
});
/** Poses held between the given offsets: `[[from, to, pose], …]`. */
function holds(...spans: [number, number, Pose][]): Record<number, Pose> {
  const frames: Record<number, Pose> = {};
  for (const [from, to, pose] of spans) frames[from] = frames[to] = pose;
  return frames;
}
const lookingUp: Pose = { x: 0.6, y: -0.3 };
const atYou: Pose = { x: 0, y: 0.9 };

export const BOT_LOOPS: Record<BotMood, readonly Loop[]> = {
  // Any kind of busy: generic on purpose, so any of them fits whatever the agent's doing.
  work: [
    { name: "bob", moves: { body: bob(0.45), antL: swayL(0.9), antR: swayR(0.9), led: blinkLights(0.9, 0.45) } },
    {
      name: "look",
      moves: {
        pupils: {
          frames: holds([0, 14, lookingUp], [20, 36, { x: -1.4, y: 0 }], [44, 60, { x: 1.4, y: -0.2 }], [68, 82, { x: 1, y: -1.3 }], [88, 100, lookingUp]),
          duration: 4.2,
          easing: [0.6, 0, 0.2, 1],
        },
        body: { frames: holds([0, 14, { rotate: 0 }], [20, 36, { rotate: -5 }], [44, 60, { rotate: 5 }], [68, 82, { rotate: 2 }], [88, 100, { rotate: 0 }]), duration: 4.2, easing: [0.6, 0, 0.2, 1] },
        antL: swayL(2.1),
        antR: swayR(2.1),
      },
    },
    {
      name: "hum",
      moves: {
        body: turn(-6, 6, 1.6),
        antL: turn(7, -7, 1.6),
        antR: turn(7, -7, 1.6),
        lids: { frames: { 0: { sy: 0.5 }, 90: { sy: 0.5 }, 95: { sy: 1 }, 100: { sy: 0.5 } }, duration: 5, easing: "ease" },
        note: {
          frames: { 0: { x: 0, y: 3, rotate: -12, sx: 0.5, sy: 0.5, opacity: 0 }, 25: { opacity: 1 }, 100: { x: 3, y: -7, rotate: 12, sx: 1, sy: 1, opacity: 0 } },
          duration: 2.6,
          easing: "ease-out",
          stagger: 1.3,
        },
      },
    },
    {
      name: "tap",
      moves: {
        antR: { frames: { 0: { rotate: 0 }, 7: { rotate: 22 }, 14: { rotate: 2 }, 21: { rotate: 22 }, 30: { rotate: 0 }, 100: { rotate: 0 } }, duration: 1.4, easing: "ease-in-out" },
        antL: swayL(2.8),
        pupils: { frames: { 0: { x: -0.9, y: 0.7 }, 7: { x: -0.9, y: 1 }, 14: { x: -0.9, y: 0.7 }, 21: { x: -0.9, y: 1 }, 30: { x: -0.9, y: 0.7 }, 100: { x: -0.9, y: 0.7 } }, duration: 1.4, easing: "ease-in-out" },
      },
    },
    {
      name: "bounce",
      moves: {
        body: {
          frames: { 0: { y: 0, sx: 1.06, sy: 0.9 }, 18: { y: 0, sx: 0.95, sy: 1.06 }, 50: { y: -2.8, sx: 1, sy: 1 }, 82: { y: 0, sx: 0.97, sy: 1.03 }, 100: { y: 0, sx: 1.06, sy: 0.9 } },
          duration: 0.8,
          easing: "ease-in-out",
        },
        antL: { frames: { 0: { rotate: -12 }, 50: { rotate: 8 }, 100: { rotate: -12 } }, duration: 0.8, easing: "ease-in-out" },
        antR: { frames: { 0: { rotate: 12 }, 50: { rotate: -8 }, 100: { rotate: 12 } }, duration: 0.8, easing: "ease-in-out" },
      },
    },
    {
      name: "scan",
      moves: {
        pupils: { frames: { 0: { x: -1.4, y: -0.6 }, 40: { x: 1.4, y: -0.6 }, 50: { x: -1.4, y: 0.4 }, 90: { x: 1.4, y: 0.4 }, 100: { x: -1.4, y: -0.6 } }, duration: 2.2, easing: "linear" },
        ring: { frames: { 0: { sx: 1, sy: 1, opacity: 0.9 }, 100: { sx: 2.5, sy: 2.5, opacity: 0 } }, duration: 1.6, easing: "ease-out", stagger: 0.8 },
        antL: swayL(2.4),
        antR: swayR(2.4),
      },
    },
    {
      name: "windmill",
      moves: {
        antL: turn(-34, 14, 1.2),
        antR: { ...turn(34, -14, 1.2), shift: 0.6 },
        pupils: { frames: { 0: { x: -1.2, y: -0.4 }, 100: { x: 1.2, y: -0.4 } }, duration: 1.2, easing: "ease-in-out", alternate: true },
      },
    },
    {
      name: "wiggle",
      moves: {
        body: { frames: { 0: { x: 0 }, 70: { x: 0 }, 73: { x: -0.8 }, 76: { x: 0.8 }, 79: { x: -0.6 }, 82: { x: 0.5 }, 85: { x: -0.3 }, 88: { x: 0 }, 100: { x: 0 } }, duration: 2.6, easing: "linear" },
        antL: { frames: { 0: { rotate: 0 }, 86: { rotate: 0 }, 89: { rotate: 16 }, 92: { rotate: -11 }, 95: { rotate: 6 }, 98: { rotate: -2 }, 100: { rotate: 0 } }, duration: 2.6, easing: "ease-out" },
        antR: { frames: { 0: { rotate: 0 }, 86: { rotate: 0 }, 89: { rotate: 16 }, 92: { rotate: -11 }, 95: { rotate: 6 }, 98: { rotate: -2 }, 100: { rotate: 0 } }, duration: 2.6, easing: "ease-out" },
      },
    },
  ],
  think: [
    {
      name: "ponder",
      moves: {
        pupils: { frames: holds([0, 45, { x: 1.1, y: -1.3 }], [55, 90, { x: -0.9, y: -1.4 }], [100, 100, { x: 1.1, y: -1.3 }]), duration: 4, easing: "ease-in-out" },
        antL: swayL(3),
        antR: turn(-16, -5, 1.4),
        puff: rise(2.4, 0.8),
      },
    },
    {
      name: "tilt",
      moves: {
        body: { frames: holds([0, 8, { rotate: 0 }], [22, 78, { rotate: -8 }], [92, 100, { rotate: 0 }]), duration: 3.6, easing: "ease-in-out" },
        pupils: { frames: holds([0, 8, lookingUp], [22, 50, { x: -1.2, y: -1.3 }], [60, 78, { x: -0.4, y: -1.5 }], [92, 100, lookingUp]), duration: 3.6, easing: "ease-in-out" },
        antL: swayL(2.6),
        antR: swayR(2.6),
        puff: rise(2.4, 0.8),
      },
    },
    {
      name: "idea",
      rest: { pupils: { x: 0, y: -1.4 } },
      moves: {
        led: { frames: { 0: { opacity: 0.15 }, 100: { opacity: 0.95 } }, duration: 1.6, easing: "ease-in-out", alternate: true },
        spark: {
          frames: {
            0: { rotate: 0, sx: 0, sy: 0, opacity: 0 },
            55: { rotate: 0, sx: 0, sy: 0, opacity: 0 },
            65: { rotate: 45, sx: 1.2, sy: 1.2, opacity: 1 },
            80: { rotate: 90, sx: 0.9, sy: 0.9, opacity: 1 },
            100: { rotate: 135, sx: 0, sy: 0, opacity: 0 },
          },
          duration: 3,
          easing: "ease-out",
        },
        body: bob(1.2),
        antL: swayL(2),
        antR: swayR(2),
      },
    },
  ],
  ask: [
    {
      name: "hop",
      rest: { pupils: atYou },
      moves: {
        body: { frames: { 0: { y: 0 }, 62: { y: 0 }, 70: { y: -2.5 }, 78: { y: 0 }, 84: { y: -1 }, 90: { y: 0 }, 100: { y: 0 } }, duration: 2.4, easing: [0.3, 0.7, 0.4, 1] },
        antL: { frames: { 0: { rotate: 0 }, 64: { rotate: 0 }, 70: { rotate: -12 }, 76: { rotate: 10 }, 82: { rotate: -5 }, 88: { rotate: 0 }, 100: { rotate: 0 } }, duration: 2.4, easing: "ease-in-out" },
        antR: { frames: { 0: { rotate: 0 }, 64: { rotate: 0 }, 70: { rotate: -12 }, 76: { rotate: 10 }, 82: { rotate: -5 }, 88: { rotate: 0 }, 100: { rotate: 0 } }, duration: 2.4, easing: "ease-in-out" },
        led: blinkLights(1.2),
      },
    },
    { name: "wave", rest: { pupils: atYou }, moves: { antL: turn(-40, -8, 0.5), body: bob(0.9), led: blinkLights(1) } },
  ],
  // Waiting on work it left running (or sleeping on purpose).
  doze: [
    {
      name: "snooze",
      rest: { lids: { sy: 0.78 }, antL: { rotate: -20 }, antR: { rotate: 20 } },
      moves: { body: { frames: { 0: { sx: 1, sy: 1 }, 50: { sx: 1.04, sy: 1.04 }, 100: { sx: 1, sy: 1 } }, duration: 3.2, easing: "ease-in-out" }, z: rise(3, 1) },
    },
    {
      name: "nod",
      moves: {
        body: { frames: { 0: { y: 0, rotate: 0 }, 58: { y: 1, rotate: 9 }, 62: { y: -0.8, rotate: -3 }, 68: { y: 0, rotate: 0 }, 100: { y: 0, rotate: 0 } }, duration: 4.4, easing: "ease-in" },
        lids: { frames: { 0: { sy: 0.45 }, 56: { sy: 0.92 }, 61: { sy: 0 }, 72: { sy: 0.2 }, 100: { sy: 0.45 } }, duration: 4.4, easing: "ease-in" },
        antL: { frames: { 0: { rotate: -10 }, 57: { rotate: -24 }, 62: { rotate: 4 }, 70: { rotate: -10 }, 100: { rotate: -10 } }, duration: 4.4, easing: "ease-in" },
        antR: { frames: { 0: { rotate: 10 }, 57: { rotate: 24 }, 62: { rotate: -4 }, 70: { rotate: 10 }, 100: { rotate: 10 } }, duration: 4.4, easing: "ease-in" },
      },
    },
  ],
};

export const LOOP_BY_NAME: Record<string, Loop> = Object.fromEntries(Object.values(BOT_LOOPS).flatMap((pool) => pool.map((l) => [l.name, l])));

/**
 * The loop a bot shows: the same for the same `seed` (the turn and its kind of work) in every view,
 * and the next one in its mood's pool every 15 s of `secs`, when the verb beside it changes too.
 */
export function botLoop(mood: BotMood, seed: string, secs: number): Loop {
  const pool = BOT_LOOPS[mood];
  return pool[(hash(seed + "loop") + Math.floor(secs / 15)) % pool.length];
}

/** Whether a loop shows a part at all (the extras only appear in loops that move them). */
export const usesPart = (loop: Loop, part: BotPart) => !!loop.moves[part] || !!loop.rest?.[part];

/** Whether the bot blinks in a loop: not when the loop moves or rests its lids itself. */
export const blinks = (loop: Loop) => !usesPart(loop, "lids");

export type TransformStep = "translate" | "rotate" | "scale";

/**
 * The transform steps a move's poses need, in the order they apply: every pose of it is written with
 * the same steps (missing values at rest), so they blend into each other step by step.
 */
export function stepsOf(poses: Pose[]): TransformStep[] {
  const steps: TransformStep[] = [];
  if (poses.some((p) => p.x !== undefined || p.y !== undefined)) steps.push("translate");
  if (poses.some((p) => p.rotate !== undefined)) steps.push("rotate");
  if (poses.some((p) => p.sx !== undefined || p.sy !== undefined)) steps.push("scale");
  return steps;
}

/** Seconds into its cycle a copy of a part starts, for a bot `phase` seconds into its own. */
export const leadOf = (move: Move, phase: number, copy: number) => phase + (move.shift ?? 0) + (move.stagger ?? 0) * copy;
