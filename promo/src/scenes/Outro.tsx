import { AbsoluteFill, random, useCurrentFrame } from "remotion";
import { Download } from "lucide-react";
import { C, FONT, MONO, STATE_COLOR, type State, pop, tween } from "../theme";
import { AppIcon } from "../Mascot";
import { DotGrid, Glow, Sub } from "../ui";

const STATES: State[] = ["running", "attention", "unread", "running", "running", "attention", "unread", "running"];

/** Thread windows drifting in the background, at a few depths. */
function Drift() {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill>
      {Array.from({ length: 16 }, (_, i) => {
        const depth = 0.35 + random(`d${i}`) * 0.65;
        const w = 260 * depth + 80;
        const h = w * 0.62;
        const x = random(`x${i}`) * 2200 - 140 - f * depth * 1.4;
        const y = random(`y${i}`) * 1180 - 100;
        const st = STATES[i % STATES.length];
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: x,
              top: y,
              width: w,
              height: h,
              borderRadius: 10 * depth,
              background: C.bg1,
              border: `1px solid ${C.line2}`,
              opacity: 0.18 + depth * 0.25,
              filter: `blur(${(1 - depth) * 5}px)`,
              overflow: "hidden",
            }}
          >
            <div style={{ height: 22 * depth + 6, background: C.bg2, display: "flex", alignItems: "center", gap: 6, padding: "0 10px", borderBottom: `1px solid ${C.line}` }}>
              <span style={{ width: 7, height: 7, borderRadius: 9, background: STATE_COLOR[st] }} />
              <span style={{ width: w * 0.35, height: 5, borderRadius: 9, background: "rgba(255,255,255,0.22)" }} />
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
}

export function Outro() {
  const f = useCurrentFrame();
  const icon = pop(f, 4, 10, 120);
  const word = pop(f, 18, 18, 140);
  const cta = pop(f, 54, 16, 150);
  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: FONT }}>
      <DotGrid opacity={0.5} dx={-f * 0.6} />
      <Drift />
      <AbsoluteFill style={{ background: "radial-gradient(ellipse at center, rgba(0,0,0,0.92) 25%, rgba(0,0,0,0.55) 60%, #000 100%)" }} />
      <Glow y="40%" opacity={0.3 * icon} size={1300} />

      <AbsoluteFill style={{ alignItems: "center", paddingTop: 205 }}>
        <div style={{ transform: `scale(${icon}) translateY(${Math.sin(f / 14) * 6}px)` }}>
          <AppIcon size={230} blinkAt={[40, 120]} look={{ x: 0, y: tween(f, 60, 14) * 0.5 }} />
        </div>
        <div
          style={{
            marginTop: 30,
            fontSize: 150,
            fontWeight: 800,
            letterSpacing: "-0.06em",
            color: C.text,
            lineHeight: 1,
            opacity: Math.min(1, word * 1.3),
            transform: `translateY(${(1 - word) * 30}px)`,
          }}
        >
          Ret
        </div>
        <Sub delay={30} size={44} style={{ color: C.text, fontWeight: 600, letterSpacing: "-0.025em", marginTop: 18 }}>
          Run lots of agents. Lose track of none.
        </Sub>
        <div
          style={{
            marginTop: 50,
            display: "flex",
            alignItems: "center",
            gap: 14,
            padding: "16px 30px",
            borderRadius: 99,
            background: C.text,
            color: "#000",
            fontSize: 34,
            fontWeight: 650,
            fontFamily: MONO,
            letterSpacing: "-0.02em",
            transform: `scale(${cta})`,
            opacity: Math.min(1, cta * 1.4),
            boxShadow: "0 0 80px rgba(139,156,255,0.35)",
          }}
        >
          <Download size={30} color="#000" strokeWidth={2.4} />
          getret.app
        </div>
        <Sub delay={66} size={24} style={{ marginTop: 24, color: C.text3 }}>
          Windows &nbsp;·&nbsp; macOS &nbsp;·&nbsp; Codex &nbsp;·&nbsp; Claude Code
        </Sub>
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
