import { createHash } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import * as tar from "tar";
import type { UpdaterSettings, UpdaterState } from "../../shared/bridge";
import { compareVersions, platformTag, probeVersion, vendorPaths } from "./platform";

const REGISTRY = "https://registry.npmjs.org";
const PKG = "@openai/codex";

const DEFAULT_SETTINGS: UpdaterSettings = {
  source: "managed",
  autoUpdate: true,
  channel: "latest",
  customPath: null,
  checkIntervalHours: 2,
  engine: "dedicated",
};

interface Manifest {
  current: string | null;
}

/**
 * Keeps a private, auto-updating copy of the codex CLI under userData/codex.
 *
 * Each version is extracted from the platform-specific npm tarball
 * (`@openai/codex@<ver>-<platform>`) into its own directory, verified against
 * the registry's sha512 integrity, smoke-tested with `--version`, and only then
 * promoted. The running app-server is never touched mid-turn: a new version is
 * "staged" and the renderer applies it once every thread is idle.
 */
export class CodexUpdater {
  private state: UpdaterState;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;

  constructor(
    private readonly root: string,
    private readonly settingsFile: string,
    private readonly emit: (state: UpdaterState) => void,
  ) {
    this.state = {
      settings: { ...DEFAULT_SETTINGS },
      phase: "idle",
      progress: null,
      latest: null,
      running: null,
      staged: null,
      installed: [],
      lastCheckedAt: null,
      error: null,
    };
  }

  get settings() {
    return this.state.settings;
  }

  snapshot(): UpdaterState {
    return structuredClone(this.state);
  }

  async init() {
    try {
      // Tolerate a UTF-8 BOM (e.g. the file was edited with PowerShell's Set-Content).
      const saved = JSON.parse((await readFile(this.settingsFile, "utf8")).replace(/^﻿/, ""));
      this.state.settings = { ...DEFAULT_SETTINGS, ...saved };
    } catch {
      /* first run */
    }
    await mkdir(this.versionsDir, { recursive: true });
    this.state.installed = await this.listInstalled();
  }

  private get versionsDir() {
    return join(this.root, "versions");
  }

  private set(patch: Partial<UpdaterState>) {
    Object.assign(this.state, patch);
    this.emit(this.snapshot());
  }

  async setSettings(patch: Partial<UpdaterSettings>) {
    this.state.settings = { ...this.state.settings, ...patch };
    await writeFile(this.settingsFile, JSON.stringify(this.state.settings, null, 2));
    this.schedule();
    this.emit(this.snapshot());
  }

  /** Whether the running app-server is Ret's managed copy (vs a system/custom fallback). */
  private runningManaged = false;

  setRunning(version: string | null, managed: boolean) {
    this.runningManaged = managed;
    const staged = this.state.staged && this.isUpgrade(this.state.staged) ? this.state.staged : null;
    this.set({ running: version, staged });
  }

  /** A managed build should replace what's running if it's newer, or if we're running a fallback. */
  private isUpgrade(version: string) {
    const running = this.state.running;
    return !this.runningManaged || !running || compareVersions(version, running) > 0;
  }

  /** Path to the binary for the version the manifest marks as current, if installed. */
  async currentManaged(): Promise<{ version: string; binary: string; pathDir: string } | null> {
    const manifest = await this.readManifest();
    const candidates = [manifest.current, ...this.state.installed.slice().sort(compareVersions).reverse()];
    for (const version of candidates) {
      if (!version) continue;
      const paths = vendorPaths(join(this.versionsDir, version));
      if (existsSync(paths.binary)) return { version, ...paths };
    }
    return null;
  }

