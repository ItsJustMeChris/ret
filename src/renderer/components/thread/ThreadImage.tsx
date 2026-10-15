import { useState } from "react";
import { ImageOff } from "lucide-react";
import { imageUrl } from "../../lib/files";
import { shortPath } from "../../lib/format";
import { openImage } from "../ImageViewer";

/**
 * An image in a thread (something you attached, or a file the agent looked at): a thumbnail
 * that opens full size. Falls back to a file chip when it can't be shown (gone, or no file
 * access in the web build).
 */
/** `full`: the whole picture to open, when `src` is a smaller copy of it. */
export function ThreadImage({
  path,
  src,
  full,
  cwd,
  host,
  size = "md",
}: {
  path?: string;
  src?: string;
  full?: string;
  cwd?: string | null;
  /** The paired device the file is on (null: this computer). */
  host?: string | null;
  size?: "sm" | "md";
}) {
  const url = src ?? (path ? imageUrl(path, cwd, host) : null);
  const [broken, setBroken] = useState(false);
  if (!url || broken) {
    return (
      <span className="chip thread-img-missing" data-path={path}>
        <ImageOff size={11} />
        {path ? shortPath(path, cwd) : "image"}
      </span>
    );
  }
  return (
    <button
      className={`thread-img ${size}`}
      data-path={path}
      onClick={(e) => {
        e.stopPropagation();
        openImage({ src: full ?? url, path: path ?? null, host });
      }}
    >
      <img src={url} alt={path ? shortPath(path, cwd) : "image"} loading="lazy" decoding="async" draggable={false} onError={() => setBroken(true)} />
    </button>
  );
}
