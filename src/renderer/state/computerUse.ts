import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { AppInfo } from "@shared/bridge";
import type { ThreadItem } from "@shared/protocol";
import { bridge } from "../bridge";

/**
 * Computer use: Codex driving a desktop app (or a browser) through its `cua_repl` tool. Each step
 * is an MCP tool call whose result says which app it touched (`_meta["codex/toolSurface"]`) and,
 * when the agent looked, carries a screenshot of the window. Screenshots are only whole live (history
 * cuts the middle out of them), and large, so they're kept here, by item, rather than in the items.
 */

type McpCall = Extract<ThreadItem, { type: "mcpToolCall" }>;

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

export function computerUseOf(item: ThreadItem | undefined): ComputerUse | null {
  if (item?.type !== "mcpToolCall") return null;
  const surface = (item.result?._meta as any)?.["codex/toolSurface"];
  const tagged = surface?.kind === "computerUse" || surface?.kind === "browserUse";
  // cua_repl exists for computer use, so its steps count before they report an app; node_repl also
  // runs plain JavaScript, so only its tagged steps do.
  if (!tagged && item.server !== "cua_repl" && item.server !== "computer-use") return null;

  const args = item.arguments as any;
  const text = outputText(item);
  const browser = surface?.kind === "browserUse";
  const app = surface?.app;
  return {
    kind: browser ? "browser" : "app",
    appId: app?.kind === "appId" ? app.appId : null,
    appName: (app?.kind === "displayName" ? app.displayName : null) ?? /\bApp: (.+?)\.?$/m.exec(text)?.[1] ?? null,
    window: browser ? ((item.result?._meta as any)?.browser_use?.url ?? null) : (/Window: "([^"]+)"/.exec(text)?.[1] ?? null),
    title: typeof args?.title === "string" ? args.title : null,
  };
}

