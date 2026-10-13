import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { GitFork } from "lucide-react";
import { C, FONT, STATE_COLOR, type State, pop, tween, ease } from "../theme";
import { AgentText, AppFrame, Code, Diff, DotGrid, Glow, Headline, Lines, Step, ThreadWindow, UserMsg } from "../ui";

type Win = {
  id: string;
  title: string;
  project: string;
  state: State;
  agent: "codex" | "claude";
  x: number;
  y: number;
  w: number;
  h: number;
  born: number;
  forked?: boolean;
  body: React.ReactNode;
};

const WINS: Win[] = [
  {
    id: "a",
    title: "Rate-limit the login endpoint",
    project: "api",
    state: "running",
    agent: "codex",
    x: 40,
    y: 40,
    w: 470,
    h: 330,
    born: 6,
    body: (
      <>
        <UserMsg>Add rate limiting to /login and keep the tests green.</UserMsg>
        <Step icon="read">Read src/server/auth.ts</Step>
        <Step icon="edit" extra={<Diff add={48} />}>Edited rateLimit.ts</Step>
        <AgentText>
          Adding a token bucket in middleware, keyed by IP + username…
        </AgentText>
        <Lines widths={[92, 70]} />
      </>
    ),
  },
  {
    id: "b",
    title: "Try a Redis store",
    project: "api · worktree",
    state: "attention",
    agent: "codex",
    forked: true,
    x: 590,
    y: 30,
    w: 450,
    h: 300,
    born: 74,
    body: (
      <>
        <UserMsg>Same idea, but back it with Redis.</UserMsg>
        <Step icon="edit" extra={<Diff add={31} del={6} />}>Edited store/redis.ts</Step>
        <div style={{ border: `1px solid rgba(242,179,61,0.45)`, background: C.amberSoft, borderRadius: 10, padding: "10px 12px", fontSize: 14, color: C.text }}>
          Run <Code>docker compose up redis</Code>?
          <div style={{ display: "flex", gap: 8, marginTop: 9 }}>
            <span style={{ background: C.text, color: "#000", fontWeight: 600, borderRadius: 7, padding: "3px 10px", fontSize: 12.5 }}>Allow</span>
            <span style={{ border: `1px solid ${C.line2}`, borderRadius: 7, padding: "3px 10px", fontSize: 12.5, color: C.text2 }}>Decline</span>
          </div>
        </div>
      </>
    ),
  },
  {
    id: "c",
    title: "Migrate to Vite 8",
    project: "web",
    state: "running",
    agent: "claude",
    x: 1120,
    y: 60,
    w: 470,
    h: 340,
    born: 16,
    body: (
      <>
        <UserMsg>Move us off webpack.</UserMsg>
        <Step>Ran rg webpack -l</Step>
        <Step icon="edit" extra={<Diff add={64} del={212} />}>Edited vite.config.ts</Step>
        <Step icon="edit" extra={<Diff add={3} del={9} />}>Edited package.json</Step>
        <AgentText>Build passes. Checking the dev server for HMR…</AgentText>
        <Lines widths={[80]} />
      </>
    ),
  },
  {
    id: "d",
    title: "Release notes for 2.4",
    project: "docs",
    state: "unread",
    agent: "claude",
    x: 70,
    y: 420,
    w: 430,
    h: 290,
    born: 24,
    body: (
      <>
        <UserMsg>Draft notes from the merged PRs.</UserMsg>
        <AgentText>Here's the draft, grouped by area:</AgentText>
        <Lines widths={[40, 88, 76, 82, 50]} />
      </>
    ),
  },
  {
    id: "e",
    title: "Passkey sign-in",
    project: "auth",
    state: "attention",
    agent: "codex",
    x: 580,
    y: 390,
    w: 470,
    h: 320,
    born: 32,
    body: (
      <>
        <UserMsg>Add passkeys as a sign-in option.</UserMsg>
        <Step icon="read">Read docs/webauthn.md</Step>
        <div style={{ border: `1px solid rgba(139,156,255,0.4)`, background: C.accentSoft, borderRadius: 10, padding: "10px 12px", fontSize: 14, color: C.text }}>
          Should passkeys replace passwords, or sit beside them?
          <div style={{ display: "flex", flexDirection: "column", gap: 5, marginTop: 8, fontSize: 13, color: C.text2 }}>
            <span>1 · Beside passwords</span>
            <span>2 · Replace them</span>
          </div>
        </div>
      </>
    ),
  },
  {
    id: "f",
    title: "Fix N+1 on /orders",
    project: "api",
    state: "running",
    agent: "claude",
    x: 1130,
    y: 450,
    w: 450,
    h: 260,
    born: 40,
    body: (
      <>
        <UserMsg>Orders page does 300 queries. Fix it.</UserMsg>
        <Step icon="edit" extra={<Diff add={12} del={30} />}>Edited orders/repo.ts</Step>
        <Step>Ran npm test -- orders</Step>
        <Lines widths={[86, 60]} />
      </>
    ),
  },
];

