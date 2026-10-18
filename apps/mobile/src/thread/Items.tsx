import {
  Bot,
  ClipboardPaste,
  Brain,
  ChartColumn,
  Check,
  ChevronRight,
  FilePen,
  FileText,
  FolderOpen,
  Globe,
  Hourglass,
  Image as ImageIcon,
  Layers,
  ListChecks,
  MessageCircleQuestion,
  MessagesSquare,
  Paperclip,
  Play,
  Search,
  SquareTerminal,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react-native";
import { memo, useMemo, useState, type ReactNode } from "react";
import { Image, Pressable, ScrollView, Text, View } from "react-native";
import type { FileUpdateChange, ThreadItem } from "@shared/protocol";
import { parseCodexMessage } from "@ret/lib/codexMessage";
import { splitContentRefs } from "@ret/lib/visualize";
import { compactionLabel } from "@ret/lib/activity";
import { changeStats, duration, shortPath, unwrapCommand } from "@ret/lib/format";
import { focusComposer, sendFromComposer } from "@ret/state/composerDrafts";
import { agentName, takesDirectInput, threadTitle } from "@ret/state/projects";
import { openQuestionItems, reopenQuestion, useQuestionDismissed } from "@ret/state/questionFlow";
import { ownerOf } from "@ret/state/threads";
import { useThread } from "@ret/state/useThread";
import { agentOf } from "@ret/agents";
import { Markdown } from "../ui/Markdown";
import { Badge, Icon, Mono, Spinner, useNow } from "../ui/primitives";
import { StatusDot } from "../ui/StatusDot";
import { router } from "expo-router";
import { resolvePath } from "@ret/lib/files";
import { openFile, openFolder } from "../files";
import { ThreadImage } from "../ui/ThreadImage";

/** `host`: the paired computer the thread runs on (its files are there). */
export type Ctx = { threadId: string; cwd: string | null; host: string | null };

const openThread = (id: string) => router.push({ pathname: "/thread/[id]", params: { id } });

function Status({ status }: { status: string }) {
  if (status === "inProgress") return <Spinner size="small" colorClassName="accent-green" />;
  if (status === "completed") return <Icon icon={Check} size={13} colorClassName="accent-green" />;
  if (status === "declined") return <Icon icon={X} size={13} colorClassName="accent-amber" />;
  return <Icon icon={X} size={13} colorClassName="accent-red" />;
}

/** The desktop's .tool row: an icon, a one-line label, meta on the right; tap to open what's inside. */
export function Disclosure({
  icon,
  label,
  meta,
  children,
  tone,
  onPress,
}: {
  icon: ReactNode;
  label: ReactNode;
  meta?: ReactNode;
  children?: ReactNode;
  tone?: "muted" | "error";
  onPress?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const expandable = !!children;
  return (
    <View>
      <Pressable
        disabled={!expandable && !onPress}
        onPress={onPress ?? (() => setOpen(!open))}
        className="min-h-[32px] flex-row items-center gap-2 rounded-lg px-1.5 py-1 active:bg-bg-2"
      >
        <View className="w-4 items-center">{icon}</View>
        <View className="flex-1">{typeof label === "string" ? <Text numberOfLines={1} className={`text-[14px] ${tone === "muted" ? "text-text-3" : "text-text-2"}`}>{label}</Text> : label}</View>
        {meta ? <View className="flex-row items-center gap-1.5">{meta}</View> : null}
        {expandable && <Icon icon={ChevronRight} size={13} colorClassName="accent-text-3" />}
      </Pressable>
      {open && expandable && <View className="gap-1.5 pb-2 pl-7 pr-1 pt-1">{children}</View>}
    </View>
  );
}

const glyph = (icon: LucideIcon, tone = "accent-text-3") => <Icon icon={icon} size={14} colorClassName={tone} />;

/** Text in a row label: the plain part grey, paths and commands mono and bright (the desktop's .path). */
function Label({ children }: { children: ReactNode }) {
  return (
    <Text numberOfLines={1} className="text-[14px] text-text-2">
      {children}
    </Text>
  );
}
const Path = ({ children }: { children: ReactNode }) => (
  <Mono className="text-[13px] text-text">{children}</Mono>
);

/** A block of output (the desktop's .output). */
export function Output({ text, max = 20_000 }: { text: string; max?: number }) {
  const shown = text.length > max ? "…" + text.slice(-max) : text;
  return (
    <ScrollView horizontal={false} nestedScrollEnabled className="max-h-72 rounded-lg border border-line bg-code-bg">
      <Mono selectable className="px-3 py-2 text-[12px] leading-[18px] text-text-2">
        {shown || " "}
      </Mono>
    </ScrollView>
  );
}

/** "Open …": a file the step was about, on the file screen. */
function OpenLink({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} hitSlop={6} className="flex-row items-center gap-1.5 self-start py-1">
      <Icon icon={FileText} size={13} colorClassName="accent-accent" />
      <Text numberOfLines={1} className="text-[14px] text-accent">
        {label}
      </Text>
    </Pressable>
  );
}

// ---------------------------------------------------------------------------

function UserMessage({ item, ctx }: { item: Extract<ThreadItem, { type: "userMessage" }>; ctx: Ctx }) {
  const text = item.content
    .filter((c): c is Extract<typeof c, { type: "text" }> => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  // Written in the Codex app: its context sections become chips, and what you wrote reads as written.
  const msg = useMemo(() => parseCodexMessage(text), [text]);
  // Images you sent show as pictures (from the computer the thread runs on); anything else stays a chip.
  const images = item.content.filter((c) => c.type === "localImage" || (c.type === "image" && "url" in c && /^data:image\//.test(c.url)));
  const files = item.content.filter((c) => c.type !== "text" && !images.includes(c));
  const pictured = new Set(images.map((c) => ("path" in c ? c.path : "")));
  const chips: { icon: LucideIcon; label: string; path?: string }[] = [
    ...files.map((f) => ({ icon: Paperclip as LucideIcon, label: "path" in f ? shortPath(f.path) : "attachment", path: "path" in f ? f.path : undefined })),
    ...(msg?.files
      .filter((f) => !(f.image && pictured.has(f.path)))
      .map((f) => ({
        icon: (f.pasted ? ClipboardPaste : f.image ? ImageIcon : f.path.endsWith("/") ? FolderOpen : FileText) as LucideIcon,
        label: f.pasted ? f.label.replace(/…$/, "") || "Pasted text" : f.label,
        path: f.pasted ? undefined : f.path,
      })) ?? []),
    ...(msg?.browser ? [{ icon: Globe as LucideIcon, label: msg.browser.replace(/^https?:\/\//, "") }] : []),
  ];
  const open = (path: string) => {
    if (!ctx.host) return;
    const full = resolvePath(path, ctx.cwd);
    if (path.endsWith("/")) openFolder(full, ctx.host);
    else openFile(full, ctx.host);
  };
  return (
    <View className="items-end pb-1 pl-10">
      <View className="max-w-full gap-1.5 rounded-[16px] rounded-br-[5px] border border-line bg-bg-3 px-3.5 py-2.5">
        {images.length > 0 && (
          <View className="flex-row flex-wrap gap-1.5">
            {images.map((c, i) =>
              c.type === "localImage" ? (
                <ThreadImage key={i} path={c.path} cwd={ctx.cwd} host={ctx.host} size={images.length > 1 ? "sm" : "md"} />
              ) : c.type === "image" && "url" in c ? (
                <ThreadImage key={i} src={c.url} size={images.length > 1 ? "sm" : "md"} />
              ) : null,
            )}
          </View>
        )}
        {msg?.quotes.map((q, i) => (
          <View key={i} className="border-l-[3px] border-line-2 pl-2.5">
            <Text className="text-[14px] text-text-2">{q.text}</Text>
            {q.comment ? <Text className="text-[14px] text-text">{q.comment}</Text> : null}
          </View>
        ))}
        {msg?.replies.map((r, i) => (
          <View key={i} className="gap-0.5">
            {r.question ? (
              <View className="flex-row items-center gap-1">
                <Icon icon={MessageCircleQuestion} size={11} colorClassName="accent-text-3" />
                <Text className="flex-1 text-[12px] text-text-3">{r.question}</Text>
              </View>
            ) : null}
            <Text selectable className="text-[15px] leading-[22px] text-text">
              {r.answer}
            </Text>
          </View>
        ))}
        {msg ? (
          msg.parts.length > 0 && (
            <Text selectable className="text-[15px] leading-[22px] text-text">
              {msg.parts.map((p, i) =>
                "text" in p ? (
                  p.text
                ) : "threadId" in p ? (
                  `“${p.title || "a chat"}”`
                ) : "mention" in p ? (
                  <Text key={i} className="text-accent">
                    @{p.mention}
                  </Text>
                ) : (
                  <Text key={i} className={ctx.host ? "text-accent" : undefined} onPress={ctx.host ? () => open(p.file) : undefined}>
                    {p.label}
                  </Text>
                ),
              )}
            </Text>
          )
        ) : text ? (
          <Text selectable className="text-[15px] leading-[22px] text-text">
            {text}
          </Text>
        ) : null}
        {(chips.length > 0 || (msg?.chats.length ?? 0) > 0) && (
          <View className="flex-row flex-wrap gap-1">
            {chips.map((c, i) => (
              <Pressable
                key={i}
                disabled={!c.path || !ctx.host}
                onPress={() => c.path && open(c.path)}
                className="h-7 max-w-[240px] flex-row items-center gap-1 rounded-md bg-bg-4 px-2 active:opacity-70"
              >
                <Icon icon={c.icon} size={11} colorClassName={c.path ? "accent-accent" : "accent-text-2"} />
                <Text numberOfLines={1} className={`text-[12px] ${c.path ? "text-text" : "text-text-2"}`}>
                  {c.label}
                </Text>
              </Pressable>
            ))}
            {msg?.chats.map((id) => <ChatRef key={id} id={id} />)}
          </View>
        )}
      </View>
    </View>
  );
}

/** A Codex chat referenced in a message: opens when Ret knows it. */
function ChatRef({ id }: { id: string }) {
  const thread = useThread(id, (s) => s.threads[id]);
  return (
    <Pressable disabled={!thread} onPress={() => openThread(id)} className="h-6 max-w-[240px] flex-row items-center gap-1 rounded-md bg-bg-4 px-2">
      <Icon icon={MessagesSquare} size={11} colorClassName="accent-text-2" />
      <Text numberOfLines={1} className="text-[12px] text-text-2">
        {thread ? threadTitle(thread) : "Codex chat"}
      </Text>
    </Pressable>
  );
}

function AgentMessage({ item, streaming, threadId }: { item: Extract<ThreadItem, { type: "agentMessage" }>; streaming: boolean; threadId: string }) {
  return (
    <View className="gap-2 px-0.5 py-0.5">
      {splitContentRefs(item.text, streaming).map((part, i) =>
        part.kind === "text" ? (
          <Markdown key={i} text={part.text} muted={item.phase === "commentary"} />
        ) : (
          <VisualizationNote key={i} title={part.kind === "viz" ? part.viz.title || part.viz.path.split(/[\\/]/).pop() : undefined} />
        ),
      )}
      {!streaming && item.questions?.length ? <ReplyQuestions threadId={threadId} itemId={item.id} /> : null}
    </View>
  );
}

/** A Codex visualization runs in a frame on the desktop; here just where it is (no title while it streams in). */
function VisualizationNote({ title }: { title?: string }) {
  return (
    <View className="flex-row items-center gap-2 rounded-lg border border-line px-3 py-2.5">
      <Icon icon={ChartColumn} size={13} colorClassName="accent-text-2" />
      <Text numberOfLines={1} className="flex-1 text-[13px] text-text-2">
        {title ? `Visualization: ${title}. Open it in Ret on your computer.` : "Preparing visualization…"}
      </Text>
    </View>
  );
}

/** Questions on a reply are answered in the dock above the composer; here a pointer to it while open. */
function ReplyQuestions({ threadId, itemId }: { threadId: string; itemId: string }) {
  const open = useThread(threadId, (s) => takesDirectInput(s.threads[threadId]) && openQuestionItems(s, threadId).includes(itemId));
  const dismissed = useQuestionDismissed(itemId);
  if (!open) return null;
  return (
    <Pressable
      onPress={() => {
        reopenQuestion(itemId);
        focusComposer(threadId);
      }}
      className="flex-row items-center gap-1.5 self-start rounded-md bg-accent-soft px-2 py-1"
    >
      <Icon icon={MessageCircleQuestion} size={12} colorClassName="accent-accent" />
      <Text className="text-[13px] text-accent">{dismissed ? "Answer this" : "Waiting for your answer below"}</Text>
    </Pressable>
  );
}

function Reasoning({ item, live }: { item: Extract<ThreadItem, { type: "reasoning" }>; live: boolean }) {
  const text = item.summary.filter(Boolean).join("\n\n") || item.content.filter(Boolean).join("\n\n");
  const heading = /\*\*(.+?)\*\*/.exec(item.summary.at(-1) ?? "")?.[1];
  if (!text) {
    return live ? (
      <View className="flex-row items-center gap-2 px-1.5 py-1">
        {glyph(Brain)}
        <Text className="animate-pulse text-[14px] text-text-3">Thinking…</Text>
      </View>
    ) : null;
  }
  return (
    <Disclosure icon={glyph(Brain)} label={<Text numberOfLines={1} className={`text-[14px] text-text-3 ${live ? "animate-pulse" : ""}`}>{heading ?? (live ? "Thinking" : "Thought")}</Text>} tone="muted">
      <Markdown text={text} muted size={14} />
    </Disclosure>
  );
}

function CommandExec({ item, ctx }: { item: Extract<ThreadItem, { type: "commandExecution" }>; ctx: Ctx }) {
  const cmd = unwrapCommand(item.command);
  const actions = item.commandActions ?? [];
  const meaningful = actions.length > 0 && actions.every((a) => a.type !== "unknown");
  let icon = glyph(SquareTerminal);
  let label: ReactNode = (
    <Mono numberOfLines={1} className="text-[13px] text-text">
      {cmd}
    </Mono>
  );
  if (meaningful) {
    const a = actions[0];
    if (a.type === "read") {
      icon = glyph(FileText);
      label = (
        <Label>
          Read <Path>{actions.map((x) => ("name" in x ? x.name : "")).filter(Boolean).join(", ")}</Path>
        </Label>
      );
    } else if (a.type === "listFiles") {
      icon = glyph(FolderOpen);
      label = (
        <Label>
          Listed <Path>{a.path ? shortPath(a.path, ctx.cwd) : "files"}</Path>
        </Label>
      );
    } else if (a.type === "search") {
      icon = glyph(Search);
      label = (
        <Label>
          Searched <Path>{a.query ?? ""}</Path>
          {a.path ? (
            <>
              {" in "}
              <Path>{shortPath(a.path, ctx.cwd)}</Path>
            </>
          ) : null}
        </Label>
      );
    }
  }
  const failed = item.status === "failed" || (item.exitCode != null && item.exitCode !== 0);
  return (
    <Disclosure
      icon={failed ? glyph(SquareTerminal, "accent-red") : icon}
      label={label}
      meta={
        <>
          {item.exitCode != null && item.exitCode !== 0 && <Badge label={`exit ${item.exitCode}`} tone="err" />}
          <Status status={failed && item.status === "completed" ? "failed" : item.status} />
        </>
      }
      tone={failed ? "error" : undefined}
    >
      {meaningful && <Output text={`$ ${cmd}`} />}
      {ctx.host &&
        actions.map((a, i) =>
          (a.type === "read" || a.type === "listFiles") && "path" in a && a.path ? (
            <OpenLink key={i} label={a.type === "read" ? `Open ${"name" in a && a.name ? a.name : shortPath(a.path, ctx.cwd)}` : `Browse ${shortPath(a.path, ctx.cwd)}`} onPress={() => (a.type === "read" ? openFile(resolvePath(a.path!, ctx.cwd), ctx.host!) : openFolder(resolvePath(a.path!, ctx.cwd), ctx.host!))} />
          ) : null,
        )}
      {item.aggregatedOutput ? <Output text={item.aggregatedOutput} /> : <Text className="text-[13px] text-text-3">No output</Text>}
      {item.durationMs != null && <Text className="text-[12px] text-text-3">{duration(item.durationMs)}</Text>}
    </Disclosure>
  );
}

/** A diff, line by line (the desktop's DiffView, without syntax colours). */
export function DiffView({ diff, whole }: { diff: string; whole?: "add" | "delete" }) {
  const lines = whole ? diff.replace(/\n$/, "").split("\n").map((l) => (whole === "add" ? "+" : "-") + l) : diff.split("\n");
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} className="bg-code-bg">
      <View className="py-1.5">
        {lines.slice(0, 800).map((line, i) => {
          const cls = line.startsWith("@@")
            ? "hunk"
            : line.startsWith("+") && !line.startsWith("+++")
              ? "add"
              : line.startsWith("-") && !line.startsWith("---")
                ? "del"
                : /^(\+\+\+|---|diff |index )/.test(line)
                  ? "meta"
                  : "ctx";
          const body = cls === "add" || cls === "del" || cls === "ctx" ? line.slice(1) : line;
          const bg = cls === "add" ? "bg-green-soft" : cls === "del" ? "bg-red-soft" : cls === "hunk" ? "bg-accent-soft" : "";
          const fg = cls === "hunk" ? "text-accent" : cls === "meta" ? "text-text-3" : "text-text";
          return (
            <View key={i} className={`flex-row pr-3 ${bg}`}>
              <Mono className={`w-5 text-center text-[12px] leading-[18px] ${cls === "add" ? "text-green" : cls === "del" ? "text-red" : "text-text-3"}`}>
                {cls === "add" ? "+" : cls === "del" ? "−" : " "}
              </Mono>
              <Mono className={`text-[12px] leading-[18px] ${fg}`}>{body || " "}</Mono>
            </View>
          );
        })}
        {lines.length > 800 && <Mono className="pl-5 text-[12px] text-text-3">… {lines.length - 800} more lines</Mono>}
      </View>
    </ScrollView>
  );
}

function FileRow({ change, cwd, host }: { change: FileUpdateChange; cwd: string | null; host: string | null }) {
  const [open, setOpen] = useState(false);
  const { add, del } = changeStats(change);
  const kind = change.kind.type;
  const kindTone = kind === "add" ? "bg-green-soft text-green" : kind === "delete" ? "bg-red-soft text-red" : "bg-accent-soft text-accent";
  return (
    <View className="border-t border-line">
      <Pressable onPress={() => setOpen(!open)} className="h-10 flex-row items-center gap-2 px-3 active:bg-bg-2">
        <Mono className={`h-4 w-4 overflow-hidden rounded text-center text-[10px] font-bold leading-4 ${kindTone}`}>{kind === "add" ? "A" : kind === "delete" ? "D" : "M"}</Mono>
        <Mono numberOfLines={1} className="flex-1 text-[13px] text-text">
          {shortPath(change.path, cwd)}
        </Mono>
        {add > 0 && <Mono className="text-[12px] text-green">+{add}</Mono>}
        {del > 0 && <Mono className="text-[12px] text-red">−{del}</Mono>}
      </Pressable>
      {open && <DiffView diff={change.diff} whole={kind === "update" ? undefined : kind} />}
      {open && host && kind !== "delete" && (
        <View className="px-3 py-1.5">
          <OpenLink label="Open the file" onPress={() => openFile(resolvePath(change.path, cwd), host)} />
        </View>
      )}
    </View>
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
    <View className={`overflow-hidden rounded-[10px] border border-line bg-bg-1 ${item.status === "declined" ? "opacity-60" : ""}`}>
      <View className="flex-row items-center gap-2 px-3 py-2">
        {glyph(FilePen, "accent-text-2")}
        <Text className="flex-1 text-[14px] text-text-2">
          {item.status === "declined" ? "Declined edit to" : item.status === "inProgress" ? "Editing" : "Edited"} {item.changes.length} {item.changes.length === 1 ? "file" : "files"}
        </Text>
        <Mono className="text-[12px] text-green">+{totals.add}</Mono>
        <Mono className="text-[12px] text-red">−{totals.del}</Mono>
        <Status status={item.status} />
      </View>
      {item.changes.map((c) => (
        <FileRow key={c.path} change={c} cwd={ctx.cwd} host={ctx.host} />
      ))}
    </View>
  );
}

const json = (v: unknown) => (typeof v === "string" ? v : (JSON.stringify(v, null, 2) ?? ""));

function McpTool({ item }: { item: Extract<ThreadItem, { type: "mcpToolCall" }> }) {
  const name = item.appContext?.appName ? `${item.appContext.appName} · ${item.tool}` : `${item.server} · ${item.tool}`;
  return (
    <Disclosure
      icon={glyph(Wrench, item.status === "failed" ? "accent-red" : "accent-text-3")}
      label={
        <Label>
          <Path>{name}</Path>
        </Label>
      }
      meta={<Status status={item.status} />}
    >
      <Text className="text-[12px] text-text-3">Arguments</Text>
      <Output text={json(item.arguments)} />
      {item.error && <Text className="text-[13px] text-red">{item.error.message}</Text>}
      {item.result && (
        <>
          <Text className="text-[12px] text-text-3">Result</Text>
          <Output text={json(item.result.structuredContent ?? item.result.content)} />
        </>
      )}
    </Disclosure>
  );
}

function WebSearch({ item }: { item: Extract<ThreadItem, { type: "webSearch" }> }) {
  const a = item.action;
  const label =
    a?.type === "openPage" ? (
      <Label>
        Opened <Path>{a.url ?? item.query}</Path>
      </Label>
    ) : a?.type === "findInPage" ? (
      <Label>
        Found “{a.pattern}” in <Path>{a.url}</Path>
      </Label>
    ) : (
      <Label>
        Searched the web for <Path>{(a?.type === "search" && (a.queries?.join(" · ") ?? a.query)) || item.query}</Path>
      </Label>
    );
  return <Disclosure icon={glyph(Globe)} label={label} />;
}

/** The agent's `clock.sleep`: counts down while it waits, then says how long it took. */
function Sleep({ item, threadId, live }: { item: Extract<ThreadItem, { type: "sleep" }>; threadId: string; live: boolean }) {
  const seen = useThread(threadId, (s) => s.live[threadId]?.sleeps[item.id]);
  const waiting = live && seen?.endedAt == null;
  const now = useNow(waiting);
  const requested = duration(item.durationMs).replace(/ 0[smh]$/, "");
  if (waiting) {
    const left = seen?.startedAt != null ? Math.ceil(Math.max(0, item.durationMs - (now - seen.startedAt)) / 1000) : null;
    const meta = left == null ? `up to ${requested}` : left < 60 ? `${left}s left` : `${duration(left * 1000)} left`;
    return <Disclosure icon={<Spinner size="small" colorClassName="accent-text-3" />} label="Waiting" meta={<Text className="text-[12px] text-text-3">{meta}</Text>} tone="muted" />;
  }
  const took = seen?.startedAt != null && seen.endedAt != null ? duration(seen.endedAt - seen.startedAt) : `up to ${requested}`;
  return <Disclosure icon={glyph(Hourglass)} label="Waited" meta={<Text className="text-[12px] text-text-3">{took}</Text>} tone="muted" />;
}

function useAgentName(threadId: string, path?: string | null): string {
  return useThread(threadId, (s) => agentName(s.threads[threadId], path)) ?? `agent ${threadId.slice(-6)}`;
}

function SubAgentActivity({ item }: { item: Extract<ThreadItem, { type: "subAgentActivity" }> }) {
  const name = useAgentName(item.agentThreadId, item.agentPath);
  const verb = { started: "Started", interacted: "Messaged", interrupted: "Interrupted", completed: "" }[item.kind] ?? "";
  return (
    <Disclosure
      icon={glyph(Bot)}
      label={
        <Label>
          {verb ? `${verb} ` : ""}
          <Text className="font-medium text-text">{name}</Text>
          {item.kind === "completed" ? " finished" : ""}
        </Label>
      }
      meta={<StatusDot threadId={item.agentThreadId} />}
      onPress={() => openThread(item.agentThreadId)}
    />
  );
}

function Collab({ item }: { item: Extract<ThreadItem, { type: "collabAgentToolCall" }> }) {
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
  return (
    <Disclosure icon={glyph(Bot)} label={`${verb[item.tool] ?? item.tool}${who ? ` ${who}` : ""}`} meta={<Status status={item.status as string} />}>
      {item.prompt ? <Markdown text={item.prompt} muted size={14} /> : null}
      {ids.map((id) => (
        <AgentLink key={id} threadId={id} />
      ))}
    </Disclosure>
  );
}

function AgentLink({ threadId }: { threadId: string }) {
  const name = useAgentName(threadId);
  return (
    <Pressable onPress={() => openThread(threadId)} className="flex-row items-center gap-2 py-1">
      <StatusDot threadId={threadId} />
      <Text className="text-[14px] text-accent">{name}</Text>
    </Pressable>
  );
}

/** Under a plan proposed in Plan mode: carry it out, or keep refining (the desktop's PlanActions). */
function PlanActions({ threadId, itemId }: { threadId: string; itemId: string }) {
  const live = useThread(threadId, (s) => {
    const lt = s.live[threadId];
    if (!lt || lt.activeTurnId || s.external[threadId]) return false;
    const last = lt.turnOrder[lt.turnOrder.length - 1];
    return !!last && !!lt.turns[last]?.itemIds.includes(itemId);
  });
  const planning = useThread(threadId, (s) => s.live[threadId]?.settings?.mode === "plan");
  if (!live || !planning) return null;
  return (
    <View className="mt-2 flex-row gap-2">
      <Pressable onPress={() => sendFromComposer(threadId, "Implement the plan.", { mode: "default" })} className="h-10 flex-row items-center gap-1.5 rounded-lg bg-accent px-3.5 active:bg-accent-strong">
        <Icon icon={Play} size={13} colorClassName="accent-[#0b0b18]" />
        <Text className="text-[14px] font-semibold text-[#0b0b18]">Implement this plan</Text>
      </Pressable>
      <Pressable onPress={() => focusComposer(threadId)} className="h-10 justify-center rounded-lg border border-line px-3.5 active:bg-bg-3">
        <Text className="text-[14px] text-text">Keep planning</Text>
      </Pressable>
    </View>
  );
}

function Divider({ icon, label }: { icon?: LucideIcon; label: string }) {
  return (
    <View className="my-1.5 flex-row items-center gap-2">
      <View className="h-px flex-1 bg-line" />
      {icon && <Icon icon={icon} size={12} colorClassName="accent-text-3" />}
      <Text className="text-[12px] text-text-3">{label}</Text>
      <View className="h-px flex-1 bg-line" />
    </View>
  );
}

export const ItemView = memo(function ItemView({ itemId, ctx, live }: { itemId: string; ctx: Ctx; live: boolean }) {
  const item = useThread(ctx.threadId, (s) => s.live[ctx.threadId]?.items[itemId]);
  if (!item) return null;
  switch (item.type) {
    case "userMessage":
      return <UserMessage item={item} ctx={ctx} />;
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
      return (
        <Disclosure icon={glyph(Wrench)} label={<Label><Path>{[item.namespace, item.tool].filter(Boolean).join(" · ")}</Path></Label>} meta={<Status status={item.status} />}>
          <Output text={json(item.arguments)} />
        </Disclosure>
      );
    case "webSearch":
      return <WebSearch item={item} />;
    case "plan":
      return (
        <View className="rounded-[10px] border border-line bg-bg-1 px-3 py-2.5">
          <View className="mb-1.5 flex-row items-center gap-1.5">
            {glyph(ListChecks, "accent-text-2")}
            <Text className="text-[13px] font-semibold text-text-2">Plan</Text>
          </View>
          <Markdown text={item.text} />
          <PlanActions threadId={ctx.threadId} itemId={item.id} />
        </View>
      );
    case "imageView":
      return (
        <View className="gap-1.5">
          <Disclosure
            icon={glyph(ImageIcon)}
            label={
              <Label>
                Viewed <Path>{shortPath(item.path, ctx.cwd)}</Path>
              </Label>
            }
          />
          <View className="pl-7">
            <ThreadImage path={item.path} cwd={ctx.cwd} host={ctx.host} />
          </View>
        </View>
      );
    case "imageGeneration":
      return item.result && /^[A-Za-z0-9+/=\s]+$/.test(item.result.slice(0, 200)) ? (
        <Image source={{ uri: `data:image/png;base64,${item.result}` }} className="aspect-square w-full rounded-xl" resizeMode="contain" />
      ) : (
        <Disclosure icon={glyph(ImageIcon)} label={item.failure ? "Image generation failed" : "Generating image…"} />
      );
    case "contextCompaction":
      return <Divider icon={Layers} label={compactionLabel(live)} />;
    case "enteredReviewMode":
    case "exitedReviewMode":
      return (
        <View>
          <Divider label={item.type === "enteredReviewMode" ? "Review started" : "Review finished"} />
          {item.review ? <Markdown text={item.review} /> : null}
        </View>
      );
    case "collabAgentToolCall":
      return <Collab item={item} />;
    case "subAgentActivity":
      return <SubAgentActivity item={item} />;
    case "hookPrompt":
      return <Text className="px-1.5 text-[13px] text-text-3">{item.fragments.map((f) => f.text).join("\n")}</Text>;
    case "sleep":
      return <Sleep item={item} threadId={ctx.threadId} live={live} />;
    default:
      return null;
  }
});

/** "Codex" or "Claude Code", for a thread. */
export function useAgentNameOf(threadId: string): string {
  return useThread(threadId, () => agentOf(ownerOf(threadId)).name);
}
