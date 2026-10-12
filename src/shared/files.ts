/** File types that would run code if "opened"; links to these are revealed, never launched. */
export const RUNNABLE = /\.(exe|dll|sys|drv|ocx|so|dylib|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|msi|msp|scr|pif|lnk|reg|hta|cpl|jar|sh|bash|zsh|command|app|appimage|run|bin|py|pyw)$/i;

/** Images Ret will show inline (served to the page by the main process's ret-img: protocol). */
export const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
};

/** The image MIME type for a path, or null if it isn't one we show. */
export function imageType(path: string): string | null {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return (ext && IMAGE_TYPES[ext]) || null;
}

export const IMAGE_SCHEME = "ret-img";
