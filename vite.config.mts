import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Strict CSP for packaged builds only; the dev server needs inline HMR preambles.
// ret-img: is the main process's local-image protocol (images in threads); the code viewer's
// Monaco runs its worker from a bundled file.
const csp: Plugin = {
  name: "ret-csp",
  apply: "build",
  transformIndexHtml(html) {
    const policy =
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: file: ret-img:; connect-src 'self'; font-src 'self' data:; worker-src 'self'";
    return html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`);
  },
};

export default defineConfig({
  root: resolve(__dirname, "src/renderer"),
  base: "./",
  plugins: [react(), csp],
  resolve: {
    alias: { "@shared": resolve(__dirname, "src/shared") },
  },
  server: { port: 5199, strictPort: true },
  build: {
    outDir: resolve(__dirname, "dist/renderer"),
    emptyOutDir: true,
    target: "chrome140",
    sourcemap: false,
    reportCompressedSize: false,
    // The code viewer's Monaco is one ~4 MB chunk, loaded only when a file is first opened.
    chunkSizeWarningLimit: 4500,
  },
});
