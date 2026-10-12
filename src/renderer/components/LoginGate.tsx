import { LoaderCircle, LogIn, Smartphone } from "lucide-react";
import { useConn } from "../state/conn";
import { cancelLogin, startLogin } from "../state/actions";
import { bridge } from "../bridge";

/** Shown only when codex reports no usable credentials. Login reuses ~/.codex/auth.json, shared with the CLI. */
export function LoginGate() {
  const account = useConn((s) => s.account);
  const login = useConn((s) => s.login);
  const codex = useConn((s) => s.codex);
  if (!account || account.account || !account.requiresOpenaiAuth) return null;

  return (
    <div className="overlay solid">
      <div className="login">
        <div className="brand-mark">ret</div>
        <h2>Sign in to Codex</h2>
        <p className="muted">Use your ChatGPT plan — the same login as the Codex CLI. Credentials stay in your Codex home directory.</p>
        {login ? (
          <div className="login-pending">
            {login.kind === "device" && login.userCode ? (
              <>
                <p>Enter this code at {login.verificationUrl}</p>
                <div className="device-code">{login.userCode}</div>
              </>
            ) : (
              <p>
                <LoaderCircle size={14} className="spin" /> Finish signing in in your browser…
              </p>
            )}
            {login.error && <div className="setting-error">{login.error}</div>}
            <div className="row-gap">
              {login.authUrl && (
                <button className="btn" onClick={() => void bridge.shell.openExternal(login.authUrl!)}>
                  Open browser again
                </button>
              )}
              <button className="btn ghost" onClick={() => void cancelLogin()}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="row-gap col">
            <button className="btn primary big" disabled={codex?.state !== "running"} onClick={() => void startLogin("browser")}>
              <LogIn size={15} /> Sign in with ChatGPT
            </button>
            <button className="btn ghost" disabled={codex?.state !== "running"} onClick={() => void startLogin("device")}>
              <Smartphone size={14} /> Use a device code instead
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
