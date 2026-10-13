// Browser-only dev mode: runs the renderer in a plain browser tab, talking to a
// local `codex app-server` over WebSocket instead of Electron IPC. Handy for
// fast UI iteration and for driving the UI with browser tooling.
//
// The app-server rejects any WebSocket carrying a browser Origin (CSRF guard),
// so the Vite server exposes /codex-ws and forwards it — but only for requests
// whose Origin is this dev server itself. Other sites still can't reach codex.
//
// Claude Code's engine (src/main/claude) runs in this process and is served on
// /claude-ws the same way, so both providers work in the browser.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { createServer } from "vite";
import { WebSocketServer } from "ws";

const port = Number(process.env.RET_WS_PORT || 5198);
const bin = process.env.CODEX_BIN || "codex";
const codex = spawn(`${bin} app-server --listen ws://127.0.0.1:${port}`, {
  stdio: ["ignore", "inherit", "inherit"],
  shell: true,
});

const claude = await startClaude();

// PORT (set by preview tooling) moves the page off the default, e.g. while `npm run dev` holds it.
const server = await createServer({ configFile: "vite.config.mts", ...(process.env.PORT ? { server: { port: Number(process.env.PORT), strictPort: true } } : {}) });
await server.listen();
const vitePort = server.config.server.port;
const allowed = new Set([`http://localhost:${vitePort}`, `http://127.0.0.1:${vitePort}`]);

server.httpServer.on("upgrade", (req, socket, head) => {
  const path = req.url ?? "";
  if (!path.startsWith("/codex-ws") && !path.startsWith("/claude-ws")) return;
  if (!allowed.has(req.headers.origin ?? "")) {
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  if (path.startsWith("/claude-ws")) {
    if (!claude) return socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    claude.wss.handleUpgrade(req, socket, head, (ws) => claude.wss.emit("connection", ws, req));
    return;
  }
  const upstream = net.connect(port, "127.0.0.1", () => {
    const lines = [`GET / HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      if (/^(origin|host)$/i.test(name)) continue;
      lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
    }
    lines.push(`Host: 127.0.0.1:${port}`);
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const close = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", close);
  socket.on("error", close);
});

server.printUrls();

/** Bundle the Claude engine for Node and serve it to one browser tab at a time. */
async function startClaude() {
  const dir = join(tmpdir(), "ret-dev-web");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, "claude-engine.cjs");
  try {
    await build({
      stdin: {
        contents: `export { ClaudeEngine } from "./src/main/claude/engine";\nexport { findSystemClaude, probeClaudeVersion } from "./src/main/claude/platform";`,
        resolveDir: process.cwd(),
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node22",
      outfile: out,
      define: { "import.meta.url": "__ret_import_meta_url" },
      banner: { js: 'var __ret_import_meta_url = require("url").pathToFileURL(__filename).href;' },
      logLevel: "warning",
    });
  } catch (err) {
    console.warn("claude engine unavailable:", err.message);
    return null;
  }
  const { ClaudeEngine, findSystemClaude, probeClaudeVersion } = createRequire(import.meta.url)(out);
  const binary = process.env.CLAUDE_BIN || (await findSystemClaude());
  if (!binary) {
    console.warn("claude engine: Claude Code isn't installed");
    return null;
  }
  let current = null;
  const engine = new ClaudeEngine(
    join(dir, "claude-state.json"),
    "dev-web",
    (lines) => current?.send(lines.join("\n")),
    () => {},
  );
  engine.start({ binary, version: await probeClaudeVersion(binary), source: "system" });
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws) => {
    current?.close();
    current = ws;
    engine.reconnect();
    ws.on("message", (data) => {
      for (const line of String(data).split("\n")) if (line.trim()) engine.send(line);
    });
    ws.on("close", () => {
      if (current === ws) current = null;
    });
  });
  console.log(`claude engine: ${binary}`);
  return { engine, wss };
}

const shutdown = () => {
  codex.kill();
  claude?.engine.stop();
  server.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
