import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Check, Sparkles, Terminal } from "lucide-react";
import { C, FONT, pop, tween } from "../theme";
import { Glow, Headline, Sub, DotGrid } from "../ui";

const ROWS = ["Live transcript", "Approvals & questions", "Plan mode", "Forks & worktrees", "Inbox", "Usage limits at a glance", "Threads from the CLI & IDE"];

export function Agents() {
  const f = useCurrentFrame();
  const colL = pop(f, 10, 16, 120);
  const colR = pop(f, 16, 16, 120);
  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: FONT }}>
      <DotGrid opacity={0.35} dy={f * 0.3} />
      <Glow x="28%" y="58%" opacity={0.16} size={1200} />
      <Glow x="72%" y="58%" color={C.claude} opacity={0.14} size={1200} />
      <AbsoluteFill style={{ background: "radial-gradient(ellipse at center, transparent 35%, #000 85%)" }} />
      <div style={{ position: "absolute", top: 70, width: "100%" }}>
        <Headline text="Two agents. *One* way of working." size={76} delay={2} />
      </div>

      <div style={{ position: "absolute", top: 240, left: 260, right: 260, display: "grid", gridTemplateColumns: "1fr 260px 260px", rowGap: 0 }}>
        <div />
        <Head label="Codex" sub="official app-server" color={C.accentStrong} soft={C.accentSoft} p={colL} icon={<Terminal size={30} color={C.accentStrong} />} />
        <Head label="Claude Code" sub="your own install" color="#f0a98c" soft="rgba(217,119,87,0.15)" p={colR} icon={<Sparkles size={30} color="#f0a98c" />} />
        {ROWS.map((r, i) => {
          const d = 34 + i * 9;
          const rowIn = tween(f, d, 12);
          return [
            <div key={r} style={{ fontSize: 30, fontWeight: 550, color: C.text, padding: "15px 0", borderTop: `1px solid ${C.line}`, opacity: rowIn, transform: `translateX(${(1 - rowIn) * -30}px)` }}>
              {r}
            </div>,
            <Tick key={r + "a"} p={pop(f, d + 4, 10, 220)} color={C.accent} />,
            <Tick key={r + "b"} p={pop(f, d + 7, 10, 220)} color={C.claude} />,
          ];
        })}
      </div>
      <div style={{ position: "absolute", bottom: 70, width: "100%" }}>
        <Sub delay={110} size={28}>
          Your login, your config, your MCP servers. Exactly as they behave in the terminal.
        </Sub>
      </div>
    </AbsoluteFill>
  );
}

function Head({ label, sub, color, soft, p, icon }: { label: string; sub: string; color: string; soft: string; p: number; icon: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, paddingBottom: 22, transform: `translateY(${(1 - p) * 40}px)`, opacity: Math.min(1, p * 1.4) }}>
      <div style={{ width: 70, height: 70, borderRadius: 20, background: soft, border: `1px solid ${color}55`, display: "grid", placeItems: "center" }}>{icon}</div>
      <div style={{ fontSize: 30, fontWeight: 700, color, letterSpacing: "-0.02em" }}>{label}</div>
      <div style={{ fontSize: 17, color: C.text3 }}>{sub}</div>
    </div>
  );
}

function Tick({ p, color }: { p: number; color: string }) {
  return (
    <div style={{ display: "grid", placeItems: "center", borderTop: `1px solid ${C.line}` }}>
      <div style={{ width: 40, height: 40, borderRadius: 99, background: `${color}26`, display: "grid", placeItems: "center", transform: `scale(${p})` }}>
        <Check size={23} color={color} strokeWidth={3} />
      </div>
    </div>
  );
}
