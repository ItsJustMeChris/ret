import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import {
  AppWindow,
  Check,
  Code2,
  Command,
  FilePen,
  FileText,
  GitFork,
  Inbox,
  Maximize2,
  PanelLeft,
  Rows3,
  Search,
  SquareTerminal,
  X,
  ArrowUp,
} from "lucide-react";
import { C, FONT, MONO, STATE_COLOR, type State, tween, pop } from "./theme";

/* ---------------------------------------------------------------- backdrop */

/** Ret's dotted canvas, with a slow drift and a vignette. */
export function DotGrid({ gap = 34, opacity = 1, dx = 0, dy = 0, scale = 1 }: { gap?: number; opacity?: number; dx?: number; dy?: number; scale?: number }) {
  const g = gap * scale;
  return (
    <AbsoluteFill
      style={{
        opacity,
        backgroundImage: `radial-gradient(circle, rgba(255,255,255,0.11) ${1.3 * Math.max(scale, 0.6)}px, transparent ${1.6 * Math.max(scale, 0.6)}px)`,
        backgroundSize: `${g}px ${g}px`,
        backgroundPosition: `${dx}px ${dy}px`,
      }}
    />
  );
}

export function Glow({ x = "50%", y = "50%", color = C.accent, size = 1200, opacity = 0.18 }: { x?: string; y?: string; color?: string; size?: number; opacity?: number }) {
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: size,
        height: size,
        transform: "translate(-50%, -50%)",
        background: `radial-gradient(circle, ${color} 0%, transparent 62%)`,
        opacity,
        pointerEvents: "none",
      }}
    />
  );
}

export function Vignette() {
  return <AbsoluteFill style={{ background: "radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.6) 100%)", pointerEvents: "none" }} />;
}

/** Film grain-ish noise so big flat blacks don't band. */
export function Grain() {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ opacity: 0.05, mixBlendMode: "overlay", pointerEvents: "none" }}>
      <svg width="100%" height="100%">
        <filter id="n">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed={f % 12} />
        </filter>
        <rect width="100%" height="100%" filter="url(#n)" />
      </svg>
    </AbsoluteFill>
  );
}

/* ---------------------------------------------------------------- text */

/** Headline whose words rise in one by one. Wrap words in *stars* to tint them. */
export function Headline({
  text,
  delay = 0,
  size = 76,
  stagger = 3,
  align = "center",
  color = C.text,
  weight = 700,
  style,
}: {
  text: string;
  delay?: number;
  size?: number;
  stagger?: number;
  align?: "center" | "left";
  color?: string;
  weight?: number;
  style?: React.CSSProperties;
}) {
  const f = useCurrentFrame();
  const words = text.split(" ");
  return (
    <div
      style={{
        fontFamily: FONT,
        fontSize: size,
        fontWeight: weight,
        letterSpacing: "-0.035em",
        lineHeight: 1.08,
        color,
        textAlign: align,
        display: "flex",
        flexWrap: "wrap",
        justifyContent: align === "center" ? "center" : "flex-start",
        columnGap: size * 0.26,
        ...style,
      }}
    >
      {words.map((w, i) => {
        const tinted = w.startsWith("*");
        const clean = w.replace(/\*/g, "");
        const p = pop(f, delay + i * stagger, 18, 170);
        return (
          <span
            key={i}
            style={{
              display: "inline-block",
              transform: `translateY(${(1 - p) * size * 0.55}px)`,
              opacity: Math.min(1, p * 1.4),
              filter: `blur(${(1 - Math.min(1, p)) * 8}px)`,
              ...(tinted
                ? {
                    background: "linear-gradient(100deg, #b9c4ff 0%, #e4dbff 50%, #a9b6ff 100%)",
                    WebkitBackgroundClip: "text",
                    color: "transparent",
                  }
                : null),
            }}
          >
            {clean}
          </span>
        );
      })}
    </div>
  );
}

