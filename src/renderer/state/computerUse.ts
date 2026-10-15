import { useEffect } from "react";
import { create } from "zustand";
import type { AppInfo } from "@shared/bridge";
import type { ThreadItem } from "@shared/protocol";
import { bridge } from "../bridge";
import { shallowEqual } from "../lib/shallow";
import { useThreads } from "./threads";
import { useGatedStore } from "./useThread";

/**
 * Computer use: Codex driving a desktop app (or a browser) through its `cua_repl` tool. Each step
 * is an MCP tool call whose result says which app it touched (`_meta["codex/toolSurface"]`) and,
 * when the agent looked, carries a screenshot of the window. Screenshots are only whole live (history
 * cuts the middle out of them), and large, so they're kept here, by item, rather than in the items.
 * Only Codex's own servers count: any other tool's result could claim to be one of these.
 */

type McpCall = Extract<ThreadItem, { type: "mcpToolCall" }>;
type McpResult = NonNullable<McpCall["result"]>;

/** Codex's computer use, and its browser use (which also runs plain JavaScript). */
const CUA = "cua_repl";
const NODE = "node_repl";

export interface ComputerUse {
  kind: "app" | "browser";
  /** macOS bundle id or Windows executable path, when the step names its app. */
  appId: string | null;
  /** The app as the agent's output names it ("App: Finder."). */
  appName: string | null;
  /** Title of the window it read, or the page it was on. */
  window: string | null;
  /** What the step was for, in the agent's words ("Capture the login form"). */
  title: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

const usesOf = new WeakMap<ThreadItem, ComputerUse | null>();

/** The computer-use step `item` is, if it's one (worked out once per item). */
export function computerUseOf(item: ThreadItem | undefined): ComputerUse | null {
  if (item?.type !== "mcpToolCall" || (item.server !== CUA && item.server !== NODE)) return null;
  let use = usesOf.get(item);
  if (use === undefined) usesOf.set(item, (use = readUse(item)));
  return use;
}

function readUse(item: McpCall): ComputerUse | null {
  const meta = obj(item.result?._meta);
  const surface = obj(meta?.["codex/toolSurface"]);
  const tagged = surface?.kind === "computerUse" || surface?.kind === "browserUse";
  // cua_repl exists for computer use, so its steps count before they report an app; node_repl also
  // runs plain JavaScript, so only its tagged steps do.
  if (!tagged && item.server !== CUA) return null;
  const browser = surface?.kind === "browserUse";
  const app = obj(surface?.app);
  const text = outputText(item);
  return {
    kind: browser ? "browser" : "app",
    appId: app?.kind === "appId" ? str(app.appId) : null,
    appName: (app?.kind === "displayName" ? str(app.displayName) : null) ?? /\bApp: (.+?)\.?$/m.exec(text)?.[1] ?? null,
    window: browser ? str(obj(meta?.browser_use)?.url) : (/Window: "([^"]+)"/.exec(text)?.[1] ?? null),
    title: str(obj(item.arguments)?.title),
  };
}

/** The step's text output, minus the computer-use manual Codex sends along with the first step. */
export function outputText(item: McpCall): string {
  const content: unknown[] = Array.isArray(item.result?.content) ? item.result.content : [];
  return content
    .map((c) => {
      const text = obj(c)?.type === "text" ? str(obj(c)!.text) : null;
      return text && !text.startsWith("## Computer Use") ? text : "";
    })
    .filter(Boolean)
    .join("\n");
}

/** `own` with its gaps filled from `known`, when both are about the same app. */
function fill(own: ComputerUse, known: ComputerUse | null | undefined): ComputerUse {
  if (!known || known.kind !== own.kind || (own.appId && known.appId && own.appId !== known.appId)) return own;
  return {
    ...own,
    appId: own.appId ?? known.appId,
    appName: own.appName ?? known.appName,
    window: own.window ?? known.window,
    title: own.title ?? known.title,
  };
}

/** A step, by the app it used: what groups and summaries count as one app. */
export const appKey = (use: ComputerUse) => use.appId?.toLowerCase() ?? (use.kind === "browser" ? "browser" : (use.appName ?? "computer"));

// ---------------------------------------------------------------------------

export interface Shot {
  /** The screenshot, as an object URL. */
  url: string;
  /** A smaller copy for thumbnails and docks, once it's made (null while it is, or when the shot is small already). */
  thumb: string | null;
  threadId: string;
}

export interface Screen {
  use: ComputerUse;
  turnId: string;
  itemId: string;
  /** The step holding the latest screenshot of this app the turn has seen. */
  shotId: string | null;
}

