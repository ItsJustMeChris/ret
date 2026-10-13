import { AbsoluteFill, useCurrentFrame } from "remotion";
import { C, FONT, pop, tween } from "../theme";
import { AppIcon } from "../Mascot";
import { DotGrid, Glow, Sub } from "../ui";

export function Logo() {
  const f = useCurrentFrame();
  const icon = pop(f, 0, 9, 120);
  const slide = pop(f, 22, 20, 120);
  const word = pop(f, 26, 16, 140);
  return (
    <AbsoluteFill style={{ background: C.bg, justifyContent: "center", alignItems: "center" }}>
      <DotGrid opacity={tween(f, 10, 30) * 0.7} dy={-f * 0.4} />
      <Glow opacity={0.28 * icon} size={1500} />
      <AbsoluteFill style={{ background: "radial-gradient(ellipse at center, transparent 30%, #000 75%)" }} />
      <div style={{ display: "flex", alignItems: "center", gap: 56, transform: `translateX(${(1 - slide) * 190}px) translateY(-40px)` }}>
        <div style={{ transform: `scale(${icon}) rotate(${(1 - icon) * -30}deg)` }}>
          <AppIcon size={300} blinkAt={[48]} look={{ x: tween(f, 30, 14) * 0.6, y: -0.2 }} />
        </div>
        <div
          style={{
            fontFamily: FONT,
            fontWeight: 800,
            fontSize: 230,
            letterSpacing: "-0.06em",
            color: C.text,
            opacity: Math.min(1, word * 1.3),
            transform: `translateX(${(1 - word) * -40}px)`,
            clipPath: `inset(0 ${(1 - word) * 100}% 0 0)`,
            lineHeight: 1,
          }}
        >
          Ret
        </div>
      </div>
      <div style={{ position: "absolute", top: 760, width: "100%" }}>
        <Sub delay={44} size={40} style={{ color: C.text }}>
          The desktop workbench for coding agents.
        </Sub>
        <Sub delay={54} size={28} style={{ marginTop: 16 }}>
          Codex and Claude Code, side by side, across every project.
        </Sub>
      </div>
    </AbsoluteFill>
  );
}
