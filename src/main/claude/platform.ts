import { execFile } from "node:child_process";
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { openTerminalWindow } from "../terminalWindow";

/**
 * Locating and talking to the user's own Claude Code install. Ret never ships or downloads
 * Claude Code: it runs whatever the user installed, unmodified, signed in through its own flow.
 */

const EXE = process.platform === "win32" ? "claude.exe" : "claude";

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

/** Entry points inside an npm/bun `@anthropic-ai/claude-code` package: the native binary, or the older JS build. */
function packageEntries(pkgRoot: string): string[] {
  return [join(pkgRoot, "bin", EXE), join(pkgRoot, EXE), join(pkgRoot, "cli.js")];
}

/**
 * Find the `claude` the user installed: the native installer (~/.local/bin), Homebrew, or a
 * global npm/bun package. npm puts a launcher script on PATH (claude.cmd on Windows, which the
 * Agent SDK can't spawn), so we look past it for the package's own entry point.
 */
export async function findSystemClaude(): Promise<string | null> {
  const home = homedir();
  const direct = [
    join(home, ".local", "bin", EXE),
    join(home, ".claude", "local", EXE),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ];
  for (const p of direct) {
    try {
      if (existsSync(p) && isNativeBinary(realpathSync(p))) return realpathSync(p);
    } catch {
      /* broken link */
    }
  }

  const candidates: string[] = [];
  for (const hit of await which("claude")) {
    try {
      const real = realpathSync(hit);
      if (isNativeBinary(real)) return real;
      // npm shim dir (…/npm/claude.cmd) or a link into the package (…/claude-code/cli.js).
      candidates.push(...packageEntries(join(dirname(hit), "node_modules", "@anthropic-ai", "claude-code")));
      candidates.push(...packageEntries(dirname(real)), ...packageEntries(dirname(dirname(real))));
    } catch {
      /* broken link */
    }
  }
  const roots = [
    process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules") : null,
    join(home, ".bun", "install", "global", "node_modules"),
    "/usr/local/lib/node_modules",
    "/opt/homebrew/lib/node_modules",
    "/usr/lib/node_modules",
    join(home, ".npm-global", "lib", "node_modules"),
  ].filter((r): r is string => !!r);
  for (const root of roots) candidates.push(...packageEntries(join(root, "@anthropic-ai", "claude-code")));

  for (const c of candidates) {
    if (!existsSync(c)) continue;
    if (c.endsWith(".js") || isNativeBinary(c)) return c;
  }
  return null;
}

/** Where Claude Code keeps its state: transcripts (`projects/`), the session registry (`sessions/`). */
export const claudeConfigDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

/**
 * Environment for a claude process. Ret may itself have been started from inside a Claude Code
 * session (a terminal tab, a dev loop); that session's host variables would make the child think
 * it's a nested session talking to that host, so they're dropped. The user's own settings
 * (ANTHROPIC_API_KEY, CLAUDE_CONFIG_DIR, proxies…) pass through untouched.
 */
export function claudeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const hosted = !!(env.CLAUDECODE || env.CLAUDE_CODE_SESSION_ID || env.CLAUDE_CODE_HOST_SESSION_ID);
  for (const key of Object.keys(env)) {
    if (/^CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|HOST_SESSION_ID|CHILD_SESSION|MESSAGING_\w+|SDK_HAS_HOST_AUTH_REFRESH|EXECPATH|DESKTOP_APP_VERSION|OAUTH_SCOPES|SESSION_ATTENDED|ACCOUNT_UUID|ORGANIZATION_UUID|USER_EMAIL|EAGER_FLUSH|EMIT_TOOL_USE_SUMMARIES|ENABLE_SDK_FILE_CHECKPOINTING|REPORT_FINDINGS|TERMINAL_MCP_TOOLS|SIMPLE|DISABLE_CRON|DISABLE_TERMINAL_TITLE)$/.test(key)) delete env[key];
    if (/^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_\w+|CLAUDE_PREVIEW_\w+)$/.test(key)) delete env[key];
  }
  // A host session routes the API through itself; the user's own base URL would not be set alongside.
  if (hosted) delete env.ANTHROPIC_BASE_URL;
  return env;
}

/** A JavaScript entry point (an older npm install's cli.js) rather than a native binary. */
const isScript = (binary: string) => /\.[cm]?js$/i.test(binary);

function run(binary: string, args: string[], timeout = 20_000): Promise<string> {
  const js = isScript(binary);
  return new Promise((resolve, reject) => {
    execFile(js ? "node" : binary, js ? [binary, ...args] : args, { windowsHide: true, timeout, env: claudeEnv() }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

/** Parses "2.1.274 (Claude Code)". */
export async function probeClaudeVersion(binary: string): Promise<string | null> {
  try {
    const m = /(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(await run(binary, ["--version"]));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod: string | null;
  apiProvider: string | null;
  email: string | null;
  organization: string | null;
  subscriptionType: string | null;
}

/** `claude auth status` (JSON): signed-in state without opening a session, so no MCP servers or hooks start. */
export async function claudeAuthStatus(binary: string): Promise<ClaudeAuthStatus | null> {
  try {
    const j = JSON.parse(await run(binary, ["auth", "status"]));
    const str = (...keys: string[]) => {
      for (const k of keys) if (typeof j[k] === "string" && j[k]) return j[k] as string;
      return null;
    };
    return {
      loggedIn: !!j.loggedIn,
      authMethod: str("authMethod"),
      apiProvider: str("apiProvider"),
      email: str("email", "emailAddress"),
      organization: str("orgName", "organizationName", "organization"),
      subscriptionType: str("subscriptionType", "plan", "planType"),
    };
  } catch {
    return null;
  }
}

/**
 * Opens a terminal window running Claude Code's own sign-in (`claude auth login`). The login
 * happens entirely in Anthropic's flow; Ret only notices afterwards that the CLI is signed in.
 */
export function openLoginTerminal(binary: string) {
  openTerminalWindow("Claude sign-in", isScript(binary) ? `node "${binary}" auth login` : `"${binary}" auth login`, claudeEnv());
}
