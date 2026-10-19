// node-pty 1.1.0 publishes its macOS spawn-helper without the execute bit, and without it every
// terminal on a Mac fails to start ("posix_spawnp failed"). Set it after each install: a dev run
// uses it from node_modules, and electron-builder copies its mode into the app's asar.unpacked.
import { chmodSync, existsSync, readdirSync } from "node:fs";

const prebuilds = "node_modules/node-pty/prebuilds";
if (existsSync(prebuilds)) {
  for (const dir of readdirSync(prebuilds)) {
    const helper = `${prebuilds}/${dir}/spawn-helper`;
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
}
