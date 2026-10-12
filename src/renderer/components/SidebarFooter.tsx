import { useEffect, useState } from "react";
import { Download, LoaderCircle, RefreshCw, Settings, CircleAlert, Check } from "lucide-react";
import { useConn } from "../state/conn";
import { useUI } from "../state/ui";

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

function Meter({ w, now }: { w: Window; now: number }) {
  const left = Math.max(0, Math.min(100, Math.round(100 - w.usedPercent)));
  const color = meterColor(left);
  const tip = w.resetsAt
    ? `${resetsIn(w.resetsAt, now)}\n${new Date(w.resetsAt * 1000).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`
    : undefined;
  return (
    <div className="usage" title={tip}>
      <div className="usage-row">
        <span>{windowLabel(w.windowDurationMins)}</span>
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

export function UsageMeter() {
  const rl = useConn((s) => s.rateLimits?.rateLimits);
  // Keep the "resets in" countdown current.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const windows = [rl?.primary, rl?.secondary].filter((w): w is Window => !!w);
  if (!windows.length) return null;
  return (
    <>
      {windows.map((w, i) => (
        <Meter key={i} w={w} now={now} />
      ))}
    </>
  );
}

export function CodexBadge() {
  const codex = useConn((s) => s.codex);
  const up = useConn((s) => s.updater);
  if (!codex) return null;
  let icon = <Check size={11} className="st-ok" />;
  let text = codex.version ? `codex ${codex.version}` : "codex";
  if (codex.state === "starting") icon = <LoaderCircle size={11} className="spin" />;
  if (codex.state === "error" || codex.state === "missing") icon = <CircleAlert size={11} className="st-err" />;
  if (up?.phase === "downloading") {
    icon = <Download size={11} className="st-run" />;
    text = `Downloading ${up.latest ?? ""} ${up.progress != null ? Math.round(up.progress * 100) + "%" : ""}`;
  } else if (up?.phase === "verifying" || up?.phase === "extracting") {
    icon = <LoaderCircle size={11} className="spin" />;
    text = `Installing ${up.latest ?? ""}`;
  } else if (up?.staged) {
    icon = <RefreshCw size={11} className="st-run" />;
    text = `${up.staged} ready · applies when idle`;
  }
  return (
    <button className="codex-badge" title={codex.error ?? codex.binaryPath ?? ""} onClick={() => useUI.setState({ settingsOpen: true })}>
      {icon}
      <span>{text}</span>
    </button>
  );
}

export function SidebarFooter() {
  const account = useConn((s) => s.account?.account);
  return (
    <div className="sidebar-foot">
      <UsageMeter />
      <div className="foot-row">
        <div className="account" title={account?.type === "chatgpt" ? (account.email ?? "") : ""}>
          <span className="account-text">
            <span className="account-name">{account?.type === "chatgpt" ? account.email : account?.type === "apiKey" ? "API key" : "Not signed in"}</span>
            {account?.type === "chatgpt" && <span className="plan">{String(account.planType)}</span>}
          </span>
        </div>
        <button className="icon-btn" title="Settings" onClick={() => useUI.setState({ settingsOpen: true })}>
          <Settings size={15} />
        </button>
      </div>
      <CodexBadge />
    </div>
  );
}
