import { memo, useCallback, useLayoutEffect, useRef } from "react";
import { bridge } from "../bridge";
import { renderMarkdown } from "../lib/markdown";
import { imageUrl, openFileRef, resolvePath } from "../lib/files";
import { openImage } from "./ImageViewer";

/** Sanitized markdown: copy buttons on code blocks, web links open in the browser, file links open locally. */
export const Markdown = memo(function Markdown({ text, className, streaming }: { text: string; className?: string; streaming?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = renderMarkdown(text, !streaming);

  // Local images: point them at the file (relative paths resolve against the thread's folder);
  // one that can't be shown becomes a file link instead.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cwd = el.closest("[data-cwd]")?.getAttribute("data-cwd");
    for (const img of el.querySelectorAll<HTMLImageElement>("img[data-local]:not([src])")) {
      const path = img.dataset.local!;
      const asLink = () => {
        const a = document.createElement("a");
        a.className = "file-link";
        a.dataset.path = path;
        a.textContent = img.alt || path;
        img.replaceWith(a);
      };
      const url = imageUrl(path, cwd);
      if (!url) {
        asLink();
        continue;
      }
      img.onerror = asLink;
      img.loading = "lazy";
      img.src = url;
    }
  }, [html]);

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
      openImage({ src: img.src, path: img.dataset.local ? resolvePath(img.dataset.local, cwd) : null, alt: img.alt });
      return;
    }
    const file = target.closest<HTMLElement>("a.file-link");
    if (file?.dataset.path) {
      e.preventDefault();
      const ref = { path: file.dataset.path, line: Number(file.dataset.line) || undefined, col: Number(file.dataset.col) || undefined };
      const cwd = file.closest("[data-cwd]")?.getAttribute("data-cwd");
      // Alt+click reveals instead of opening.
      if (e.altKey) void bridge.shell.reveal(resolvePath(ref.path, cwd));
      else void openFileRef(ref, cwd);
      return;
    }
    const a = target.closest("a");
    const href = a?.getAttribute("href");
    if (href) {
      e.preventDefault();
      if (/^(https?:|mailto:)/i.test(href)) void bridge.shell.openExternal(href);
    }
  }, []);
  return <div ref={ref} className={`md ${className ?? ""}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
});
