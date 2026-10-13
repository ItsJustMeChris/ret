import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";

/**
 * The app-server's `fs/*` methods (read, write, list, watch), for engines that don't provide
 * them natively. Code mode and the file viewer read files through whichever engine is up, so a
 * Claude-only setup still has a working editor.
 */
export class FsService {
  private watchers = new Map<string, { watcher: FSWatcher | null; path: string; timer: NodeJS.Timeout | null; closed: boolean }>();

  constructor(private readonly notify: (method: string, params: unknown) => void) {}

  handles(method: string) {
    return method.startsWith("fs/");
  }

  async call(method: string, p: any): Promise<unknown> {
    switch (method) {
      case "fs/readFile":
        return { dataBase64: (await readFile(p.path)).toString("base64") };
      case "fs/writeFile":
        await writeFile(p.path, Buffer.from(String(p.dataBase64 ?? ""), "base64"));
        return {};
      case "fs/readDirectory": {
        const entries = await readdir(p.path, { withFileTypes: true });
        return { entries: entries.map((e) => ({ fileName: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() })) };
      }
      case "fs/watch":
        this.watch(String(p.watchId), String(p.path));
        return {};
      case "fs/unwatch":
        this.unwatch(String(p.watchId));
        return {};
      default:
        throw Object.assign(new Error(`${method} is not supported`), { code: -32601 });
    }
  }

  private watch(watchId: string, path: string) {
    this.unwatch(watchId);
    const entry = { watcher: null as FSWatcher | null, path, timer: null as NodeJS.Timeout | null, closed: false };
    this.watchers.set(watchId, entry);
    const changed = () => {
      if (entry.timer) return;
      // Coalesce a save's burst of events into one notification.
      entry.timer = setTimeout(() => {
        entry.timer = null;
        if (!entry.closed) this.notify("fs/changed", { watchId, changedPaths: [path] });
      }, 60);
    };
    const arm = () => {
      if (entry.closed) return;
      try {
        entry.watcher = watch(path, { persistent: false }, (event) => {
          changed();
          // Editors save by replacing the file, which ends this watcher; follow the new one.
          if (event === "rename") {
            entry.watcher?.close();
            entry.watcher = null;
            setTimeout(arm, 100);
          }
        });
        entry.watcher.on("error", () => {
          entry.watcher?.close();
          entry.watcher = null;
          setTimeout(arm, 1000);
        });
      } catch {
        // Not there (yet): try again shortly, so a file that gets created is picked up.
        setTimeout(arm, 2000);
      }
    };
    arm();
  }

  private unwatch(watchId: string) {
    const entry = this.watchers.get(watchId);
    if (!entry) return;
    entry.closed = true;
    if (entry.timer) clearTimeout(entry.timer);
    entry.watcher?.close();
    this.watchers.delete(watchId);
  }

  dispose() {
    for (const id of [...this.watchers.keys()]) this.unwatch(id);
  }
}
