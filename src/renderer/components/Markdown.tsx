import { memo, useCallback } from "react";
import { bridge } from "../bridge";
import { renderMarkdown } from "../lib/markdown";
import { openFileRef, resolvePath } from "../lib/files";

/** Sanitized markdown: copy buttons on code blocks, web links open in the browser, file links open locally. */
export const Markdown = memo(function Markdown({ text, className, streaming }: { text: string; className?: string; streaming?: boolean }) {
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
  return <div className={`md ${className ?? ""}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: renderMarkdown(text, !streaming) }} />;
});
