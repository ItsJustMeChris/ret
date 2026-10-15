import { bridge, isDesktop } from "../bridge";
import { toast } from "../state/toasts";
import { NOT_TEXT, imageType, imageUrl, openFileRef, resolvePath, type FileRef } from "./files";
import { openImage } from "../components/ImageViewer";
import { openFile } from "../state/actions";
import { hostOfThread } from "../state/threads";
import { isDraft, isFile } from "../state/ui";

/**
 * Show a referenced file inside Ret: code and text as a view of its own beside the thread it
 * came from (`from`), at the referenced line; images in the image viewer. Folders open in the
 * file manager; other non-text files (archives, PDFs, programs…) go the usual way (default app,
 * and programs are only ever revealed). The file is on the device the thread `from` runs on.
 */
export async function viewFile(ref: FileRef, cwd?: string | null, from?: string | null) {
  const path = resolvePath(ref.path, cwd);
  const host = from && !isFile(from) && !isDraft(from) ? hostOfThread(from) : null;
  if (isDesktop) {
    const st = await bridge.files.stat(path, host);
    if (!st.exists) {
      toast(`Not found: ${path}`, "error");
      return;
    }
    if (st.isDir) {
      const err = await bridge.shell.openPath(path, host);
      if (err) toast(err, "error");
      return;
    }
  }
  const image = imageType(path) ? imageUrl(path, null, host) : null;
  if (image) {
    openImage({ src: image, path, host });
    return;
  }
  if (NOT_TEXT.test(path)) {
    await openFileRef(ref, cwd, host);
    return;
  }
  openFile(path, { line: ref.line, col: ref.col, from, host });
}