export function CanvasScene() {
  const f = useCurrentFrame();
  const enter = pop(f, 0, 22, 90);
  // Camera: start close on the first thread, pull back to show the board, then drift.
  const z = interpolate(f, [0, 60, 300], [1.45, 0.94, 0.88], { extrapolateRight: "clamp", easing: ease });
  const camX = interpolate(f, [0, 60, 300], [380, 0, -30], { extrapolateRight: "clamp", easing: ease });
  const camY = interpolate(f, [0, 60, 300], [180, 0, -10], { extrapolateRight: "clamp", easing: ease });
  const link = tween(f, 82, 22);
  const headlineSwap = f >= 150;

  const A = WINS[0];
  const B = WINS[1];
  const p1 = { x: A.x + A.w, y: A.y + 120 };
  const p2 = { x: B.x, y: B.y + 120 };
  const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };

  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <Glow y="70%" opacity={0.16} size={2000} />
      <div style={{ position: "absolute", top: 58, width: "100%" }}>
        <AbsoluteFill style={{ position: "relative", height: 100, opacity: headlineSwap ? 1 - tween(f, 150, 8) : 1 }}>
          <Headline text="Spread every thread out on a *canvas.*" size={68} delay={4} />
        </AbsoluteFill>
        {f >= 154 && (
          <div style={{ position: "absolute", top: 0, width: "100%" }}>
            <Headline text="Know what's *working* — and what's *waiting* on you." size={68} delay={156} stagger={2} />
          </div>
        )}
      </div>
      <div
        style={{
          position: "absolute",
          left: 140,
          top: 200,
          perspective: 2400,
        }}
      >
        <div
          style={{
            transform: `translateY(${(1 - enter) * 500}px) rotateX(${(1 - enter) * 28}deg) scale(${0.9 + enter * 0.1})`,
            transformOrigin: "50% 0%",
          }}
        >
          <AppFrame mode="canvas" width={1640} height={830} need={2} working={3}>
            <AbsoluteFill style={{ background: C.bg }}>
              <DotGrid gap={30 * z} dx={camX * z} dy={camY * z} />
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  transformOrigin: "0 0",
                  transform: `translate(${820 - 820 * z - camX * z}px, ${390 - 390 * z - camY * z}px) scale(${z})`,
                }}
              >
                {/* fork link */}
                <svg style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }} width={1} height={1}>
                  <path
                    d={`M ${p1.x} ${p1.y} C ${p1.x + 50} ${p1.y}, ${p2.x - 50} ${p2.y}, ${p2.x} ${p2.y}`}
                    stroke={C.accent}
                    strokeWidth={2}
                    fill="none"
                    strokeDasharray="6 6"
                    pathLength={1}
                    style={{ strokeDasharray: `${link} 1`, opacity: 0.8 }}
                  />
                </svg>
                <div
                  style={{
                    position: "absolute",
                    left: mid.x - 15,
                    top: mid.y - 15,
                    width: 30,
                    height: 30,
                    borderRadius: 99,
                    background: C.bg2,
                    border: `1.5px solid ${C.accent}`,
                    display: "grid",
                    placeItems: "center",
                    transform: `scale(${pop(f, 96, 10, 200)})`,
                    zIndex: 3,
                  }}
                >
                  <GitFork size={15} color={C.accent} />
                </div>
                {WINS.map((w) => {
                  const p = pop(w.id === "b" ? f : f, w.born, 15, 150);
                  // The fork slides out of its parent.
                  const fromX = w.id === "b" ? A.x - w.x : 0;
                  return (
                    <div
                      key={w.id}
                      style={{
                        position: "absolute",
                        left: w.x,
                        top: w.y,
                        transform: w.id === "b" ? `translateX(${(1 - p) * fromX}px) scale(${0.85 + 0.15 * p})` : `translateY(${(1 - p) * 40}px) scale(${0.9 + 0.1 * p})`,
                        opacity: Math.min(1, p * 1.5),
                        zIndex: w.id === "b" ? 2 : 1,
                      }}
                    >
                      <ThreadWindow title={w.title} project={w.project} state={w.state} agent={w.agent} width={w.w} height={w.h} forked={w.forked} selected={f > 160 && w.state === "attention"}>
                        {w.body}
                      </ThreadWindow>
                    </div>
                  );
                })}
              </div>
              {/* beacon pointing at an off-screen thread that needs you */}
              <Beacon f={f} />
              <Minimap f={f} />
            </AbsoluteFill>
          </AppFrame>
        </div>
      </div>
    </AbsoluteFill>
  );
}

