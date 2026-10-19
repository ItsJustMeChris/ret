import { installApps } from "../state/apps";
import { appKind, type AppKind, type ModeApp, type ViewMode } from "../state/ui";
import type { RetApp } from "./app";
import { code } from "./code";
import { inbox } from "./inbox";
import { terminal } from "./terminal";

/**
 * Every app Ret has. Adding one: a module like these (a RetApp), its line here, and its kind in
 * AppKind (state/ui.ts), or in ModeApp if it's a full-screen mode too. In this order: the modes in
 * the title bar after Focus and Canvas, and the windows in the canvas's menu.
 */
export const APPS: { [K in AppKind]: RetApp<K> } = { code, inbox, terminal };

export const APP_LIST: readonly RetApp[] = Object.values(APPS);
export const MODE_APPS = APP_LIST.filter((app): app is RetApp<ModeApp> => !!app.mode);
/** Alt+1 onwards. */
export const VIEW_MODES: readonly ViewMode[] = ["focus", "canvas", ...MODE_APPS.map((app) => app.kind)];

/** The app an `app:…` window id is one of. */
export const appOf = (id: string): RetApp => APPS[appKind(id)];

installApps(APP_LIST);
