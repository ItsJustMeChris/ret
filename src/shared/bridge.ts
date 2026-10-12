// Contract between the Electron main process and the renderer.
// The renderer only ever sees `window.ret`, which implements RetBridge.

export type CodexSource = "managed" | "system" | "custom";

export interface CodexStatus {
  state: "starting" | "running" | "stopped" | "error" | "missing";
  /** Increments every time a fresh app-server process is spawned. The renderer
   * re-runs `initialize` and re-subscribes to threads when this changes. */
  generation: number;
  version: string | null;
  binaryPath: string | null;
  source: CodexSource | null;
  engine: "dedicated" | "shared";
  error: string | null;
  stderrTail: string[];
}

export interface UpdaterSettings {
  /** managed = Ret downloads and auto-updates its own copy of codex. */
  source: CodexSource;
  autoUpdate: boolean;
  channel: "latest" | "alpha";
  customPath: string | null;
  checkIntervalHours: number;
  /** dedicated = Ret runs its own app-server; shared = attach to the Codex daemon other Codex apps use. */
  engine: "dedicated" | "shared";
}

export type UpdaterPhase =
  | "idle"
  | "checking"
  | "downloading"
  | "verifying"
  | "extracting"
  | "ready"
  | "upToDate"
  | "error";

export interface UpdaterState {
  settings: UpdaterSettings;
  phase: UpdaterPhase;
  /** 0..1 while downloading. */
  progress: number | null;
  latest: string | null;
  /** Version currently running in the app-server process. */
  running: string | null;
  /** Installed (managed) version that is newer than `running` and waiting for a restart. */
  staged: string | null;
  installed: string[];
  lastCheckedAt: number | null;
  error: string | null;
}

export interface WorktreeResult {
  path: string;
  branch: string;
  repoRoot: string;
}

export interface GitInfo {
  isRepo: boolean;
  root: string | null;
  branch: string | null;
}

export interface RetBridge {
  platform: string;
  appVersion: string;
  codex: {
    send(line: string): void;
    onMessages(cb: (lines: string[]) => void): () => void;
    onStatus(cb: (status: CodexStatus) => void): () => void;
    getStatus(): Promise<CodexStatus>;
    restart(): Promise<void>;
  };
  updater: {
    getState(): Promise<UpdaterState>;
    onState(cb: (state: UpdaterState) => void): () => void;
    check(): Promise<UpdaterState>;
    /** Restart the app-server on the staged version. */
    apply(): Promise<void>;
    setSettings(patch: Partial<UpdaterSettings>): Promise<UpdaterState>;
  };
  dialog: {
    pickFolder(): Promise<string | null>;
    pickFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
  };
  shell: {
    openExternal(url: string): Promise<void>;
    /** Opens a file/folder with its default app. Resolves to an error message ("" on success). */
    openPath(path: string): Promise<string>;
    /** Shows the item selected in File Explorer / Finder. */
    reveal(path: string): Promise<void>;
  };
  editor: {
    /** Whether a code editor that can jump to a line (VS Code) is installed. */
    available(): Promise<boolean>;
    open(path: string, line?: number, col?: number): Promise<void>;
  };
  git: {
    info(path: string): Promise<GitInfo>;
    createWorktree(cwd: string, label: string): Promise<WorktreeResult>;
  };
  files: {
    saveImage(data: ArrayBuffer, ext: string): Promise<string>;
    stat(path: string): Promise<{ exists: boolean; isDir: boolean }>;
  };
  /** Writes to the system clipboard (works regardless of page focus). */
  copy(text: string): Promise<void>;
  /** Native editing commands for the focused field (context menus). */
  edit(command: EditCommand, arg?: string): void;
  /** Spellchecker suggestions for the word under the last right-click in an editable field. */
  onSpelling(cb: (s: { word: string; suggestions: string[] }) => void): () => void;
  notify(title: string, body: string): void;
  setTheme(theme: "dark" | "light"): void;
}

export type EditCommand = "undo" | "redo" | "cut" | "copy" | "paste" | "selectAll" | "replaceMisspelling" | "addToDictionary";

export const IPC = {
  codexSend: "codex:send",
  codexMessages: "codex:messages",
  codexStatus: "codex:status",
  codexGetStatus: "codex:getStatus",
  codexRestart: "codex:restart",
  updaterGet: "updater:get",
  updaterState: "updater:state",
  updaterCheck: "updater:check",
  updaterApply: "updater:apply",
  updaterSettings: "updater:settings",
  pickFolder: "dialog:pickFolder",
  pickFile: "dialog:pickFile",
  openExternal: "shell:openExternal",
  openPath: "shell:openPath",
  gitInfo: "git:info",
  gitWorktree: "git:worktree",
  saveImage: "files:saveImage",
  notify: "app:notify",
  setTheme: "app:setTheme",
  reveal: "shell:reveal",
  stat: "files:stat",
  editorAvailable: "editor:available",
  editorOpen: "editor:open",
  edit: "edit:command",
  spelling: "edit:spelling",
  copy: "clipboard:write",
} as const;