export function Sub({ children, delay = 0, size = 30, style }: { children: React.ReactNode; delay?: number; size?: number; style?: React.CSSProperties }) {
  const f = useCurrentFrame();
  const t = tween(f, delay, 18);
  return (
    <div
      style={{
        fontFamily: FONT,
        fontSize: size,
        fontWeight: 450,
        color: C.text2,
        letterSpacing: "-0.01em",
        textAlign: "center",
        opacity: t,
        transform: `translateY(${(1 - t) * 14}px)`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------- atoms */

export function Dot({ state, size = 10, phase = 0 }: { state: State; size?: number; phase?: number }) {
  const f = useCurrentFrame();
  const color = STATE_COLOR[state];
  const pinging = state === "running" || state === "attention";
  const t = ((f + phase) % 48) / 48;
  return (
    <span style={{ position: "relative", width: size, height: size, flex: "none", display: "inline-block" }}>
      <span style={{ position: "absolute", inset: 0, borderRadius: "50%", background: state === "idle" || state === "done" ? "transparent" : color, border: state === "idle" ? `1.5px solid ${C.text3}` : undefined }} />
      {pinging && (
        <span
          style={{
            position: "absolute",
            inset: -size * 0.45,
            borderRadius: "50%",
            border: `1.5px solid ${color}`,
            transform: `scale(${0.6 + t * 0.9})`,
            opacity: 1 - t,
          }}
        />
      )}
    </span>
  );
}

export function Kbd({ children, size = 15, on = 0 }: { children: React.ReactNode; size?: number; on?: number }) {
  return (
    <span
      style={{
        fontFamily: MONO,
        fontSize: size,
        padding: `${size * 0.15}px ${size * 0.45}px`,
        borderRadius: size * 0.35,
        border: `1px solid ${on ? C.accent : C.line2}`,
        borderBottomWidth: 3,
        background: on ? `rgba(139,156,255,${0.12 + on * 0.2})` : C.bg3,
        color: on ? C.text : C.text2,
        transform: `translateY(${on * 2}px)`,
        display: "inline-block",
        lineHeight: 1.3,
      }}
    >
      {children}
    </span>
  );
}

export function AgentBadge({ agent, size = 13 }: { agent: "codex" | "claude"; size?: number }) {
  const claude = agent === "claude";
  return (
    <span
      style={{
        fontFamily: FONT,
        fontSize: size,
        fontWeight: 600,
        padding: `${size * 0.12}px ${size * 0.5}px`,
        borderRadius: 999,
        color: claude ? "#f0a98c" : C.accentStrong,
        background: claude ? "rgba(217,119,87,0.14)" : C.accentSoft,
        whiteSpace: "nowrap",
      }}
    >
      {claude ? "Claude Code" : "Codex"}
    </span>
  );
}

/** A grey "text line" placeholder for transcript body copy. */
export function Lines({ widths, h = 9, gap = 9, color = "rgba(255,255,255,0.13)", reveal = 1 }: { widths: number[]; h?: number; gap?: number; color?: string; reveal?: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap }}>
      {widths.map((w, i) => {
        const r = Math.max(0, Math.min(1, reveal * widths.length - i));
        return <div key={i} style={{ height: h, width: `${w * r}%`, borderRadius: h, background: color }} />;
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- transcript pieces */

export function UserMsg({ children, s = 1 }: { children: React.ReactNode; s?: number }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end" }}>
      <div
        style={{
          maxWidth: "82%",
          background: C.bg3,
          border: `1px solid ${C.line}`,
          borderRadius: 14 * s,
          padding: `${9 * s}px ${14 * s}px`,
          fontSize: 15 * s,
          color: C.text,
          lineHeight: 1.45,
        }}
      >
        {children}
      </div>
    </div>
  );
}

export function AgentText({ children, s = 1 }: { children: React.ReactNode; s?: number }) {
  return <div style={{ fontSize: 15 * s, color: C.text, lineHeight: 1.55 }}>{children}</div>;
}

export function Step({ icon = "run", children, ok = true, s = 1, extra }: { icon?: "run" | "edit" | "read"; children: React.ReactNode; ok?: boolean; s?: number; extra?: React.ReactNode }) {
  const I = icon === "edit" ? FilePen : icon === "read" ? FileText : SquareTerminal;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 * s, fontSize: 13.5 * s, color: C.text2 }}>
      <I size={15 * s} color={C.text3} strokeWidth={1.8} />
      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{children}</span>
      {extra}
      {ok && <Check size={14 * s} color={C.green} strokeWidth={2.4} />}
    </div>
  );
}

export function Code({ children, s = 1 }: { children: React.ReactNode; s?: number }) {
  return (
    <span style={{ fontFamily: MONO, fontSize: "0.88em", padding: `${1 * s}px ${5 * s}px`, borderRadius: 5 * s, background: C.bg3, color: C.text }}>{children}</span>
  );
}

export function Diff({ add, del, s = 1 }: { add: number; del?: number; s?: number }) {
  return (
    <span style={{ fontFamily: MONO, fontSize: 12.5 * s, display: "inline-flex", gap: 6 * s }}>
      <span style={{ color: C.green }}>+{add}</span>
      {del ? <span style={{ color: C.red }}>−{del}</span> : null}
    </span>
  );
}

export function Composer({ s = 1, text, placeholder = "Ask for follow-up changes", focus = false, caret = false }: { s?: number; text?: string; placeholder?: string; focus?: boolean; caret?: boolean }) {
  const f = useCurrentFrame();
  return (
    <div
      style={{
        border: `1px solid ${focus ? "rgba(139,156,255,0.5)" : C.line2}`,
        background: C.bg2,
        borderRadius: 14 * s,
        padding: `${11 * s}px ${12 * s}px ${10 * s}px ${14 * s}px`,
        display: "flex",
        flexDirection: "column",
        gap: 10 * s,
        boxShadow: focus ? `0 0 0 ${4 * s}px rgba(139,156,255,0.08)` : undefined,
      }}
    >
      <div style={{ fontSize: 15 * s, color: text ? C.text : C.text3, minHeight: 20 * s }}>
        {text || placeholder}
        {caret && <span style={{ display: "inline-block", width: 2 * s, height: 17 * s, background: C.accent, marginLeft: 1, verticalAlign: "-3px", opacity: Math.floor(f / 15) % 2 ? 0 : 1 }} />}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 * s, fontSize: 12.5 * s, color: C.text3 }}>
        <span style={{ padding: `${2 * s}px ${8 * s}px`, borderRadius: 7 * s, border: `1px solid ${C.line}` }}>Plan</span>
        <span>Auto</span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            width: 28 * s,
            height: 28 * s,
            borderRadius: 9 * s,
            background: text ? C.text : C.bg4,
            display: "grid",
            placeItems: "center",
          }}
        >
          <ArrowUp size={16 * s} color={text ? "#000" : C.text3} strokeWidth={2.4} />
        </span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- windows */

/** A thread window as it looks on Ret's canvas. */
export function ThreadWindow({
  title,
  project,
  state,
  agent = "codex",
  width,
  height,
  s = 1,
  children,
  forked,
  selected,
  style,
}: {
  title: string;
  project: string;
  state: State;
  agent?: "codex" | "claude";
  width: number;
  height: number;
  s?: number;
  children?: React.ReactNode;
  forked?: boolean;
  selected?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        width,
        height,
        borderRadius: 12 * s,
        background: C.bg1,
        border: `1px solid ${selected ? "rgba(139,156,255,0.55)" : C.line2}`,
        boxShadow: `0 ${30 * s}px ${70 * s}px -${20 * s}px rgba(0,0,0,1), 0 ${8 * s}px ${20 * s}px rgba(0,0,0,0.6)${selected ? `, 0 0 0 ${3 * s}px rgba(139,156,255,0.15)` : ""}`,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        fontFamily: FONT,
        ...style,
      }}
    >
      <div
        style={{
          height: 40 * s,
          flex: "none",
          display: "flex",
          alignItems: "center",
          gap: 9 * s,
          padding: `0 ${12 * s}px`,
          borderBottom: `1px solid ${C.line}`,
          background: C.bg2,
        }}
      >
        <Dot state={state} size={9 * s} phase={title.length * 7} />
        {forked && <GitFork size={14 * s} color={C.accent} strokeWidth={2} />}
        <span style={{ fontSize: 14.5 * s, fontWeight: 600, color: C.text, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{title}</span>
        <span style={{ fontSize: 12.5 * s, color: C.text3, whiteSpace: "nowrap" }}>{project}</span>
        <span style={{ flex: 1 }} />
        <AgentBadge agent={agent} size={11 * s} />
        <Maximize2 size={13 * s} color={C.text3} />
        <X size={14 * s} color={C.text3} />
      </div>
      <div style={{ flex: 1, padding: `${14 * s}px ${16 * s}px`, display: "flex", flexDirection: "column", gap: 12 * s, overflow: "hidden", position: "relative" }}>
        {children}
      </div>
    </div>
  );
}

export type Mode = "focus" | "canvas" | "code" | "inbox";

/** The whole Ret window: title bar + content. */
export function AppFrame({
  mode,
  width,
  height,
  children,
  need = 2,
  working = 3,
  s = 1,
  style,
}: {
  mode: Mode;
  width: number;
  height: number;
  children?: React.ReactNode;
  need?: number;
  working?: number;
  s?: number;
  style?: React.CSSProperties;
}) {
  const modes: [Mode, string, React.ComponentType<{ size?: number; color?: string; strokeWidth?: number }>][] = [
    ["focus", "Focus", Rows3],
    ["canvas", "Canvas", AppWindow],
    ["code", "Code", Code2],
    ["inbox", "Inbox", Inbox],
  ];
  return (
    <div
      style={{
        width,
        height,
        borderRadius: 16 * s,
        background: C.bg,
        border: `1px solid ${C.line2}`,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        fontFamily: FONT,
        boxShadow: `0 60px 140px -30px rgba(0,0,0,1), 0 0 0 1px rgba(255,255,255,0.04), 0 0 120px -20px rgba(139,156,255,0.18)`,
        ...style,
      }}
    >
      <div style={{ height: 50 * s, flex: "none", display: "flex", alignItems: "center", gap: 14 * s, padding: `0 ${16 * s}px`, borderBottom: `1px solid ${C.line}`, background: C.bg1 }}>
        <PanelLeft size={18 * s} color={C.text2} strokeWidth={1.8} />
        <span style={{ fontWeight: 700, fontSize: 17 * s, letterSpacing: "-0.02em", color: C.text }}>ret</span>
        <div style={{ display: "flex", gap: 2 * s, padding: 3 * s, borderRadius: 9 * s, background: C.bg2, border: `1px solid ${C.line}` }}>
          {modes.map(([m, label, I]) => (
            <span
              key={m}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6 * s,
                padding: `${4 * s}px ${11 * s}px`,
                borderRadius: 7 * s,
                fontSize: 13.5 * s,
                fontWeight: 500,
                color: mode === m ? C.text : C.text3,
                background: mode === m ? C.bg4 : "transparent",
              }}
            >
              <I size={14 * s} strokeWidth={1.9} />
              {label}
              {m === "inbox" && need > 0 && (
                <span style={{ fontSize: 11 * s, fontWeight: 700, color: "#000", background: C.amber, borderRadius: 99, padding: `0 ${6 * s}px`, lineHeight: `${17 * s}px` }}>{need}</span>
              )}
            </span>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8 * s,
            width: 380 * s,
            height: 32 * s,
            padding: `0 ${12 * s}px`,
            borderRadius: 9 * s,
            background: C.bg2,
            border: `1px solid ${C.line}`,
            color: C.text3,
            fontSize: 13.5 * s,
          }}
        >
          <Search size={14 * s} />
          Search threads, files, commands
          <span style={{ flex: 1 }} />
          <Command size={12 * s} />K
        </div>
        <span style={{ flex: 1 }} />
        {need > 0 && <Pill color={C.amber} soft={C.amberSoft} s={s}>{need} need you</Pill>}
        {working > 0 && <Pill color={C.green} soft={C.greenSoft} s={s}>{working} working</Pill>}
      </div>
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>{children}</div>
    </div>
  );
}

