import { providerOf, type EngineId } from "@shared/bridge";
import type { ThreadItem } from "@shared/protocol";
import type { JsonValue } from "@shared/protocol/generated/serde_json/JsonValue";
import { rpcFor } from "../rpc/client";
import { PROVIDERS } from "../agents";
import { useConn, emptyProviderConn } from "./conn";
import { flushNow, useThreads } from "./threads";
import { spawnedBy } from "./projects";

/**
 * Thread titles for engines that leave naming to the client: Codex's TUI and desktop app each
 * title their threads, so threads started here would otherwise go unnamed. Done the way the TUI
 * does it (codex-rs/tui/src/app/thread_title.rs): when a message goes out in a thread with no
 * name, a hidden thread is asked for a structured title, which is saved with `thread/name/set`
 * unless the thread got a name in the meantime.
 *
 * The hidden thread is ephemeral (never written to disk or listed) and read-only, with every
 * tool, hook, plugin and MCP server off, since the prompt carries the user's text. Its events
 * are kept out of the stores here.
 */

const SOURCE = "thread_title";
const MODEL = "gpt-5.6-luna";
const MAX_CHARS = 36;
const PROMPT_MAX_BYTES = 960;
const TIMEOUT_MS = 30_000;
const RESPONSE_MAX_BYTES = 8 * 1024;

const INSTRUCTIONS =
  `Generate a concise, single-line task title of at most ${MAX_CHARS} characters and under five words where possible. ` +
  "Start with an imperative verb. Capitalize only the first word unless the user's language, proper nouns, acronyms, or code terms require otherwise. " +
  "Preserve ticket references exactly. Write in the user's language. Do not use quotes, markdown, or trailing punctuation. Do not answer the request.";

const SCHEMA = {
  type: "object",
  properties: { title: { type: "string", minLength: 1, maxLength: MAX_CHARS } },
  required: ["title"],
  additionalProperties: false,
};

const FEATURES_OFF = [
  "apps",
  "code_mode",
  "code_mode_only",
  "context_management",
  "current_time_reminder",
  "deferred_executor",
  "enable_fanout",
  "goals",
  "hooks",
  "image_generation",
  "memories",
  "multi_agent",
  "multi_agent_v2",
  "plugins",
  "request_permissions_tool",
  "shell_snapshot",
  "shell_tool",
  "standalone_web_search",
  "token_budget",
  "tool_suggest",
  "unified_exec",
  "view_image",
];

/** Hidden threads, kept for the session so their late events stay hidden too. */
const hidden = new Set<string>();
/** What each running hidden turn has answered so far, and who's waiting for it. */
const waiting = new Map<string, { text: string | null; done: (result: string | Error) => void }>();
/** Threads with a title on the way (one at a time each); a rename in the meantime cancels it. */
const pending = new Map<string, { cancelled: boolean }>();

/**
 * A notification from a hidden thread: consumed here, and the caller drops it. The thread is
 * recognized by its source on `thread/started`, which can arrive before `thread/start` returns.
 */
export function titleEvent(method: string, params: any): boolean {
  if (method === "thread/started" && params?.thread?.threadSource === SOURCE) hidden.add(params.thread.id);
  const threadId: string | undefined = params?.threadId ?? params?.thread?.id;
  if (!threadId || !hidden.has(threadId)) return false;
  const w = waiting.get(threadId);
  if (!w) return true;
  if (method === "item/completed" && params.item?.type === "agentMessage") {
    if (new TextEncoder().encode(params.item.text).length > RESPONSE_MAX_BYTES) w.done(new Error("title response too long"));
    else w.text = params.item.text;
  } else if (method === "turn/completed") {
    const status = params.turn?.status;
    if (status !== "completed") w.done(new Error(`title turn ended ${status}`));
    else w.done(w.text ?? new Error("title turn gave no answer"));
  }
  return true;
}

/** Hidden threads ask nothing of the user; anything they do ask is refused. */
export const isTitleThread = (threadId: string) => hidden.has(threadId);

/** A name the user chose wins over one still being generated. */
export function cancelTitle(threadId: string) {
  const p = pending.get(threadId);
  if (p) p.cancelled = true;
}

/** A message went out in a thread: if the thread has no name yet, title it from that message. */
export function titleFromMessage(provider: EngineId, threadId: string, item: Extract<ThreadItem, { type: "userMessage" }>) {
  if (!PROVIDERS[providerOf(provider)].autoTitle || pending.has(threadId) || hidden.has(threadId)) return;
  flushNow(); // a brand-new thread's thread/started may still be queued
  const thread = useThreads.getState().threads[threadId];
  // A subagent goes by the nickname Codex gave it.
  if (!thread || thread.ephemeral || thread.name || spawnedBy(thread)) return;
  const text = item.content
    .map((c) => (c.type === "text" ? c.text : ""))
    .filter(Boolean)
    .join(" ");
  if (!text.trim()) return;
  const job = { cancelled: false };
  pending.set(threadId, job);
  void generate(provider, threadId, titlePrompt(text), job)
    .catch((err) => console.debug(`${provider}: couldn't title ${threadId}`, err))
    .finally(() => pending.delete(threadId));
}

