import { AbsoluteFill, useCurrentFrame } from "remotion";
import { Check } from "lucide-react";
import { C, FONT, type State, pop, tween } from "../theme";
import { AgentBadge, AgentText, AppFrame, Dot, Glow, Headline, Kbd, Lines, Step, UserMsg, Diff } from "../ui";

type Row = { title: string; project: string; preview: string; state: State; agent: "codex" | "claude"; time: string };
const SECTIONS: { name: string; rows: Row[] }[] = [
  {
    name: "Needs you",
    rows: [
      { title: "Passkey sign-in", project: "auth", preview: "Should passkeys replace passwords, or sit beside them?", state: "attention", agent: "codex", time: "now" },
      { title: "Try a Redis store", project: "api", preview: "Run docker compose up redis?", state: "attention", agent: "codex", time: "1m" },
    ],
  },
  {
    name: "Ready to review",
    rows: [
      { title: "Release notes for 2.4", project: "docs", preview: "Here's the draft, grouped by area.", state: "unread", agent: "claude", time: "4m" },
      { title: "Fix N+1 on /orders", project: "api", preview: "Down from 300 queries to 4. Tests pass.", state: "unread", agent: "claude", time: "7m" },
      { title: "Dark mode tokens", project: "mobile", preview: "Done. Swapped 41 hard-coded colors.", state: "unread", agent: "codex", time: "12m" },
    ],
  },
  {
    name: "Working",
    rows: [
      { title: "Migrate to Vite 8", project: "web", preview: "Checking the dev server for HMR…", state: "running", agent: "claude", time: "" },
      { title: "Webhook retries", project: "billing", preview: "Adding exponential backoff…", state: "running", agent: "codex", time: "" },
    ],
  },
  {
    name: "Failed",
    rows: [{ title: "Terraform plan", project: "infra", preview: "Provider credentials expired.", state: "error", agent: "codex", time: "20m" }],
  },
];

const KEYS: { f: number; k: string }[] = [
  { f: 58, k: "j" },
  { f: 80, k: "j" },
  { f: 102, k: "j" },
  { f: 140, k: "e" },
];