/** The step's text output, minus the computer-use manual Codex sends along with the first step. */
export function outputText(item: McpCall): string {
  return (item.result?.content ?? [])
    .map((c: any) => (c?.type === "text" && typeof c.text === "string" && !c.text.startsWith("## Computer Use") ? c.text : ""))
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------

export interface Screen {
  use: ComputerUse;
  turnId: string;
  itemId: string;
  /** The latest screenshot of this app the thread has seen. */
  shot: string | null;
}

interface ScreensState {
  /** Per thread: the app its latest computer-use step touched, and what the window last looked like. */
  latest: Record<string, Screen>;
  /** Screenshots by item id, the most recent SHOTS_KEPT of them. */
  shots: Record<string, string>;
  /** Steps seen so far, filled in from the steps around them (a step names its app only once it's done). */
  uses: Record<string, ComputerUse>;
}

const SHOTS_KEPT = 60;
const USES_KEPT = 2000;

export const useScreens = create<ScreensState>(() => ({ latest: {}, shots: {}, uses: {} }));

/** Keeps the newest `n` entries (insertion order) plus `id`. */
function capped<T>(map: Record<string, T>, n: number, id: string, value: T): Record<string, T> {
  const ids = Object.keys(map);
  const out = ids.length >= n ? Object.fromEntries(ids.slice(ids.length - n + 1).map((k) => [k, map[k]])) : { ...map };
  out[id] = value;
  return out;
}

/** A step's own facts, with the gaps filled from what the live session knew about it. */
export function useComputerUse(item: ThreadItem): ComputerUse | null {
  const known = useScreens((s) => s.uses[item.id]);
  const own = computerUseOf(item);
  if (!own) return null;
  if (!known) return own;
  return { ...own, appId: own.appId ?? known.appId, appName: own.appName ?? known.appName, window: own.window ?? known.window };
}

/** A step, by the app it used: what groups and summaries count as one app. */
export const appKey = (use: ComputerUse) => use.appId?.toLowerCase() ?? (use.kind === "browser" ? "browser" : (use.appName ?? "computer"));

/**
 * Records a computer-use step as it arrives (item/started, item/completed) and returns the item
 * to store in the thread, without its screenshots: they're large, and live here instead.
 */
export function captureComputerUse<T extends ThreadItem>(threadId: string, turnId: string, raw: T, live = true): T {
  const item = unwrapResult(raw);
  const use = computerUseOf(item);
  if (!use || item.type !== "mcpToolCall") return raw;
  const content = item.result?.content ?? [];
  const image = content.findLast((c: any) => c?.type === "image" && typeof c.data === "string" && c.data);
  // History's copies are cut short ("…N chars truncated…"): nothing to show.
  const whole = image && !/[^A-Za-z0-9+/=]/.test((image as any).data);
  const shot = whole ? `data:${(image as any).mimeType || "image/png"};base64,${(image as any).data}` : null;

  useScreens.setState((s) => {
    if (!live) {
      // History: remember the step and its screenshot; the live preview is for steps arriving now.
      const known = s.uses[item.id];
      const merged = known ? { ...use, appId: use.appId ?? known.appId, appName: use.appName ?? known.appName, window: use.window ?? known.window } : use;
      const uses = capped(s.uses, USES_KEPT, item.id, merged);
      return shot && s.shots[item.id] !== shot ? { uses, shots: capped(s.shots, SHOTS_KEPT, item.id, shot) } : { uses };
    }
    const prev = s.latest[threadId];
    const sameApp = prev && prev.turnId === turnId && (!use.appId || prev.use.appId === use.appId);
    // A step that hasn't said which app yet carries on with the one before it (or the one it asked to use).
    const before = s.uses[item.id] ?? (sameApp ? prev.use : null);
    const merged: ComputerUse = before ? { ...use, appId: use.appId ?? before.appId, appName: use.appName ?? before.appName, window: use.window ?? before.window } : use;
    // Steps that look without sending the picture back keep showing the last one of the same app.
    const lastShot = prev && appKey(prev.use) === appKey(merged) ? prev.shot : null;
    const latest = { ...s.latest, [threadId]: { use: merged, turnId, itemId: item.id, shot: shot ?? lastShot } };
    const uses = capped(s.uses, USES_KEPT, item.id, merged);
    if (!shot) return { latest, uses };
    return { latest, uses, shots: capped(s.shots, SHOTS_KEPT, item.id, shot) };
  });

  if (!image) return item;
  return { ...item, result: { ...item.result!, content: content.filter((c: any) => c?.type !== "image") } };
}

/**
 * History stores a step whose result held a screenshot as that whole result, serialized into a
 * single text block ({"content":[…],"_meta":{…}}). Put it back the way it arrived live, so the
 * step still says which app it used.
 */
function unwrapResult<T extends ThreadItem>(item: T): T {
  if (item.type !== "mcpToolCall" || !item.result) return item;
  // It can be wrapped more than once (a result inside a result inside a result).
  let result = item.result;
  for (let depth = 0; depth < 4 && result.content?.length === 1; depth++) {
    const only = result.content[0] as any;
    if (only?.type !== "text" || typeof only.text !== "string" || !only.text.startsWith('{"content":[')) break;
    try {
      const inner = JSON.parse(only.text);
      if (!Array.isArray(inner?.content)) break;
      result = { ...result, ...inner, content: inner.content, _meta: inner._meta ?? result._meta };
    } catch {
      break;
    }
  }
  return result === item.result ? item : { ...item, result };
}

/**
 * Codex asks before computer use touches an app, naming it: the step waiting on that answer is
 * about that app, before its result can say so.
 */
export function noteAppRequest(threadId: string, turnId: string, params: any) {
  const meta = params?._meta;
  const ask = appAskedFor(params);
  if (!ask?.appId || typeof meta?.callId !== "string") return;
  const { appId: app, appName } = ask;
  useScreens.setState((s) => {
    const prev = s.uses[meta.callId];
    const use: ComputerUse = { kind: "app", title: prev?.title ?? null, window: prev?.window ?? null, appId: prev?.appId ?? app, appName: prev?.appName ?? appName };
    const latest = s.latest[threadId];
    return {
      uses: capped(s.uses, USES_KEPT, meta.callId, use),
      latest: latest?.itemId === meta.callId && latest.turnId === turnId ? { ...s.latest, [threadId]: { ...latest, use } } : s.latest,
    };
  });
}

/** The app a computer-use permission request (an MCP elicitation) is about, if it's one. */
export function appAskedFor(params: any): ComputerUse | null {
  const meta = params?._meta;
  const app = meta?.tool_params?.app;
  if (params?.serverName !== "cua_repl" || typeof app !== "string") return null;
  const appName = meta.tool_params_display?.find?.((d: any) => d?.name === "app")?.value ?? null;
  return { kind: "app", appId: app, appName: typeof appName === "string" ? appName : null, window: null, title: null };
}

/** An elicitation that only asks permission (Codex's MCP tool approvals): no form, and it can be remembered. */
export function isPermissionAsk(params: any): boolean {
  return params?.mode === "form" && Array.isArray(params._meta?.persist) && !Object.keys(params.requestedSchema?.properties ?? {}).length;
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
    .catch(() => {});
}

/** The installed app's name and icon, looked up once per app. */
export function useAppInfo(appId: string | null): AppInfo | null {
  const info = useAppInfos((s) => (appId ? s[appId] : undefined));
  useEffect(() => {
    if (appId) lookUp(appId);
  }, [appId]);
  return info ?? null;
}

/** Looks up several apps, re-rendering as each arrives: for labels that name apps without showing them. */
export function useAppInfosFor(appIds: string[]) {
  const key = appIds.join("\n");
  useAppInfos(useShallow((s) => appIds.map((id) => s[id])));
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
