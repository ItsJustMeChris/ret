import { memo, useState } from "react";
import {
  Bot,
  Brain,
  Check,
  ChevronRight,
  FileText,
  FolderOpen,
  Globe,
  Image as ImageIcon,
  ListChecks,
  LoaderCircle,
  Paperclip,
  Search,
  SquareTerminal,
  Wrench,
  X,
  FilePen,
  Layers,
} from "lucide-react";
import type { FileUpdateChange, ThreadItem } from "../../protocol";
import { useThreads } from "../../state/threads";
import { changeStats, duration, shortPath, unwrapCommand } from "../../lib/format";
import { highlight } from "../../lib/markdown";
import { Markdown } from "../Markdown";
import { ThreadImage } from "./ThreadImage";
import { PlanActions, ReplyQuestions } from "./Questions";

type Ctx = { threadId: string; cwd: string | null };

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
        {expandable && <ChevronRight className="tool-chev" size={13} />}
      </button>
      {open && expandable && <div className="tool-body">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------

function UserMessage({ item, cwd }: { item: Extract<ThreadItem, { type: "userMessage" }>; cwd: string | null }) {
  const text = item.content
    .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  // Images you sent show as pictures; anything else stays a chip.
  const images = item.content.filter((c) => c.type === "localImage" || c.type === "image");
  const files = item.content.filter((c) => c.type !== "text" && c.type !== "localImage" && c.type !== "image");
  return (
    <div className="msg-user">
      <div className="bubble">
        {images.length > 0 && (
          <div className={`user-images ${images.length === 1 ? "single" : ""}`}>
            {images.map((c, i) =>
              c.type === "localImage" ? <ThreadImage key={i} path={c.path} cwd={cwd} /> : "url" in c ? <ThreadImage key={i} src={c.url} /> : null,
            )}
          </div>
        )}
        {text && <div className="user-text">{text}</div>}
        {files.length > 0 && (
          <div className="attachments">
            {files.map((f, i) => (
              <span className="chip" key={i} data-path={"path" in f ? f.path : undefined}>
                <Paperclip size={11} />
                {"path" in f ? shortPath(f.path) : "url" in f ? f.url : "attachment"}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentMessage({ item, streaming, threadId }: { item: Extract<ThreadItem, { type: "agentMessage" }>; streaming: boolean; threadId: string }) {
  return (
    <div className={`msg-agent ${item.phase === "commentary" ? "commentary" : ""} ${streaming ? "streaming" : ""}`}>
      <Markdown text={item.text} streaming={streaming} />
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
      label={live ? <span className="shimmer">{heading ?? "Thinking"}</span> : (heading ?? "Thought")}
      tone="muted"
    >
      <Markdown text={text} className="md-muted" />
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

function FileRow({ change, cwd }: { change: FileUpdateChange; cwd: string | null }) {
  const [open, setOpen] = useState(false);
  const { add, del } = changeStats(change);
  const kind = change.kind.type;
  return (
    <div className={`file-row ${open ? "open" : ""}`}>
      <button className="file-head" onClick={() => setOpen(!open)}>
        <ChevronRight className="tool-chev" size={12} />
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

function Collab({ item }: { item: Extract<ThreadItem, { type: "collabAgentToolCall" }> }) {
  const verb: Record<string, string> = {
    spawnAgent: "Spawned agent",
    sendInput: "Messaged agent",
    sendMessage: "Messaged agent",
    wait: "Waiting on agents",
    closeAgent: "Closed agent",
    resumeAgent: "Resumed agent",
    followupTask: "Follow-up task",
    interruptAgent: "Interrupted agent",
    listAgents: "Listed agents",
  };
  return (
    <Disclosure icon={<Bot size={13} />} label={verb[item.tool] ?? item.tool} meta={<Status status={item.status as string} />}>
      {item.prompt && <Markdown text={item.prompt} className="md-muted" />}
    </Disclosure>
  );
}

// ---------------------------------------------------------------------------

/** Items that render as compact "activity" rows and can be grouped. */
export function isActivity(item: ThreadItem | undefined): boolean {
  if (!item) return false;
  switch (item.type) {
    case "commandExecution":
    case "mcpToolCall":
    case "dynamicToolCall":
    case "webSearch":
    case "imageView":
    case "collabAgentToolCall":
    case "subAgentActivity":
    case "functionCallOutput":
    case "sleep":
    case "reasoning":
      return true;
    default:
      return false;
  }
}

export function activitySummary(items: ThreadItem[]): string {
  let reads = 0;
  let searches = 0;
  let cmds = 0;
  let tools = 0;
  let web = 0;
  for (const it of items) {
    if (it.type === "commandExecution") {
      const t = it.commandActions?.[0]?.type;
      if (t === "read") reads += it.commandActions.length;
      else if (t === "search" || t === "listFiles") searches++;
      else cmds++;
    } else if (it.type === "mcpToolCall" || it.type === "dynamicToolCall" || it.type === "collabAgentToolCall") tools++;
    else if (it.type === "webSearch") web++;
  }
  const parts: string[] = [];
  if (reads) parts.push(`read ${reads} ${reads === 1 ? "file" : "files"}`);
  if (searches) parts.push(`${searches} ${searches === 1 ? "search" : "searches"}`);
  if (cmds) parts.push(`ran ${cmds} ${cmds === 1 ? "command" : "commands"}`);
  if (tools) parts.push(`${tools} tool ${tools === 1 ? "call" : "calls"}`);
  if (web) parts.push(`${web} web ${web === 1 ? "lookup" : "lookups"}`);
  const s = parts.join(", ") || "thought";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const ItemView = memo(function ItemView({ itemId, ctx, live }: { itemId: string; ctx: Ctx; live: boolean }) {
  const item = useThreads((s) => s.live[ctx.threadId]?.items[itemId]);
  if (!item) return null;
  switch (item.type) {
    case "userMessage":
      return <UserMessage item={item} cwd={ctx.cwd} />;
    case "agentMessage":
      return <AgentMessage item={item} streaming={live} threadId={ctx.threadId} />;
    case "reasoning":
      return <Reasoning item={item} live={live} />;
    case "commandExecution":
      return <CommandExec item={item} ctx={ctx} />;
    case "fileChange":
      return <FileChange item={item} ctx={ctx} />;
    case "mcpToolCall":
      return <McpTool item={item} />;
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
          <Markdown text={item.text} />
          <PlanActions threadId={ctx.threadId} itemId={item.id} />
        </div>
      );
    case "imageView":
      return (
        <div className="image-view">
          <Disclosure icon={<ImageIcon size={13} />} label={<>Viewed <span className="path" data-path={item.path}>{shortPath(item.path, ctx.cwd)}</span></>} />
          <ThreadImage path={item.path} cwd={ctx.cwd} />
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
          <Layers size={12} /> Context compacted
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
      return <Collab item={item} />;
    case "subAgentActivity":
      return <Disclosure icon={<Bot size={13} />} label={`Sub-agent ${item.kind}`} meta={<span className="path">{item.agentPath}</span>} />;
    case "hookPrompt":
      return <div className="hook">{item.fragments.map((f) => f.text).join("\n")}</div>;
    case "sleep":
      return <Disclosure icon={<LoaderCircle size={13} />} label="Waiting" tone="muted" />;
    default:
      return null;
  }
});
