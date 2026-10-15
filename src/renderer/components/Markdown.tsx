import { memo, useCallback, useLayoutEffect, useRef } from "react";
import { bridge } from "../bridge";
import { renderMarkdown, renderMarkdownFragment, splitBlocks, type MarkdownBlocks } from "../lib/markdown";
import { imageUrl, openFileRef, resolvePath } from "../lib/files";
import { viewFile } from "../lib/viewFile";
import { openImage } from "./ImageViewer";
import { hostOfView } from "../state/projectTree";

/**
 * Local images: point them at the file (relative paths resolve against the thread's folder);
 * one that can't be shown becomes a file link instead.
 */
function resolveImages(el: HTMLElement) {
  const imgs = el.querySelectorAll<HTMLImageElement>("img[data-local]:not([src])");
  if (!imgs.length) return;
  const cwd = el.closest("[data-cwd]")?.getAttribute("data-cwd");
  const host = hostOfView(el.closest("[data-thread]")?.getAttribute("data-thread"));
  for (const img of imgs) {
    const path = img.dataset.local!;
    const asLink = () => {
      const a = document.createElement("a");
      a.className = "file-link";
      a.dataset.path = path;
      a.textContent = img.alt || path;
      img.replaceWith(a);
    };
    const url = imageUrl(path, cwd, host);
    if (!url) {
      asLink();
      continue;
    }
    img.onerror = asLink;
    img.loading = "lazy";
    img.src = url;
  }
}

/** What a streaming message has on screen: its blocks, and each one's nodes. */
interface Live {
  blocks: MarkdownBlocks | null;
  nodes: ChildNode[][];
}

/**
 * Sanitized markdown: copy buttons on code blocks, web links open in the browser, file links open locally.
 *
 * While `streaming`, the text is rendered a block at a time and only the blocks that changed are
 * replaced, so a long reply growing token by token re-parses and re-lays out its last paragraph,
 * not the whole reply. Once it's done it's rendered whole, as any other.
 */
export const Markdown = memo(function Markdown({ text, className, streaming }: { text: string; className?: string; streaming?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = streaming ? "" : renderMarkdown(text);
  const live = useRef<Live>({ blocks: null, nodes: [] });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!streaming) {
      live.current = { blocks: null, nodes: [] };
      resolveImages(el);
      return;
    }
    const st = live.current;
    const prev = st.blocks?.raws ?? [];
    st.blocks = splitBlocks(text, st.blocks);
    const raws = st.blocks.raws;
    // Blocks whose source hasn't changed keep their nodes; the rest are rendered and put in place.
    let same = 0;
    while (same < raws.length && same < prev.length && raws[same] === prev[same]) same++;
    for (let i = same; i < st.nodes.length; i++) for (const n of st.nodes[i]) n.remove();
    st.nodes.length = same;
    for (let i = same; i < raws.length; i++) {
      const frag = renderMarkdownFragment(raws[i]);
      st.nodes.push([...frag.childNodes]);
      el.append(frag);
    }
    resolveImages(el);
  }, [text, html, streaming]);

  const onClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const copy = target.closest<HTMLButtonElement>("[data-copy]");
    if (copy) {
      const code = copy.parentElement?.querySelector("code")?.textContent ?? "";
      void bridge.copy(code);
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1200);
      return;
    }
    const img = target.closest<HTMLImageElement>("img.md-img");
    if (img?.src) {
      const cwd = img.closest("[data-cwd]")?.getAttribute("data-cwd");
      const host = hostOfView(img.closest("[data-thread]")?.getAttribute("data-thread"));
      openImage({ src: img.src, path: img.dataset.local ? resolvePath(img.dataset.local, cwd) : null, alt: img.alt, host });
      return;
    }
    const file = target.closest<HTMLElement>("a.file-link");
    if (file?.dataset.path) {
      e.preventDefault();
      const ref = { path: file.dataset.path, line: Number(file.dataset.line) || undefined, col: Number(file.dataset.col) || undefined };
      const cwd = file.closest("[data-cwd]")?.getAttribute("data-cwd");
      const thread = file.closest("[data-thread]")?.getAttribute("data-thread");
      const host = hostOfView(thread);
      // Click views it in Ret; Ctrl+click opens it in VS Code (or its app); Alt+click reveals it.
      if (e.altKey) void bridge.shell.reveal(resolvePath(ref.path, cwd), host);
      else if (e.ctrlKey || e.metaKey) void openFileRef(ref, cwd, host);
      else void viewFile(ref, cwd, thread);
      return;
    }
    const a = target.closest("a");
    const href = a?.getAttribute("href");
    if (href) {
      e.preventDefault();
      if (/^(https?:|mailto:)/i.test(href)) void bridge.shell.openExternal(href);
    }
  }, []);
  // Keyed by mode: streamed blocks are put in place by hand, finished text is set whole.
  return streaming ? (
    <div key="streaming" ref={ref} className={`md ${className ?? ""}`} onClick={onClick} />
  ) : (
    <div key="done" ref={ref} className={`md ${className ?? ""}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
  );
});
