import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, extname, isAbsolute, join } from "node:path";

/**
 * Finding and starting an ACP agent: a program Ret runs as a subprocess and talks JSON-RPC to
 * over its stdin/stdout. Ret never installs one; it runs what the user has.
 */

/** A program and its arguments, as Ret starts it. */
export interface AcpCommand {
  program: string;
  args: string[];
}

/** A command line split into words: quotes group, backslashes are kept (they're Windows paths). */
export function splitCommand(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: string | null = null;
  let any = false;
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      any = true;
    } else if (/\s/.test(ch)) {
      if (word || any) words.push(word);
      word = "";
      any = false;
    } else word += ch;
  }
  if (word || any) words.push(word);
  return words;
}

const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Where a command runs from: a path as given, or the first match on PATH (with Windows' extensions). */
export function resolveProgram(name: string): string | null {
  const exts = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)] : [""];
  const withExt = (base: string) => {
    // On Windows an extensionless file next to the .exe (a shell script for Git Bash) can't be started.
    for (const e of exts) if ((e || process.platform !== "win32" || extname(base)) && isFile(base + e)) return base + e;
    return null;
  };
  if (isAbsolute(name) || name.includes("/") || name.includes("\\")) return withExt(name);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const hit = withExt(join(dir, name));
    if (hit) return hit;
  }
  return null;
}

/**
 * OpenCode where its installers put it (its own script, Homebrew, bun, npm), else on PATH.
 * npm's launcher (opencode.cmd) works too: it's started through the shell.
 */
export function findOpencode(): string | null {
  const home = homedir();
  const exe = process.platform === "win32" ? "opencode.exe" : "opencode";
  const direct = [join(home, ".opencode", "bin", exe), join(home, ".bun", "bin", exe), "/opt/homebrew/bin/opencode", "/usr/local/bin/opencode", join(home, ".local", "bin", "opencode")];
  return direct.find((p) => existsSync(p) && isFile(p)) ?? resolveProgram("opencode");
}

/** Windows starts batch files (npm's launchers) only through cmd.exe. */
const needsShell = (program: string) => process.platform === "win32" && /\.(cmd|bat)$/i.test(program);

/** Quoted for cmd.exe, for a batch file's arguments. */
const cmdQuote = (s: string) => (/^[\w./:\\=@-]+$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);

export function spawnAgent(cmd: AcpCommand, env: NodeJS.ProcessEnv): ChildProcess {
  const opts = { cwd: homedir(), env, stdio: ["pipe", "pipe", "pipe"] as ("pipe")[], windowsHide: true };
  if (needsShell(cmd.program)) return spawn([cmd.program, ...cmd.args].map(cmdQuote).join(" "), { ...opts, shell: true });
  return spawn(cmd.program, cmd.args, opts);
}

/** `<program> --version`, for an agent that doesn't say its own in `initialize`. */
export function probeVersion(program: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(program, ["--version"], { windowsHide: true, timeout: 15_000, shell: needsShell(program) }, (err, stdout) => {
      const m = !err && /(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(stdout);
      resolve(m ? m[1] : null);
    });
  });
}

/** The command line that runs a program with these arguments, for a terminal window. */
export function commandLine(program: string, args: string[]): string {
  const q = process.platform === "win32" ? cmdQuote : (s: string) => (/^[\w./:=@-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`);
  return [program, ...args].map(q).join(" ");
}
