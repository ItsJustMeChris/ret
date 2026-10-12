import { useState } from "react";
import { Download } from "lucide-react";
import { useConn } from "../state/conn";
import { useThreads } from "../state/threads";
import { bridge } from "../bridge";

/** Asks before restarting into a downloaded Ret update. "Later" leaves it to install on the next quit. */
export function AppUpdatePrompt() {
  const update = useConn((s) => s.appUpdate);
  const busy = useThreads((s) => Object.values(s.live).some((l) => l.activeTurnId));
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (update?.phase !== "ready" || !update.version || dismissed === update.version) return null;
  const version = update.version;
  return (
    <div className="toast update" role="status">
      <Download size={14} />
      <div className="toast-body">
        <div>Ret {version} is ready to install</div>
        <div className="muted small">
          {busy ? "Restarting now stops running turns. " : ""}If you wait, it installs the next time you quit.
        </div>
        <div className="toast-actions">
          <button className="btn ghost" onClick={() => setDismissed(version)}>
            Later
          </button>
          <button className="btn primary" onClick={() => void bridge.appUpdate.install()}>
            Restart now
          </button>
        </div>
      </div>
    </div>
  );
}
