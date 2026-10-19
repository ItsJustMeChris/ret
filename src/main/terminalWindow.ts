import { spawn } from "node:child_process";

/**
 * Opens a terminal window running `cmd` (a provider's own sign-in, say): cmd on Windows,
 * Terminal on macOS, the default terminal emulator elsewhere. The window stays open afterwards.
 */
export function openTerminalWindow(title: string, cmd: string, env: NodeJS.ProcessEnv = process.env) {
  if (process.platform === "win32") {
    spawn("cmd.exe", ["/c", "start", `"${title.replace(/"/g, "")}"`, "cmd", "/k", cmd], { env, detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
  } else if (process.platform === "darwin") {
    const script = `tell application "Terminal" to do script ${JSON.stringify(cmd)}\ntell application "Terminal" to activate`;
    spawn("osascript", ["-e", script], { env, detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("x-terminal-emulator", ["-e", `sh -c '${cmd.replace(/'/g, "'\\''")}; exec sh'`], { env, detached: true, stdio: "ignore" }).unref();
  }
}
