import { memo, useState } from "react";
import type { BotMood } from "../../lib/working";
import { botShape } from "../../lib/retBot";
import {
  BLINK,
  BLINK_TWICE,
  BOT_LOOPS,
  LOOP_BY_NAME,
  PART_COPIES,
  REST,
  blinks,
  stepsOf,
  usesPart,
  type BotPart,
  type Easing,
  type Move,
  type Pose,
  type TransformStep,
} from "../../lib/retBotMotion";

/** 18 px tall, beside 12.5 px text. */
const S = botShape(18);

// The loops (lib/retBotMotion) as CSS: a rule and keyframes per part each loop moves, written once
// into the page. Each bot is somewhere else in its cycles (`--d`, a negative delay) and blinks on
// its own beat (`--bl`).

const len = (v: number) => `${Math.round(v * S.unit * 1000) / 1000}px`;
const ease = (e: Easing) => (typeof e === "string" ? e : `cubic-bezier(${e.join(",")})`);
const moved = (p: Pose) => p.x !== undefined || p.y !== undefined || p.rotate !== undefined || p.sx !== undefined || p.sy !== undefined;

function declare(p: Pose, steps: TransformStep[]): string {
  const out: string[] = [];
  if (steps.length && moved(p)) {
    const t = steps.map((s) => (s === "translate" ? `translate(${len(p.x ?? 0)},${len(p.y ?? 0)})` : s === "rotate" ? `rotate(${p.rotate ?? 0}deg)` : `scale(${p.sx ?? 1},${p.sy ?? 1})`));
    out.push(`transform:${t.join(" ")}`);
  }
  if (p.opacity !== undefined) out.push(`opacity:${p.opacity}`);
  return out.join(";");
}

function keyframes(name: string, move: Move): string {
  const steps = stepsOf(Object.values(move.frames));
  const frames = Object.entries(move.frames)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([at, pose]) => `${at}%{${declare(pose, steps)}}`);
  return `@keyframes ${name}{${frames.join("")}}`;
}

function animation(name: string, move: Move, lead: number, duration = `${move.duration}s`): string {
  return `animation:${name} ${duration} ${ease(move.easing)} calc(var(--d) - ${lead}s) infinite${move.alternate ? " alternate" : ""}`;
}

/** Each copy of a part, by selector (`.rb-led.c1` is the right antenna's light). */
const copiesOf = (part: BotPart) => Array.from({ length: PART_COPIES[part] ?? 1 }, (_, i) => ({ i, sel: `.rb-${part}${PART_COPIES[part] ? `.c${i}` : ""}` }));

function origin(part: BotPart, copy: number): { x: number; y: number } | null {
  if (part === "led" || part === "ring") return S.tips[copy];
  if (part === "pupils") return null;
  return S.pivots[part as keyof typeof S.pivots] ?? null;
}

function motionCss(): string {
  const rules: string[] = [];
  const parts = Object.keys(REST).concat("body", "antL", "antR") as BotPart[];
  for (const part of parts) {
    for (const { i, sel } of copiesOf(part)) {
      const o = origin(part, i);
      if (o) rules.push(`.retbot ${sel}{transform-origin:${o.x}px ${o.y}px}`);
    }
  }
  for (const [part, pose] of Object.entries(REST) as [BotPart, Pose][]) rules.push(`.retbot .rb-${part}{${declare(pose, stepsOf([pose]))}}`);
  rules.push(keyframes("rbm-blink", BLINK), keyframes("rbm-blink2", BLINK_TWICE));
  rules.push(`.retbot .rb-lids{${animation("rbm-blink", BLINK, 0, "var(--bl)")}}`, `.retbot.dbl .rb-lids{animation-name:rbm-blink2}`);
  for (const loop of Object.values(BOT_LOOPS).flat()) {
    const scope = `.retbot.rb-${loop.name}`;
    for (const [part, pose] of Object.entries(loop.rest ?? {}) as [BotPart, Pose][]) rules.push(`${scope} .rb-${part}{${declare(pose, stepsOf([pose]))}}`);
    if (!blinks(loop) && !loop.moves.lids) rules.push(`${scope} .rb-lids{animation:none}`);
    for (const [part, move] of Object.entries(loop.moves) as [BotPart, Move][]) {
      const name = `rbm-${loop.name}-${part}`;
      rules.push(keyframes(name, move));
      for (const { i, sel } of copiesOf(part)) rules.push(`${scope} ${sel}{${animation(name, move, (move.shift ?? 0) + (move.stagger ?? 0) * i)}}`);
    }
  }
  return rules.join("\n");
}

