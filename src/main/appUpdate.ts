// Keeps Ret itself current from GitHub Releases (see `build.publish` in package.json).
// Updates download in the background; the renderer asks before restarting into one,
// and a declined update installs on the next quit.
import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { AppUpdateState } from "../shared/bridge";

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 15_000;

export class AppUpdater {
  state: AppUpdateState = {
    phase: app.isPackaged ? "idle" : "unsupported",
    version: null,
    progress: null,
    lastCheckedAt: null,
    error: null,
  };

  constructor(private onState: (state: AppUpdateState) => void) {
    if (!app.isPackaged) return;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null;
    autoUpdater.on("checking-for-update", () => this.set({ phase: "checking", error: null }));
    autoUpdater.on("update-not-available", () => this.set({ phase: "upToDate", lastCheckedAt: Date.now() }));
    autoUpdater.on("update-available", (info) =>
      this.set({ phase: "downloading", version: info.version, progress: 0, lastCheckedAt: Date.now() }),
    );
    autoUpdater.on("download-progress", (p) => this.set({ progress: p.percent / 100 }));
    autoUpdater.on("update-downloaded", (info) => this.set({ phase: "ready", version: info.version, progress: null }));
    autoUpdater.on("error", (err) => this.set({ phase: "error", progress: null, error: err.message }));
  }

  private set(patch: Partial<AppUpdateState>) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }

  async check() {
    const { phase } = this.state;
    if (phase === "unsupported" || phase === "checking" || phase === "downloading" || phase === "ready") return;
    try {
      const result = await autoUpdater.checkForUpdates();
      // Download failures already arrive through the "error" event.
      result?.downloadPromise?.catch(() => {});
    } catch (err) {
      this.set({ phase: "error", error: (err as Error).message });
    }
  }

  schedule() {
    if (!app.isPackaged) return;
    setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS);
    setInterval(() => void this.check(), CHECK_EVERY_MS);
  }

  install() {
    if (this.state.phase !== "ready") return;
    // Silent so the one-click installer doesn't flash its window; relaunch Ret afterwards.
    autoUpdater.quitAndInstall(true, true);
  }
}
