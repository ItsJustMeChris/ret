import { execFile } from "node:child_process";
import type { EngineUpdate } from "../../shared/bridge";
import { compareVersions } from "../codex/platform";
import { claudeEnv } from "./platform";

const REGISTRY = "https://registry.npmjs.org/@anthropic-ai/claude-code/latest";
const CHECK_EVERY_MS = 4 * 3_600_000;
const IDLE_RETRY_MS = 60_000;

export interface ClaudeUpdaterHost {
  binary(): string | null;
  version(): string | null;
  /** A Claude turn is running somewhere (updating swaps the binary under it). */
  busy(): boolean;
  /** Stop idle Claude Code processes so the binary can be replaced. */
  closeIdle(): void;
  changed(state: EngineUpdate): void;
  /** Called after an update: find the binary again and reconnect on the new version. */
  updated(): Promise<void>;
}

/**
 * Keeps the user's own Claude Code current, so its model list does too. Claude Code updates itself
 * when used interactively, but not when the Agent SDK runs it, so Ret runs its updater
 * (`claude update`, which knows whether it came from the native installer, npm or Homebrew) when
 * npm has a newer release and no Claude thread is busy.
 */
export class ClaudeUpdater {
  state: EngineUpdate = { phase: "idle", latest: null, error: null, checkedAt: null, auto: true };
  private timer: NodeJS.Timeout | null = null;
  private waiting: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly host: ClaudeUpdaterHost) {}

  private set(patch: Partial<EngineUpdate>) {
    this.state = { ...this.state, ...patch };
    this.host.changed(this.state);
  }

  /** Background checks every few hours; `auto` also installs what they find. */
  schedule(auto: boolean) {
    this.stop();
    this.set({ auto });
    this.timer = setInterval(() => void this.check({ install: this.state.auto }), CHECK_EVERY_MS);
    void this.check({ install: auto });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.waiting) clearTimeout(this.waiting);
    this.timer = this.waiting = null;
  }

  /** Is a newer Claude Code out? With `install`, update to it (once nothing is running). */
  check(opts: { install: boolean }): Promise<void> {
    this.running ??= (async () => {
      try {
        this.set({ phase: "checking", error: null });
        const res = await fetch(REGISTRY, { headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(`npm registry: HTTP ${res.status}`);
        const latest = String(((await res.json()) as { version?: string }).version ?? "") || null;
        this.set({ latest, checkedAt: Date.now(), phase: "idle" });
        const current = this.host.version();
        if (opts.install && latest && current && compareVersions(latest, current) > 0) await this.install();
      } catch (err) {
        this.set({ phase: "error", error: (err as Error).message });
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async install() {
    if (this.host.busy()) {
      // Never swap the binary under a running turn; try again once it's quiet.
      this.set({ phase: "waiting" });
      if (this.waiting) clearTimeout(this.waiting);
      this.waiting = setTimeout(() => {
        this.waiting = null;
        void this.check({ install: true });
      }, IDLE_RETRY_MS);
      return;
    }
    const binary = this.host.binary();
    if (!binary) return;
    this.set({ phase: "updating", error: null });
    this.host.closeIdle();
    const before = this.host.version();
    try {
      await run(binary, ["update"]);
    } catch (err) {
      this.set({ phase: "error", error: `claude update failed: ${(err as Error).message}` });
      return;
    }
    await this.host.updated();
    const after = this.host.version();
    this.set(
      after && before && compareVersions(after, before) > 0
        ? { phase: "idle" }
        : { phase: "error", error: "claude update finished, but the version didn't change. Update it yourself (claude update) or reinstall." },
    );
  }
}

function run(binary: string, args: string[]): Promise<string> {
  const js = /\.[cm]?js$/i.test(binary);
  return new Promise((resolve, reject) => {
    execFile(js ? "node" : binary, js ? [binary, ...args] : args, { windowsHide: true, timeout: 5 * 60_000, env: claudeEnv() }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || stdout).trim().split(/\r?\n/).slice(-3).join(" ") || err.message));
      else resolve(stdout);
    });
  });
}