interface ScreensState {
  /** Per thread, while its turn uses the computer: the app its latest step touched, and its last look at it. */
  latest: Record<string, Screen>;
  /** Screenshots by item id, the most recent ones. */
  shots: Record<string, Shot>;
  /** Steps seen so far, filled in from the steps around them (a step names its app only once it's done). */
  uses: Record<string, ComputerUse>;
}

const SHOTS_KEPT = 60;
const USES_KEPT = 2000;
/** Width of the copy shown in docks, glances and thumbnails. */
const THUMB_W = 640;

export const useScreens = create<ScreensState>(() => ({ latest: {}, shots: {}, uses: {} }));

/** A selector over the screens, held still while its view is frozen (as useThread's are). */
export function useScreen<T>(selector: (s: ScreensState) => T, equal: (a: T, b: T) => boolean = Object.is): T {
  return useGatedStore(useScreens, selector, equal);
}

/**
 * Once `map` holds twice `n` entries, the oldest (insertion order) go, down to `n`: a copy every
 * `n` additions rather than on each. `keep` spares some; `drop` hears about the rest.
 */
function trim<T>(map: Record<string, T>, n: number, keep?: (id: string) => boolean, drop?: (v: T) => void): Record<string, T> {
  const ids = Object.keys(map);
  if (ids.length <= 2 * n) return map;
  const cut = ids.length - n;
  const out: Record<string, T> = {};
  ids.forEach((id, i) => {
    if (i >= cut || keep?.(id)) out[id] = map[id];
    else drop?.(map[id]);
  });
  return out;
}

function revoke(shot: Shot) {
  URL.revokeObjectURL(shot.url);
  if (shot.thumb) URL.revokeObjectURL(shot.thumb);
}

/** Trims the screenshots, sparing any a dock still shows (its thread's latest). */
function trimShots(latest: Record<string, Screen>, shots: Record<string, Shot>): Record<string, Shot> {
  const showing = new Set(Object.values(latest).map((l) => l.shotId));
  return trim(shots, SHOTS_KEPT, (id) => showing.has(id), revoke);
}

/** A step's own facts, with the gaps filled from what the live session knew about it. */
export function useComputerUse(item: ThreadItem): ComputerUse | null {
  const known = useScreen((s) => s.uses[item.id]);
  const own = computerUseOf(item);
  return own && fill(own, known);
}

// ---------------------------------------------------------------------------
// Capture: steps as they arrive (live, or in history), recorded here and stored without screenshots.

interface Capture {
  /** The item to keep in the thread: unwrapped, minus its screenshots. */
  item: McpCall;
  use: ComputerUse;
  image: { data: string; mime: string } | null;
}

/** Finished steps by id: history comes back again and again (every poll of a thread running elsewhere), and a finished step doesn't change. */
const captured = new Map<string, Capture>();
const CAPTURED_KEPT = 500;

function capture(raw: ThreadItem): Capture | null {
  if (raw.type !== "mcpToolCall" || (raw.server !== CUA && raw.server !== NODE)) return null;
  const done = raw.status !== "inProgress";
  const hit = done ? captured.get(raw.id) : undefined;
  if (hit && hit.item.status === raw.status) return hit;
  const item = unwrapResult(raw);
  const use = computerUseOf(item);
  if (!use) return null;
  const content: unknown[] = Array.isArray(item.result?.content) ? item.result.content : [];
  const image = obj(content.findLast((c) => obj(c)?.type === "image" && str(obj(c)!.data)));
  const data = str(image?.data);
  // History's copies are cut short ("…N chars truncated…"): nothing to show.
  const whole = !!data && !/[^A-Za-z0-9+/=]/.test(data);
  const kept: McpCall = image ? { ...item, result: { ...item.result!, content: content.filter((c) => obj(c)?.type !== "image") as McpResult["content"] } } : item;
  if (kept !== item) usesOf.set(kept, use);
  const c: Capture = { item: kept, use, image: whole ? { data: data!, mime: str(image!.mimeType) ?? "image/png" } : null };
  if (done) {
    captured.set(raw.id, c);
    if (captured.size > CAPTURED_KEPT) captured.delete(captured.keys().next().value!);
  }
  return c;
}

/**
 * History stores a step whose result held a screenshot as that whole result, serialized into a
 * single text block ({"content":[…],"_meta":{…}}). Put it back the way it arrived live, so the
 * step still says which app it used.
 */
function unwrapResult(item: McpCall): McpCall {
  if (!item.result) return item;
  // It can be wrapped more than once (a result inside a result inside a result).
  let result = item.result;
  for (let depth = 0; depth < 4 && Array.isArray(result.content) && result.content.length === 1; depth++) {
    const text = obj(result.content[0])?.type === "text" ? str(obj(result.content[0])!.text) : null;
    if (!text?.startsWith('{"content":[')) break;
    try {
      const inner = obj(JSON.parse(text));
      if (!inner || !Array.isArray(inner.content)) break;
      result = { ...result, ...inner, content: inner.content, _meta: inner._meta ?? result._meta } as McpResult;
    } catch {
      break;
    }
  }
  return result === item.result ? item : { ...item, result };
}

