import { Download, LoaderCircle, RefreshCw, Settings, CircleAlert, Check } from "lucide-react";
import { useConn } from "../state/conn";
import { useUI } from "../state/ui";

export function UsageMeter() {
  const rl = useConn((s) => s.rateLimits?.rateLimits);
  if (!rl?.primary) return null;
  const pct = Math.round(rl.primary.usedPercent);
  const resets = rl.primary.resetsAt ? new Date(rl.primary.resetsAt * 1000) : null;
  const windowLabel = rl.primary.windowDurationMins
    ? rl.primary.windowDurationMins >= 1440
      ? `${Math.round(rl.primary.windowDurationMins / 1440)}d`
      : `${Math.round(rl.primary.windowDurationMins / 60)}h`
    : "";
  return (
    <div className="usage" title={resets ? `Resets ${resets.toLocaleString()}` : undefined}>
      <div className="usage-row">
        <span>{windowLabel} limit</span>
        <span className={pct > 85 ? "st-err" : pct > 60 ? "st-warn" : "muted"}>{pct}%</span>
      </div>
      <div className="usage-bar">
        <div className="usage-fill" style={{ width: `${pct}%` }} data-level={pct > 85 ? "high" : pct > 60 ? "mid" : "low"} />
      </div>
    </div>
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
          <span className="avatar">{account?.type === "chatgpt" ? (account.email?.[0]?.toUpperCase() ?? "C") : "·"}</span>
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
