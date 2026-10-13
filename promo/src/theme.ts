import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";
import { interpolate, spring, Easing } from "remotion";

export const FONT = loadInter("normal", { weights: ["400", "500", "600", "700", "800"], subsets: ["latin"] }).fontFamily;
export const MONO = loadMono("normal", { weights: ["400", "500"], subsets: ["latin"] }).fontFamily;

// Ret's dark theme tokens (src/renderer/styles/app.css).
export const C = {
  bg: "#000000",
  bg1: "#0a0a0a",
  bg2: "#121212",
  bg3: "#1b1b1b",
  bg4: "#262626",
  line: "rgba(255,255,255,0.08)",
  line2: "rgba(255,255,255,0.135)",
  text: "#ededed",
  text2: "#a3a3a3",
  text3: "#6e6e6e",
  accent: "#8b9cff",
  accentStrong: "#a3b0ff",
  accentSoft: "rgba(139,156,255,0.13)",
  green: "#3fd18f",
  greenSoft: "rgba(63,209,143,0.13)",
  amber: "#f2b33d",
  amberSoft: "rgba(242,179,61,0.14)",
  red: "#f2616a",
  redSoft: "rgba(242,97,106,0.13)",
  navy: "#062155",
  claude: "#d97757",
};

export const FPS = 30;
export const W = 1920;
export const H = 1080;

export type State = "attention" | "running" | "error" | "unread" | "idle" | "done";
export const STATE_COLOR: Record<State, string> = {
  attention: C.amber,
  running: C.green,
  error: C.red,
  unread: C.accent,
  idle: C.text3,
  done: C.text3,
};

export const ease = Easing.bezier(0.2, 0.8, 0.2, 1);

/** 0→1 over [start, start+dur] with Ret's ease. */
export const tween = (f: number, start: number, dur: number, from = 0, to = 1) =>
  dur <= 0 ? (f >= start ? to : from) : interpolate(f, [start, start + dur], [from, to], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });

export const pop = (f: number, delay: number, damping = 14, stiffness = 140) =>
  spring({ frame: f - delay, fps: FPS, config: { damping, stiffness, mass: 0.9 } });

export const soft = (f: number, delay: number) => spring({ frame: f - delay, fps: FPS, config: { damping: 200 } });
