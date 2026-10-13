import { LoaderCircle, LogIn, Smartphone, Terminal } from "lucide-react";
import type { ProviderId } from "@shared/bridge";
import { useConn, useEnabledProviders, type ProviderConn } from "../state/conn";
import { cancelLogin, loadAccount, startLogin } from "../state/actions";
import { PROVIDERS } from "../agents";
import { bridge } from "../bridge";

/** Usable without signing in: signed in already, or an engine that needs no account (e.g. a custom model provider). */
const usable = (c: ProviderConn) => !!c.account?.account || (c.account != null && !c.account.requiresOpenaiAuth);

/**
 * Shown only when no agent that's running can be used yet. Each provider signs in its own way:
 * Codex reuses ~/.codex/auth.json (shared with its CLI), Claude Code its own CLI's sign-in.
 */
export function LoginGate() {
  const enabled = useEnabledProviders();
  const providers = useConn((s) => s.providers);
  const up = enabled.filter((p) => providers[p].status?.state === "running");
  if (!up.length || up.some((p) => !providers[p].accountLoaded) || up.some((p) => usable(providers[p]))) return null;

  return (
    <div className="overlay solid">
      <div className="login">
        <div className="brand-mark">ret</div>
        <h2>{up.length === 1 ? `Sign in to ${PROVIDERS[up[0]].name}` : "Sign in to an agent"}</h2>
        {up.map((p) => (
          <ProviderLogin key={p} provider={p} several={up.length > 1} />
        ))}
      </div>
    </div>
  );
}

function ProviderLogin({ provider, several }: { provider: ProviderId; several: boolean }) {
  const login = useConn((s) => s.providers[provider].login);
  const running = useConn((s) => s.providers[provider].status?.state === "running");
  const name = PROVIDERS[provider].name;
  return (
    <div className="login-provider">
      {several && <h3>{name}</h3>}
      <p className="muted">
        {provider === "codex"
          ? "Use your ChatGPT plan — the same login as the Codex CLI. Credentials stay in your Codex home directory."
          : "Use your Claude plan or API key — Claude Code signs in for itself in a terminal (claude auth login), and Ret never sees your credentials."}
      </p>
      {login ? (
        <div className="login-pending">
          {login.kind === "device" && login.userCode ? (
            <>
              <p>Enter this code at {login.verificationUrl}</p>
              <div className="device-code">{login.userCode}</div>
            </>
          ) : (
            <p>
              <LoaderCircle size={14} className="spin" /> {login.kind === "terminal" ? "Finish signing in in the terminal…" : "Finish signing in in your browser…"}
            </p>
          )}
          {login.error && <div className="setting-error">{login.error}</div>}
          <div className="row-gap">
            {login.authUrl && (
              <button className="btn" onClick={() => void bridge.shell.openExternal(login.authUrl!)}>
                Open browser again
              </button>
            )}
            {login.kind === "terminal" && (
              <button className="btn" onClick={() => void loadAccount(provider)}>
                Check again
              </button>
            )}
            <button className="btn ghost" onClick={() => void cancelLogin(provider)}>
              Cancel
            </button>
          </div>
        </div>
      ) : provider === "codex" ? (
        <div className="row-gap col">
          <button className="btn primary big" disabled={!running} onClick={() => void startLogin(provider, "browser")}>
            <LogIn size={15} /> Sign in with ChatGPT
          </button>
          <button className="btn ghost" disabled={!running} onClick={() => void startLogin(provider, "device")}>
            <Smartphone size={14} /> Use a device code instead
          </button>
        </div>
      ) : (
        <div className="row-gap col">
          <button className="btn primary big" disabled={!running} onClick={() => void startLogin(provider)}>
            <Terminal size={15} /> Sign in with {name}
          </button>
        </div>
      )}
    </div>
  );
}
