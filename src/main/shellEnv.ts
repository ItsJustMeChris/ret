import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";

/**
 * A GUI launch on macOS (Finder, Dock, Spotlight) hands the app launchd's bare environment:
 * PATH=/usr/bin:/bin:/usr/sbin:/sbin and nothing from the user's shell profile. Everything Ret
 * spawns — codex app-server, Claude, ACP agents, and through them MCP servers and hooks — would
 * then miss `npx`, `uvx`, brew and bun installs, and any exported variables.
 *
 * Like the Codex and Claude desktop apps (and VS Code), we run the user's login shell once,
 * interactively so .zshrc/.bashrc are read too, dump its environment between markers, and merge
 * it into process.env before anything is spawned.
 */

const TIMEOUT_MS = 5_000;

// Keep the shell from doing interactive-only work (oh-my-zsh update prompts, tmux autostart).
const GUARDS: Record<string, string> = {
  DISABLE_AUTO_UPDATE: "true",
  ZSH_DISABLE_COMPFIX: "true",
  ZSH_TMUX_AUTOSTART: "false",
  ZSH_TMUX_AUTOSTARTED: "true",
  RET_RESOLVING_ENVIRONMENT: "1",
};
// Per-shell bookkeeping that describes the throwaway shell, not the user's environment.
const SKIP = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function userShell(): string {
  try {
    const shell = userInfo().shell;
    if (shell) return shell;
  } catch {
    /* no passwd entry */
  }
  return process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
}

function readShellEnv(shell: string): Promise<Record<string, string>> {
  const mark = `__RET_ENV_${randomUUID().replace(/-/g, "")}__`;
  const script = `printf '\\0%s\\0' '${mark}'; command env -0 || exit; printf '\\0%s\\0' '${mark}'; exit`;
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ["-i", "-l", "-c", script], {
      env: { ...process.env, ...GUARDS },
      stdio: ["ignore", "pipe", "ignore"],
      detached: true, // its own process group, so a timeout takes down anything the profile started
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      reject(new Error(`${shell} took longer than ${TIMEOUT_MS / 1000}s to start`));
    }, TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    // Resolve on exit, not close: a background process started by the profile can hold stdout open.
    child.on("exit", () => {
      clearTimeout(timer);
      child.stdout.destroy();
      const [, body] = out.split(`\0${mark}\0`);
      if (body == null) return reject(new Error(`${shell} printed no environment`));
      const env: Record<string, string> = {};
      for (const entry of body.split("\0")) {
        const eq = entry.indexOf("=");
        if (eq <= 0) continue;
        const key = entry.slice(0, eq);
        if (NAME.test(key) && !SKIP.has(key)) env[key] = entry.slice(eq + 1);
      }
      for (const [key, value] of Object.entries(GUARDS)) if (env[key] === value) delete env[key];
      resolve(env);
    });
  });
}

/** Merges the login shell's environment into process.env. Never throws; Windows is left alone. */
export async function loadShellEnv(): Promise<void> {
  if (process.platform === "win32") return;
  const shell = userShell();
  try {
    const env = await readShellEnv(shell);
    if (!env.PATH) return;
    Object.assign(process.env, env);
  } catch (err) {
    console.warn(`[ret] Could not read the login shell environment: ${(err as Error).message}`);
  }
}
