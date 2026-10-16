# Ret for iPhone and Android

Ret on your phone: the threads, approvals and questions of the agents on your computer. The phone
runs no agents. It pairs with a desktop Ret over remote access (Settings → Remote access → Pair a
device) and uses that computer's engines the way a desktop window uses a paired computer's.

Expo SDK 57 (React Native 0.86), Expo Router, Uniwind Pro.

## How it fits with the desktop app

- **The same logic.** The desktop renderer's stores and actions (`src/renderer/state`), RPC
  client, agent descriptions and helpers run here unchanged. `metro.config.js` swaps in the phone's
  version of the two platform modules: the bridge (`src/platform/bridge.ts`, in place of
  `src/renderer/bridge.ts`) and what "focused" means (`src/platform/appFocus.ts`). Shared code is
  imported as `@ret/…` (renderer) and `@shared/…`.
- **The same protocol.** `src/remote` is the client half of the desktop's `src/main/remote`:
  TLS 1.3 with a pinned device key, CPace pairing bound to the TLS session, and the same wire
  framing. The TLS itself is native (`modules/ret-tls`: Network.framework on iOS, JSSE and the
  Android Keystore on Android) because React Native has no client certificates or keying-material
  export.
- **The same look.** `src/theme.css` is generated from the desktop's stylesheet
  (`npm run tokens`), so `bg-bg-2` or `text-text-3` is the desktop's `--bg-2` / `--text-3`, dark
  and light. The screens are native, drawn with those tokens.

## What it does

- **Inbox and projects**: every thread on your paired computers, grouped as the desktop groups them.
- **Threads**: the live transcript; approvals and questions; a composer with the desktop's model,
  effort, speed, access and Plan mode choices; images from the photo library or camera (saved on the
  computer, where the agent reads them).
- **New threads**: in any project, with any agent the computer runs.
- **Files**: tap a path in a thread to read the file, or browse a project's folders (read through the
  computer's agent, as the desktop's Code mode does).
- **Notifications** while the app is away: a turn finished or failed, or an agent wants you. The
  desktop sends them through Expo's push service to the token the phone gave it (see below).

## Run it

Needs Node 22.13+ or 24, Xcode and CocoaPods (iOS), or Android Studio's JDK and SDK (Android).

```bash
npm install                 # Uniwind Pro installs from your uniwind-pro login (see below)
npx expo prebuild           # ios/ and android/ are generated, never edited
npm run ios                 # or: npm run android
```

To try it without a desktop to pair with, run a test desktop (the desktop's real remote-access host
with the web demo's scripted agents), then pair with the code it prints:

```bash
node test/serve.mjs         # listens on 47899; the current code is in /tmp/ret-test-host.json
```

## Check it

```bash
npm run typecheck           # Uniwind's class types, then tsc
npm run lint
npm test                    # design tokens up to date; protocol and store tests against the desktop's code
```

The tests run the phone's remote-access code against the desktop's own host (`src/main/remote`):
pairing (right code, wrong code), pinning, revocation, and the desktop's stores booted on the phone's
bridge (thread lists, streaming replies, approvals and questions).

## Uniwind Pro

`uniwind` is installed as `npm:uniwind-pro`, whose install script downloads the Pro build for the
GitHub account logged in with `npx uniwind-pro` (the session lives in the macOS keychain for 180
days). For CI, set `UNIWIND_AUTH_TOKEN` from a CI license. Its native code needs a rebuild
(`npx expo prebuild --clean`) after an upgrade. The `uniwind` binary npm links is Pro's account
CLI; the build tool is `node node_modules/uniwind/dist/cli/index.mjs` (used by `npm run typecheck`).

## Push notifications

The desktop sends notices (finished, failed, needs your input) to paired phones that are away,
through Expo's push service, which needs nothing secret on the desktop. The phone needs tokens for
an EAS project with Apple (and, for Android, Firebase) push credentials:

```bash
npx eas-cli login
npx eas-cli init            # links the app to an EAS project: writes extra.eas.projectId to app.json
npx eas-cli credentials     # iOS → Push Notifications: let EAS make (or upload) an APNs key
```

Then rebuild. Until `extra.eas.projectId` is set, Settings says the build isn't set up for push and
nothing is registered. Android also needs `google-services.json` (Firebase) set in `app.json`.
Notice text (the thread's title) passes through Apple's or Google's and Expo's push services.