/** A screenshot as an object URL (decoded here once, not on every render), with a smaller copy to follow. */
function shotFrom(threadId: string, itemId: string, image: { data: string; mime: string }): Shot | null {
  try {
    const bin = atob(image.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: image.mime });
    void thumbnail(itemId, blob);
    return { url: URL.createObjectURL(blob), thumb: null, threadId };
  } catch {
    return null;
  }
}

async function thumbnail(itemId: string, blob: Blob) {
  let thumb: string | null = null;
  try {
    const bmp = await createImageBitmap(blob);
    if (bmp.width > THUMB_W) {
      const canvas = new OffscreenCanvas(THUMB_W, Math.round((bmp.height * THUMB_W) / bmp.width));
      canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      thumb = URL.createObjectURL(await canvas.convertToBlob({ type: "image/webp", quality: 0.85 }));
    }
    bmp.close();
  } catch {
    return;
  }
  if (!thumb) return;
  const shot = useScreens.getState().shots[itemId];
  if (!shot || shot.thumb) return void URL.revokeObjectURL(thumb);
  useScreens.setState((s) => ({ shots: { ...s.shots, [itemId]: { ...shot, thumb } } }));
}

/**
 * A step arriving live (item/started, item/completed): recorded, and shown as what the thread is
 * doing now. Returns the item to store in the thread.
 */
export function captureLive<T extends ThreadItem>(threadId: string, turnId: string, raw: T): T {
  const c = capture(raw);
  if (!c) return raw;
  const id = c.item.id;
  const shot = c.image && !useScreens.getState().shots[id] ? shotFrom(threadId, id, c.image) : null;
  useScreens.setState((s) => {
    const prev = s.latest[threadId];
    const sameTurn = prev?.turnId === turnId;
    // A step that hasn't said which app yet carries on with the one it asked to use, or the one before it.
    const use = fill(fill(c.use, s.uses[id]), sameTurn ? prev.use : null);
    const shots = shot ? { ...s.shots, [id]: shot } : s.shots;
    // Steps that look without sending the picture back keep showing the last one of the same app.
    const shotId = shots[id] ? id : sameTurn && appKey(prev.use) === appKey(use) ? prev.shotId : null;
    const latest = { ...s.latest, [threadId]: { use, turnId, itemId: id, shotId } };
    return { latest, uses: trim({ ...s.uses, [id]: use }, USES_KEPT), shots: trimShots(latest, shots) };
  });
  return c.item as T;
}

/**
 * Steps from history, or from a turn as it finishes: each one recorded (what it was, and its
 * screenshot when whole), in one store update for the lot. Returns the turns to store.
 */
export function captureTurns<T extends { items: ThreadItem[] }>(threadId: string, turns: T[]): T[] {
  const found: Capture[] = [];
  const out = turns.map((t) => {
    let changed = false;
    const items = t.items.map((it) => {
      const c = capture(it);
      if (!c) return it;
      found.push(c);
      if (c.item !== it) changed = true;
      return c.item;
    });
    return changed ? { ...t, items } : t;
  });
  if (!found.length) return turns;
  const have = useScreens.getState();
  const fresh: Record<string, Shot> = {};
  for (const c of found) {
    if (!c.image || have.shots[c.item.id]) continue;
    const shot = shotFrom(threadId, c.item.id, c.image);
    if (shot) fresh[c.item.id] = shot;
  }
  useScreens.setState((s) => {
    let uses = s.uses;
    for (const c of found) {
      const use = fill(c.use, s.uses[c.item.id]);
      if (shallowEqual(use, s.uses[c.item.id])) continue;
      if (uses === s.uses) uses = { ...uses };
      uses[c.item.id] = use;
    }
    const shots = Object.keys(fresh).length ? trimShots(s.latest, { ...s.shots, ...fresh }) : s.shots;
    return uses === s.uses && shots === s.shots ? s : { uses: trim(uses, USES_KEPT), shots };
  });
  return out;
}

/** The turn the thread was using the computer in is over: its dock goes. */
export function screenTurnEnded(threadId: string, turnId: string) {
  if (useScreens.getState().latest[threadId]?.turnId !== turnId) return;
  useScreens.setState((s) => {
    const latest = { ...s.latest };
    delete latest[threadId];
    return { latest };
  });
}