function Beacon({ f }: { f: number }) {
  const p = pop(f, 170, 12, 160);
  const t = ((f - 170) % 40) / 40;
  return (
    <div
      style={{
        position: "absolute",
        left: 700,
        bottom: 16,
        transform: `scale(${p})`,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 12px 7px 10px",
        borderRadius: 99,
        background: "rgba(18,18,18,0.92)",
        border: `1px solid rgba(242,179,61,0.5)`,
        color: C.text,
        fontFamily: FONT,
        fontSize: 13.5,
        fontWeight: 500,
        boxShadow: `0 0 0 ${t * 14}px rgba(242,179,61,${0.25 * (1 - t)})`,
      }}
    >
      <span style={{ width: 8, height: 8, borderRadius: 9, background: C.amber }} />
      Deploy preview · needs you
      <span style={{ color: C.amber, fontSize: 16 }}>↓</span>
    </div>
  );
}

function Minimap({ f }: { f: number }) {
  const o = tween(f, 60, 15);
  const sc = 0.105;
  return (
    <div
      style={{
        position: "absolute",
        right: 18,
        bottom: 18,
        width: 210,
        height: 110,
        borderRadius: 10,
        background: "rgba(10,10,10,0.9)",
        border: `1px solid ${C.line2}`,
        opacity: o,
        overflow: "hidden",
      }}
    >
      <div style={{ position: "absolute", left: 10, top: 12 }}>
        {WINS.map((w) => (
          <div
            key={w.id}
            style={{
              position: "absolute",
              left: w.x * sc,
              top: w.y * sc,
              width: w.w * sc,
              height: w.h * sc,
              borderRadius: 2,
              background: w.state === "attention" ? "rgba(242,179,61,0.5)" : "rgba(255,255,255,0.18)",
              borderTop: `2px solid ${STATE_COLOR[w.state]}`,
            }}
          />
        ))}
        <div style={{ position: "absolute", left: 700 * sc, top: 880 * sc, width: 30, height: 20, borderRadius: 2, background: "rgba(242,179,61,0.6)" }} />
      </div>
      <div style={{ position: "absolute", left: 6, top: 6, width: 176, height: 92, border: `1.5px solid ${C.accent}`, borderRadius: 4, opacity: 0.6 }} />
    </div>
  );
}