export function InboxScene() {
  const f = useCurrentFrame();
  const enter = pop(f, 0, 22, 110);
  const sel = f < 60 ? 0 : f < 82 ? 1 : f < 104 ? 2 : f < 150 ? 3 : 4;
  const doneN1 = tween(f, 142, 10);
  const swap = f >= 118;
  const key = [...KEYS].reverse().find((k) => f >= k.f);

  let idx = -1;
  return (
    <AbsoluteFill style={{ background: C.bg }}>
      <Glow y="80%" opacity={0.14} size={2000} />
      <div style={{ position: "absolute", top: 58, width: "100%", height: 100 }}>
        <div style={{ position: "absolute", width: "100%", opacity: 1 - tween(f, 114, 8) }}>
          <Headline text="One *inbox* for everything that needs you." size={68} delay={4} stagger={2} />
        </div>
        {swap && (
          <div style={{ position: "absolute", width: "100%" }}>
            <Headline text="Every project. Every agent. *Triaged.*" size={68} delay={120} stagger={2} />
          </div>
        )}
      </div>

      <div style={{ position: "absolute", left: 140, top: 200, transform: `translateY(${(1 - enter) * 120}px)`, opacity: enter }}>
        <AppFrame mode="inbox" width={1640} height={830} need={2} working={2}>
          <div style={{ display: "flex", height: "100%", fontFamily: FONT }}>
            <div style={{ width: 700, borderRight: `1px solid ${C.line}`, padding: "18px 14px", display: "flex", flexDirection: "column", gap: 4 }}>
              {SECTIONS.map((sec, si) => {
                const count = sec.name === "Ready to review" ? 3 - (doneN1 >= 1 ? 1 : 0) : sec.rows.length;
                return (
                  <div key={sec.name} style={{ marginBottom: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", fontSize: 13, fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase", color: si === 0 ? C.amber : C.text3, opacity: tween(f, 6 + si * 6, 10) }}>
                      {sec.name}
                      <span style={{ color: C.text3, fontWeight: 500 }}>{count}</span>
                    </div>
                    {sec.rows.map((r) => {
                      idx++;
                      const i = idx;
                      const on = i === sel;
                      const p = pop(f, 8 + i * 3, 18, 160);
                      const done = i === 3 ? doneN1 : 0;
                      return (
                        <div
                          key={r.title}
                          style={{
                            position: "relative",
                            display: "flex",
                            alignItems: "center",
                            gap: 12,
                            padding: "10px 12px",
                            borderRadius: 10,
                            background: on ? C.bg3 : "transparent",
                            boxShadow: on ? `inset 3px 0 0 ${C.accent}` : undefined,
                            opacity: Math.min(1, p * 1.4) * (1 - done * 0.55),
                            transform: `translateX(${(1 - p) * -30}px)`,
                          }}
                        >
                          {done > 0 ? (
                            <span style={{ width: 10, display: "grid", placeItems: "center", transform: `scale(${pop(f, 142, 10, 200)})` }}>
                              <Check size={15} color={C.green} strokeWidth={3} />
                            </span>
                          ) : (
                            <Dot state={r.state} size={10} phase={i * 9} />
                          )}
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                              <span style={{ fontSize: 16, fontWeight: 600, color: C.text }}>{r.title}</span>
                              <span style={{ fontSize: 13.5, color: C.text3 }}>{r.project}</span>
                              <span style={{ flex: 1 }} />
                              <span style={{ fontSize: 13, color: C.text3 }}>{r.time}</span>
                            </div>
                            <div style={{ fontSize: 14.5, color: C.text2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", marginTop: 2 }}>{r.preview}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
            <Detail sel={sel} f={f} />
          </div>
        </AppFrame>
      </div>

      {key && f - key.f < 26 && (
        <div style={{ position: "absolute", left: 1640, top: 880, transform: `scale(${pop(f, key.f, 10, 220)})`, opacity: 1 - tween(f, key.f + 18, 8) }}>
          <Kbd size={60} on={f - key.f < 8 ? 1 : 0}>{key.k}</Kbd>
        </div>
      )}
    </AbsoluteFill>
  );
}

const ALL = SECTIONS.flatMap((s) => s.rows);

function Detail({ sel, f }: { sel: number; f: number }) {
  const r = ALL[sel];
  // Re-key the fade on each selection change.
  const changed = [0, 60, 82, 104, 150][sel] ?? 0;
  const o = tween(f, changed, 8);
  return (
    <div style={{ flex: 1, padding: "26px 40px", display: "flex", flexDirection: "column", gap: 18, opacity: o, transform: `translateY(${(1 - o) * 10}px)` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Dot state={r.state} size={11} />
        <span style={{ fontSize: 24, fontWeight: 700, color: C.text, letterSpacing: "-0.02em" }}>{r.title}</span>
        <span style={{ fontSize: 16, color: C.text3 }}>{r.project}</span>
        <span style={{ flex: 1 }} />
        <AgentBadge agent={r.agent} size={14} />
      </div>
      <div style={{ height: 1, background: C.line }} />
      <UserMsg s={1.2}>{["Add passkeys as a sign-in option.", "Same idea, but back it with Redis.", "Draft notes from the merged PRs.", "Orders page does 300 queries. Fix it.", "Replace hard-coded colors with tokens."][sel]}</UserMsg>
      <Step s={1.2} icon="read">Read {["docs/webauthn.md", "src/server/rateLimit.ts", "CHANGELOG.md", "orders/repo.ts", "theme/tokens.ts"][sel]}</Step>
      <Step s={1.2} icon="edit" extra={<Diff s={1.2} add={[22, 31, 88, 12, 41][sel]} del={[0, 6, 0, 30, 41][sel]} />}>
        Edited {["auth/passkeys.ts", "store/redis.ts", "docs/release-2.4.md", "orders/repo.ts", "theme/colors.ts"][sel]}
      </Step>
      <AgentText s={1.2}>{r.preview}</AgentText>
      <Lines widths={[90, 74, 82]} h={11} gap={12} />
    </div>
  );
}
