// Metro for the phone app, which runs the desktop renderer's shared code (src/renderer, src/shared)
// as it is, swapping in the phone's own version of the few modules that are about the platform.
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { withUniwindConfig } = require("uniwind/metro");

const app = __dirname;
const repo = path.resolve(app, "../..");
const shared = path.join(repo, "src/shared");
const renderer = path.join(repo, "src/renderer");

/** Desktop modules → the phone's: the bridge to the agents, and what "focused" means. */
const swaps = new Map([
  [path.join(renderer, "bridge.ts"), path.join(app, "src/platform/bridge.ts")],
  [path.join(renderer, "lib/appFocus.ts"), path.join(app, "src/platform/appFocus.ts")],
]);

const config = getDefaultConfig(app);
config.watchFolders = [...(config.watchFolders ?? []), shared, renderer];

const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = (ctx, name) => (upstream ? upstream(ctx, name, platform) : ctx.resolveRequest(ctx, name, platform));
  const fromRepo = !context.originModulePath.startsWith(app + path.sep);
  let r;
  if (moduleName.startsWith("@shared/")) r = resolve(context, path.join(shared, moduleName.slice("@shared/".length)));
  else if (moduleName.startsWith("@ret/")) r = resolve(context, path.join(renderer, moduleName.slice("@ret/".length)));
  // Vite's worker import (the screenshot decoder): the phone doesn't decode screenshots.
  else if (moduleName.endsWith("?worker")) return { type: "sourceFile", filePath: path.join(app, "src/platform/shotWorker.ts") };
  // Packages come from the app's node_modules whoever imports them: one React, one zustand.
  else if (fromRepo && !moduleName.startsWith(".") && !path.isAbsolute(moduleName)) r = resolve({ ...context, originModulePath: path.join(app, "package.json") }, moduleName);
  else r = resolve(context, moduleName);
  // However a platform module is reached (the desktop's own imports, or @ret/… here), the phone's is used.
  return r.type === "sourceFile" && swaps.has(r.filePath) ? { type: "sourceFile", filePath: swaps.get(r.filePath) } : r;
};

module.exports = withUniwindConfig(config, {
  cssEntryFile: "./src/global.css",
  dtsFile: "./src/uniwind-types.d.ts",
});
