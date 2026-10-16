// Runs the Node tests (test/*.test.ts), each bundled by bundle.mjs. Usage: node test/run.mjs [file…]
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "./bundle.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const files = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(here).filter((f) => f.endsWith(".test.ts")).map((f) => join(here, f));
let failed = false;
for (const file of files) {
  const out = await bundle(file);
  const r = spawnSync(process.execPath, ["--enable-source-maps", "--test", "--test-force-exit", "--test-timeout=30000", "--test-reporter=spec", out], { stdio: "inherit" });
  if (r.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
