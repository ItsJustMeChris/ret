import { useEffect, useState } from "react";
import { Download, LoaderCircle, RefreshCw, Settings, CircleAlert, Check, ArrowUpCircle } from "lucide-react";
import type { ProviderId } from "@shared/bridge";
import { useConn, useEnabledProviders } from "../state/conn";
import { useUI } from "../state/ui";
import { PROVIDERS } from "../agents";
import { engineStatus } from "./HoverCards";

type Window = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null };

/** "Resets in 3 days 4 hours 12 min" — largest unit first, zero units left out. */
function resetsIn(resetsAt: number, now: number): string {
  const sec = Math.max(0, Math.round(resetsAt - now / 1000));
  if (sec < 60) return "Resets in under a minute";
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d} day${d === 1 ? "" : "s"}`);
  if (h) parts.push(`${h} hour${h === 1 ? "" : "s"}`);
  if (m) parts.push(`${m} min`);
  return `Resets in ${parts.join(" ")}`;
}

/** Green with plenty left, through amber, to red as the remaining share approaches 0%. */
function meterColor(left: number): string {
  return left >= 50
    ? `color-mix(in oklch, var(--green) ${(left - 50) * 2}%, var(--amber))`
    : `color-mix(in oklch, var(--amber) ${left * 2}%, var(--red))`;
}

function windowLabel(mins: number | null) {
  if (!mins) return "Usage";
  return mins >= 1440 ? `${Math.round(mins / 1440)}d limit` : `${Math.round(mins / 60)}h limit`;
}

function Meter({ w, now, label }: { w: Window; now: number; label?: string | null }) {
  const left = Math.max(0, Math.min(100, Math.round(100 - w.usedPercent)));
  const color = meterColor(left);
  const tip = w.resetsAt
    ? `${resetsIn(w.resetsAt, now)}\n${new Date(w.resetsAt * 1000).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
    : undefined;
  return (
    <div className="usage" title={tip}>
      <div className="usage-row">
        <span>{label ? `${label} · ` : ""}{windowLabel(w.windowDurationMins)}</span>
        <span className="usage-left" style={{ color }}>
          {left}% left
        </span>
      </div>
      <div className="usage-bar">
        <div className="usage-fill" style={{ width: `${left}%`, background: color }} />
      </div>
    </div>
  );
}

/**
 * A provider's plan usage windows, then any other limits it reports (per-model buckets such as
 * Claude's Fable weekly limit). `label` names the provider when several are on.
 */
export function UsageMeter({ provider, label }: { provider: ProviderId; label?: string }) {
  const windows = useUsageWindows(provider, label);
  // Keep the "resets in" countdown current.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  if (!windows.length) return null;
  return (
    <>
      {windows.map((m, i) => (
        <Meter key={i} w={m.w} now={now} label={m.label} />
      ))}
    </>
  );
}

/** Every usage window a provider reports: its main limits, then other buckets (per-model ones). */
function useUsageWindows(provider: ProviderId, label?: string): { w: Window; label?: string | null }[] {
  const rl = useConn((s) => s.providers[provider].rateLimits?.rateLimits);
  const byId = useConn((s) => s.providers[provider].rateLimits?.rateLimitsByLimitId);
  const windows: { w: Window; label?: string | null }[] = [rl?.primary, rl?.secondary].filter((w): w is Window => !!w).map((w) => ({ w, label }));
  for (const [id, snap] of Object.entries(byId ?? {})) {
    if (!snap || id === rl?.limitId) continue; // the main limit, already shown
    const name = [label, snap.limitName ?? id].filter(Boolean).join(" · ");
    for (const w of [snap.primary, snap.secondary]) if (w) windows.push({ w, label: name });
  }
  return windows;
}

/** Below this share left, a limit shows on the account line while usage is tucked away. */
const LOW_LEFT = 20;

