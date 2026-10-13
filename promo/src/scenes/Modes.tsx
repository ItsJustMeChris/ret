import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { AppWindow, Code2, Inbox, Rows3, ChevronRight, File, Folder } from "lucide-react";
import { C, FONT, MONO, STATE_COLOR, type State, pop, tween } from "../theme";
import { DotGrid, Glow, Headline, Kbd, Lines } from "../ui";

const MODES = [
  { k: "Focus", d: "Tabs and side-by-side splits", I: Rows3 },
  { k: "Canvas", d: "An infinite board of threads", I: AppWindow },
  { k: "Code", d: "Files, editor and a thread together", I: Code2 },
  { k: "Inbox", d: "Everything waiting on you", I: Inbox },
];
const START = 22;
const EACH = 34;

export function Modes() {
  const f = useCurrentFrame();
  const cur = Math.min(3, Math.floor(Math.max(0, f - START) / EACH));
  // Highlight slides between options.
  const pos = [1, 2, 3].reduce((a, i) => a + tween(f, START + i * EACH, 8), 0);
  const segW = 250;

  return (
    <AbsoluteFill style={{ background: C.bg, fontFamily: FONT }}>
      <Glow y="65%" opacity={0.16} size={1800} />
      <div style={{ position: "absolute", top: 64, width: "100%" }}>
        <Headline text="Four ways to see the *same work.*" size={72} delay={2} />
      </div>
      {/* the big segmented control */}
      <div style={{ position: "absolute", top: 190, left: (1920 - segW * 4 - 12) / 2, display: "flex", padding: 6, borderRadius: 18, background: C.bg2, border: `1px solid ${C.line2}`, opacity: tween(f, 4, 12) }}>
        <div style={{ position: "absolute", left: 6 + pos * segW, top: 6, width: segW, height: 62, borderRadius: 13, background: C.bg4, boxShadow: `0 0 0 1px ${C.line2}` }} />
        {MODES.map((m, i) => (
          <div key={m.k} style={{ position: "relative", width: segW, height: 62, display: "flex", alignItems: "center", justifyContent: "center", gap: 12, fontSize: 25, fontWeight: 600, color: i === cur && f >= START ? C.text : C.text3 }}>
            <m.I size={25} strokeWidth={1.9} />
            {m.k}
            <span style={{ opacity: 0.9 }}>
              <Kbd size={13} on={i === cur && f >= START && (f - START) % EACH < 8 ? 1 : 0}>Alt {i + 1}</Kbd>
            </span>
          </div>
        ))}
      </div>
      <div style={{ position: "absolute", top: 300, left: 310, width: 1300, height: 640 }}>
        {MODES.map((m, i) => {
          const s = START + i * EACH;
          const vis = i === 3 ? tween(f, s, 10) : Math.min(tween(f, s, 10), 1 - tween(f, s + EACH, 10));
          if (vis <= 0 && !(i === 0 && f < START)) return null;
          const o = i === 0 && f < START ? tween(f, 6, 14) : vis;
          return (
            <div key={m.k} style={{ position: "absolute", inset: 0, opacity: o, transform: `scale(${0.96 + o * 0.04}) translateY(${(1 - o) * 20}px)` }}>
              <Stage>{[<FocusArt key="f" />, <CanvasArt key="c" f={f - s} />, <CodeArt key="k" f={f - s} />, <InboxArt key="i" f={f - s} />][i]}</Stage>
              <div style={{ position: "absolute", bottom: -64, width: "100%", textAlign: "center", fontSize: 28, color: C.text2 }}>{m.d}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
}

function Stage({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ position: "absolute", inset: 0, borderRadius: 18, border: `1px solid ${C.line2}`, background: C.bg, overflow: "hidden", boxShadow: "0 50px 120px -30px rgba(0,0,0,1), 0 0 100px -20px rgba(139,156,255,0.2)" }}>{children}</div>
  );
}

function Mini({ x, y, w, h, st, p = 1 }: { x: number; y: number; w: number; h: number; st: State; p?: number }) {
  return (
    <div style={{ position: "absolute", left: x, top: y, width: w, height: h, borderRadius: 10, background: C.bg1, border: `1px solid ${C.line2}`, overflow: "hidden", transform: `scale(${p})`, opacity: Math.min(1, p * 1.5) }}>
      <div style={{ height: 28, background: C.bg2, borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", gap: 8, padding: "0 10px" }}>
        <span style={{ width: 8, height: 8, borderRadius: 9, background: STATE_COLOR[st] }} />
        <div style={{ width: w * 0.4, height: 7, borderRadius: 9, background: "rgba(255,255,255,0.25)" }} />
      </div>
      <div style={{ padding: 14 }}>
        <Lines widths={[60, 90, 75, 84, 40, 70].slice(0, Math.max(2, Math.floor(h / 40)))} h={7} gap={9} />
      </div>
    </div>
  );
}

function FocusArt() {
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div style={{ height: 44, display: "flex", alignItems: "flex-end", gap: 6, padding: "0 14px", borderBottom: `1px solid ${C.line}`, background: C.bg1 }}>
        {[1, 0, 0, 0].map((on, i) => (
          <div key={i} style={{ width: 200, height: 32, borderRadius: "8px 8px 0 0", background: on ? C.bg : "transparent", border: on ? `1px solid ${C.line}` : "none", display: "flex", alignItems: "center", gap: 8, padding: "0 12px" }}>
            <span style={{ width: 8, height: 8, borderRadius: 9, background: [C.green, C.amber, C.accent, C.green][i] }} />
            <div style={{ width: 120, height: 7, borderRadius: 9, background: on ? "rgba(255,255,255,0.3)" : "rgba(255,255,255,0.12)" }} />
          </div>
        ))}
      </div>
      <div style={{ position: "absolute", left: 300, right: 300, top: 90, display: "flex", flexDirection: "column", gap: 24 }}>
        <div style={{ alignSelf: "flex-end", width: 360, height: 44, borderRadius: 12, background: C.bg3 }} />
        <Lines widths={[95, 88, 92, 60]} h={10} gap={13} />
        <Lines widths={[30]} h={10} color="rgba(63,209,143,0.45)" />
        <Lines widths={[90, 80, 45]} h={10} gap={13} />
      </div>
      <div style={{ position: "absolute", left: 300, right: 300, bottom: 34, height: 86, borderRadius: 14, border: `1px solid ${C.line2}`, background: C.bg2 }} />
    </div>
  );
}

function CanvasArt({ f }: { f: number }) {
  const wins: [number, number, number, number, State][] = [
    [60, 50, 340, 230, "running"],
    [460, 30, 330, 200, "attention"],
    [850, 70, 380, 250, "running"],
    [90, 330, 320, 250, "unread"],
    [470, 290, 360, 280, "attention"],
    [880, 370, 340, 220, "running"],
  ];
  const z = 1 - Math.min(1, Math.max(0, f) / 40) * 0.06;
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <DotGrid gap={26} />
      <div style={{ position: "absolute", inset: 0, transform: `scale(${z})` }}>
        <svg style={{ position: "absolute", inset: 0 }} width={1300} height={640}>
          <path d="M 400 120 C 430 120, 430 110, 460 110" stroke={C.accent} strokeWidth={2} strokeDasharray="5 5" fill="none" />
        </svg>
        {wins.map(([x, y, w, h, st], i) => (
          <Mini key={i} x={x} y={y} w={w} h={h} st={st} p={pop(f, i * 2, 14, 170)} />
        ))}
      </div>
    </div>
  );
}

const CODE: [string, string][][] = [
  [["import", C.accentStrong], [" { rateLimit } ", C.text], ["from", C.accentStrong], [" \"./rateLimit\"", C.green]],
  [["", C.text]],
  [["export function", C.accentStrong], [" loginRoute", "#f0c674"], ["(app) {", C.text]],
  [["  app.", C.text], ["post", "#f0c674"], ["(\"/login\", ", C.text], ["rateLimit", "#f0c674"], ["({ max: ", C.text], ["5", C.amber], [" }), ", C.text]],
  [["    async ", C.accentStrong], ["(req, res) => {", C.text]],
  [["      const", C.accentStrong], [" user = ", C.text], ["await", C.accentStrong], [" verify(req.body)", C.text]],
  [["      if", C.accentStrong], [" (!user) ", C.text], ["return", C.accentStrong], [" res.status(", C.text], ["401", C.amber], [")", C.text]],
  [["      res.json(issueSession(user))", C.text]],
  [["    })", C.text]],
  [["}", C.text]],
];

function CodeArt({ f }: { f: number }) {
  const flash = Math.max(0, 1 - Math.max(0, f - 10) / 20);
  const files = [
    ["src", 0, true, ""],
    ["server", 1, true, ""],
    ["auth.ts", 2, false, "M"],
    ["rateLimit.ts", 2, false, "A"],
    ["routes.ts", 2, false, ""],
    ["store", 1, true, ""],
    ["test", 0, true, ""],
    ["package.json", 0, false, "M"],
  ] as const;
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex" }}>
      <div style={{ width: 250, borderRight: `1px solid ${C.line}`, background: C.bg1, padding: "16px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
        {files.map(([n, d, dir, m]) => (
          <div key={n} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 16, color: n === "auth.ts" ? C.text : C.text2, background: n === "auth.ts" ? C.bg3 : undefined, borderRadius: 6, padding: `3px 6px 3px ${6 + d * 16}px` }}>
            {dir ? <ChevronRight size={13} color={C.text3} /> : null}
            {dir ? <Folder size={15} color={C.text3} /> : <File size={15} color={C.text3} />}
            {n}
            <span style={{ flex: 1 }} />
            {m ? <span style={{ fontFamily: MONO, fontSize: 13, color: m === "A" ? C.green : C.amber }}>{m}</span> : null}
          </div>
        ))}
      </div>
      <div style={{ flex: 1, background: "#050505", display: "flex", flexDirection: "column" }}>
        <div style={{ height: 40, display: "flex", alignItems: "flex-end", gap: 2, padding: "0 10px", borderBottom: `1px solid ${C.line}` }}>
          {["auth.ts", "rateLimit.ts"].map((t, i) => (
            <div key={t} style={{ padding: "7px 16px", fontSize: 15, color: i === 0 ? C.text : C.text3, background: i === 0 ? "#050505" : "transparent", borderRadius: "7px 7px 0 0", border: i === 0 ? `1px solid ${C.line}` : "none", borderBottom: "none" }}>
              {t}
            </div>
          ))}
        </div>
        <div style={{ padding: "16px 0", fontFamily: MONO, fontSize: 17, lineHeight: 1.75 }}>
          {CODE.map((line, i) => (
            <div key={i} style={{ display: "flex", background: i === 3 ? `rgba(63,209,143,${0.06 + flash * 0.22})` : undefined }}>
              <span style={{ width: 52, textAlign: "right", paddingRight: 18, color: C.text3 }}>{i + 1}</span>
              <span style={{ whiteSpace: "pre" }}>
                {line.map(([t, c], k) => (
                  <span key={k} style={{ color: c }}>
                    {t}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ width: 330, borderLeft: `1px solid ${C.line}`, background: C.bg1, padding: 18, display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, fontWeight: 600, color: C.text }}>
          <span style={{ width: 8, height: 8, borderRadius: 9, background: C.green }} /> Rate-limit /login
        </div>
        <div style={{ alignSelf: "flex-end", width: 220, height: 38, borderRadius: 10, background: C.bg3 }} />
        <Lines widths={[90, 70, 85]} h={8} />
        <Lines widths={[60]} h={8} color="rgba(63,209,143,0.4)" />
        <Lines widths={[80, 55]} h={8} />
      </div>
    </div>
  );
}

function InboxArt({ f }: { f: number }) {
  const rows: State[] = ["attention", "attention", "unread", "unread", "unread", "running", "running", "error"];
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex" }}>
      <div style={{ width: 560, borderRight: `1px solid ${C.line}`, padding: "20px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
        {rows.map((st, i) => {
          const p = pop(f, i * 2, 16, 170);
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 14px", borderRadius: 10, background: i === 0 ? C.bg3 : "transparent", boxShadow: i === 0 ? `inset 3px 0 0 ${C.accent}` : undefined, opacity: p, transform: `translateX(${(1 - p) * -20}px)` }}>
              <span style={{ width: 10, height: 10, borderRadius: 9, background: STATE_COLOR[st] }} />
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ width: `${40 + ((i * 17) % 30)}%`, height: 9, borderRadius: 9, background: "rgba(255,255,255,0.32)" }} />
                <div style={{ width: `${60 + ((i * 23) % 30)}%`, height: 7, borderRadius: 9, background: "rgba(255,255,255,0.12)" }} />
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ flex: 1, padding: 36, display: "flex", flexDirection: "column", gap: 22 }}>
        <div style={{ width: 300, height: 14, borderRadius: 9, background: "rgba(255,255,255,0.35)" }} />
        <div style={{ alignSelf: "flex-end", width: 340, height: 44, borderRadius: 12, background: C.bg3 }} />
        <Lines widths={[90, 84, 60]} h={10} gap={13} />
        <div style={{ height: 120, borderRadius: 14, border: "1px solid rgba(139,156,255,0.4)", background: C.accentSoft }} />
      </div>
    </div>
  );
}
