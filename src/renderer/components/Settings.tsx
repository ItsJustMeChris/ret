import { useState } from "react";
import { CircleAlert, Download, LoaderCircle, LogOut, RefreshCw, X } from "lucide-react";
import { useUI, type Theme } from "../state/ui";
import { useConn } from "../state/conn";
import { logout, startLogin } from "../state/actions";
import { bridge, isDesktop } from "../bridge";
import type { CodexSource } from "@shared/bridge";
import { UsageMeter } from "./SidebarFooter";
import { Switch } from "./ui/Toggle";

export function SettingsModal() {
  const open = useUI((s) => s.settingsOpen);
  if (!open) return null;
  return <SettingsInner />;
}

function SettingsInner() {
  const close = () => useUI.setState({ settingsOpen: false });
  const codex = useConn((s) => s.codex);
  const up = useConn((s) => s.updater);
  const ret = useConn((s) => s.appUpdate);
  const account = useConn((s) => s.account?.account);
  const theme = useUI((s) => s.theme);
  const projects = useUI((s) => s.projects);
  const hidden = Object.entries(projects).filter(([, p]) => p.hidden);
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);

  const setSource = async (source: CodexSource) => {
    let customPath = up?.settings.customPath ?? null;
    if (source === "custom") {
      customPath = await bridge.dialog.pickFile();
      if (!customPath) return;
    }
    await bridge.updater.setSettings({ source, customPath });
  };

  const check = async () => {
    setBusy(true);
    try {
      await bridge.updater.check();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="overlay" onPointerDown={close}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Settings</h3>
          <button className="icon-btn" onClick={close}>
            <X size={15} />
          </button>
        </div>
        <div className="modal-body">
          <section>
            <h4>Account</h4>
            {account?.type === "chatgpt" ? (
              <div className="setting-row">
                <div>
                  <div>{account.email}</div>
                  <div className="muted small">ChatGPT · {String(account.planType)} plan — Codex runs on your subscription</div>
                </div>
                <button className="btn ghost" onClick={() => void logout()}>
                  <LogOut size={13} /> Sign out
                </button>
              </div>
            ) : account?.type === "apiKey" ? (
              <div className="setting-row">
                <div>Signed in with an API key</div>
                <button className="btn" onClick={() => void startLogin()}>
                  Use ChatGPT instead
                </button>
              </div>
            ) : (
              <div className="setting-row">
                <div className="muted">Not signed in</div>
                <button className="btn primary" onClick={() => void startLogin()}>
                  Sign in with ChatGPT
                </button>
              </div>
            )}
            <UsageMeter />
          </section>

          <section>
            <h4>Codex engine</h4>
            <div className="setting-row">
              <div>
                <div>
                  {codex?.version ? `codex ${codex.version}` : "codex"}
                  {codex?.engine === "shared" ? " · shared daemon" : ""}{" "}
                  <span className={`badge ${codex?.state === "running" ? "ok" : codex?.state === "starting" ? "" : "err"}`}>{codex?.state}</span>
                </div>
                <div className="muted small mono" title={codex?.binaryPath ?? ""} data-path={codex?.binaryPath ?? undefined}>
                  {codex?.binaryPath}
                </div>
              </div>
              <button className="btn ghost" onClick={() => void bridge.codex.restart()} title="Restart the app-server process">
                <RefreshCw size={13} /> Restart
              </button>
            </div>
            {codex?.error && (
              <div className="setting-error">
                <CircleAlert size={13} /> {codex.error}
              </div>
            )}
            {isDesktop && up && (
              <>
                <div className="setting-row">
                  <div>
                    <div>Engine</div>
                    <div className="muted small">
                      {up.settings.engine === "shared"
                        ? "Attached to the shared Codex daemon — threads running in the Codex desktop app stream here live. The daemon manages its own version."
                        : "Ret runs its own app-server on the codex version below."}
                    </div>
                  </div>
                  <div className="segmented small">
                    {([
                      ["dedicated", "Dedicated"],
                      ["shared", "Shared daemon"],
                    ] as const).map(([k, label]) => (
                      <button key={k} className={up.settings.engine === k ? "on" : ""} onClick={() => void bridge.updater.setSettings({ engine: k })}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="setting-row">
                  <div>
                    <div>Source</div>
                    <div className="muted small">Managed keeps a private copy of codex and updates it automatically.</div>
                  </div>
                  <div className="segmented small">
                    {(["managed", "system", "custom"] as const).map((s) => (
                      <button key={s} className={up.settings.source === s ? "on" : ""} onClick={() => void setSource(s)}>
                        {s === "managed" ? "Managed" : s === "system" ? "System" : "Custom…"}
                      </button>
                    ))}
                  </div>
                </div>
                {up.settings.source === "managed" && (
                  <>
                    <div className="setting-row">
                      <div>
                        <div>Auto-update</div>
                        <div className="muted small">Checks npm every {up.settings.checkIntervalHours}h; new versions are verified and swapped in when no thread is running.</div>
                      </div>
                      <Switch checked={up.settings.autoUpdate} onChange={(v) => void bridge.updater.setSettings({ autoUpdate: v })} />
                    </div>
                    <div className="setting-row">
                      <div>
                        <div>Channel</div>
                        <div className="muted small">Alpha gets codex prereleases as soon as they ship.</div>
                      </div>
                      <div className="segmented small">
                        {(["latest", "alpha"] as const).map((c) => (
                          <button key={c} className={up.settings.channel === c ? "on" : ""} onClick={() => void bridge.updater.setSettings({ channel: c })}>
                            {c === "latest" ? "Stable" : "Alpha"}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}
                <div className="setting-row">
                  <div>
                    <div>
                      Updates{" "}
                      {up.phase === "downloading" && <span className="badge">{Math.round((up.progress ?? 0) * 100)}%</span>}
                      {up.phase === "upToDate" && <span className="badge ok">up to date</span>}
                      {up.staged && <span className="badge">{up.staged} ready</span>}
                    </div>
                    <div className="muted small">
                      Latest {up.latest ?? "—"} · running {up.running ?? "—"}
                      {up.lastCheckedAt ? ` · checked ${new Date(up.lastCheckedAt).toLocaleTimeString()}` : ""}
                      {up.installed.length ? ` · installed ${up.installed.join(", ")}` : ""}
                    </div>
                    {up.error && <div className="setting-error small">{up.error}</div>}
                  </div>
                  <div className="row-gap">
                    {up.staged && (
                      <button className="btn primary" onClick={() => void bridge.updater.apply()}>
                        <Download size={13} /> Restart into {up.staged}
                      </button>
                    )}
                    <button className="btn" disabled={busy || up.phase === "downloading"} onClick={() => void check()}>
                      {busy || up.phase === "checking" || up.phase === "downloading" ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />} Check now
                    </button>
                  </div>
                </div>
              </>
            )}
            <button className="link small" onClick={() => setShowLog(!showLog)}>
              {showLog ? "Hide" : "Show"} app-server log
            </button>
            {showLog && <pre className="output log">{codex?.stderrTail.join("\n") || "(empty)"}</pre>}
          </section>

          <section>
            <h4>Appearance</h4>
            <div className="setting-row">
              <div>Theme</div>
              <div className="segmented small">
                {(["dark", "light", "system"] as Theme[]).map((t) => (
                  <button key={t} className={theme === t ? "on" : ""} onClick={() => useUI.setState({ theme: t })}>
                    {t[0].toUpperCase() + t.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </section>

          {isDesktop && ret && (
            <section>
              <h4>Ret</h4>
              <div className="setting-row">
                <div>
                  <div>
                    Ret {bridge.appVersion}{" "}
                    {ret.phase === "downloading" && <span className="badge">{Math.round((ret.progress ?? 0) * 100)}%</span>}
                    {ret.phase === "upToDate" && <span className="badge ok">up to date</span>}
                    {ret.phase === "ready" && <span className="badge">{ret.version} ready</span>}
                  </div>
                  <div className="muted small">
                    {ret.phase === "unsupported"
                      ? "Updates are only checked in installed builds."
                      : `Checks GitHub Releases every 4h and downloads updates in the background${ret.lastCheckedAt ? ` · checked ${new Date(ret.lastCheckedAt).toLocaleTimeString()}` : ""}`}
                  </div>
                  {ret.error && <div className="setting-error small">{ret.error}</div>}
                </div>
                {ret.phase === "ready" ? (
                  <button className="btn primary" onClick={() => void bridge.appUpdate.install()}>
                    <Download size={13} /> Restart into {ret.version}
                  </button>
                ) : (
                  ret.phase !== "unsupported" && (
                    <button className="btn" disabled={ret.phase === "checking" || ret.phase === "downloading"} onClick={() => void bridge.appUpdate.check()}>
                      {ret.phase === "checking" || ret.phase === "downloading" ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />} Check now
                    </button>
                  )
                )}
              </div>
            </section>
          )}

          {hidden.length > 0 && (
            <section>
              <h4>Hidden projects</h4>
              {hidden.map(([key, p]) => (
                <div key={key} className="setting-row">
                  <div className="mono small">{p.path}</div>
                  <button
                    className="btn ghost"
                    onClick={() => useUI.setState((s) => ({ projects: { ...s.projects, [key]: { ...s.projects[key], hidden: false } } }))}
                  >
                    Show
                  </button>
                </div>
              ))}
            </section>
          )}

          <section>
            <h4>Shortcuts</h4>
            <div className="shortcuts">
              {[
                ["Ctrl K", "Command palette"],
                ["Ctrl N", "New thread in current project"],
                ["Ctrl \\", "Toggle Focus / Canvas"],
                ["Ctrl B", "Toggle sidebar"],
                ["Ctrl Shift F", "Fork current thread"],
                ["Ctrl W", "Close tab / window"],
                ["Ctrl 1–9", "Jump to tab / window"],
                ["Ctrl Tab", "Next tab / window"],
                ["Ctrl 0", "Canvas: fit all"],
                ["Ctrl ± / Ctrl+scroll", "Canvas: zoom"],
                ["Space + drag", "Canvas: pan"],
                ["Alt + drag", "Canvas: move without snapping"],
                ["Esc", "Stop the running turn"],
              ].map(([k, v]) => (
                <div key={k} className="shortcut">
                  <kbd>{k}</kbd>
                  <span>{v}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
