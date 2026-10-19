import type { ComponentType } from "react";
import type { LucideIcon } from "lucide-react";
import type { MenuItem } from "../components/Menu";
import type { AppBasics } from "../state/apps";
import type { AppKind, ModeApp } from "../state/ui";

/** Which of an app's windows: its instance (a terminal's id), or null for an app with a single window. */
export type Instance = { instance: string | null };

/** What an app that's also a full-screen mode adds (its button in the title bar, Alt+3 onwards). */
export interface AppMode {
  /** Its button's tooltip, before the shortcut: what the mode is for. */
  hint: string;
  /** Its command in the palette. */
  command: string;
  /** Take a thread or file opened while the mode shows; false: it opens as anywhere else. */
  openThread?: (id: string) => boolean;
  /** The thread it's showing: the palette's and the shortcuts' current thread. */
  currentThread?: () => string | null;
  /** Ctrl+Tab, Ctrl+W and Ctrl+1…9 while it shows, for a mode with tabs of its own (Code's files). */
  tabs?: { cycle(dir: 1 | -1): void; close(): void; go(n: number): void };
}

interface AppParts extends AppBasics {
  name: string;
  icon: LucideIcon;
  /**
   * "one": a single window (`app:<kind>`), placed from the canvas's menu (and a mode's button);
   * "many": a window per instance (`app:<kind>:<instance>`), opened by the app's own commands.
   */
  instances: "one" | "many";
  /**
   * The view: the same in its window as full screen, so the window is the mode under a title bar.
   * `active`: it has the keyboard (always as a mode; while its window is focused on the canvas).
   */
  View: ComponentType<Instance & { active: boolean }>;
  /** Zoomed out, its card's body and state line (`.tcard-body`, `.tcard-state`) under the icon and title. */
  Card: ComponentType<Instance>;
  /** Its window's (and card's) title: the app's name if it has none. */
  useTitle?: (instance: string | null) => string;
  /** A count by its name, in its window's title bar and on its mode's button. */
  Badge?: ComponentType;
  /** Chips after its window's title (a terminal's device, folder and thread). */
  Chips?: ComponentType<Instance>;
  /** Buttons before its window's own (a terminal's New shell and End). */
  Actions?: ComponentType<Instance>;
  /** The folder relative paths in its window are from (hover cards and right-click menus read it). */
  useCwd?: (instance: string | null) => string | null | undefined;
  /** At the top of its window's right-click menu. */
  menu?: (instance: string | null) => MenuItem[];
}

/**
 * One of Ret's apps: a view that's a window on the canvas desktop, and a full-screen mode too if its
 * kind is a ModeApp. The registry (index.ts) lists them; the canvas, title bar, palette and
 * shortcuts take everything they show of an app from here.
 */
export type RetApp<K extends AppKind = AppKind> = K extends AppKind
  ? AppParts & { kind: K } & (K extends ModeApp ? { mode: AppMode } : { mode?: undefined })
  : never;
