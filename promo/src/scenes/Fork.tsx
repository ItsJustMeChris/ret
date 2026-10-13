import React from "react";
import { AbsoluteFill, interpolate, useCurrentFrame } from "remotion";
import { FolderGit2, GitFork, GitBranch } from "lucide-react";
import { C, FONT, MONO, pop, tween, ease } from "../theme";
import { AgentText, AppFrame, Composer, Cursor, Diff, Dot, Glow, Headline, Step, Sub, UserMsg } from "../ui";

const S = 1.2;

function Pane({ title, sub, forked, children, state }: { title: string; sub: React.ReactNode; forked?: boolean; children: React.ReactNode; state: "running" | "unread" }) {
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", fontFamily: FONT, minWidth: 0 }}>
      <div style={{ height: 52, flex: "none", display: "flex", alignItems: "center", gap: 10, padding: "0 22px", borderBottom: `1px solid ${C.line}` }}>
        <Dot state={state} size={9} />
        {forked && <GitFork size={16} color={C.accent} />}
        <span style={{ fontSize: 17, fontWeight: 600, color: C.text, whiteSpace: "nowrap" }}>{title}</span>
        <span style={{ fontSize: 14, color: C.text3, display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>{sub}</span>
      </div>
      <div style={{ flex: 1, position: "relative", padding: "24px 40px", display: "flex", flexDirection: "column", gap: 16, overflow: "hidden" }}>{children}</div>
    </div>
  );
}

function Typed({ text, start, f, cps = 1.8 }: { text: string; start: number; f: number; cps?: number }) {
  const n = Math.max(0, Math.floor((f - start) * cps));
  return n > 0 ? <AgentText s={S}>{text.slice(0, n)}</AgentText> : null;
}

export function Fork() {
  const f = useCurrentFrame();
  const enter = pop(f, 0, 22, 110);
  const split = interpolate(f, [62, 84], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const hoverBtn = tween(f, 30, 8);
  const W = 1638;
  const leftW = W - split * (W / 2);

  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <Glow y="80%" opacity={0.14} size={2000} />
      <div style={{ position: "absolute", top: 50, width: "100%" }}>
        <Headline text="*Fork* any turn. Try both ideas at once." size={68} delay={4} stagger={2} />
        <Sub delay={92} size={26} style={{ marginTop: 10 }}>
          Each fork can get its own git worktree, so experiments never step on each other.
        </Sub>
      </div>

      <div style={{ position: "absolute", left: 140, top: 210, transform: `translateY(${(1 - enter) * 120}px)`, opacity: enter }}>
        <AppFrame mode="focus" width={1640} height={820} need={0} working={split > 0 ? 2 : 1}>
          <div style={{ display: "flex", height: "100%" }}>
            <div style={{ width: leftW, flex: "none", overflow: "hidden" }}>
              <Pane title="Rate-limit the login endpoint" state="running" sub={<><GitBranch size={14} />main</>}>
                <UserMsg s={S}>Add rate limiting to the login endpoint.</UserMsg>
                <div>
                  <AgentText s={S}>Two ways to store the counters: in memory, or Redis so every instance shares them. Going with in-memory for now.</AgentText>
                  {/* the turn's hover action */}
                  <div
                    style={{
                      marginTop: 10,
                      width: "fit-content",
                      opacity: hoverBtn * (1 - split),
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      fontSize: 15,
                      fontWeight: 500,
                      color: f > 56 ? C.text : C.text2,
                      background: f > 56 ? C.bg4 : C.bg2,
                      border: `1px solid ${C.line2}`,
                      borderRadius: 9,
                      padding: "6px 12px",
                    }}
                  >
                    <GitFork size={15} /> Fork from here
                  </div>
                </div>
                <Step s={S} icon="edit" extra={<Diff s={S} add={48} />}>Edited src/server/rateLimit.ts</Step>
                {f > 90 && <Step s={S}>Ran npm test -- auth</Step>}
                {f > 100 && <Typed f={f} start={100} text="In-memory limiter done. 42 tests pass." />}
              </Pane>
            </div>
            <div style={{ width: 1, background: C.line2, position: "relative", flex: "none", opacity: split }}>
              <div
                style={{
                  position: "absolute",
                  top: 330,
                  left: -20,
                  width: 40,
                  height: 40,
                  borderRadius: 99,
                  background: C.bg2,
                  border: `1.5px solid ${C.accent}`,
                  display: "grid",
                  placeItems: "center",
                  transform: `scale(${pop(f, 78, 10, 200)}) rotate(${(1 - pop(f, 78, 10, 200)) * -90}deg)`,
                  boxShadow: `0 0 30px rgba(139,156,255,0.35)`,
                  zIndex: 5,
                }}
              >
                <GitFork size={19} color={C.accent} />
              </div>
            </div>
            <div style={{ flex: 1, overflow: "hidden", opacity: split, transform: `translateX(${(1 - split) * -80}px)`, background: "linear-gradient(180deg, rgba(139,156,255,0.035), transparent 40%)" }}>
              <div style={{ width: W / 2, height: "100%" }}>
                <Pane
                  title="Try a Redis store"
                  forked
                  state="running"
                  sub={
                    <>
                      <FolderGit2 size={14} />
                      <span style={{ fontFamily: MONO, fontSize: 13 }}>worktree/try-redis</span>
                    </>
                  }
                >
                  <UserMsg s={S}>Add rate limiting to the login endpoint.</UserMsg>
                  <AgentText s={S}>Two ways to store the counters: in memory, or Redis so every instance shares them.</AgentText>
                  {f > 96 && <UserMsg s={S}>Let's try Redis instead.</UserMsg>}
                  {f > 108 && <Step s={S} icon="edit" extra={<Diff s={S} add={31} del={6} />}>Edited store/redis.ts</Step>}
                  {f > 118 && <Typed f={f} start={118} text="Redis store wired up. Spinning up a container to test against it." />}
                </Pane>
              </div>
            </div>
          </div>
          {split < 1 && (
            <div style={{ position: "absolute", left: 40 + 330, right: 40 + 330, bottom: 24, opacity: 1 - split }}>
              <Composer s={S} />
            </div>
          )}
        </AppFrame>
      </div>
      <Cursor
        path={[
          { f: 26, x: 1200, y: 640 },
          { f: 46, x: 250, y: 455 },
          { f: 70, x: 256, y: 461 },
          { f: 96, x: 1700, y: 900 },
        ]}
        clicks={[58]}
      />
    </AbsoluteFill>
  );
}
