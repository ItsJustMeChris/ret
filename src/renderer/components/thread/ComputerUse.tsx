import { memo, useState } from "react";
import { AppWindow, Globe } from "lucide-react";
import { Chevron } from "../ui/Chevron";
import { useThread } from "../../state/useThread";
import { hostOfThread } from "../../state/threads";
import { appLabel, useAppInfo, useScreen, type ComputerUse, type Screen, type Shot } from "../../state/computerUse";
import { openImage } from "../ImageViewer";
import { Shimmer } from "../ui/Shimmer";

/** The app's own icon when it's installed here; a generic window (or globe, for the browser) otherwise. */
export function AppIcon({ use, host = null, size = 14 }: { use: ComputerUse; host?: string | null; size?: number }) {
  const info = useAppInfo(use.kind === "app" ? use.appId : null, host);
  if (info?.icon) return <img className="app-icon" src={info.icon} width={size} height={size} alt="" decoding="async" draggable={false} />;
  return use.kind === "browser" ? <Globe size={size - 1} /> : <AppWindow size={size - 1} />;
}

/** `host`: the paired device the agent runs on (its apps are there); null for this computer. */
export function AppName({ use, host = null }: { use: ComputerUse; host?: string | null }) {
  const info = useAppInfo(use.kind === "app" ? use.appId : null, host);
  return <>{appLabel(use, info, host)}</>;
}

/** The computer-use step a running turn is on, if it's on one, and the last look it took at that app. */
export function useLiveScreen(threadId: string): { screen: Screen; shot: Shot | null } | null {
  const activeTurn = useThread(threadId, (s) => s.live[threadId]?.activeTurnId ?? null);
  const screen = useScreen((s) => s.latest[threadId]);
  const shot = useScreen((s) => {
    const l = s.latest[threadId];
    return (l?.shotId && s.shots[l.shotId]) || null;
  });
  return activeTurn && screen?.turnId === activeTurn ? { screen, shot } : null;
}

/**
 * While the agent is using an app: which one, the window it's in, what it's doing, and the last
 * screenshot it sent back of that window (not a live view). Docks above the composer; folds down to one line.
 */
export const ScreenDock = memo(function ScreenDock({ threadId, compact }: { threadId: string; compact?: boolean }) {
  const live = useLiveScreen(threadId);
  const host = useThread(threadId, () => hostOfThread(threadId));
  const [folded, setFolded] = useState<boolean | null>(null);
  if (!live) return null;
  const { use } = live.screen;
  const shot = live.shot;
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
          <AppIcon use={use} host={host} size={16} />
          <AppName use={use} host={host} />
        </span>
        {use.window && <span className="screen-window">{use.window}</span>}
        <span className="screen-step">
          <Shimmer text={use.title ?? "Using the computer"} />
        </span>
        {shot && <Chevron className="screen-chev" size={13} />}
      </button>
      {open && (
        <button className="screen-shot" onClick={() => openImage({ src: shot.url, alt: use.window ?? appLabel(use, null, host) })} title="Open full size">
          <img src={shot.thumb ?? shot.url} alt={use.window ?? ""} decoding="async" draggable={false} />
        </button>
      )}
    </div>
  );
});

/** A tiny canvas window watching an agent use an app: the window itself, labeled. */
export function ScreenGlance({ screen, shot, host }: { screen: Screen; shot: Shot; host: string | null }) {
  return (
    <div className="screen-glance">
      <img src={shot.thumb ?? shot.url} alt="" decoding="async" draggable={false} />
      <span className="screen-glance-label">
        <AppIcon use={screen.use} host={host} size={13} />
        <AppName use={screen.use} host={host} />
      </span>
    </div>
  );
}
