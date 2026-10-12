// Browser-only dev mode: runs the renderer in a plain browser tab, talking to a
// local `codex app-server` over WebSocket instead of Electron IPC. Handy for
// fast UI iteration and for driving the UI with browser tooling.
//
// The app-server rejects any WebSocket carrying a browser Origin (CSRF guard),
// so the Vite server exposes /codex-ws and forwards it — but only for requests
// whose Origin is this dev server itself. Other sites still can't reach codex.
import { spawn } from "node:child_process";
import net from "node:net";
import { createServer } from "vite";

const port = Number(process.env.RET_WS_PORT || 5198);
const bin = process.env.CODEX_BIN || "codex";
const codex = spawn(`${bin} app-server --listen ws://127.0.0.1:${port}`, {
  stdio: ["ignore", "inherit", "inherit"],
  shell: true,
});

const server = await createServer({ configFile: "vite.config.mts" });
await server.listen();
const vitePort = server.config.server.port;
const allowed = new Set([`http://localhost:${vitePort}`, `http://127.0.0.1:${vitePort}`]);

server.httpServer.on("upgrade", (req, socket, head) => {
  if (!req.url?.startsWith("/codex-ws")) return;
  if (!allowed.has(req.headers.origin ?? "")) {
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
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

const shutdown = () => {
  codex.kill();
  server.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
