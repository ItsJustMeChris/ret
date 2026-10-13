import { useCurrentFrame } from "remotion";
import { C } from "./theme";

/**
 * Ret's antenna bot (build/icon-source.png), redrawn as vectors so it can blink and wiggle.
 * `look` shifts the pupils (-1..1), `blinkAt` lists local frames to blink on.
 */
export function Mascot({
  size = 400,
  color = C.navy,
  light = "#f7f8fb",
  look = { x: 0, y: 0 },
  blinkAt = [],
  wiggle = 1,
}: {
  size?: number;
  color?: string;
  light?: string;
  look?: { x: number; y: number };
  blinkAt?: number[];
  wiggle?: number;
}) {
  const f = useCurrentFrame();
  let lid = 1;
  for (const b of blinkAt) {
    const d = f - b;
    if (d >= 0 && d < 8) lid = Math.min(lid, Math.abs(d - 4) / 4);
  }
  lid = Math.max(lid, 0.08);
  const sway = Math.sin(f / 9) * 5 * wiggle;
  const sway2 = Math.sin(f / 9 + 1.3) * 5 * wiggle;
  const px = look.x * 26;
  const py = look.y * 22;

  return (
    <svg width={size} height={size} viewBox="0 0 1250 1250" style={{ overflow: "visible" }}>
      {/* antennae */}
      <g transform={`rotate(${-sway} 600 300)`}>
        <path d="M 395 150 C 470 170 550 215 605 300" stroke={color} strokeWidth={56} fill="none" strokeLinecap="round" />
        <circle cx={362} cy={138} r={80} fill={color} />
      </g>
      <g transform={`rotate(${sway2} 650 300)`}>
        <path d="M 855 150 C 780 170 700 215 645 300" stroke={color} strokeWidth={56} fill="none" strokeLinecap="round" />
        <circle cx={888} cy={138} r={80} fill={color} />
      </g>
      <rect x={570} y={262} width={110} height={50} rx={20} fill={color} />
      {/* body + feet */}
      <ellipse cx={627} cy={1030} rx={258} ry={138} fill={color} />
      <g transform="rotate(-40 425 1078)">
        <ellipse cx={425} cy={1078} rx={128} ry={142} fill={color} />
        <ellipse cx={415} cy={1080} rx={70} ry={100} fill={light} />
      </g>
      <g transform="rotate(40 828 1078)">
        <ellipse cx={828} cy={1078} rx={128} ry={142} fill={color} />
        <ellipse cx={838} cy={1080} rx={70} ry={100} fill={light} />
      </g>
      {/* head */}
      <rect x={170} y={290} width={914} height={628} rx={380} ry={300} fill={color} />
      <rect x={222} y={352} width={810} height={536} rx={300} ry={250} fill={light} />
      <rect x={290} y={444} width={674} height={378} rx={200} ry={175} fill={color} />
      {/* eyes */}
      {[
        { cx: 452, pcx: 482 },
        { cx: 802, pcx: 806 },
      ].map((e, i) => (
        <g key={i} transform={`translate(0 ${640 * (1 - lid)}) scale(1 ${lid})`}>
          <circle cx={e.cx} cy={640} r={97} fill={light} />
          <circle cx={e.pcx + px} cy={634 + py} r={64} fill={color} />
          <circle cx={e.pcx + 16 + px} cy={600 + py} r={24} fill={light} />
        </g>
      ))}
    </svg>
  );
}

/** The app icon: the bot on Ret's rounded light tile. */
export function AppIcon({ size = 300, ...rest }: { size?: number } & Parameters<typeof Mascot>[0]) {
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.235,
        background: "linear-gradient(180deg, #ffffff 0%, #eef0f6 100%)",
        display: "grid",
        placeItems: "center",
        boxShadow: `0 ${size * 0.08}px ${size * 0.25}px -${size * 0.05}px rgba(0,0,0,0.9), 0 0 0 1px rgba(255,255,255,0.4) inset`,
      }}
    >
      <Mascot size={size * 0.78} {...rest} />
    </div>
  );
}
