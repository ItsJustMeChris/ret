import { CircleAlert, Info, X } from "lucide-react";
import { dismissToast, useToasts } from "../state/toasts";
import { AppUpdatePrompt } from "./AppUpdatePrompt";

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  // Always mounted (an empty stack takes no space) so the update prompt keeps its "Later" state.
  return (
    <div className="toasts">
      <AppUpdatePrompt />
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`} role="status">
          {t.kind === "error" ? <CircleAlert size={14} /> : <Info size={14} />}
          <span>{t.message}</span>
          <button className="icon-btn tiny" onClick={() => dismissToast(t.id)}>
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
