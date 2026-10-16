import { imageType } from "@shared/files";
import { access } from "./bridge";

// Images on the computer a thread runs on (what you attached, what the agent looked at), fetched
// over its link the way the desktop shows a paired computer's (ret-img:// → its `image` call).

const cache = new Map<string, Promise<string | null>>();
const CACHE_SIZE = 40;

/** A data URI for the image at `path` on `host`; null if it's not an image or not there. */
export function loadImage(path: string, host: string | null): Promise<string | null> {
  const type = imageType(path);
  if (!type || !host) return Promise.resolve(null);
  const key = `${host}|${path}`;
  let p = cache.get(key);
  if (p) {
    // Most recently used last.
    cache.delete(key);
    cache.set(key, p);
    return p;
  }
  p = access.then(async (a) => {
    const link = a.linkFor(host);
    if (!link) return null;
    const data: string | null = await link.call("image", path);
    return data ? `data:${type};base64,${data}` : null;
  });
  // A failure isn't remembered: the next look tries again (the link may be back).
  p.then((v) => v === null && cache.delete(key), () => cache.delete(key));
  cache.set(key, p);
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return p;
}
