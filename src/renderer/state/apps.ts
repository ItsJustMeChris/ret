import type { AppKind, ModeApp } from "./ui";

/**
 * What the state code needs to know of Ret's apps. Their registry (src/renderer/apps) installs them
 * at start: they aren't imported here because they're React views, and this code runs on the phone
 * too, which has none of them.
 */
export interface AppBasics {
  kind: AppKind;
  /** A new window's size on the canvas. */
  size: { w: number; h: number };
  /** Full-screen modes only. */
  mode?: {
    /** Take a thread or file opened while the mode shows (Inbox: into its reading pane); false: it opens as anywhere else. */
    openThread?: (id: string) => boolean;
  };
}

const installed = new Map<AppKind, AppBasics>();

export function installApps(apps: readonly AppBasics[]) {
  for (const app of apps) installed.set(app.kind, app);
}

export const appBasics = (kind: AppKind) => installed.get(kind);
export const modeBasics = (mode: ModeApp) => installed.get(mode)?.mode;
