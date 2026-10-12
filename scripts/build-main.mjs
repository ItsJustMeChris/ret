// Bundles the Electron main + preload processes with esbuild.
import { build, context } from "esbuild";

const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  // ws optionally loads native accelerators; they are not installed and ws falls back to JS.
  external: ["electron", "bufferutil", "utf-8-validate"],
  sourcemap: watch ? "inline" : false,
  minify: !watch,
  logLevel: "info",
};

const targets = [
  { ...common, entryPoints: ["src/main/index.ts"], outfile: "dist/main/index.cjs" },
  { ...common, entryPoints: ["src/preload/index.ts"], outfile: "dist/preload/index.cjs" },
];

if (watch) {
  const ctxs = await Promise.all(targets.map((t) => context(t)));
  await Promise.all(ctxs.map((c) => c.watch()));
} else {
  await Promise.all(targets.map((t) => build(t)));
}
