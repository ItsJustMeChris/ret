import { useState } from "react";
import { CircleAlert, Download, Eye, EyeOff, LoaderCircle, LogIn, LogOut, RefreshCw, Terminal, X } from "lucide-react";
import { useUI, type Theme } from "../state/ui";
import { useConn, useEnabledProviders } from "../state/conn";
import { cancelLogin, loadAccount, logout, startLogin } from "../state/actions";
import { bridge, isDesktop } from "../bridge";
import { PROVIDER_IDS, type CodexSource, type ProviderId } from "@shared/bridge";
import { PROVIDERS } from "../agents";
import { UsageMeter } from "./SidebarFooter";
import { RemoteAccessSection } from "./RemoteAccess";
import { Switch } from "./ui/Toggle";

export function SettingsModal() {
  const open = useUI((s) => s.settingsOpen);
  if (!open) return null;
  return <SettingsInner />;
}

function SettingsInner() {
  const close = () => useUI.setState({ settingsOpen: false });
  const ret = useConn((s) => s.appUpdate);
  const theme = useUI((s) => s.theme);
  const projects = useUI((s) => s.projects);
  const hidden = Object.entries(projects).filter(([, p]) => p.hidden);
  const enabled = useEnabledProviders();
  const codexOn = enabled.includes("codex");
  const claudeOn = enabled.includes("claude");

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
          <AgentsSection />
          {codexOn && <CodexSection />}
          {claudeOn && <ClaudeSection />}
          {isDesktop && <RemoteAccessSection />}

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
                ["Ctrl `", "Show / hide the thread's terminal"],
                ["Ctrl Shift `", "New terminal"],
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

/** Which agents are on, and which one new threads start with. */
function AgentsSection() {
  const settings = useConn((s) => s.settings);
  const engines = useConn((s) => s.providers);
  if (!settings || !isDesktop) return null;
  const enabled = PROVIDER_IDS.filter((p) => settings.enabled[p]);
  return (
    <section>
      <h4>Agents</h4>
      {PROVIDER_IDS.map((p) => {
        const st = engines[p].status;
        const on = settings.enabled[p];
        return (
          <div key={p} className="setting-row">
            <div>
              <div>
                {PROVIDERS[p].name}{" "}
                {on && st && <span className={`badge ${st.state === "running" ? "ok" : st.state === "starting" ? "" : "err"}`}>{st.state === "running" ? (st.version ?? "running") : st.state}</span>}
              </div>
              <div className="muted small">
                {p === "codex" ? "OpenAI's coding agent, on your ChatGPT plan or API key." : "Anthropic's coding agent, using your own Claude Code install and sign-in."}
              </div>
            </div>
            <Switch
              checked={on}
              onChange={(v) => {
                // Keep at least one agent on.
                if (!v && enabled.length === 1) return;
                void bridge.agents.setSettings({ enabled: { [p]: v } });
              }}
            />
          </div>
        );
      })}
    </section>
  );
}

/** A provider engine's version, state and binary, with restart and log. */
function EngineRow({ provider, children }: { provider: ProviderId; children?: React.ReactNode }) {
  const st = useConn((s) => s.providers[provider].status);
  const [showLog, setShowLog] = useState(false);
  const name = PROVIDERS[provider].name;
  return (
    <>
      <div className="setting-row">
        <div>
          <div>
            {st?.version ? `${name} ${st.version}` : name}
            {st?.engine === "shared" ? " · shared daemon" : ""}{" "}
            <span className={`badge ${st?.state === "running" ? "ok" : st?.state === "starting" ? "" : "err"}`}>{st?.state}</span>
          </div>
          <div className="muted small mono" title={st?.binaryPath ?? ""} data-path={st?.binaryPath ?? undefined}>
            {st?.binaryPath}
          </div>
        </div>
        <button className="btn ghost" onClick={() => void bridge.agents.restart(provider)} title={`Restart ${name}`}>
          <RefreshCw size={13} /> Restart
        </button>
      </div>
      {st?.error && (
        <div className="setting-error">
          <CircleAlert size={13} /> {st.error}
        </div>
      )}
      {children}
      <button className="link small" onClick={() => setShowLog(!showLog)}>
        {showLog ? "Hide" : "Show"} {provider === "codex" ? "app-server" : name} log
      </button>
      {showLog && <pre className="output log">{st?.stderrTail.join("\n") || "(empty)"}</pre>}
    </>
  );
}

/** An account's email, masked until clicked (and again on the next click): safe to open Settings on a stream. */
function HiddenEmail({ email }: { email: string }) {
  const [shown, setShown] = useState(false);
  return (
    <button className="hidden-email" title={shown ? "Hide email" : "Show email"} onClick={() => setShown(!shown)}>
      {/* Fixed-length mask: it doesn't even give away how long the address is. */}
      <span className={shown ? "" : "masked"}>{shown ? email : "••••••••@••••••"}</span>
      {shown ? <EyeOff size={12} /> : <Eye size={12} />}
    </button>
  );
}

function CodexSection() {
  const up = useConn((s) => s.updater);
  const account = useConn((s) => s.providers.codex.account?.account);
  const [busy, setBusy] = useState(false);

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
    <section>
      <h4>Codex</h4>
      {account?.type === "chatgpt" ? (
        <div className="setting-row">
          <div>
            <div>{account.email ? <HiddenEmail email={account.email} /> : "ChatGPT account"}</div>
            <div className="muted small">ChatGPT · {String(account.planType)} plan — Codex runs on your subscription</div>
          </div>
          <button className="btn ghost" onClick={() => void logout("codex")}>
            <LogOut size={13} /> Sign out
          </button>
        </div>
      ) : account?.type === "apiKey" ? (
        <div className="setting-row">
          <div>Signed in with an API key</div>
          <button className="btn" onClick={() => void startLogin("codex")}>
            Use ChatGPT instead
          </button>
        </div>
      ) : (
        <div className="setting-row">
          <div className="muted">Not signed in</div>
          <button className="btn primary" onClick={() => void startLogin("codex")}>
            Sign in with ChatGPT
          </button>
        </div>
      )}
      <UsageMeter provider="codex" />
      <EngineRow provider="codex">
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
      </EngineRow>
    </section>
  );
}

