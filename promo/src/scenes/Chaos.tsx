import { AbsoluteFill, interpolate, random, useCurrentFrame } from "remotion";
import { C, FONT, MONO, tween, pop } from "../theme";
import { Headline, Glow } from "../ui";

// Things agents print while you're not looking.
const LOG = [
  "$ codex exec \"fix flaky auth test\"",
  "› reading src/server/auth.ts",
  "› running npm test -- auth",
  "  ✓ 41 passing  ✗ 1 failing",
  "› editing src/server/session.ts",
  "Allow command? git push --force [y/N]",
  "$ claude \"migrate to vite 8\"",
  "› searching for webpack.config",
  "› writing vite.config.ts",
  "? Which package manager do you use?",
  "› tsc --noEmit",
  "error TS2339: Property 'id' does not exist",
  "› retrying with narrowed type",
  "Waiting for approval…",
  "› patching README.md",
  "✓ done in 4m 12s",
];
const NAMES = ["api — fix flaky test", "web — vite 8", "docs — changelog", "infra — terraform plan", "mobile — dark mode", "api — rate limiting", "web — a11y audit", "cli — release notes", "billing — webhooks", "search — reindex", "web — bundle size", "api — n+1 queries", "auth — passkeys", "ml — eval harness"];

function Term({ i, born, f }: { i: number; born: number; f: number }) {
  const w = 430 + random(`w${i}`) * 160;
  const h = 250 + random(`h${i}`) * 110;
  const col = (i * 7) % 5;
  const row = (i * 2) % 3;
  const x = 20 + col * 370 + (random(`x${i}`) - 0.5) * 140 + (row % 2) * 90;
  const y = 40 + row * 330 + (random(`y${i}`) - 0.5) * 120;
  const p = pop(f, born, 13, 180);
  const age = Math.max(0, f - born);
  const start = Math.floor(random(`s${i}`) * LOG.length);
  const shown = Math.min(9, Math.floor(age / 4) + 1);
  const rot = (random(`r${i}`) - 0.5) * 6;
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: w,
        height: h,
        background: "rgba(10,10,10,0.96)",
        border: `1px solid ${C.line2}`,
        borderRadius: 10,
        boxShadow: "0 30px 60px -10px rgba(0,0,0,0.9)",
        transform: `scale(${p}) rotate(${rot * (1 - p * 0.6)}deg)`,
        opacity: Math.min(1, p * 2),
        overflow: "hidden",
        fontFamily: MONO,
      }}
    >
      <div style={{ height: 30, display: "flex", alignItems: "center", gap: 7, padding: "0 12px", background: "#151515", borderBottom: `1px solid ${C.line}` }}>
        {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
          <span key={c} style={{ width: 10, height: 10, borderRadius: 9, background: c, opacity: 0.85 }} />
        ))}
        <span style={{ marginLeft: 8, fontSize: 12, color: C.text3, fontFamily: FONT }}>{NAMES[i % NAMES.length]}</span>
      </div>
      <div style={{ padding: "10px 14px", fontSize: 13, lineHeight: 1.7, display: "flex", flexDirection: "column", justifyContent: "flex-end", height: h - 30 }}>
        {Array.from({ length: shown }, (_, k) => {
          const line = LOG[(start + k) % LOG.length];
          const warn = line.includes("Allow") || line.includes("?") || line.includes("Waiting");
          const err = line.startsWith("error") || line.includes("✗");
          return (
            <div key={k} style={{ color: warn ? C.amber : err ? C.red : line.startsWith("$") ? C.text : C.text2, whiteSpace: "nowrap" }}>
              {line}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Chaos() {
  const f = useCurrentFrame();
  const count = 14;
  // Terminals pile up faster and faster.
  const births = Array.from({ length: count }, (_, i) => 40 + Math.round(Math.pow(i / count, 0.75) * 70));
  // Then everything gets pulled into the middle.
  const suck = tween(f, 128, 22);
  const shake = f > 70 && f < 128 ? (random(`sh${f}`) - 0.5) * interpolate(f, [70, 125], [0, 10], { extrapolateRight: "clamp" }) : 0;

  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <Glow color={C.red} opacity={interpolate(f, [60, 125], [0, 0.12], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) * (1 - suck)} size={1800} />
      <AbsoluteFill
        style={{
          transform: `translate(${shake}px, ${shake * 0.6}px) scale(${1 - suck * 0.97}) rotate(${suck * 25}deg)`,
          opacity: 1 - tween(f, 140, 10),
          filter: `blur(${suck * 6}px)`,
        }}
      >
        {births.map((b, i) => (
          <Term key={i} i={i} born={b} f={f} />
        ))}
      </AbsoluteFill>

      {/* Line 1 */}
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity: 1 - tween(f, 36, 8) }}>
        <Headline text="One agent is easy." size={110} />
      </AbsoluteFill>
      {/* Line 2, over the pile */}
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity: 1 - tween(f, 124, 8) }}>
        {f >= 82 && (
          <div style={{ padding: "26px 54px", borderRadius: 28, background: "rgba(0,0,0,0.78)", backdropFilter: "blur(14px)", boxShadow: "0 0 120px 60px rgba(0,0,0,0.75)" }}>
            <Headline text="Ten is chaos." size={130} delay={82} weight={800} />
          </div>
        )}
      </AbsoluteFill>
      {/* the flash as it collapses */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(circle at 50% 50%, rgba(163,176,255,${tween(f, 140, 6) * (1 - tween(f, 146, 10))}) 0%, transparent 40%)`,
        }}
      />
    </AbsoluteFill>
  );
}
