import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")) as { version: string };

// The web demo: the real renderer (src/renderer) with scripted engines in the page
// (src/renderer/demo), built as a static site for getret.app/demo/. Nothing here touches the
// desktop build (vite.config.mts → dist/).
export default defineConfig({
  root: resolve(__dirname, "src/renderer/demo"),
  publicDir: resolve(__dirname, "src/renderer/public"),
  base: "./",
  plugins: [react()],
  resolve: {
    alias: { "@shared": resolve(__dirname, "src/shared") },
  },
  define: {
    __RET_VERSION__: JSON.stringify(version),
  },
  server: { port: 5299, strictPort: false },
  preview: { port: 5299, strictPort: false },
  build: {
    outDir: resolve(__dirname, "site/demo"),
    emptyOutDir: true,
    sourcemap: false,
    reportCompressedSize: false,
    // The code viewer's Monaco is one ~4 MB chunk, loaded only when a file is first opened.
    chunkSizeWarningLimit: 4500,
  },
});
