// iOS 27 stops apps at launch unless they adopt the scene-based life cycle. Expo SDK 57 ships the
// scene delegate for it (ExpoAppSceneDelegate) but its template still starts React Native from the
// app delegate; this does what SDK 58's template does: the app delegate only makes the React
// Native factory, a SceneDelegate makes the window and starts React Native in it.
// Remove once on SDK 58 (whose template already looks like this).
const { withAppDelegate, withInfoPlist } = require("expo/config-plugins");

const SCENE_DELEGATE = `
@objc(SceneDelegate)
class SceneDelegate: ExpoAppSceneDelegate {
  // Extension point for config plugins.
}
`;

function withSceneDelegate(config) {
  return withAppDelegate(config, (c) => {
    if (c.modResults.language !== "swift") throw new Error("withSceneLifecycle: expected a Swift AppDelegate");
    let src = c.modResults.contents;
    if (src.includes("class SceneDelegate")) return c;
    const decl = "class AppDelegate: ExpoAppDelegate {";
    const start = /\n#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow\(frame: UIScreen\.main\.bounds\)\n\s*factory\.startReactNative\([\s\S]*?\)\n#endif\n/;
    if (!src.includes(decl) || !start.test(src)) throw new Error("withSceneLifecycle: the AppDelegate template changed; update the plugin");
    src = src.replace(decl, "class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {");
    src = src.replace(start, "\n    // The window is made, and React Native started, by SceneDelegate (the scene-based life cycle).\n");
    c.modResults.contents = src + SCENE_DELEGATE;
    return c;
  });
}

function withSceneManifest(config) {
  return withInfoPlist(config, (c) => {
    c.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          { UISceneConfigurationName: "Default Configuration", UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate" },
        ],
      },
    };
    return c;
  });
}

module.exports = (config) => withSceneManifest(withSceneDelegate(config));