export function EngineBadge({ provider }: { provider: ProviderId }) {
  const codex = useConn((s) => s.providers[provider].status);
  const updater = useConn((s) => s.updater);
  const up = provider === "codex" ? updater : null;
  if (!codex) return null;
  // Always "<Name> <version>"; the state rides along as a small chip. Details live in the hover card.
  const st = engineStatus(codex, up);
  const busy = codex.state === "starting" || up?.phase === "verifying" || up?.phase === "extracting" || codex.update?.phase === "updating";
  const icon = busy ? (
    <LoaderCircle size={11} className="spin" />
  ) : st.tone === "bad" ? (
    <CircleAlert size={11} className="st-err" />
  ) : up?.phase === "downloading" ? (
    <Download size={11} className="st-run" />
  ) : up?.staged ? (
    <RefreshCw size={11} className="st-run" />
  ) : st.tone === "warn" ? (
    <ArrowUpCircle size={11} className="st-warn" />
  ) : (
    <Check size={11} className="st-ok" />
  );
  const name = PROVIDERS[provider].short;
  return (
    <button className="codex-badge" data-card="engine" data-provider={provider} aria-label={`${PROVIDERS[provider].name} status`} onClick={() => useUI.setState({ settingsOpen: true })}>
      {icon}
      <span className="codex-badge-text">{name}{codex.version ? ` ${codex.version}` : ""}</span>
      {st.short && <span className={`codex-chip ${st.tone}`}>{st.short}</span>}
    </button>
  );
}

/** How a provider is signed in, in a word or two. Never the account's email (Settings shows that). */
function AccountLine({ provider, label }: { provider: ProviderId; label: boolean }) {
  const account = useConn((s) => s.providers[provider].account?.account);
  // An engine that needs no account from Ret (an ACP agent signs in for itself).
  const ownSignIn = useConn((s) => s.providers[provider].account?.requiresOpenaiAuth === false && !s.providers[provider].account?.account);
  const subscription = account?.type === "chatgpt" || account?.type === "claudeAi";
  // A subscription reads as "Codex PLUS": the provider's name stands where the email was.
  const name = subscription
    ? PROVIDERS[provider].short
    : account?.type === "apiKey"
      ? "API key"
      : account?.type === "cloud"
        ? account.provider
        : ownSignIn
          ? "Own sign-in"
          : "Not signed in";
  const plan = account?.type === "chatgpt" || account?.type === "claudeAi" ? account.planType : null;
  // Usage is out of sight until hovered, so a limit that's nearly used up still says so here.
  const windows = useUsageWindows(provider);
  const left = windows.length ? Math.max(0, Math.round(100 - Math.max(...windows.map((m) => m.w.usedPercent)))) : null;
  return (
    <span className="account-line">
      {label && !subscription && <span className="account-provider">{PROVIDERS[provider].short}</span>}
      <span className="account-name">{name}</span>
      {plan && <span className="plan">{String(plan)}</span>}
      {left != null && left < LOW_LEFT && (
        <span className="usage-low" style={{ color: meterColor(left) }} title="Hover for usage">
          {left}% left
        </span>
      )}
    </span>
  );
}

export function SidebarFooter() {
  const enabled = useEnabledProviders();
  const several = enabled.length > 1;
  return (
    <div className="sidebar-foot">
      {/* Plan usage slides up over the thread list while the footer is hovered, and takes no room otherwise. */}
      <div className="usage-pop">
        <div className="usage-pop-panel">
          {enabled.map((p) => (
            <UsageMeter key={p} provider={p} label={several ? PROVIDERS[p].short : undefined} />
          ))}
        </div>
      </div>
      <div className="foot-row">
        <div className="account">
          <span className="account-text">
            {enabled.map((p) => (
              <AccountLine key={p} provider={p} label={several} />
            ))}
          </span>
        </div>
        <button className="icon-btn" title="Settings" onClick={() => useUI.setState({ settingsOpen: true })}>
          <Settings size={15} />
        </button>
      </div>
      <div className="engine-badges">
        {enabled.map((p) => (
          <EngineBadge key={p} provider={p} />
        ))}
      </div>
    </div>
  );
}
