// Regenerates the app-server protocol typings from the installed codex binary.
// Run after a codex upgrade that changes the protocol: `npm run gen:protocol`.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

const out = "src/renderer/protocol/generated";
const bin = process.env.CODEX_BIN || "codex";
rmSync(out, { recursive: true, force: true });
execFileSync(bin, ["app-server", "generate-ts", "--out", out], { stdio: "inherit", shell: process.platform === "win32" });
console.log(`protocol typings written to ${out}`);
