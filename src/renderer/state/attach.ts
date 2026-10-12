import { bridge, isDesktop } from "../bridge";
import { useThreads } from "./threads";
import { useUI } from "./ui";
import { toast } from "./toasts";
import { attachToComposer, fillComposer, focusComposer } from "./composerDrafts";
import type { Attachment } from "./actions";

/** Image types the model accepts as attachments; anything else is passed along as a path. */
const ATTACHABLE = /\.(png|jpe?g|gif|webp)$/i;
const ATTACHABLE_MIME = /^image\/(png|jpe?g|gif|webp)$/i;

/** `path` relative to the thread's folder when it's inside it (what you'd type), else absolute. */
function asTyped(path: string, cwd: string | null | undefined): string {
  const p = path.replace(/\\/g, "/");
  const c = cwd?.replace(/\\/g, "/").replace(/\/+$/, "");
  if (c && p.toLowerCase().startsWith(c.toLowerCase() + "/")) return p.slice(c.length + 1);
  return path;
}

/**
 * Files dropped or pasted onto a thread: images become attachments (the original file when it
 * has a path, else a saved copy, e.g. dragged out of a web page); other files and folders are
 * added to the message as paths for the agent to read.
 */
export async function addFilesToThread(threadId: string, files: File[]): Promise<void> {
  if (!files.length) return;
  const cwd = useThreads.getState().threads[threadId]?.cwd ?? useUI.getState().drafts[threadId]?.cwd ?? null;
  const attachments: Attachment[] = [];
  const paths: string[] = [];
  const skipped: string[] = [];
  for (const file of files) {
    const path = bridge.files.pathFor(file);
    const image = path ? ATTACHABLE.test(path) : ATTACHABLE_MIME.test(file.type);
    if (image && isDesktop) {
      const previewUrl = URL.createObjectURL(file);
      if (path) {
        attachments.push({ path, name: file.name, previewUrl });
      } else {
        const ext = file.type.split("/")[1] || "png";
        attachments.push({ path: await bridge.files.saveImage(await file.arrayBuffer(), ext), name: file.name || `image.${ext}`, previewUrl });
      }
    } else if (path) {
      paths.push(asTyped(path, cwd));
    } else {
      skipped.push(file.name || "file");
    }
  }
  attachToComposer(threadId, attachments);
  if (paths.length) fillComposer(threadId, paths.map((p) => `\`${p}\``).join(" ") + " ", { focus: true });
  else if (attachments.length) focusComposer(threadId);
  if (skipped.length) {
    toast(isDesktop ? `Couldn't attach ${skipped.join(", ")}: drop it from your file manager` : "Attaching files needs the desktop app", "error");
  }
}
