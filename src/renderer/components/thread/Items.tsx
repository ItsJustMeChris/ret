import { memo, useEffect, useMemo, useState } from "react";
import {
  Bot,
  Brain,
  Check,
  ClipboardPaste,
  FileText,
  FolderOpen,
  Globe,
  Hourglass,
  Image as ImageIcon,
  ListChecks,
  LoaderCircle,
  MessageCircleQuestion,
  MessagesSquare,
  Paperclip,
  Puzzle,
  Search,
  SquareTerminal,
  Wrench,
  X,
  FilePen,
  Layers,
} from "lucide-react";
import { Chevron } from "../ui/Chevron";
import type { FileUpdateChange, ThreadItem } from "@shared/protocol";
import { useThread } from "../../state/useThread";
import { agentName, threadTitle } from "../../state/projects";
import { bridge } from "../../bridge";
import { viewFile } from "../../lib/viewFile";
import { parseCodexMessage } from "../../lib/codexMessage";
import { imageType } from "@shared/files";
import { StatusDot } from "../StatusDot";
import { openFrom } from "./Subagents";
import { changeStats, duration, shortPath, unwrapCommand } from "../../lib/format";
import { compactionLabel } from "../../lib/activity";
import { highlight } from "../../lib/markdown";
import { Markdown } from "../Markdown";
import { splitContentRefs } from "../../lib/visualize";
import { Visualization, VisualizationPending } from "./Visualization";
import { ThreadImage } from "./ThreadImage";
import { PlanActions, ReplyQuestions } from "./Questions";
import { Shimmer } from "../ui/Shimmer";
import { computerUseOf, outputText, useComputerUse, useScreen } from "../../state/computerUse";
import { AppIcon, AppName } from "./ComputerUse";

/** `host`: the paired device the thread runs on (its files are there); null for this computer. */
type Ctx = { threadId: string; cwd: string | null; host: string | null };

const Status = ({ status }: { status: string }) => {
  if (status === "inProgress") return <LoaderCircle className="spin st-run" size={13} />;
  if (status === "completed") return <Check className="st-ok" size={13} />;
  if (status === "declined") return <X className="st-warn" size={13} />;
  return <X className="st-err" size={13} />;
};

