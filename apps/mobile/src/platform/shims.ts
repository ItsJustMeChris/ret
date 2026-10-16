// What the desktop's shared code expects of a browser, for the phone: randomness, window events
// and localStorage. Imported first (index.ts), before any of that code runs.

import { getRandomValues, randomUUID } from "expo-crypto";
import { File, Paths } from "expo-file-system";

const g = globalThis as any;

// Randomness: @noble's pairing math and the shared stores' ids.
g.crypto ??= {};
g.crypto.getRandomValues ??= getRandomValues;
g.crypto.randomUUID ??= randomUUID;

// Window events: the shared stores tell a thread's composer to fill, focus or send this way
// (state/composerDrafts.ts). Only what they use: no capture, no bubbling.
if (typeof g.addEventListener !== "function") {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  g.addEventListener = (type: string, cb: (e: unknown) => void) => {
    let set = listeners.get(type);
    if (!set) listeners.set(type, (set = new Set()));
    set.add(cb);
  };
  g.removeEventListener = (type: string, cb: (e: unknown) => void) => void listeners.get(type)?.delete(cb);
  g.dispatchEvent = (e: { type: string }) => {
    for (const cb of [...(listeners.get(e.type) ?? [])]) cb(e);
    return true;
  };
}
g.CustomEvent ??= class CustomEvent<T = unknown> {
  readonly detail: T;
  constructor(
    readonly type: string,
    init?: { detail?: T },
  ) {
    this.detail = init?.detail as T;
  }
};

// TextDecoder, for files read from a computer (lib/fileText.ts), if the engine hasn't one: UTF-8 only.
g.TextDecoder ??= class TextDecoder {
  decode(input?: ArrayBufferView | ArrayBuffer): string {
    const b = input instanceof ArrayBuffer ? new Uint8Array(input) : input ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array();
    let out = "";
    for (let i = 0; i < b.length; ) {
      const c = b[i++];
      let cp: number;
      if (c < 0x80) cp = c;
      else if (c >> 5 === 6) cp = ((c & 31) << 6) | (b[i++] & 63);
      else if (c >> 4 === 14) cp = ((c & 15) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
      else cp = ((c & 7) << 18) | ((b[i++] & 63) << 12) | ((b[i++] & 63) << 6) | (b[i++] & 63);
      out += String.fromCodePoint(cp);
    }
    return out;
  }
};

// localStorage: the shared UI store (state/ui.ts) keeps its settings there through zustand's
// persist, which reads it synchronously as the store is made. One JSON file, read once now and
// written (soon after a change) whenever something changes.
if (!g.localStorage) {
  const file = new File(Paths.document, "local-storage.json");
  let data: Record<string, string> = {};
  try {
    if (file.exists) data = JSON.parse(file.textSync()) ?? {};
  } catch {
    data = {};
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        file.write(JSON.stringify(data));
      } catch (err) {
        console.warn("Couldn't save settings:", (err as Error).message);
      }
    }, 300);
  };
  g.localStorage = {
    getItem: (k: string) => (Object.hasOwn(data, k) ? data[k] : null),
    setItem: (k: string, v: string) => {
      data[k] = String(v);
      save();
    },
    removeItem: (k: string) => {
      delete data[k];
      save();
    },
    clear: () => {
      data = {};
      save();
    },
    key: (i: number) => Object.keys(data)[i] ?? null,
    get length() {
      return Object.keys(data).length;
    },
  };
}
