import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { MessageCircleQuestion, SquareTerminal, X } from "lucide-react";
import { C, FONT, MONO, pop, tween } from "../theme";
import { AgentText, AppFrame, Composer, Cursor, Diff, Dot, Glow, Headline, Kbd, Step, UserMsg } from "../ui";

const S = 1.32;

function Typed({ text, start, f, cps = 1.6 }: { text: string; start: number; f: number; cps?: number }) {
  const n = Math.max(0, Math.floor((f - start) * cps));
  if (n <= 0) return null;
  return <AgentText s={S}>{text.slice(0, n)}</AgentText>;
}

function Tabs() {
  const tabs = [
    { t: "Rate-limit the login endpoint", st: "attention" as const, on: true },
    { t: "Passkey sign-in", st: "attention" as const },
    { t: "Migrate to Vite 8", st: "running" as const },
    { t: "Fix N+1 on /orders", st: "running" as const },
  ];
  return (
    <div style={{ height: 46, display: "flex", alignItems: "flex-end", gap: 4, padding: "0 14px", borderBottom: `1px solid ${C.line}`, background: C.bg1 }}>
      {tabs.map((t) => (
        <div
          key={t.t}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 9,
            height: 36,
            padding: "0 14px",
            borderRadius: "9px 9px 0 0",
            background: t.on ? C.bg : "transparent",
            border: t.on ? `1px solid ${C.line}` : "1px solid transparent",
            borderBottom: "none",
            fontSize: 14,
            color: t.on ? C.text : C.text3,
            fontWeight: 500,
          }}
        >
          <Dot state={t.st} size={8} />
          {t.t}
          <X size={13} color={C.text3} />
        </div>
      ))}
    </div>
  );
}