function Disclosure({
  icon,
  label,
  meta,
  children,
  defaultOpen = false,
  tone,
}: {
  icon: React.ReactNode;
  label: React.ReactNode;
  meta?: React.ReactNode;
  children?: React.ReactNode;
  defaultOpen?: boolean;
  tone?: "muted" | "error";
}) {
  const [open, setOpen] = useState(defaultOpen);
  const expandable = !!children;
  return (
    <div className={`tool ${open ? "open" : ""} ${tone ?? ""}`}>
      <button className="tool-head" onClick={() => expandable && setOpen(!open)} disabled={!expandable}>
        <span className="tool-icon">{icon}</span>
        <span className="tool-label">{label}</span>
        {meta && <span className="tool-meta">{meta}</span>}
        {expandable && <Chevron className="tool-chev" size={13} />}
      </button>
      {open && expandable && <div className="tool-body">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function UserMessage({ item, ctx }: { item: Extract<ThreadItem, { type: "userMessage" }>; ctx: Ctx }) {
  const { cwd, host } = ctx;
  const text = item.content
    .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  // Written in the Codex app: its context sections become chips, and what you wrote reads as written.
  const msg = useMemo(() => parseCodexMessage(text), [text]);
  // Images you sent show as pictures; anything else stays a chip.
  const images = item.content.filter((c) => c.type === "localImage" || c.type === "image");
  const files = item.content.filter((c) => c.type !== "text" && c.type !== "localImage" && c.type !== "image");
  const pictured = new Set(images.map((c) => ("path" in c ? c.path : "")));
  const mentioned = msg?.files.filter((f) => !(f.image && pictured.has(f.path))) ?? [];
  const chips = files.length + mentioned.length + (msg?.chats.length ?? 0) + (msg?.browser ? 1 : 0);
  return (
    <div className="msg-user">
      <div className="bubble">
        {images.length > 0 && (
          <div className={`user-images ${images.length === 1 ? "single" : ""}`}>
            {images.map((c, i) =>
              c.type === "localImage" ? <ThreadImage key={i} path={c.path} cwd={cwd} host={host} /> : "url" in c ? <ThreadImage key={i} src={c.url} /> : null,
            )}
          </div>
        )}
        {msg?.quotes.map((q, i) => (
          <blockquote key={i} className="user-quote">
            {q.text}
            {q.comment && <div className="user-quote-comment">{q.comment}</div>}
          </blockquote>
        ))}
        {msg?.replies.map((r, i) => (
          <div key={i} className="user-reply">
            {r.question && (
              <div className="user-reply-q">
                <MessageCircleQuestion size={11} />
                <span>{r.question}</span>
              </div>
            )}
            <div className="user-text">{r.answer}</div>
          </div>
        ))}
        {msg ? (
          msg.parts.length > 0 && (
            <div className="user-text">
              {msg.parts.map((p, i) =>
                "text" in p ? (
                  p.text
                ) : "threadId" in p ? (
                  <ChatRef key={i} id={p.threadId} title={p.title} from={ctx.threadId} inline />
                ) : "mention" in p ? (
                  <span key={i} className="chip chip-inline" title={`${p.kind[0].toUpperCase()}${p.kind.slice(1)}: ${p.mention}`}>
                    <Puzzle size={11} />
                    <span className="chip-text">{p.mention}</span>
                  </span>
                ) : (
                  <button key={i} className="chip chip-link chip-inline" title={p.file} onClick={() => void viewFile({ path: p.file }, cwd, ctx.threadId)}>
                    {imageType(p.file) ? <ImageIcon size={11} /> : <FileText size={11} />}
                    <span className="chip-text">{p.label}</span>
                  </button>
                ),
              )}
            </div>
          )
        ) : (
          text && <div className="user-text">{text}</div>
        )}
        {chips > 0 && (
          <div className="attachments">
            {files.map((f, i) => (
              <span className="chip" key={i} data-path={"path" in f ? f.path : undefined}>
                <Paperclip size={11} />
                {"path" in f ? shortPath(f.path) : "url" in f ? f.url : "attachment"}
              </span>
            ))}
            {mentioned.map((f, i) => (
              <button
                key={`f${i}`}
                className="chip chip-link"
                data-path={f.path}
                title={f.path}
                onClick={() => void viewFile({ path: f.path }, cwd, ctx.threadId)}
              >
                {f.pasted ? <ClipboardPaste size={11} /> : f.image ? <ImageIcon size={11} /> : f.path.endsWith("/") ? <FolderOpen size={11} /> : <FileText size={11} />}
                <span className="chip-text">{f.pasted ? f.label.replace(/…$/, "") || "Pasted text" : f.label}</span>
              </button>
            ))}
            {msg?.chats.map((id) => <ChatRef key={id} id={id} title={null} from={ctx.threadId} />)}
            {msg?.browser && (
              <button className="chip chip-link" title={`Open in the Codex app's browser: ${msg.browser}`} onClick={() => void bridge.shell.openExternal(msg.browser!)}>
                <Globe size={11} />
                <span className="chip-text">{msg.browser.replace(/^https?:\/\//, "")}</span>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** A Codex chat referenced in a message: opens beside this thread when Ret knows it. */
function ChatRef({ id, title, from, inline }: { id: string; title: string | null; from: string; inline?: boolean }) {
  // That chat's entry only (a whole-store selector would re-run on every streamed token).
  const thread = useThread(id, (s) => s.threads[id]);
  const name = thread ? threadTitle(thread) : title || "Codex chat";
  return (
    <button
      className={`chip chip-link ${inline ? "chip-inline" : ""}`}
      disabled={!thread}
      title={thread ? `Open “${name}”` : "A chat Ret doesn't have"}
      onClick={(e) => openFrom(e, id, from)}
    >
      <MessagesSquare size={11} />
      <span className="chip-text">{name}</span>
    </button>
  );
}

function AgentMessage({
  item,
  streaming,
  threadId,
  host,
}: {
  item: Extract<ThreadItem, { type: "agentMessage" }>;
  streaming: boolean;
  threadId: string;
  host: string | null;
}) {
  return (
    <div className={`msg-agent ${item.phase === "commentary" ? "commentary" : ""} ${streaming ? "streaming" : ""}`}>
      {splitContentRefs(item.text, streaming).map((part, i) =>
        part.kind === "viz" ? (
          <Visualization key={i} viz={part.viz} host={host} />
        ) : part.kind === "pending" ? (
          <VisualizationPending key={i} />
        ) : (
          <Markdown key={i} text={part.text} streaming={streaming} />
        ),
      )}
      {!streaming && item.questions?.length ? <ReplyQuestions threadId={threadId} itemId={item.id} text={item.text} questions={item.questions} /> : null}
    </div>
  );
}

function Reasoning({ item, live }: { item: Extract<ThreadItem, { type: "reasoning" }>; live: boolean }) {
  const text = item.summary.filter(Boolean).join("\n\n") || item.content.filter(Boolean).join("\n\n");
  const heading = /\*\*(.+?)\*\*/.exec(item.summary.at(-1) ?? "")?.[1];
  if (!text) return live ? <div className="thinking"><Brain size={13} /> Thinking…</div> : null;
  return (
    <Disclosure
      icon={<Brain size={13} />}
      label={live ? <Shimmer text={heading ?? "Thinking"} /> : (heading ?? "Thought")}
      tone="muted"
    >
      <Markdown text={text} className="md-muted" streaming={live} />
    </Disclosure>
  );
}

function CommandExec({ item, ctx }: { item: Extract<ThreadItem, { type: "commandExecution" }>; ctx: Ctx }) {
  const cmd = unwrapCommand(item.command);
  const actions = item.commandActions ?? [];
  const meaningful = actions.length > 0 && actions.every((a) => a.type !== "unknown");
  let icon = <SquareTerminal size={13} />;
  let label: React.ReactNode = <code className="cmd">{cmd}</code>;
  if (meaningful) {
    const a = actions[0];
    if (a.type === "read") {
      icon = <FileText size={13} />;
      label = (
        <>
          Read{" "}
          <span className="path" data-path={actions.length === 1 && "path" in a ? a.path : undefined}>
            {actions.map((x) => ("name" in x ? x.name : "")).filter(Boolean).join(", ")}
          </span>
        </>
      );
    } else if (a.type === "listFiles") {
      icon = <FolderOpen size={13} />;
      label = (
        <>
          Listed <span className="path" data-path={a.path ?? undefined}>{a.path ? shortPath(a.path, ctx.cwd) : "files"}</span>
        </>
      );
    } else if (a.type === "search") {
      icon = <Search size={13} />;
      label = (
        <>
          Searched <span className="path">{a.query ?? ""}</span>
          {a.path ? <> in <span className="path" data-path={a.path}>{shortPath(a.path, ctx.cwd)}</span></> : null}
        </>
      );
    }
  }
  const failed = item.status === "failed" || (item.exitCode != null && item.exitCode !== 0);
  const meta = (
    <>
      {item.exitCode != null && item.exitCode !== 0 && <span className="badge err">exit {item.exitCode}</span>}
      {item.durationMs != null && <span>{duration(item.durationMs)}</span>}
      <Status status={failed && item.status === "completed" ? "failed" : item.status} />
    </>
  );
  return (
    <Disclosure icon={icon} label={label} meta={meta} tone={failed ? "error" : undefined}>
      {meaningful && <pre className="cmd-full">$ {cmd}</pre>}
      {item.aggregatedOutput ? <pre className="output">{tail(item.aggregatedOutput, 20_000)}</pre> : <div className="empty">No output</div>}
    </Disclosure>
  );
}

const tail = (s: string, n: number) => (s.length > n ? "…" + s.slice(-n) : s);

export function DiffView({ diff, path, whole }: { diff: string; path?: string; whole?: "add" | "delete" }) {
  // Added/deleted files arrive as plain content; present them as all-plus / all-minus.
  const lines = whole ? diff.replace(/\n$/, "").split("\n").map((l) => (whole === "add" ? "+" : "-") + l) : diff.split("\n");
  const ext = path?.split(".").pop() ?? null;
  return (
    <pre className="diff">
      {lines.slice(0, 1500).map((line, i) => {
        const cls = line.startsWith("@@")
          ? "hunk"
          : line.startsWith("+") && !line.startsWith("+++")
            ? "add"
            : line.startsWith("-") && !line.startsWith("---")
              ? "del"
              : line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")
                ? "meta"
                : "ctx";
        const body = cls === "add" || cls === "del" || cls === "ctx" ? line.slice(1) : line;
        return (
          <div key={i} className={`dl ${cls}`}>
            <span className="dl-sign">{cls === "add" ? "+" : cls === "del" ? "−" : " "}</span>
            {cls === "hunk" || cls === "meta" ? (
              <span>{body}</span>
            ) : (
              <span dangerouslySetInnerHTML={{ __html: highlight(body, ext) || " " }} />
            )}
          </div>
        );
      })}
      {lines.length > 1500 && <div className="dl meta">… {lines.length - 1500} more lines</div>}
    </pre>
  );
}

export function FileRow({ change, cwd }: { change: FileUpdateChange; cwd: string | null }) {
  const [open, setOpen] = useState(false);
  const { add, del } = changeStats(change);
  const kind = change.kind.type;
  return (
    <div className={`file-row ${open ? "open" : ""}`}>
      <button className="file-head" onClick={() => setOpen(!open)}>
        <Chevron className="tool-chev" size={12} />
        <span className={`kind kind-${kind}`}>{kind === "add" ? "A" : kind === "delete" ? "D" : "M"}</span>
        <span className="path" data-path={change.path}>{shortPath(change.path, cwd)}</span>
        <span className="stat">
          {add > 0 && <span className="add">+{add}</span>}
          {del > 0 && <span className="del">−{del}</span>}
        </span>
      </button>
      {open && <DiffView diff={change.diff} path={change.path} whole={kind === "update" ? undefined : kind} />}
    </div>
  );
}

function FileChange({ item, ctx }: { item: Extract<ThreadItem, { type: "fileChange" }>; ctx: Ctx }) {
  const totals = item.changes.reduce(
    (acc, c) => {
      const s = changeStats(c);
      return { add: acc.add + s.add, del: acc.del + s.del };
    },
    { add: 0, del: 0 },
  );
  return (
    <div className={`patch ${item.status}`}>
      <div className="patch-head">
        <FilePen size={13} />
        <span>
          {item.status === "declined" ? "Declined edit to" : item.status === "inProgress" ? "Editing" : "Edited"} {item.changes.length}{" "}
          {item.changes.length === 1 ? "file" : "files"}
        </span>
        <span className="stat">
          <span className="add">+{totals.add}</span>
          <span className="del">−{totals.del}</span>
        </span>
        <Status status={item.status} />
      </div>
      {item.changes.map((c) => (
        <FileRow key={c.path} change={c} cwd={ctx.cwd} />
      ))}
    </div>
  );
}

function Json({ value }: { value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return <pre className="output" dangerouslySetInnerHTML={{ __html: highlight(tail(text ?? "", 20_000), "json") }} />;
}

function McpTool({ item }: { item: Extract<ThreadItem, { type: "mcpToolCall" }> }) {
  const name = item.appContext?.appName ? `${item.appContext.appName} · ${item.tool}` : `${item.server} · ${item.tool}`;
  return (
    <Disclosure
      icon={<Wrench size={13} />}
      label={<span className="path">{name}</span>}
      meta={
        <>
          {item.durationMs != null && <span>{duration(item.durationMs)}</span>}
          <Status status={item.status} />
        </>
      }
      tone={item.status === "failed" ? "error" : undefined}
    >
      <div className="kv">Arguments</div>
      <Json value={item.arguments} />
      {item.error && <div className="error-text">{item.error.message}</div>}
      {item.result && (
        <>
          <div className="kv">Result</div>
          <Json value={item.result.structuredContent ?? item.result.content} />
        </>
      )}
    </Disclosure>
  );
}

/** A step of the agent using an app: the app, what the step was for, and the window it saw. */
function ComputerUseTool({ item, host }: { item: Extract<ThreadItem, { type: "mcpToolCall" }>; host: string | null }) {
  const use = useComputerUse(item)!;
  const shot = useScreen((s) => s.shots[item.id]);
  const code = (item.arguments as any)?.code;
  const output = outputText(item);
  const failed = item.status === "failed" || (item.result as any)?.isError === true;
  return (
    <Disclosure
      icon={<AppIcon use={use} host={host} />}
      label={
        <>
          <span className="cu-app">
            <AppName use={use} host={host} />
          </span>
          {use.title && <span className="cu-step">{use.title}</span>}
        </>
      }
      meta={
        <>
          {item.durationMs != null && <span>{duration(item.durationMs)}</span>}
          <Status status={failed && item.status === "completed" ? "failed" : item.status} />
        </>
      }
      tone={failed ? "error" : undefined}
    >
      {shot && (
        <div className="cu-shot">
          <ThreadImage src={shot.thumb ?? shot.url} full={shot.url} />
        </div>
      )}
      {use.window && (
        <div className="kv">
          {use.kind === "browser" ? "Page" : "Window"} · <span className="cu-window">{use.window}</span>
        </div>
      )}
      {typeof code === "string" && <pre className="output" dangerouslySetInnerHTML={{ __html: highlight(code, "js") }} />}
      {item.error && <div className="error-text">{item.error.message}</div>}
      {output && <pre className="output">{tail(output, 20_000)}</pre>}
    </Disclosure>
  );
}

function DynamicTool({ item }: { item: Extract<ThreadItem, { type: "dynamicToolCall" }> }) {
  return (
    <Disclosure
      icon={<Wrench size={13} />}
      label={<span className="path">{[item.namespace, item.tool].filter(Boolean).join(" · ")}</span>}
      meta={<Status status={item.status} />}
    >
      <Json value={item.arguments} />
      {item.contentItems?.map((c, i) => (c.type === "inputText" ? <pre key={i} className="output">{c.text}</pre> : null))}
    </Disclosure>
  );
}

function WebSearch({ item }: { item: Extract<ThreadItem, { type: "webSearch" }> }) {
  const a = item.action;
  const label =
    a?.type === "openPage" ? (
      <>Opened <span className="path">{a.url ?? item.query}</span></>
    ) : a?.type === "findInPage" ? (
      <>Found “{a.pattern}” in <span className="path">{a.url}</span></>
    ) : (
      <>Searched the web for <span className="path">{(a?.type === "search" && (a.queries?.join(" · ") ?? a.query)) || item.query}</span></>
    );
  return <Disclosure icon={<Globe size={13} />} label={label} />;
}

/**
 * The agent's `clock.sleep`. Only the latest step of a running turn can still be waiting; it counts
 * down until it ends (early, if new input arrives), and then says how long it took.
 */
function Sleep({ item, threadId, live }: { item: Extract<ThreadItem, { type: "sleep" }>; threadId: string; live: boolean }) {
  const seen = useThread(threadId, (s) => s.live[threadId]?.sleeps[item.id]);
  const waiting = live && seen?.endedAt == null;
  const [, tick] = useState(0);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [waiting]);
  // What was asked for is a round figure: "5m", not "5m 0s".
  const requested = duration(item.durationMs).replace(/ 0[smh]$/, "");
  if (waiting) {
    const left = seen?.startedAt != null ? Math.ceil(Math.max(0, item.durationMs - (Date.now() - seen.startedAt)) / 1000) : null;
    const meta = left == null ? `up to ${requested}` : left < 60 ? `${left}s left` : `${duration(left * 1000)} left`;
    return <Disclosure icon={<LoaderCircle className="spin" size={13} />} label="Waiting" meta={meta} tone="muted" />;
  }
  // From history there's no telling how long it really ran (new input cuts a sleep short).
  const took = seen?.startedAt != null && seen.endedAt != null ? duration(seen.endedAt - seen.startedAt) : `up to ${requested}`;
  return <Disclosure icon={<Hourglass size={13} />} label="Waited" meta={took} tone="muted" />;
}

/** What a subagent goes by here: its nickname once its thread is known, else its path or id. */
function useAgentName(threadId: string, path?: string | null): string {
  return useThread(threadId, (s) => agentName(s.threads[threadId], path)) ?? `agent ${threadId.slice(-6)}`;
}

/** A subagent named in a row of `from`'s transcript: opens its thread. */
function AgentLink({ threadId, path, from }: { threadId: string; path?: string | null; from: string }) {
  const name = useAgentName(threadId, path);
  return (
    <button className="agent-link" onClick={(e) => openFrom(e, threadId, from)} title={`Open ${name}'s thread`}>
      <StatusDot threadId={threadId} />
      <span>{name}</span>
    </button>
  );
}

/** A subagent starting, hearing from its parent, being stopped, or finishing. The row opens its thread. */
function SubAgentActivity({ item, from }: { item: Extract<ThreadItem, { type: "subAgentActivity" }>; from: string }) {
  const name = useAgentName(item.agentThreadId, item.agentPath);
  const who = <span className="agent-name">{name}</span>;
  const label = {
    started: <>Started {who}</>,
    interacted: <>Messaged {who}</>,
    interrupted: <>Interrupted {who}</>,
    completed: <>{who} finished</>,
  }[item.kind] ?? <>{who}</>;
  const meta = [item.model, item.reasoningEffort].filter(Boolean).join(" · ");
  return (
    <div className="tool">
      <button className="tool-head" onClick={(e) => openFrom(e, item.agentThreadId, from)} title={`Open ${name}'s thread`}>
        <span className="tool-icon">
          <Bot size={13} />
        </span>
        <span className="tool-label">{label}</span>
        <span className="tool-meta">
          {meta}
          <StatusDot threadId={item.agentThreadId} />
        </span>
      </button>
    </div>
  );
}

function Collab({ item, from }: { item: Extract<ThreadItem, { type: "collabAgentToolCall" }>; from: string }) {
  const verb: Record<string, string> = {
    spawnAgent: "Spawned",
    sendInput: "Messaged",
    sendMessage: "Messaged",
    wait: "Waited on",
    closeAgent: "Closed",
    resumeAgent: "Resumed",
    followupTask: "Follow-up task for",
    interruptAgent: "Interrupted",
    listAgents: "Listed agents",
  };
  const ids = item.receiverThreadIds;
  const first = useAgentName(ids[0] ?? "");
  const who = item.tool === "listAgents" ? "" : !ids.length ? "agents" : ids.length === 1 ? first : `${ids.length} agents`;
  const label = `${verb[item.tool] ?? item.tool}${who ? ` ${who}` : ""}`;
  // What the agents said back (a Claude Code agent's report; Codex's last message, on a wait).
  const reports = ids.map((id) => item.agentsStates[id]?.message).filter((m): m is string => !!m?.trim());
  return (
    <Disclosure icon={<Bot size={13} />} label={label} meta={<Status status={item.status as string} />}>
      {(item.prompt || ids.length > 0) && (
        <>
          {item.prompt && <Markdown text={item.prompt} className="md-muted" />}
          {ids.length > 0 && (
            <div className="agent-links">
              {ids.map((id) => (
                <AgentLink key={id} threadId={id} from={from} />
              ))}
            </div>
          )}
          {reports.map((r, i) => (
            <Markdown key={i} text={r} className="agent-report" />
          ))}
        </>
      )}
    </Disclosure>
  );
}

// ---------------------------------------------------------------------------

export const ItemView = memo(function ItemView({ itemId, ctx, live }: { itemId: string; ctx: Ctx; live: boolean }) {
  const item = useThread(ctx.threadId, (s) => s.live[ctx.threadId]?.items[itemId]);
  if (!item) return null;
  switch (item.type) {
    case "userMessage":
      return <UserMessage item={item} ctx={ctx} />;
    case "agentMessage":
      return <AgentMessage item={item} streaming={live} threadId={ctx.threadId} host={ctx.host} />;
    case "reasoning":
      return <Reasoning item={item} live={live} />;
    case "commandExecution":
      return <CommandExec item={item} ctx={ctx} />;
    case "fileChange":
      return <FileChange item={item} ctx={ctx} />;
    case "mcpToolCall":
      return computerUseOf(item) ? <ComputerUseTool item={item} host={ctx.host} /> : <McpTool item={item} />;
    case "dynamicToolCall":
      return <DynamicTool item={item} />;
    case "webSearch":
      return <WebSearch item={item} />;
    case "plan":
      return (
        <div className="plan-item">
          <div className="plan-title">
            <ListChecks size={13} /> Plan
          </div>
          <Markdown text={item.text} streaming={live} />
          <PlanActions threadId={ctx.threadId} itemId={item.id} />
        </div>
      );
    case "imageView":
      return (
        <div className="image-view">
          <Disclosure icon={<ImageIcon size={13} />} label={<>Viewed <span className="path" data-path={item.path}>{shortPath(item.path, ctx.cwd)}</span></>} />
          <ThreadImage path={item.path} cwd={ctx.cwd} host={ctx.host} />
        </div>
      );
    case "imageGeneration":
      return (
        <div className="gen-image">
          {item.result && /^[A-Za-z0-9+/=\s]+$/.test(item.result.slice(0, 200)) ? (
            <img src={`data:image/png;base64,${item.result}`} alt={item.revisedPrompt ?? "generated image"} />
          ) : (
            <Disclosure icon={<ImageIcon size={13} />} label={item.failure ? "Image generation failed" : "Generating image…"} />
          )}
        </div>
      );
    case "contextCompaction":
      return (
        <div className="divider">
          <Layers size={12} /> {compactionLabel(live)}
        </div>
      );
    case "enteredReviewMode":
    case "exitedReviewMode":
      return (
        <div className="review-block">
          <div className="divider">{item.type === "enteredReviewMode" ? "Review started" : "Review finished"}</div>
          {item.review && <Markdown text={item.review} />}
        </div>
      );
    case "collabAgentToolCall":
      return <Collab item={item} from={ctx.threadId} />;
    case "subAgentActivity":
      return <SubAgentActivity item={item} from={ctx.threadId} />;
    case "hookPrompt":
      return <div className="hook">{item.fragments.map((f) => f.text).join("\n")}</div>;
    case "sleep":
      return <Sleep item={item} threadId={ctx.threadId} live={live} />;
    default:
      return null;
  }
});