/**
 * Claude Code runs from the user's own install, signed in through its own CLI: Ret never
 * downloads it, never sees its credentials, and leaves updates to Claude Code itself.
 */
function ClaudeSection() {
  const conn = useConn((s) => s.providers.claude);
  const settings = useConn((s) => s.settings);
  const account = conn.account?.account;
  const running = conn.status?.state === "running";

  const setSource = async (source: "system" | "custom") => {
    let customPath = settings?.claude.customPath ?? null;
    if (source === "custom") {
      customPath = await bridge.dialog.pickFile();
      if (!customPath) return;
    }
    await bridge.agents.setSettings({ claude: { source, customPath } });
  };

  return (
    <section>
      <h4>Claude Code</h4>
      {account ? (
        <div className="setting-row">
          <div>
            <div>{account.type === "claudeAi" ? (account.email ? <HiddenEmail email={account.email} /> : "Claude account") : account.type === "apiKey" ? "Signed in with an API key" : account.type === "cloud" ? `Using ${account.provider}` : "Signed in"}</div>
            <div className="muted small">
              {account.type === "claudeAi"
                ? `Claude${account.planType ? ` · ${account.planType} plan` : ""} — Claude Code runs on your subscription`
                : "Claude Code's own sign-in, shared with the claude CLI"}
            </div>
          </div>
          <button className="btn ghost" title="Sign out in Claude Code itself: claude auth logout" onClick={() => void loadAccount("claude")}>
            <RefreshCw size={13} /> Refresh
          </button>
        </div>
      ) : (
        <div className="setting-row">
          <div>
            <div className="muted">{conn.login?.kind === "terminal" ? "Waiting for you to finish signing in in the terminal…" : "Not signed in"}</div>
            <div className="muted small">
              Sign-in happens in Claude Code itself (<code>claude auth login</code>); Ret never sees your credentials.
            </div>
            {conn.login?.error && <div className="setting-error small">{conn.login.error}</div>}
          </div>
          {conn.login?.kind === "terminal" ? (
            <div className="row-gap">
              <button className="btn" onClick={() => void loadAccount("claude")}>
                Check again
              </button>
              <button className="btn ghost" onClick={() => void cancelLogin("claude")}>
                Cancel
              </button>
            </div>
          ) : (
            <button className="btn primary" disabled={!running} onClick={() => void startLogin("claude")}>
              <Terminal size={13} /> Sign in with Claude Code
            </button>
          )}
        </div>
      )}
      <UsageMeter provider="claude" />
      <EngineRow provider="claude">
        {isDesktop && settings && (
          <>
            <div className="setting-row">
              <div>
                <div>Source</div>
                <div className="muted small">Ret uses the Claude Code you installed; it never installs its own copy.</div>
              </div>
              <div className="segmented small">
                {(["system", "custom"] as const).map((s) => (
                  <button key={s} className={settings.claude.source === s ? "on" : ""} onClick={() => void setSource(s)}>
                    {s === "system" ? "System" : "Custom…"}
                  </button>
                ))}
              </div>
            </div>
            <div className="setting-row">
              <div>
                <div>Keep up to date</div>
                <div className="muted small">
                  Runs Claude Code's own updater (<code>claude update</code>) when a new version is out and no Claude thread is running. Its model list comes from the
                  installed version.
                </div>
              </div>
              <Switch checked={settings.claude.autoUpdate} onChange={(v) => void bridge.agents.setSettings({ claude: { autoUpdate: v } })} />
            </div>
            <ClaudeUpdates />
          </>
        )}
      </EngineRow>
    </section>
  );
}

