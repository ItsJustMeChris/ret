/**
 * Notifying a paired phone that's away, through Expo's push service: the phone registered a token
 * for Ret's app with it, and Expo hands the message to Apple's or Google's push service. Nothing
 * secret is needed here; a token only reaches the app it was made for.
 */

export interface PushMessage {
  /** The phone's Expo push token ("ExponentPushToken[…]"). */
  to: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
}

/** Per message, in order: sent, or why not; `gone` means the token is dead and should be forgotten. */
export type PushResult = { ok: true } | { ok: false; gone: boolean; error: string };

export type PushSender = (messages: PushMessage[]) => Promise<PushResult[]>;

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const TIMEOUT_MS = 10_000;

export const EXPO_TOKEN = /^Expo(nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$/;

export const sendExpoPush: PushSender = async (messages) => {
  if (!messages.length) return [];
  const res = await fetch(EXPO_PUSH_URL, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify(messages.map((m) => ({ ...m, sound: "default", priority: "high" }))),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Push service answered ${res.status}`);
  const json = (await res.json()) as { data?: { status: string; message?: string; details?: { error?: string } }[] };
  return messages.map((_, i) => {
    const ticket = json.data?.[i];
    if (ticket?.status === "ok") return { ok: true };
    const error = ticket?.details?.error ?? ticket?.message ?? "No answer";
    return { ok: false, gone: error === "DeviceNotRegistered", error };
  });
};
