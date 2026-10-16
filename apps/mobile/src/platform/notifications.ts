import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { AndroidImportance } from "expo-notifications";
import { router } from "expo-router";
import { AppState, Platform } from "react-native";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { access } from "./bridge";

// Notices while the app is away: a paired computer sends them (finished, failed, needs your input)
// through Expo's push service to this phone's token, which the phone gives it over the link. While
// the app is in front it hears everything live, and tells its computers so they hold off.

export type NotifyState =
  /** Not decided yet (the app hasn't asked). */
  | "unknown"
  | "on"
  | "off"
  /** Turned down in the system's settings. */
  | "denied"
  /** This build has no push project (EAS) to make tokens for. */
  | "unavailable"
  | "error";

/** Whether you want notices (yours to change in Settings), and how that's going. */
export const useNotify = create<{ wanted: boolean | null; state: NotifyState; error: string | null }>()(
  persist(() => ({ wanted: null as boolean | null, state: "unknown" as NotifyState, error: null as string | null }), {
    name: "ret-notify",
    partialize: (s) => ({ wanted: s.wanted }),
  }),
);

/** The push project tokens are made for (EAS project id, from app config). */
const projectId = (): string | null =>
  (Constants.expoConfig?.extra?.eas?.projectId as string | undefined) ?? (Constants.easConfig as { projectId?: string } | undefined)?.projectId ?? null;

export const pushAvailable = () => !!projectId();

Notifications.setNotificationHandler({
  // A notice arriving while the app is open (it raced the app coming back): show it all the same.
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

/** Ask (if `ask`, or already allowed) and hand the token to paired computers; anything else says why not. */
async function register(ask: boolean) {
  const id = projectId();
  if (!id) return useNotify.setState({ state: "unavailable", error: null });
  try {
    let perm = await Notifications.getPermissionsAsync();
    if (!perm.granted && ask && perm.canAskAgain) perm = await Notifications.requestPermissionsAsync();
    if (!perm.granted) {
      useNotify.setState({ state: perm.canAskAgain ? "off" : "denied", error: null });
      (await access).setPushToken(null);
      return;
    }
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", { name: "Threads", importance: AndroidImportance.HIGH });
    }
    const token = (await Notifications.getExpoPushTokenAsync({ projectId: id })).data;
    (await access).setPushToken(token);
    useNotify.setState({ state: "on", error: null });
  } catch (err) {
    useNotify.setState({ state: "error", error: (err as Error).message });
  }
}

/** Turn notices on (asking the system) or off (computers forget the token). */
export async function setNotifications(on: boolean) {
  useNotify.setState({ wanted: on });
  if (on) await register(true);
  else {
    (await access).setPushToken(null);
    useNotify.setState({ state: "off", error: null });
  }
}

/** After pairing: the moment to offer notices, unless you've said already. */
export function offerNotifications() {
  if (useNotify.getState().wanted === null && pushAvailable()) void setNotifications(true);
}

let started = false;

/** At launch: re-register if wanted, follow the app in and out of the front, and open tapped notices. */
export function startNotifications() {
  if (started) return;
  started = true;
  const wanted = useNotify.getState().wanted;
  if (wanted) void register(false);
  else if (!pushAvailable()) useNotify.setState({ state: "unavailable" });
  else if (wanted === false) useNotify.setState({ state: "off" });

  void access.then(
    (a) => {
      a.setAway(AppState.currentState !== "active");
      AppState.addEventListener("change", (s) => a.setAway(s !== "active"));
    },
    () => {},
  );

  const open = (r: Notifications.NotificationResponse | null) => {
    const threadId = r?.notification.request.content.data?.threadId;
    if (typeof threadId === "string" && threadId) router.push({ pathname: "/thread/[id]", params: { id: threadId } });
  };
  Notifications.addNotificationResponseReceivedListener(open);
  // Opened by tapping one (the app wasn't running).
  void Notifications.getLastNotificationResponseAsync().then((r) => {
    if (r) {
      open(r);
      void Notifications.clearLastNotificationResponseAsync();
    }
  });
}
