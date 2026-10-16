import { router } from "expo-router";
import { createContext, useContext } from "react";
import { parseFileRef, resolvePath } from "@ret/lib/files";

// Opening files: everything that names a file in a thread (a path in a reply, an edited file, a
// read command) opens it on the file screen, from the computer the thread runs on.

/** Where a thread's relative paths start, and the computer its files are on. */
export interface FileScope {
  cwd: string | null;
  host: string | null;
}

export const FileScopeContext = createContext<FileScope | null>(null);
export const useFileScope = () => useContext(FileScopeContext);

/** Open a file reference (`src/a.ts:12`, `/abs/b.ts#L3`, `file:///…`) from a thread. */
export function openFileRef(raw: string, scope: FileScope | null) {
  const ref = parseFileRef(raw);
  if (!ref || !scope?.host) return false;
  openFile(resolvePath(ref.path, scope.cwd), scope.host, ref.line);
  return true;
}

export function openFile(path: string, host: string, line?: number) {
  router.push({ pathname: "/file", params: { path, host, ...(line ? { line: String(line) } : {}) } });
}

export function openFolder(path: string, host: string) {
  router.push({ pathname: "/files", params: { path, host } });
}
