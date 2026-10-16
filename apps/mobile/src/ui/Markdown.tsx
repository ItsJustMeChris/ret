import * as Clipboard from "expo-clipboard";
import { Lexer, type Token, type Tokens } from "marked";
import { memo, useMemo, type ReactNode } from "react";
import { Linking, Pressable, ScrollView, Text, View } from "react-native";
import { looksLikePath, parseFileRef } from "@ret/lib/files";
import { toast } from "@ret/state/toasts";
import { openFileRef, useFileScope, type FileScope } from "../files";
import { Mono } from "./primitives";

/**
 * Agent replies, as the desktop shows them (lib/markdown.ts): GitHub-flavoured markdown through
 * the same `marked`, drawn with native text. The same rules hold: a remote image is never fetched
 * (it stays a link), and file references read as paths.
 */
export const Markdown = memo(function Markdown({ text, muted, size = 15 }: { text: string; muted?: boolean; size?: number }) {
  const blocks = useMemo(() => Lexer.lex(text.includes("\r") ? text.replace(/\r\n?/g, "\n") : text, { gfm: true }), [text]);
  const scope = useFileScope();
  const ctx: Ctx = { size: muted ? size - 1 : size, tone: muted ? "text-text-2" : "text-text", scope };
  return (
    <View className="gap-2.5">
      {blocks.map((t, i) => (t.type === "space" ? null : <Block key={i} token={t} ctx={ctx} />))}
    </View>
  );
});

interface Ctx {
  size: number;
  tone: string;
  /** Where the thread's files are: references open on the file screen. */
  scope: FileScope | null;
}

/** One top-level block. Streaming only changes the last one or two, so the rest keep their render. */
const Block = memo(
  function Block({ token, ctx }: { token: Token; ctx: Ctx }) {
    return block(token, ctx);
  },
  (a, b) => a.token.raw === b.token.raw && a.ctx.size === b.ctx.size && a.ctx.tone === b.ctx.tone && a.ctx.scope === b.ctx.scope,
);

