import { create } from "zustand";

/** Per open file view: where to scroll (bumped each time something asks), and unsaved edits. */
interface FilesState {
  /** Latest request to show a line; `n` changes on every request so the view re-reveals. */
  targets: Record<string, { line?: number; col?: number; n: number }>;
  /** File views with unsaved edits (shown as a dot on their tab / window). */
  dirty: Record<string, true>;
}

export const useFiles = create<FilesState>(() => ({ targets: {}, dirty: {} }));

export function setFileDirty(id: string, dirty: boolean) {
  useFiles.setState((s) => {
    if (!!s.dirty[id] === dirty) return s;
    const next = { ...s.dirty };
    if (dirty) next[id] = true;
    else delete next[id];
    return { dirty: next };
  });
}

/**
 * What a file view leaves behind when it isn't on screen (another tab is active, the window was
 * closed): its scroll position and selection, and its text if it had unsaved edits, so coming
 * back finds it exactly as it was.
 */
export const fileBuffers = new Map<string, { text?: string; saved?: string; view?: unknown; editing?: boolean }>();

// ---------------------------------------------------------------------------
// Watching open files (the app-server's fs/watch), so a view reloads when Codex, or anything
// else, changes the file under it.
// ---------------------------------------------------------------------------

const watchers = new Map<string, (paths: string[]) => void>();

/** Route an `fs/changed` notification to whoever is watching. */
export function onFsChanged(params: { watchId: string; changedPaths: string[] }) {
  watchers.get(params.watchId)?.(params.changedPaths ?? []);
}

/** Watch `path`; returns a function that stops watching. Quietly does nothing if watching isn't available. */
export async function watchPath(path: string, onChange: (paths: string[]) => void): Promise<() => void> {
  const { fsClient } = await import("../rpc/client");
  const rpc = fsClient();
  const watchId = `ret-${Math.random().toString(36).slice(2, 10)}`;
  watchers.set(watchId, onChange);
  try {
    await rpc.request("fs/watch", { watchId, path });
  } catch {
    watchers.delete(watchId);
    return () => {};
  }
  return () => {
    watchers.delete(watchId);
    void rpc.request("fs/unwatch", { watchId }).catch(() => {});
  };
}
