import { Marked } from "marked";
import { looksLikePath, parseFileRef } from "./files";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import markdown from "highlight.js/lib/languages/markdown";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import ini from "highlight.js/lib/languages/ini";
import x86asm from "highlight.js/lib/languages/x86asm";

const langs: Record<string, any> = {
  bash, c, cpp, csharp, css, diff, go, java, javascript, json, kotlin, lua, markdown,
  powershell, python, rust, sql, swift, typescript, xml, yaml, ini, x86asm,
};
for (const [name, lang] of Object.entries(langs)) hljs.registerLanguage(name, lang);
const aliases: Record<string, string> = {
  sh: "bash", shell: "bash", zsh: "bash", console: "bash", ps1: "powershell", pwsh: "powershell",
  js: "javascript", jsx: "javascript", mjs: "javascript", ts: "typescript", tsx: "typescript",
  py: "python", rs: "rust", "c++": "cpp", hpp: "cpp", h: "c", cs: "csharp", html: "xml", svg: "xml",
  yml: "yaml", toml: "ini", md: "markdown", asm: "x86asm", nasm: "x86asm", patch: "diff", kt: "kotlin",
};

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

export function highlight(code: string, lang?: string | null): string {
  const name = lang ? (aliases[lang.toLowerCase()] ?? lang.toLowerCase()) : null;
  if (code.length > 60_000) return escapeHtml(code);
  try {
    if (name && hljs.getLanguage(name)) return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
  } catch {
    /* fall through */
  }
  return escapeHtml(code);
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const language = (lang ?? "").trim().split(/\s+/)[0];
      const label = language ? `<span class="code-lang">${escapeHtml(language)}</span>` : "";
      return `<div class="code-block">${label}<button class="code-copy" data-copy>Copy</button><pre><code class="hljs">${highlight(text, language)}</code></pre></div>`;
    },
    codespan({ text }) {
      // `src/app.ts:12` in a reply is a file you can click (text arrives already escaped).
      const raw = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      const ref = looksLikePath(raw) ? parseFileRef(raw) : null;
      if (!ref) return `<code>${text}</code>`;
      return `<code class="code-path" data-path="${escapeHtml(ref.path)}"${ref.line ? ` data-line="${ref.line}"` : ""}${ref.col ? ` data-col="${ref.col}"` : ""}>${text}</code>`;
    },
    image({ href, text }) {
      const alt = escapeHtml(text || "");
      // Data URIs are self-contained: show them as they are.
      if (/^data:image\//i.test(href)) return `<img class="md-img" src="${escapeHtml(href)}" alt="${alt}">`;
      // A remote image in model output would be fetched just by rendering it, which is a known
      // way for a prompt-injected agent to leak data. So it stays a link you choose to open.
      if (/^https?:/i.test(href)) return `<a href="${escapeHtml(href)}" class="md-remote-img">Image: ${alt || escapeHtml(href)}</a>`;
      // Local files: the Markdown component fills in a ret-img: src (it knows the thread's cwd).
      const ref = parseFileRef(href);
      return ref ? `<img class="md-img" data-local="${escapeHtml(ref.path)}" alt="${alt}">` : alt;
    },
    link({ href, title, tokens }) {
      const inner = this.parser.parseInline(tokens);
      const tip = title ? ` title="${escapeHtml(title)}"` : "";
      if (/^(https?:|mailto:)/i.test(href)) return `<a href="${escapeHtml(href)}"${tip}>${inner}</a>`;
      // Codex links local files as C:/…, /C:/…, file:///… (often with :line). The sanitizer would
      // strip those hrefs, so carry the path in data attributes and open it ourselves.
      const ref = parseFileRef(href);
      if (!ref) return inner;
      const loc = ref.line ? `:${ref.line}${ref.col ? `:${ref.col}` : ""}` : "";
      return `<a class="file-link" data-path="${escapeHtml(ref.path)}"${ref.line ? ` data-line="${ref.line}"` : ""}${ref.col ? ` data-col="${ref.col}"` : ""} title="${escapeHtml(ref.path + loc)}">${inner}</a>`;
    },
  },
});

const cache = new Map<string, string>();
const CACHE_MAX = 600;

/** Markdown → sanitized HTML. Finished text is memoized; streaming partials skip the cache so they don't evict it. */
export function renderMarkdown(src: string, memo = true): string {
  const hit = cache.get(src);
  if (hit !== undefined) return hit;
  const html = DOMPurify.sanitize(marked.parse(src, { async: false }) as string, {
    ADD_ATTR: ["data-copy", "target"],
  });
  if (!memo) return html;
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(src, html);
  return html;
}
