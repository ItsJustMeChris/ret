import { app, nativeImage } from "electron";
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { AppInfo } from "../shared/bridge";

/**
 * Names and icons for the desktop apps an agent drives with computer use. Codex reports them by
 * bundle id on macOS (com.apple.finder) and by executable path on Windows. The id comes from what
 * the agent did, so only those shapes are looked up (on Windows, a local .exe: never a share or a
 * device path). Anything else, or an app that isn't installed here, comes back empty and the UI
 * falls back to what the agent said.
 */
const NONE: AppInfo = { name: null, icon: null };
/** Apps remembered, most recently asked for last. */
const cache = new Map<string, Promise<AppInfo>>();
const KEPT = 64;
const LOOKUP_MS = 5000;

export function appInfo(appId: unknown): Promise<AppInfo> {
  if (typeof appId !== "string" || !appId || appId.length > 1024) return Promise.resolve(NONE);
  const hit = cache.get(appId);
  if (hit) {
    cache.delete(appId);
    cache.set(appId, hit);
    return hit;
  }
  const p: Promise<AppInfo> = withTimeout(lookup(appId), LOOKUP_MS).catch(() => {
    if (cache.get(appId) === p) cache.delete(appId); // a lookup that failed is tried again next time
    return NONE;
  });
  cache.set(appId, p);
  if (cache.size > KEPT) cache.delete(cache.keys().next().value!);
  return p;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out")), ms);
    p.then(resolve, reject).finally(() => clearTimeout(t));
  });
}

async function lookup(appId: string): Promise<AppInfo> {
  const path = await locate(appId);
  if (!path) return NONE;
  if (process.platform === "darwin") {
    // getFileIcon gives macOS's placeholder for apps whose icons live in an asset catalog; a
    // Quick Look thumbnail of the bundle is the real icon.
    const icon = await nativeImage.createThumbnailFromPath(path, { width: 64, height: 64 });
    return { name: basename(path, extname(path)), icon: icon.isEmpty() ? null : icon.toDataURL() };
  }
  // An executable's file name is seldom what the app is called (msedge, WINWORD): what the agent
  // called it reads better, so only the icon comes from here.
  const icon = await app.getFileIcon(path, { size: "normal" });
  return { name: null, icon: icon.isEmpty() ? null : icon.toDataURL() };
}

async function locate(appId: string): Promise<string | null> {
  if (process.platform === "win32") {
    // A drive path (C:\…\app.exe): not \\server\share, \\?\ or \\.\, which reach past this machine's disks.
    if (!/^[A-Za-z]:[\\/]/.test(appId) || !/\.exe$/i.test(appId)) return null;
    const s = await stat(appId).catch(() => null);
    return s?.isFile() ? appId : null;
  }
  if (process.platform !== "darwin" || !/^[A-Za-z0-9.-]{1,255}$/.test(appId)) return null;
  // Spotlight knows where every installed app lives by its bundle id.
  const out = await new Promise<string>((resolve) =>
    execFile("mdfind", [`kMDItemCFBundleIdentifier == "${appId}"`], { timeout: LOOKUP_MS }, (err, stdout) => resolve(err ? "" : stdout)),
  );
  const apps = out.split("\n").filter((p) => p.endsWith(".app"));
  // Prefer the copy in an Applications folder over stray builds and DMG mounts.
  return apps.find((p) => /^\/(System\/)?Applications\//.test(p)) ?? apps[0] ?? null;
}
