/**
 * Messages written in the Codex app arrive wrapped for the model: what you attached, the chats you
 * referenced, the page open in its browser and the text you selected come first as sections of
 * their own, then "## My request:" and what you wrote (as markdown, escaped by its composer). Its
 * answers to async questions arrive as a <send_user_message_question_reply> block. This takes
 * them apart so a message reads the way it was written.
 */

import { parseFileRef } from "./files";

export interface MessageFile {
  /** The file's name, or for pasted text its opening words. */
  label: string;
  path: string;
  /** Long text pasted into the composer, saved as a file. */
  pasted: boolean;
  /** Also attached as an image (shown as a picture already). */
  image: boolean;
}

/** A piece of what you wrote: text, a chat, plugin/skill/app or file you mentioned in it. */
export type RequestPart =
  | { text: string }
  | { threadId: string; title: string }
  | { mention: string; kind: string }
  | { file: string; label: string };

export interface QuestionReply {
  question: string;
  answer: string;
}

export interface CodexMessage {
  /** What you wrote. */
  parts: RequestPart[];
  files: MessageFile[];
  /** Chats referenced but not mentioned in the text itself. */
  chats: string[];
  /** The page open in the Codex app's browser. */
  browser: string | null;
  /** Text selected from earlier replies. */
  quotes: { text: string; comment: string | null }[];
  /** Answers to the agent's questions. */
  replies: QuestionReply[];
}

const REQUEST = /^## My request(?: for Codex)?:[ \t]*\n?/m;
const REPLY = /<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>\s*/;
const SECTIONS = /^(?:# Files (?:mentioned|pasted) by the user:|## Referenced chats with Codex:|# Response annotations:|<in-app-browser-context\b)/m;
/** `[@Title](thread://id)`, `[@Sites](plugin://sites@…)`, `[report.html](/abs/path)`: what its composer links inline. */
const INLINE = /\[(@?)([^\]\n]*)\]\(([a-z][a-z0-9+.-]*:\/\/[^)\s]*|\/[^)\s]*|[A-Za-z]:[\\/][^)\s]*)\)/g;
const MENTION_KINDS = new Set(["plugin", "skill", "app", "connector"]);

const json = (s: string | undefined): unknown => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};

/** The message taken apart, or null when it's plain text (as Ret and the CLI send it). */
export function parseCodexMessage(text: string): CodexMessage | null {
  const msg: CodexMessage = { parts: [], files: [], chats: [], browser: null, quotes: [], replies: [] };
  let rest = text;

  const reply = REPLY.exec(rest);
  if (reply) {
    const items = json(reply[1]);
    if (Array.isArray(items)) {
      for (const r of items) if (r && typeof r.answer === "string") msg.replies.push({ question: String(r.question ?? ""), answer: unescape(r.answer).trim() });
      rest = rest.slice(0, reply.index) + rest.slice(reply.index + reply[0].length);
    }
  }

  const req = REQUEST.exec(rest);
  if (req && SECTIONS.test(rest.slice(0, req.index))) {
    readSections(rest.slice(0, req.index), msg);
    const mentioned = new Set<string>();
    msg.parts = requestParts(rest.slice(req.index + req[0].length), mentioned);
    msg.chats = msg.chats.filter((id) => !mentioned.has(id));
  } else if (msg.replies.length) {
    if (rest.trim()) msg.parts = [{ text: rest.trim() }];
  } else if (hasInline(rest)) {
    // Sent by the app without its context sections (its Publish action, say): only the links are markup.
    msg.parts = requestParts(rest, new Set(), (s) => s);
  } else return null;
  return msg;
}

const previews = new Map<string, string>();

/** What you wrote, as plain text: for previews and titles (every thread's, on every render). */
export function requestText(text: string): string {
  if (!text.includes("## My request") && !text.includes("<send_user_message_question_reply>") && !hasInline(text)) return text;
  let own = previews.get(text);
  if (own === undefined) {
    const msg = parseCodexMessage(text);
    own = !msg ? text : msg.parts.map(partText).join("") || msg.replies.map((r) => r.answer).join("\n");
    if (previews.size > 500) previews.clear();
    previews.set(text, own);
  }
  return own;
}