function block(t: Token, ctx: Ctx): ReactNode {
  const body = { fontSize: ctx.size, lineHeight: Math.round(ctx.size * 1.47) };
  switch (t.type) {
    case "paragraph":
    case "text":
      return (
        <Text selectable className={ctx.tone} style={body}>
          {"tokens" in t && t.tokens ? inline(t.tokens, ctx) : unescape(t.text)}
        </Text>
      );
    case "heading": {
      const scale = [1.35, 1.2, 1.07, 1, 1, 1][(t as Tokens.Heading).depth - 1];
      return (
        <Text selectable className={`mt-1 font-bold ${ctx.tone}`} style={{ fontSize: ctx.size * scale, lineHeight: Math.round(ctx.size * scale * 1.3) }}>
          {inline((t as Tokens.Heading).tokens, ctx)}
        </Text>
      );
    }
    case "code":
      return <CodeBlock code={(t as Tokens.Code).text} lang={((t as Tokens.Code).lang ?? "").trim().split(/\s+/)[0]} />;
    case "blockquote":
      return (
        <View className="border-l-[3px] border-line-2 pl-3">
          <View className="gap-2">{(t as Tokens.Blockquote).tokens.map((c, i) => <View key={i}>{block(c, { ...ctx, tone: "text-text-2" })}</View>)}</View>
        </View>
      );
    case "list": {
      const list = t as Tokens.List;
      const start = typeof list.start === "number" ? list.start : 1;
      return (
        <View className="gap-1">
          {list.items.map((item, i) => (
            <View key={i} className="flex-row gap-2 pr-2">
              <Text className="text-text-3" style={{ ...body, minWidth: list.ordered ? 18 : 10 }}>
                {item.task ? (item.checked ? "☑" : "☐") : list.ordered ? `${start + i}.` : "•"}
              </Text>
              <View className="flex-1 gap-1">
                {item.tokens.map((c, j) => (c.type === "space" ? null : <View key={j}>{block(c, ctx)}</View>))}
              </View>
            </View>
          ))}
        </View>
      );
    }
    case "hr":
      return <View className="my-1 h-px bg-line" />;
    case "table": {
      const table = t as Tokens.Table;
      return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View className="overflow-hidden rounded-md border border-line-2">
            {[table.header, ...table.rows].map((row, r) => (
              <View key={r} className={`flex-row ${r === 0 ? "bg-bg-2" : "border-t border-line-2"}`}>
                {row.map((cell, c) => (
                  <View key={c} className={`w-40 px-2.5 py-1.5 ${c ? "border-l border-line-2" : ""}`}>
                    <Text selectable className={`${ctx.tone} ${r === 0 ? "font-semibold" : ""}`} style={{ fontSize: ctx.size - 1.5 }}>
                      {inline(cell.tokens, ctx)}
                    </Text>
                  </View>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
    }
    case "html":
      return (
        <Text selectable className={ctx.tone} style={body}>
          {t.text}
        </Text>
      );
    case "space":
    case "def":
      return null;
    default:
      return "text" in t && typeof t.text === "string" ? (
        <Text selectable className={ctx.tone} style={body}>
          {t.text}
        </Text>
      ) : null;
  }
}

function inline(tokens: Token[] | undefined, ctx: Ctx): ReactNode[] {
  return (tokens ?? []).map((t, i) => {
    switch (t.type) {
      case "text":
        return "tokens" in t && t.tokens?.length ? <Text key={i}>{inline(t.tokens, ctx)}</Text> : unescape(t.text);
      case "escape":
        return unescape(t.text);
      case "strong":
        return (
          <Text key={i} className="font-semibold">
            {inline((t as Tokens.Strong).tokens, ctx)}
          </Text>
        );
      case "em":
        return (
          <Text key={i} className="italic">
            {inline((t as Tokens.Em).tokens, ctx)}
          </Text>
        );
      case "del":
        return (
          <Text key={i} className="line-through">
            {inline((t as Tokens.Del).tokens, ctx)}
          </Text>
        );
      case "codespan": {
        const raw = unescape((t as Tokens.Codespan).text);
        // `src/app.ts:12` in a reply is a file (on the computer the thread runs on).
        const path = looksLikePath(raw) && parseFileRef(raw);
        return (
          <Mono
            key={i}
            className={`bg-bg-3 ${path && ctx.scope?.host ? "text-accent" : ctx.tone}`}
            style={{ fontSize: ctx.size * 0.86 }}
            onPress={path && ctx.scope?.host ? () => openFileRef(raw, ctx.scope) : undefined}
          >
            {`\u00a0${raw}\u00a0`}
          </Mono>
        );
      }
      case "link": {
        const link = t as Tokens.Link;
        const inner = inline(link.tokens, ctx);
        if (/^(https?:|mailto:)/i.test(link.href)) {
          return (
            <Text key={i} className="text-accent" onPress={() => void Linking.openURL(link.href)}>
              {inner}
            </Text>
          );
        }
        // A file on the computer the thread runs on: it opens on the file screen.
        return parseFileRef(link.href) ? (
          <Mono
            key={i}
            className={ctx.scope?.host ? "text-accent" : "text-text"}
            style={{ fontSize: ctx.size * 0.9 }}
            onPress={ctx.scope?.host ? () => openFileRef(link.href, ctx.scope) : undefined}
          >
            {inner}
          </Mono>
        ) : (
          <Text key={i}>{inner}</Text>
        );
      }
      case "image": {
        const img = t as Tokens.Image;
        // Never fetched by showing it: a remote image is a link you choose to open.
        if (/^https?:/i.test(img.href)) {
          return (
            <Text key={i} className="text-accent" onPress={() => void Linking.openURL(img.href)}>
              ↗ Image: {img.text || img.href}
            </Text>
          );
        }
        return img.text ? `[${img.text}]` : "";
      }
      case "br":
        return "\n";
      case "html":
        return t.text;
      default:
        return "text" in t && typeof t.text === "string" ? unescape(t.text) : "";
    }
  });
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  return (
    <View className="overflow-hidden rounded-lg border border-line bg-code-bg">
      <View className="flex-row items-center justify-between border-b border-line px-3 py-1.5">
        <Text className="text-[12px] text-text-3">{lang || "code"}</Text>
        <Pressable
          hitSlop={8}
          onPress={() => {
            void Clipboard.setStringAsync(code);
            toast("Copied");
          }}
        >
          <Text className="text-[12px] text-text-2">Copy</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerClassName="px-3 py-2.5">
        <Mono selectable className="text-[12.5px] leading-[19px] text-text">
          {code}
        </Mono>
      </ScrollView>
    </View>
  );
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };
const unescape = (s: string) => (s.includes("&") ? s.replace(/&(amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m]) : s);