{
  // Once per page (and again when this module is hot-reloaded).
  const id = "retbot-motion";
  document.getElementById(id)?.remove();
  const style = document.createElement("style");
  style.id = id;
  style.textContent = motionCss();
  document.head.append(style);
}

function Layer({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <svg viewBox={S.box} className={className}>
      {children}
    </svg>
  );
}

/**
 * Ret's mascot as a status glyph: antennae, visor and eyes, in the mood of what a thread is doing,
 * moving in one of that mood's loops (`loop`, see botLoop). Each moving part is its own SVG layer
 * the size of the glyph, so every motion is a transform or opacity keyframe on an element, which
 * the compositor runs. The phone's (apps/mobile/src/ui/RetBot) is drawn from the same shapes and
 * runs the same loops.
 */
export const RetBot = memo(function RetBot({ mood, loop }: { mood: BotMood; loop: string }) {
  const l = LOOP_BY_NAME[loop] ?? BOT_LOOPS[mood][0];
  // Its own place in its cycles and its own blink: a board of them never moves in step.
  const [own] = useState(() => ({ phase: `${(-Math.random() * 3).toFixed(2)}s`, blink: `${(3.6 + Math.random() * 2.8).toFixed(2)}s`, twice: Math.random() < 0.4 }));
  const has = (part: BotPart) => usesPart(l, part);
  return (
    <span className={`retbot ${mood} rb-${l.name}${own.twice ? " dbl" : ""}`} style={{ "--d": own.phase, "--bl": own.blink } as React.CSSProperties} aria-hidden>
      <span className="rb-body">
        {(["antL", "antR"] as const).map((part, i) => (
          <span key={part} className={`rb-ant rb-${part}`}>
            <Layer>
              <path d={S.stalks[i]} strokeWidth={S.stroke.stalk} />
              <circle cx={S.tips[i].x} cy={S.tips[i].y} r={S.tipR} />
            </Layer>
            {has("led") && (
              <Layer className={`rb-led c${i}`}>
                <circle cx={S.tips[i].x} cy={S.tips[i].y} r={S.ledR} />
              </Layer>
            )}
            {has("ring") && (
              <Layer className={`rb-ring c${i}`}>
                <circle cx={S.tips[i].x} cy={S.tips[i].y} r={S.tipR} strokeWidth={S.stroke.ring} />
              </Layer>
            )}
          </span>
        ))}
        <Layer>
          <path fillRule="evenodd" d={S.head} />
        </Layer>
        <Layer className="rb-pupils">
          {S.eyes.map((e, i) => (
            <circle key={i} cx={e.x} cy={e.y} r={S.pupilR} />
          ))}
        </Layer>
        <Layer className="rb-lids">
          {S.eyes.map((e, i) => (
            <circle key={i} cx={e.x} cy={e.y} r={S.lidR} />
          ))}
        </Layer>
      </span>
      {has("puff") &&
        S.puffR.map((r, i) => (
          <Layer key={r} className={`rb-puff c${i}`}>
            <circle cx={S.puff.x} cy={S.puff.y} r={r} strokeWidth={S.stroke.puff} />
          </Layer>
        ))}
      {has("z") &&
        [0, 1, 2].map((i) => (
          <Layer key={i} className={`rb-z c${i}`}>
            <path d={S.z} strokeWidth={S.stroke.z} />
          </Layer>
        ))}
      {has("note") &&
        [0, 1].map((i) => (
          <Layer key={i} className={`rb-note c${i}`}>
            <circle cx={S.note.head.x} cy={S.note.head.y} r={S.note.headR} />
            <path d={S.note.stem} strokeWidth={S.stroke.note} />
          </Layer>
        ))}
      {has("spark") && (
        <Layer className="rb-spark">
          <path d={S.spark} />
        </Layer>
      )}
    </span>
  );
});