function readSections(pre: string, msg: CodexMessage) {
  let section: "files" | "pasted" | "chats" | null = null;
  for (const line of pre.split("\n")) {
    if (/^# Files mentioned by the user:/.test(line)) section = "files";
    else if (/^# Files pasted by the user:/.test(line)) section = "pasted";
    else if (/^## Referenced chats with Codex:/.test(line)) section = "chats";
    else if (/^#{1,2} /.test(line) && section && section !== "chats" && line.includes(": ")) {
      // "## name: /path", or for pasted text `## "its opening words…": /path`.
      const at = line.lastIndexOf(": ");
      let label = line.slice(line.indexOf(" ") + 1, at).trim();
      const quoted = /^"(.*)"$/.exec(label);
      if (quoted) label = (json(`"${quoted[1]}"`) as string | null) ?? quoted[1];
      msg.files.push({ label, path: line.slice(at + 2).trim(), pasted: section === "pasted" || !!quoted, image: false });
    } else if (/^#{1,2} /.test(line) || line.startsWith("<")) section = null;
    else if (/^Image attachment: true/.test(line) && msg.files.length) msg.files[msg.files.length - 1].image = true;
    else if (section === "chats" && line.startsWith("[")) {
      const refs = json(line);
      if (Array.isArray(refs)) for (const r of refs) if (typeof r?.threadId === "string") msg.chats.push(r.threadId);
    }
  }
  msg.browser = /^- Current URL: (\S+)/m.exec(pre)?.[1] ?? null;
  const quotes = json(/<response-annotations>\s*([\s\S]*?)\s*<\/response-annotations>/.exec(pre)?.[1]);
  if (Array.isArray(quotes)) {
    for (const q of quotes) {
      if (typeof q?.text !== "string") continue;
      const comment = typeof q.comment === "string" && q.comment.trim() ? q.comment.trim() : null;
      msg.quotes.push({ text: q.text, comment });
    }
  }
}

function partText(p: RequestPart): string {
  if ("text" in p) return p.text;
  if ("threadId" in p) return `@${p.title}`;
  if ("mention" in p) return `@${p.mention}`;
  return p.label;
}

function hasInline(text: string): boolean {
  if (!text.includes("](")) return false;
  for (const m of text.matchAll(INLINE)) if (inlinePart(m)) return true;
  return false;
}

function inlinePart([, at, label, href]: RegExpMatchArray): RequestPart | null {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(href)?.[1].toLowerCase();
  if (at && scheme === "thread") return { threadId: href.slice(9).split(/[?#]/)[0], title: label };
  if (at && scheme && MENTION_KINDS.has(scheme)) return { mention: label, kind: scheme };
  if (scheme && scheme !== "file") return null;
  const ref = parseFileRef(href);
  return ref && /^(\/|[A-Za-z]:[\\/])/.test(ref.path) ? { file: ref.path, label: label.replace(/\\(.)/g, "$1") || ref.path } : null;
}

/** The Codex app's composer writes markdown: undo its escaping, keep what it links (chats, plugins, files) apart. */
function requestParts(md: string, mentioned: Set<string>, clean: (s: string) => string = unescape): RequestPart[] {
  const parts: RequestPart[] = [];
  let last = 0;
  const push = (s: string) => {
    if (s) parts.push({ text: s });
  };
  for (const m of md.matchAll(INLINE)) {
    const part = inlinePart(m);
    if (!part) continue;
    push(clean(md.slice(last, m.index)));
    parts.push(part);
    if ("threadId" in part) mentioned.add(part.threadId);
    last = m.index + m[0].length;
  }
  push(clean(md.slice(last)));
  // Trim the ends of the whole, not of each piece.
  const first = parts[0];
  if (first && "text" in first) first.text = first.text.replace(/^\s+/, "");
  const end = parts[parts.length - 1];
  if (end && "text" in end) end.text = end.text.replace(/\s+$/, "");
  return parts.filter((p) => !("text" in p) || p.text);
}

function unescape(md: string): string {
  return (
    md
      // Links it made of bare URLs.
      .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (all, label: string, href: string) => (label.replace(/\\(.)/g, "$1") === href.replace(/\\(.)/g, "$1") ? label : all))
      .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
      .replace(/&(amp|lt|gt|quot|nbsp);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', nbsp: " " })[e] ?? _)
      // Hard line breaks, and escaped punctuation.
      .replace(/\\\n/g, "\n")
      .replace(/\\([!-/:-@[-`{-~])/g, "$1")
      // Spaces left at line ends: not at the end of a piece, which may be the space before a mention.
      .replace(/[ \t]+(?=\n)/g, "")
  );
}
