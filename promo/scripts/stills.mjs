// Renders review stills: node scripts/stills.mjs 30 100 220 …
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import path from "node:path";

const frames = process.argv.slice(2).map(Number);
const serveUrl = await bundle({ entryPoint: path.resolve("src/index.ts") });
const composition = await selectComposition({ serveUrl, id: "RetPromo" });
for (const frame of frames) {
  await renderStill({ serveUrl, composition, frame, output: `out/f${String(frame).padStart(4, "0")}.png`, scale: 0.5 });
  console.log("frame", frame);
}
