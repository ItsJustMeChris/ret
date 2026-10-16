// Bundles a test entry with the desktop's esbuild, resolving the desktop's shared code the way
// Metro does for the app (metro.config.js): @shared, and the renderer's bridge and focus modules
// swapped for the test's.
import { createRequire } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, "..");
const repo = resolve(app, "../..");
const { build } = createRequire(join(repo, "package.json"))("esbuild");

const swaps = {
  [join(repo, "src/renderer/bridge.ts")]: join(here, "support/bridge.ts"),
  [join(repo, "src/renderer/lib/appFocus.ts")]: join(here, "support/appFocus.ts"),
};

const redirect = {
  name: "ret-mobile-test",
  setup(b) {
    b.onResolve({ filter: /^@shared\// }, (args) => ({ path: join(repo, "src/shared", args.path.slice(8)) + ".ts" }));
    b.onResolve({ filter: /\?worker$/ }, () => ({ path: join(app, "src/platform/shotWorker.ts") }));
    b.onResolve({ filter: /(^|\/)(bridge|appFocus)$/ }, (args) => {
      const target = resolve(args.resolveDir, args.path) + ".ts";
      return swaps[target] ? { path: swaps[target] } : undefined;
    });
    // Packages resolve from the app, whoever imports them (one React, one zustand); what only the
    // desktop has (its mDNS library) from the desktop's.
    b.onResolve({ filter: /^[^./]/ }, async (args) => {
      if (args.pluginData === "app" || args.path.startsWith("node:") || args.importer.startsWith(app + "/node_modules")) return undefined;
      const r = await b.resolve(args.path, { kind: args.kind, resolveDir: app, pluginData: "app" });
      return r.errors.length ? undefined : { path: r.path, external: r.external };
    });
  },
};

/** Bundle `entry` to a temporary .mjs; returns its path. */
export async function bundle(entry) {
  const outfile = join(mkdtempSync(join(tmpdir(), "ret-mobile-test-")), entry.split("/").pop().replace(/\.ts$/, ".mjs"));
  await build({
    entryPoints: [resolve(entry)],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: "inline",
    logLevel: "warning",
    plugins: [redirect],
    banner: {
      js: [
        "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
        "globalThis.window ??= globalThis;",
        "globalThis.requestAnimationFrame ??= (cb) => setTimeout(() => cb(performance.now()), 16);",
        // Node's own localStorage needs a flag; the app has the shim's (src/platform/shims.ts).
        "{ const m = new Map(); Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k), clear: () => m.clear() } }); }",
      ].join("\n"),
    },
  });
  return outfile;
}
