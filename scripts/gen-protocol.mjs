// Regenerates the app-server protocol typings from the installed codex binary.
// Run after a codex upgrade that changes the protocol: `npm run gen:protocol`.
// Includes experimental methods and fields: Ret opts into them at initialize (experimentalApi), and
// some everyday features live there (collaboration modes, questions on agent messages).
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

const out = "src/shared/protocol/generated";
const bin = process.env.CODEX_BIN || "codex";
rmSync(out, { recursive: true, force: true });
execFileSync(bin, ["app-server", "generate-ts", "--experimental", "--out", out], { stdio: "inherit", shell: process.platform === "win32" });
console.log(`protocol typings written to ${out}`);
