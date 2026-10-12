import { existsSync, statSync, openSync, readSync, closeSync, realpathSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

/** Rust target triple for the current machine, mirroring @openai/codex/bin/codex.js. */
export function targetTriple(): string {
  const { platform, arch } = process;
  const table: Record<string, Record<string, string>> = {
    linux: { x64: "x86_64-unknown-linux-musl", arm64: "aarch64-unknown-linux-musl" },
    darwin: { x64: "x86_64-apple-darwin", arm64: "aarch64-apple-darwin" },
    win32: { x64: "x86_64-pc-windows-msvc", arm64: "aarch64-pc-windows-msvc" },
  };
  const triple = table[platform]?.[arch];
  if (!triple) throw new Error(`Unsupported platform: ${platform} (${arch})`);
  return triple;
}

/** npm dist-tag suffix for the platform-specific codex package, e.g. "win32-x64". */
export function platformTag(): string {
  return `${process.platform}-${process.arch}`;
}

export const EXE = process.platform === "win32" ? "codex.exe" : "codex";

/** Layout of an extracted `@openai/codex@<ver>-<platform>` package root. */
export function vendorPaths(packageRoot: string) {
  const base = join(packageRoot, "vendor", targetTriple());
  return {
    binary: join(base, "bin", EXE),
    pathDir: join(base, "codex-path"),
  };
}

function isNativeBinary(file: string): boolean {
  try {
    if (statSync(file).size < 1_000_000) return false; // launchers/shims are tiny
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(2);
    readSync(fd, buf, 0, 2, 0);
    closeSync(fd);
    return buf.toString() !== "#!";
  } catch {
    return false;
  }
}

function which(cmd: string): Promise<string[]> {
  const tool = process.platform === "win32" ? "where" : "which";
  const args = process.platform === "win32" ? [cmd] : ["-a", cmd];
  return new Promise((resolve) => {
    execFile(tool, args, { windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    });
  });
}

/**
 * Locate a codex binary the user installed themselves (npm, bun, brew, ...).
 * npm/bun install a tiny launcher on PATH, so we look past it for the native
 * vendor binary — spawning it directly avoids an extra node process and keeps
 * process-tree shutdown reliable on Windows.
 */
export async function findSystemCodex(): Promise<{ binary: string; pathDir: string | null } | null> {
  const pkg = `codex-${platformTag()}`;
  const home = homedir();
  const roots = [
    join(home, ".bun", "install", "global", "node_modules"),
    process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules") : null,
    "/usr/local/lib/node_modules",
    "/opt/homebrew/lib/node_modules",
    "/usr/lib/node_modules",
    join(home, ".npm-global", "lib", "node_modules"),
  ].filter((r): r is string => !!r);

  const candidates: string[] = [];
  for (const root of roots) {
    candidates.push(join(root, "@openai", pkg));
    candidates.push(join(root, "@openai", "codex", "node_modules", "@openai", pkg));
    candidates.push(join(root, "@openai", "codex"));
  }

  // Also derive package roots from whatever `codex` resolves to on PATH.
  for (const hit of await which("codex")) {
    if (isNativeBinary(hit)) return { binary: hit, pathDir: null };
    try {
      const real = realpathSync(hit);
      if (isNativeBinary(real)) return { binary: real, pathDir: null };
      const pkgRoot = dirname(dirname(real)); // .../@openai/codex/bin/codex.js -> .../@openai/codex
      candidates.push(join(pkgRoot, "node_modules", "@openai", pkg));
      candidates.push(join(dirname(pkgRoot), pkg));
      candidates.push(pkgRoot);
    } catch {
      /* broken link */
    }
  }

  for (const root of candidates) {
    const { binary, pathDir } = vendorPaths(root);
    if (existsSync(binary) && isNativeBinary(binary)) {
      return { binary, pathDir: existsSync(pathDir) ? pathDir : null };
    }
  }
  return null;
}

/** Runs `<binary> --version` and parses "codex-cli 0.162.1". */
export function probeVersion(binary: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(binary, ["--version"], { windowsHide: true, timeout: 15_000 }, (err, stdout) => {
      if (err) return resolve(null);
      const m = /(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(stdout);
      resolve(m ? m[1] : null);
    });
  });
}

/** Semver-ish compare that understands prerelease suffixes (0.163.0-alpha.5 < 0.163.0). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split("-", 2);
    return { nums: core.split(".").map((n) => parseInt(n, 10) || 0), pre: pre ?? null };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d) return d;
  }
  if (pa.pre === pb.pre) return 0;
  if (pa.pre === null) return 1;
  if (pb.pre === null) return -1;
  return pa.pre.localeCompare(pb.pre, undefined, { numeric: true });
}