/** Claude Code's version against the latest release, and updating it now. */
function ClaudeUpdates() {
  const st = useConn((s) => s.providers.claude.status);
  const u = st?.update;
  if (!st || !u) return null;
  const behind = !!(u.latest && st.version && u.latest !== st.version && newer(u.latest, st.version));
  const working = u.phase === "checking" || u.phase === "updating";
  return (
    <div className="setting-row">
      <div>
        <div>
          Updates{" "}
          {u.phase === "updating" && <span className="badge">updating</span>}
          {u.phase === "waiting" && <span className="badge">{u.latest} waits for idle</span>}
          {u.phase !== "updating" && u.phase !== "waiting" && behind && <span className="badge">{u.latest} available</span>}
          {u.phase === "idle" && !behind && u.checkedAt && <span className="badge ok">up to date</span>}
        </div>
        <div className="muted small">
          Latest {u.latest ?? "—"} · running {st.version ?? "—"}
          {u.checkedAt ? ` · checked ${new Date(u.checkedAt).toLocaleTimeString()}` : ""}
        </div>
        {u.phase === "error" && u.error && <div className="setting-error small">{u.error}</div>}
      </div>
      <button className={`btn ${behind ? "primary" : ""}`} disabled={working || st.state !== "running"} onClick={() => void bridge.agents.update("claude")}>
        {working ? <LoaderCircle size={13} className="spin" /> : behind ? <Download size={13} /> : <RefreshCw size={13} />} {behind ? "Update now" : "Check now"}
      </button>
    </div>
  );
}

/** a > b for versions like 2.1.274 and 2.1.296. */
function newer(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map((n) => Number(n) || 0);
  const pb = b.split(/[.-]/).map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

/** The provider's sign-in button, for places outside Settings. */
export function SignInButton({ provider, className = "btn primary" }: { provider: ProviderId; className?: string }) {
  const running = useConn((s) => s.providers[provider].status?.state === "running");
  return (
    <button className={className} disabled={!running} onClick={() => void startLogin(provider)}>
      <LogIn size={13} /> Sign in to {PROVIDERS[provider].name}
    </button>
  );
}