// A thread whose transcript is let go (idle eviction) lets go of its screenshots too.
useThreads.subscribe((s, prev) => {
  if (s.live === prev.live) return;
  const sc = useScreens.getState();
  const gone = (id: string) => !!prev.live[id] && !s.live[id];
  const shotsGone = Object.keys(sc.shots).filter((id) => gone(sc.shots[id].threadId));
  const latestGone = Object.keys(sc.latest).filter(gone);
  if (!shotsGone.length && !latestGone.length) return;
  useScreens.setState((cur) => {
    const shots = { ...cur.shots };
    for (const id of shotsGone) {
      if (shots[id]) revoke(shots[id]);
      delete shots[id];
    }
    const latest = { ...cur.latest };
    for (const id of latestGone) delete latest[id];
    return { shots, latest };
  });
});

/**
 * Codex asks before computer use touches an app, naming it: the step waiting on that answer is
 * about that app, before its result can say so.
 */
export function noteAppRequest(threadId: string, turnId: string, params: unknown) {
  const callId = str(obj(obj(params)?._meta)?.callId);
  const ask = appAskedFor(params);
  if (!ask?.appId || !callId) return;
  useScreens.setState((s) => {
    const prev = s.uses[callId];
    const use = prev ? fill(prev, ask) : ask;
    const latest = s.latest[threadId];
    return {
      uses: trim({ ...s.uses, [callId]: use }, USES_KEPT),
      latest: latest?.itemId === callId && latest.turnId === turnId ? { ...s.latest, [threadId]: { ...latest, use } } : s.latest,
    };
  });
}

/** The app a computer-use permission request (an MCP elicitation) is about, if it's one. */
export function appAskedFor(params: unknown): ComputerUse | null {
  const p = obj(params);
  const meta = obj(p?._meta);
  const app = str(obj(meta?.tool_params)?.app);
  if (p?.serverName !== CUA || !app || app.length > 1024) return null;
  const appName = str(displayParams(meta?.tool_params_display).find((d) => d.name === "app")?.value);
  return { kind: "app", appId: app, appName, window: null, title: null };
}

/** An elicitation that only asks permission (Codex's MCP tool approvals): no form, and it can be remembered. */
export function isPermissionAsk(params: unknown): boolean {
  const p = obj(params);
  return obj(p?._meta)?.codex_approval_kind === "mcp_tool_call" && !Object.keys(obj(obj(p?.requestedSchema)?.properties) ?? {}).length;
}

/** How long a permission request's answer may be remembered for, as offered. */
export function persistOffered(params: unknown): { session: boolean; always: boolean } {
  const v = obj(obj(params)?._meta)?.persist;
  const list = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  return { session: list.includes("session"), always: list.includes("always") };
}

/** The parameters a permission request shows, as the tool labels them. */
export function displayParams(v: unknown): { name: string; label: string; value: unknown }[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((d) => {
    const name = str(obj(d)?.name);
    return name ? [{ name, label: str(obj(d)!.display_name) ?? name, value: obj(d)!.value }] : [];
  });
}

// ---------------------------------------------------------------------------

const useAppInfos = create<Record<string, AppInfo>>(() => ({}));
const asked = new Set<string>();

function lookUp(appId: string) {
  if (asked.has(appId)) return;
  asked.add(appId);
  bridge.apps
    .info(appId)
    .then((i) => useAppInfos.setState({ [appId]: i }))
    .catch(() => asked.delete(appId)); // try again next time it's shown
}

/** The installed app's name and icon, looked up once per app. */
export function useAppInfo(appId: string | null): AppInfo | null {
  const info = useGatedStore(useAppInfos, (s) => (appId ? s[appId] : undefined));
  useEffect(() => {
    if (appId) lookUp(appId);
  }, [appId]);
  return info ?? null;
}

/** Looks up several apps, re-rendering as each arrives: for labels that name apps without showing them. */
export function useAppInfosFor(appIds: string[]) {
  const key = appIds.join("\n");
  useGatedStore(useAppInfos, (s) => appIds.map((id) => s[id]), shallowEqual);
  useEffect(() => {
    for (const id of appIds) lookUp(id);
  }, [key]);
}

/** What to call the app: its installed name, else what the agent saw, else the tail of its id. */
export function appLabel(use: ComputerUse, info?: AppInfo | null): string {
  if (use.kind === "browser") return "Browser";
  const known = info ?? (use.appId ? useAppInfos.getState()[use.appId] : null);
  if (known?.name) return known.name;
  if (use.appName) return use.appName;
  if (use.appId) {
    const tail = use.appId.split(/[\\/]/).pop()!.replace(/\.exe$/i, "").split(".").pop()!;
    return tail.charAt(0).toUpperCase() + tail.slice(1);
  }
  return "Computer";
}