export function Pill({ children, color, soft, s = 1 }: { children: React.ReactNode; color: string; soft: string; s?: number }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 7 * s, fontSize: 13 * s, fontWeight: 600, color, background: soft, padding: `${4 * s}px ${11 * s}px`, borderRadius: 99 }}>
      <span style={{ width: 7 * s, height: 7 * s, borderRadius: 9, background: color }} />
      {children}
    </span>
  );
}

/* ---------------------------------------------------------------- cursor */

export function Cursor({ path, clicks = [] }: { path: { f: number; x: number; y: number }[]; clicks?: number[] }) {
  const f = useCurrentFrame();
  const fs = path.map((p) => p.f);
  const x = interpolate(f, fs, path.map((p) => p.x), { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: (t) => 1 - Math.pow(1 - t, 3) });
  const y = interpolate(f, fs, path.map((p) => p.y), { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: (t) => 1 - Math.pow(1 - t, 3) });
  const appear = tween(f, path[0].f - 6, 8);
  let press = 0;
  let ring = -1;
  for (const c of clicks) {
    const d = f - c;
    if (d >= 0 && d < 8) press = Math.max(press, 1 - Math.abs(d - 3) / 4);
    if (d >= 0 && d < 20) ring = d / 20;
  }
  return (
    <div style={{ position: "absolute", left: x, top: y, opacity: appear, pointerEvents: "none", zIndex: 50 }}>
      {ring >= 0 && (
        <div
          style={{
            position: "absolute",
            left: -26,
            top: -26,
            width: 52,
            height: 52,
            borderRadius: "50%",
            border: `2px solid ${C.accent}`,
            transform: `scale(${0.3 + ring})`,
            opacity: 1 - ring,
          }}
        />
      )}
      <svg width={30} height={30} viewBox="0 0 24 24" style={{ transform: `scale(${1 - press * 0.15})`, transformOrigin: "0 0", filter: "drop-shadow(0 3px 6px rgba(0,0,0,0.6))" }}>
        <path d="M3 2 L3 19 L7.5 14.8 L10.5 21.5 L13.4 20.2 L10.5 13.7 L16.8 13.7 Z" fill="#fff" stroke="#000" strokeWidth={1.3} strokeLinejoin="round" />
      </svg>
    </div>
  );
}

/** Fades a scene in and out over its own span. */
export function SceneFade({ dur, children, inFrames = 12, outFrames = 12 }: { dur: number; children: React.ReactNode; inFrames?: number; outFrames?: number }) {
  const f = useCurrentFrame();
  const o = Math.min(tween(f, 0, inFrames), 1 - tween(f, dur - outFrames, outFrames));
  return <AbsoluteFill style={{ opacity: o }}>{children}</AbsoluteFill>;
}
