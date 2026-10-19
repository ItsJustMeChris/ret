import { bridge, isDesktop } from "../bridge";
import { fsClient } from "../rpc/client";

// Reading a file to show it: as text, or why not (binary, too big). Code mode's file pane on the
// desktop, the file screen on the phone.

export const MAX_BYTES = 8 * 1024 * 1024;

/** Through the app-server, so it works in the desktop app and the web build alike (and for a paired device's files, `device`). */
export async function readText(path: string, device: string | null): Promise<{ text: string } | { binary: true } | { large: number }> {
  if (isDesktop) {
    const st = await bridge.files.stat(path, device);
    if (!st.exists) throw new Error("File not found");
    if (st.isDir) throw new Error("That's a folder");
    if (st.size && st.size > MAX_BYTES) return { large: st.size };
  }
  const res = (await fsClient(device).request("fs/readFile", { path })) as { dataBase64: string };
  const raw = atob(res.dataBase64);
  if (raw.length > MAX_BYTES) return { large: raw.length };
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  if (bytes.subarray(0, 8000).includes(0)) return { binary: true };
  return { text: new TextDecoder("utf-8").decode(bytes) };
}

/** Save `text` (UTF-8) to `path` on this computer or the paired device `device`. */
export async function writeText(path: string, text: string, device: string | null) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  await fsClient(device).request("fs/writeFile", { path, dataBase64: btoa(bin) });
}
