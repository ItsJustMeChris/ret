import { useEffect } from "react";
import { create } from "zustand";
import { Copy, ExternalLink, FolderOpen, X } from "lucide-react";
import { bridge, isDesktop } from "../bridge";
import { copyText, revealLabel } from "../lib/files";

type Shown = { src: string; path?: string | null; alt?: string };

const useViewer = create<{ shown: Shown | null }>(() => ({ shown: null }));

/** Show an image full size over the app. */
export function openImage(shown: Shown) {
  useViewer.setState({ shown });
}

/** Full-size image viewer: Escape or a click outside the image closes it. */
export function ImageViewer() {
  const shown = useViewer((s) => s.shown);
  const close = () => useViewer.setState({ shown: null });

  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [shown]);

  if (!shown) return null;
  const name = shown.path?.split(/[\\/]/).pop() ?? shown.alt ?? "Image";
  return (
    <div className="overlay image-viewer" onPointerDown={close}>
      <div className="iv-bar" onPointerDown={(e) => e.stopPropagation()}>
        <span className="iv-name" title={shown.path ?? undefined}>
          {name}
        </span>
        {shown.path && isDesktop && (
          <>
            <button className="icon-btn" title="Open with default app" onClick={() => void bridge.shell.openPath(shown.path!)}>
              <ExternalLink size={14} />
            </button>
            <button className="icon-btn" title={revealLabel} onClick={() => void bridge.shell.reveal(shown.path!)}>
              <FolderOpen size={14} />
            </button>
          </>
        )}
        {shown.path && (
          <button className="icon-btn" title="Copy path" onClick={() => copyText(shown.path!, "Path copied")}>
            <Copy size={14} />
          </button>
        )}
        <button className="icon-btn" title="Close (Esc)" onClick={close}>
          <X size={15} />
        </button>
      </div>
      <img className="iv-img" src={shown.src} alt={shown.alt ?? name} onPointerDown={(e) => e.stopPropagation()} />
    </div>
  );
}
