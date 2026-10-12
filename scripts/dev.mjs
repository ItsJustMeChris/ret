// Dev loop: Vite (renderer, HMR) + esbuild watch (main/preload) + Electron.
// Electron starts after the first main/preload build and restarts on rebuilds,
// waiting for the previous instance to exit so the single-instance lock is free.
import { spawn } from "node:child_process";
import { context } from "esbuild";
import { createServer } from "vite";
import electronPath from "electron";

// Any free port: dev:web may already hold the default one.
const server = await createServer({ configFile: "vite.config.mts", server: { strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`renderer: ${url}`);

let electron = null;
let restarting = Promise.resolve();

function start() {
  const child = spawn(electronPath, ["."], { stdio: "inherit", env: { ...process.env, VITE_DEV_SERVER_URL: url } });
  child.on("exit", (code) => {
    if (electron !== child) return; // replaced by a restart
    void shutdown(code ?? 0);
  });
  electron = child;
}

function restart() {
  restarting = restarting.then(async () => {
    const old = electron;
    electron = null;
    if (old && old.exitCode === null) {
      const exited = new Promise((r) => old.once("exit", r));
      old.kill();
      await exited;
    }
    start();
  });
}

let firstBuilds = 0;
const relaunch = {
  name: "relaunch-electron",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length) return;
      // Two bundles (main + preload): launch once both exist, then restart on any rebuild.
      if (firstBuilds < 2) {
        if (++firstBuilds === 2) start();
      } else restart();
    });
  },
};

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron", "bufferutil", "utf-8-validate"],
  sourcemap: "inline",
  logLevel: "info",
  plugins: [relaunch],
};
const ctxs = await Promise.all([
  context({ ...common, entryPoints: ["src/main/index.ts"], outfile: "dist/main/index.cjs" }),
  context({ ...common, entryPoints: ["src/preload/index.ts"], outfile: "dist/preload/index.cjs" }),
]);
await Promise.all(ctxs.map((c) => c.watch()));

async function shutdown(code) {
  await Promise.all(ctxs.map((c) => c.dispose()));
  await server.close();
  process.exit(code);
}
process.on("SIGINT", () => {
  electron?.kill();
  void shutdown(0);
});