export function Approve() {
  const f = useCurrentFrame();
  const enter = pop(f, 0, 22, 110);
  const card = pop(f, 56, 14, 170);
  const approved = f >= 96;
  const collapse = tween(f, 96, 10);
  const dock = pop(f, 128, 15, 170);
  const picked = f >= 168;
  const dockGone = tween(f, 180, 10);
  const swap = f >= 116;

  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <Glow y="80%" opacity={0.14} size={2000} />
      <div style={{ position: "absolute", top: 58, width: "100%", height: 100 }}>
        <div style={{ position: "absolute", width: "100%", opacity: 1 - tween(f, 112, 8) }}>
          <Headline text="Approvals come to *you.*" size={68} delay={4} />
        </div>
        {swap && (
          <div style={{ position: "absolute", width: "100%" }}>
            <Headline text="Questions too. Answer with *one key.*" size={68} delay={118} stagger={2} />
          </div>
        )}
      </div>

      <div style={{ position: "absolute", left: 140, top: 200, transform: `translateY(${(1 - enter) * 120}px) scale(${0.96 + enter * 0.04})`, opacity: enter }}>
        <AppFrame mode="focus" width={1640} height={830} need={approved ? 1 : 2} working={2}>
          <Tabs />
          <div style={{ position: "absolute", left: 330, top: 46, width: 980, height: 734, fontFamily: FONT }}>
            <div style={{ position: "absolute", top: 34, left: 0, right: 0 }}>
              <UserMsg s={S}>Add rate limiting to the login endpoint, and make sure the tests still pass.</UserMsg>
            </div>
            <div style={{ position: "absolute", top: 124, left: 0, right: 0, display: "flex", flexDirection: "column", gap: 14 }}>
              <Step s={S} icon="read">Read src/server/auth.ts</Step>
              <Step s={S} icon="edit" extra={<Diff s={S} add={48} />}>Edited src/server/rateLimit.ts</Step>
            </div>
            <div style={{ position: "absolute", top: 222, left: 0, right: 0 }}>
              <AgentText s={S}>The limiter is in. Running the auth tests to make sure nothing broke.</AgentText>
            </div>

            {/* approval card → collapses into a finished step */}
            <div style={{ position: "absolute", top: 296, left: 0, right: 0 }}>
              {!approved || collapse < 1 ? (
                <div
                  style={{
                    transform: `scale(${(0.92 + card * 0.08) * (1 - collapse * 0.08)})`,
                    transformOrigin: "50% 0",
                    opacity: Math.min(1, card * 1.5) * (1 - collapse),
                    border: `1px solid rgba(242,179,61,0.45)`,
                    background: "linear-gradient(180deg, rgba(242,179,61,0.10), rgba(242,179,61,0.04))",
                    borderRadius: 16,
                    padding: "20px 24px",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 20, fontWeight: 600, color: C.text }}>
                    <span style={{ width: 34, height: 34, borderRadius: 9, background: C.amberSoft, display: "grid", placeItems: "center" }}>
                      <SquareTerminal size={19} color={C.amber} />
                    </span>
                    Codex wants to run a command
                  </div>
                  <div style={{ marginTop: 14, fontFamily: MONO, fontSize: 19, color: C.text, background: C.bg1, border: `1px solid ${C.line}`, borderRadius: 10, padding: "12px 16px" }}>
                    <span style={{ color: C.text3 }}>$ </span>npm test -- auth
                  </div>
                  <div style={{ display: "flex", gap: 12, marginTop: 16, fontSize: 17, fontWeight: 600 }}>
                    <Btn primary pressed={f >= 92 && f < 98}>Allow once</Btn>
                    <Btn>Allow for this session</Btn>
                    <Btn ghost>Decline</Btn>
                  </div>
                </div>
              ) : null}
              {approved && (
                <div style={{ opacity: collapse, display: "flex", flexDirection: "column", gap: 16 }}>
                  <Step s={S} extra={<span style={{ color: C.green, fontSize: 16 }}>42 passed</span>}>
                    Ran npm test -- auth
                  </Step>
                  <Typed f={f} start={108} text="All 42 auth tests pass. One decision before I wire up storage:" />
                </div>
              )}
              {f >= 186 && (
                <div style={{ marginTop: 22, opacity: tween(f, 186, 8) }}>
                  <UserMsg s={S}>Redis, shared across instances</UserMsg>
                  <div style={{ marginTop: 18 }}>
                    <Typed f={f} start={194} text="On it, wiring up the Redis store." cps={2} />
                  </div>
                </div>
              )}
            </div>

            {/* question dock + composer */}
            <div style={{ position: "absolute", left: 0, right: 0, bottom: 26, display: "flex", flexDirection: "column" }}>
              {f >= 128 && dockGone < 1 && (
                <div
                  style={{
                    transform: `translateY(${(1 - dock) * 40 + dockGone * 30}px)`,
                    opacity: Math.min(1, dock * 1.5) * (1 - dockGone),
                    border: `1px solid rgba(139,156,255,0.4)`,
                    borderBottom: "none",
                    background: C.bg2,
                    borderRadius: "16px 16px 0 0",
                    padding: "18px 22px 14px",
                    marginBottom: -14,
                    paddingBottom: 28,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 19, fontWeight: 600, color: C.text }}>
                    <MessageCircleQuestion size={20} color={C.accent} />
                    Where should the limiter keep its counts?
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 12 }}>
                    {["In memory (one instance)", "Redis, shared across instances", "Other…"].map((o, i) => {
                      const on = picked && i === 1;
                      return (
                        <div
                          key={o}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 12,
                            padding: "8px 12px",
                            borderRadius: 10,
                            fontSize: 17,
                            color: on ? C.text : C.text2,
                            background: on ? C.accentSoft : "transparent",
                            border: `1px solid ${on ? "rgba(139,156,255,0.5)" : "transparent"}`,
                          }}
                        >
                          <Kbd size={14} on={on ? 1 : 0}>{i + 1}</Kbd>
                          {o}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              <Composer s={S} />
            </div>
          </div>
        </AppFrame>
      </div>

      <Cursor
        path={[
          { f: 62, x: 1500, y: 980 },
          { f: 88, x: 548, y: 760 },
          { f: 120, x: 560, y: 770 },
          { f: 140, x: 1380, y: 1000 },
        ]}
        clicks={[93]}
      />
      {/* the keypress */}
      {f >= 156 && f < 186 && (
        <div style={{ position: "absolute", left: 1580, top: 700, transform: `scale(${pop(f, 156, 10, 220)})`, opacity: 1 - tween(f, 178, 8) }}>
          <Kbd size={64} on={f >= 166 ? 1 : 0}>2</Kbd>
        </div>
      )}
    </AbsoluteFill>
  );
}

function Btn({ children, primary, ghost, pressed }: { children: React.ReactNode; primary?: boolean; ghost?: boolean; pressed?: boolean }) {
  return (
    <span
      style={{
        padding: "9px 18px",
        borderRadius: 10,
        background: primary ? C.text : ghost ? "transparent" : C.bg3,
        color: primary ? "#000" : C.text2,
        border: primary ? "none" : `1px solid ${C.line2}`,
        transform: pressed ? "scale(0.94)" : undefined,
        display: "inline-block",
      }}
    >
      {children}
    </span>
  );
}