/** The title thread runs in the thread's own engine (on its device, for a paired device's). */
async function generate(provider: EngineId, threadId: string, prompt: string, job: { cancelled: boolean }) {
  const rpc = rpcFor(provider);
  const st = useThreads.getState();
  const thread = st.threads[threadId];
  const conn = useConn.getState().providers[provider] ?? emptyProviderConn();
  // The TUI's small title model where the account has it; otherwise the thread's own model.
  const small = thread.modelProvider === "openai" && conn.account?.account?.type === "chatgpt" && conn.models.some((m) => m.model === MODEL);
  const model = small ? MODEL : (st.live[threadId]?.settings?.model ?? thread.model ?? null);

  const cwd = thread.cwd || null;
  const started = await deadline(
    (async () => {
      // Every MCP server is turned off by name, so read which ones this folder's config has.
      const effective = (await rpc.request("config/read", { includeLayers: false, cwd })) as { config?: { mcp_servers?: Record<string, unknown> | null } };
      const config: Record<string, JsonValue> = {
        ...Object.fromEntries(FEATURES_OFF.map((f) => [`features.${f}`, false])),
        "cloud.skills.enabled": false,
        "skills.include_instructions": false,
        "tools.experimental_request_user_input.enabled": false,
        "tools.update_plan.enabled": false,
        web_search: "disabled",
        default_permissions: ":read-only",
        mcp_servers: Object.fromEntries(Object.keys(effective.config?.mcp_servers ?? {}).map((name) => [name, { enabled: false }])),
      };
      return rpc.request("thread/start", {
        model,
        modelProvider: thread.modelProvider || null,
        cwd,
        sandbox: "read-only",
        runtimeWorkspaceRoots: [],
        ephemeral: true,
        threadSource: SOURCE,
        environments: [],
        dynamicTools: [],
        selectedCapabilityRoots: [],
        config,
      });
    })(),
    "title thread didn't start",
  );
  const tempId = started.thread.id;
  hidden.add(tempId);
  let finish!: (result: string | Error) => void;
  const answer = new Promise<string>((resolve, reject) => {
    finish = (result) => (result instanceof Error ? reject(result) : resolve(result));
  });
  const timer = setTimeout(() => finish(new Error("title timed out")), TIMEOUT_MS);
  try {
    if (started.sandbox.type !== "readOnly") throw new Error("title thread didn't start read-only");
    if (job.cancelled) return;
    waiting.set(tempId, { text: null, done: finish });
    await rpc.request("turn/start", {
      threadId: tempId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
      outputSchema: SCHEMA,
      ...(small ? { effort: "low" as const } : {}),
    });
    const title = parseTitle(await answer);
    if (!title || job.cancelled) return;
    // Named while we waited (here, or in another app): that name stays.
    const fresh = await rpc.request("thread/read", { threadId, includeTurns: false });
    if (fresh.thread.name || job.cancelled) return;
    await rpc.request("thread/name/set", { threadId, name: title });
    useThreads.setState((s) => (s.threads[threadId] ? { threads: { ...s.threads, [threadId]: { ...s.threads[threadId], name: title } } } : s));
  } finally {
    clearTimeout(timer);
    waiting.delete(tempId);
    void rpc.request("thread/unsubscribe", { threadId: tempId }).catch(() => {});
  }
}

function deadline<T>(work: Promise<T>, what: string): Promise<T> {
  let timer = 0;
  const late = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(what)), TIMEOUT_MS);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** The instructions plus as much of the message as fits the TUI's 960-byte budget. */
function titlePrompt(message: string): string {
  const prefix = `${INSTRUCTIONS}\n\nUser prompt:\n`;
  const enc = new TextEncoder();
  let room = PROMPT_MAX_BYTES - enc.encode(prefix).length;
  let kept = "";
  for (const ch of message.trim()) {
    room -= enc.encode(ch).length;
    if (room < 0) break;
    kept += ch;
  }
  return prefix + kept;
}

/** `{"title": …}` and nothing else, tidied: no wrapping quotes, runs of spaces or trailing punctuation. */
export function parseTitle(response: string): string | null {
  if (!response.trimStart().startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Object.keys(parsed).some((k) => k !== "title")) return null;
  const raw = (parsed as { title?: unknown }).title;
  if (typeof raw !== "string") return null;
  const title = raw
    .trim()
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
    .replace(/[.?!]+$/, "")
    .trimEnd();
  return title ? Array.from(title).slice(0, MAX_CHARS).join("") : null;
}
