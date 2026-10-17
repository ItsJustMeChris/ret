// Bundles the Electron main + preload processes with esbuild.
import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  // ws optionally loads native accelerators; they are not installed and ws falls back to JS.
  // node-pty is native: loaded from node_modules (unpacked from the asar in a build).
  external: ["electron", "bufferutil", "utf-8-validate", "node-pty"],
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
};

// The Claude Agent SDK is an ES module that reads import.meta.url at load; give it the bundle's own URL.
const main = {
  define: { "import.meta.url": "__ret_import_meta_url" },
  banner: { js: 'var __ret_import_meta_url = require("url").pathToFileURL(__filename).href;' },
};

const targets = [
  { ...common, ...main, entryPoints: ["src/main/index.ts"], outfile: "dist/main/index.cjs" },
  { ...common, entryPoints: ["src/preload/index.ts"], outfile: "dist/preload/index.cjs" },
];

if (watch) {
  const ctxs = await Promise.all(targets.map((t) => context(t)));
  await Promise.all(ctxs.map((c) => c.watch()));
} else {
  await Promise.all(targets.map((t) => build(t)));
}
