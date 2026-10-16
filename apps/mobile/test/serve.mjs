// A desktop Ret to try the app against (test/host.ts on the network): node test/serve.mjs [port]
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "./bundle.mjs";

const out = await bundle(join(dirname(fileURLToPath(import.meta.url)), "serve.ts"));
spawn(process.execPath, ["--enable-source-maps", out, ...process.argv.slice(2)], { stdio: "inherit" }).on("exit", (code) => process.exit(code ?? 0));
