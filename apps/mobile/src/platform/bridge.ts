import * as Clipboard from "expo-clipboard";
import Constants from "expo-constants";
import { File, Paths } from "expo-file-system";
import { AppState, Linking, Platform } from "react-native";
import RetTls from "../../modules/ret-tls";
import type { AccessStore, Found } from "../remote/access";
import type { HostRecord } from "../remote/link";
import { deviceIdentity } from "../remote/nativeTransport";
import { toast } from "@ret/state/toasts";
import { createMobileBridge } from "./createBridge";

// The bridge the desktop's shared code imports as src/renderer/bridge.ts (metro.config.js swaps
// this in): the phone's, reaching its paired desktops' engines through the native TLS module.

const file = new File(Paths.document, "remote.json");

const store: AccessStore = {
  async load() {
    try {
      if (!file.exists) return { hosts: [], name: null };
      const saved = JSON.parse(await file.text()) as { hosts?: HostRecord[]; name?: string };
      return { hosts: Array.isArray(saved.hosts) ? saved.hosts : [], name: saved.name ?? null };
    } catch {
      return { hosts: [], name: null };
    }
  },
  save(data) {
    try {
      file.write(JSON.stringify(data));
    } catch (err) {
      console.warn("Couldn't save paired computers:", (err as Error).message);
    }
  },
};

function discover(found: (list: Found[]) => void) {
  RetTls.addListener("onServices", ({ services }) => {
    const byId = new Map<string, Found>();
    for (const s of services) {
      const id = s.id.toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(id) || !s.address || !s.port) continue;
      const f = byId.get(id);
      if (f) f.addresses.push(s.address);
      else byId.set(id, { id, name: s.name, addresses: [s.address], port: s.port });
    }
    found([...byId.values()]);
  });
  RetTls.startDiscovery("_ret._tcp");
}

const made = createMobileBridge({
  platform: Platform.OS,
  appVersion: Constants.expoConfig?.version ?? "0.0.0",
  identity: deviceIdentity,
  store,
  defaultName: Platform.OS === "ios" ? "iPhone" : "Android phone",
  discover,
  // Notifications while the app is in front show as toasts; in the background there's no
  // connection to hear from (the desktop keeps the thread until the app comes back).
  notify: (title, body) => toast(`${title}: ${body}`),
  openExternal: async (url) => void (await Linking.openURL(url)),
  copy: async (text) => void (await Clipboard.setStringAsync(text)),
});

export const bridge = made.bridge;
export const access = made.access;
/** The full bridge (remote access included), as on the desktop: not the browser dev fallback. */
export const isDesktop = true;

// Back in front: connections that died while the app was frozen come back now, not at the next retry.
AppState.addEventListener("change", (state) => {
  if (state === "active") void access.then((a) => a.resumed(), () => {});
});
