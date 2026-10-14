import { useState } from "react";
import { AppWindow, ChevronDown, Globe } from "lucide-react";
import { useThreads } from "../../state/threads";
import { appLabel, useAppInfo, useScreens, type ComputerUse } from "../../state/computerUse";
import { openImage } from "../ImageViewer";
import { Shimmer } from "../ui/Shimmer";

/** The app's own icon when it's installed here; a generic window (or globe, for the browser) otherwise. */
export function AppIcon({ use, size = 14 }: { use: ComputerUse; size?: number }) {
  const info = useAppInfo(use.kind === "app" ? use.appId : null);
  if (info?.icon) return <img className="app-icon" src={info.icon} width={size} height={size} alt="" draggable={false} />;
  return use.kind === "browser" ? <Globe size={size - 1} /> : <AppWindow size={size - 1} />;
}

export function AppName({ use }: { use: ComputerUse }) {
  const info = useAppInfo(use.kind === "app" ? use.appId : null);
  return <>{appLabel(use, info)}</>;
}

/** The computer-use step a running turn is on, if it's on one. */
export function useLiveScreen(threadId: string) {
  const activeTurn = useThreads((s) => s.live[threadId]?.activeTurnId ?? null);
  const screen = useScreens((s) => s.latest[threadId]);
  return activeTurn && screen?.turnId === activeTurn ? screen : null;
}

/**
 * While the agent is using an app: which one, the window it's in, what it's doing, and the last
 * screenshot it sent back of that window (not a live view). Docks above the composer; folds down to one line.
 */
export function ScreenDock({ threadId, compact }: { threadId: string; compact?: boolean }) {
  const screen = useLiveScreen(threadId);
  const [folded, setFolded] = useState<boolean | null>(null);
  if (!screen) return null;
  const { use, shot } = screen;
  const open = !!shot && !(folded ?? compact);
  return (
    <div className={`screen-dock ${open ? "open" : ""}`}>
      <button
        className="screen-head"
        onClick={() => setFolded(open)}
        disabled={!shot}
        title={!shot ? "No screenshot of this window yet" : open ? "Hide the window's last screenshot" : "Show the window's last screenshot"}
      >
        <span className="screen-app">
          <AppIcon use={use} size={16} />
          <AppName use={use} />
        </span>
        {use.window && <span className="screen-window">{use.window}</span>}
        <span className="screen-step">
          <Shimmer text={use.title ?? "Using the computer"} />
        </span>
        {shot && <ChevronDown className="screen-chev" size={13} />}
      </button>
      {open && (
        <button className="screen-shot" onClick={() => openImage({ src: shot, alt: use.window ?? appLabel(use) })} title="Open full size">
          <img src={shot} alt={use.window ?? ""} draggable={false} />
        </button>
      )}
    </div>
  );
}

/** A tiny canvas window watching an agent use an app: the window itself, labeled. */
export function ScreenGlance({ threadId }: { threadId: string }) {
  const screen = useLiveScreen(threadId);
  if (!screen?.shot) return null;
  return (
    <div className="screen-glance">
      <img src={screen.shot} alt="" draggable={false} />
      <span className="screen-glance-label">
        <AppIcon use={screen.use} size={13} />
        <AppName use={screen.use} />
      </span>
    </div>
  );
}