  schedule() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const s = this.state.settings;
    if (!s.autoUpdate || s.source !== "managed" || s.engine === "shared") return;
    const ms = Math.max(0.25, this.state.settings.checkIntervalHours) * 3_600_000;
    this.timer = setInterval(() => void this.check(), ms);
  }

  /** Check the registry and, when a newer build exists, download + stage it. */
  check(opts: { install?: boolean } = {}): Promise<void> {
    if (this.inflight) return this.inflight;
    const install = opts.install ?? this.state.settings.autoUpdate;
    this.inflight = this.doCheck(install).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async doCheck(install: boolean) {
    this.set({ phase: "checking", error: null });
    try {
      const latest = await this.fetchLatestVersion();
      this.set({ latest, lastCheckedAt: Date.now() });
      // Managed mode is judged by the managed copy alone (a system codex we fell back to
      // doesn't count); other sources just report whether the running build is current.
      const managed = this.state.settings.source === "managed";
      const have = managed ? (await this.readManifest()).current : this.state.running;
      if (have && compareVersions(latest, have) <= 0) {
        this.set({ phase: "upToDate" });
        return;
      }
      if (!install || !managed) {
        this.set({ phase: "idle" });
        return;
      }
      await this.install(latest);
    } catch (err) {
      this.set({ phase: "error", progress: null, error: (err as Error).message });
    }
  }

  private async fetchJson(url: string) {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
    return res.json() as Promise<any>;
  }

  async fetchLatestVersion(): Promise<string> {
    const tags = await this.fetchJson(`${REGISTRY}/-/package/${PKG}/dist-tags`);
    const tag = this.state.settings.channel === "alpha" ? "alpha" : "latest";
    const version: string | undefined = tags[tag];
    if (!version) throw new Error(`No "${tag}" dist-tag for ${PKG}`);
    return version;
  }

  /** Download, verify, extract and promote `version`. */
  async install(version: string) {
    const target = join(this.versionsDir, version);
    if (existsSync(vendorPaths(target).binary)) {
      await this.promote(version);
      return;
    }

    const meta = await this.fetchJson(`${REGISTRY}/${PKG}/${version}-${platformTag()}`);
    const tarballUrl: string = meta?.dist?.tarball;
    const integrity: string = meta?.dist?.integrity;
    if (!tarballUrl || !integrity?.startsWith("sha512-")) throw new Error("Registry metadata missing tarball/integrity");

    const staging = join(this.root, `.staging-${version}-${Date.now()}`);
    const archive = `${staging}.tgz`;
    await mkdir(staging, { recursive: true });

    try {
      // Download with progress, hashing as we go.
      this.set({ phase: "downloading", progress: 0 });
      const res = await fetch(tarballUrl);
      if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
      const total = Number(res.headers.get("content-length")) || 0;
      const hash = createHash("sha512");
      let received = 0;
      let lastEmit = 0;
      const meter = new Transform({
        transform: (chunk: Buffer, _enc, cb) => {
          hash.update(chunk);
          received += chunk.length;
          const now = Date.now();
          if (total && now - lastEmit > 120) {
            lastEmit = now;
            this.set({ progress: received / total });
          }
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body as any), meter, createWriteStream(archive));

      this.set({ phase: "verifying", progress: null });
      const digest = `sha512-${hash.digest("base64")}`;
      if (digest !== integrity) throw new Error("Integrity check failed for downloaded codex tarball");

      this.set({ phase: "extracting" });
      await tar.x({ file: archive, cwd: staging, strip: 1 });

      const { binary } = vendorPaths(staging);
      const probed = await probeVersion(binary);
      if (!probed) throw new Error("Downloaded codex binary failed its --version smoke test");

      await rm(target, { recursive: true, force: true });
      await renameWithRetry(staging, target);
      await this.promote(version);
    } finally {
      await rm(archive, { force: true }).catch(() => {});
      await rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async promote(version: string) {
    await writeFile(join(this.root, "manifest.json"), JSON.stringify({ current: version } satisfies Manifest));
    const installed = await this.listInstalled();
    const staged = this.state.settings.source === "managed" && this.isUpgrade(version) ? version : null;
    this.set({ phase: staged ? "ready" : "upToDate", progress: null, installed, staged });
    void this.prune(version);
  }

  /** Keep the current and previous managed versions (for rollback); remove the rest. */
  private async prune(current: string) {
    const keep = new Set([current, this.state.running].filter(Boolean) as string[]);
    const sorted = this.state.installed.slice().sort(compareVersions).reverse();
    const previous = sorted.find((v) => !keep.has(v));
    if (previous) keep.add(previous);
    for (const v of sorted) {
      if (!keep.has(v)) await rm(join(this.versionsDir, v), { recursive: true, force: true }).catch(() => {});
    }
    // Leftover staging dirs from interrupted downloads.
    for (const entry of await readdir(this.root).catch(() => [] as string[])) {
      if (entry.startsWith(".staging-")) await rm(join(this.root, entry), { recursive: true, force: true }).catch(() => {});
    }
    this.set({ installed: await this.listInstalled() });
  }

  private async readManifest(): Promise<Manifest> {
    try {
      return JSON.parse(await readFile(join(this.root, "manifest.json"), "utf8"));
    } catch {
      return { current: null };
    }
  }

  private async listInstalled(): Promise<string[]> {
    const entries = await readdir(this.versionsDir).catch(() => [] as string[]);
    return entries.filter((v) => existsSync(vendorPaths(join(this.versionsDir, v)).binary)).sort(compareVersions);
  }
}

/** Windows: antivirus/indexers briefly lock a freshly executed binary, so a rename right after can EPERM. */
async function renameWithRetry(from: string, to: string, attempts = 8) {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (i >= attempts - 1 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
}
