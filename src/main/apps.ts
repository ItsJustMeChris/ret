import { app, nativeImage } from "electron";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, extname, isAbsolute } from "node:path";
import type { AppInfo } from "../shared/bridge";

/**
 * Names and icons for the desktop apps an agent drives with computer use. Codex reports them by
 * bundle id on macOS (com.apple.finder) and by executable path on Windows; anything else, or an
 * app that isn't installed here, comes back empty and the UI falls back to what the agent said.
 */
const cache = new Map<string, Promise<AppInfo>>();

export function appInfo(appId: string): Promise<AppInfo> {
  let hit = cache.get(appId);
  if (!hit) {
    hit = lookup(appId).catch(() => ({ name: null, icon: null }));
    cache.set(appId, hit);
  }
  return hit;
}

async function lookup(appId: string): Promise<AppInfo> {
  const path = await locate(appId);
  if (!path) return { name: null, icon: null };
  // getFileIcon gives macOS's placeholder for apps whose icons live in an asset catalog; a
  // Quick Look thumbnail of the bundle is the real icon.
  const icon =
    process.platform === "darwin"
      ? await nativeImage.createThumbnailFromPath(path, { width: 64, height: 64 }).catch(() => null)
      : await app.getFileIcon(path, { size: "normal" }).catch(() => null);
  return { name: basename(path, extname(path)), icon: icon && !icon.isEmpty() ? icon.toDataURL() : null };
}

async function locate(appId: string): Promise<string | null> {
  if (isAbsolute(appId)) return existsSync(appId) ? appId : null;
  if (process.platform !== "darwin" || !/^[\w.-]+$/.test(appId)) return null;
  // Spotlight knows where every installed app lives by its bundle id.
  const out = await new Promise<string>((resolve) =>
    execFile("mdfind", [`kMDItemCFBundleIdentifier == "${appId}"`], { timeout: 5000 }, (err, stdout) => resolve(err ? "" : stdout)),
  );
  const apps = out.split("\n").filter((p) => p.endsWith(".app"));
  // Prefer the copy in an Applications folder over stray builds and DMG mounts.
  return apps.find((p) => /^\/(System\/)?Applications\//.test(p)) ?? apps[0] ?? null;
}
