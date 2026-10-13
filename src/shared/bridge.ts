// Contract between the Electron main process and the renderer.
// The renderer only ever sees `window.ret`, which implements RetBridge.

/**
 * Agent backends Ret can drive. Each one is an *engine* in the main process that speaks the
 * app-server JSON-RPC protocol (src/shared/protocol) to the renderer: Codex natively, the others
 * through an adapter that translates their own protocol into it.
 */
export type ProviderId = "codex" | "claude";
export const PROVIDER_IDS: readonly ProviderId[] = ["codex", "claude"];

export type CodexSource = "managed" | "system" | "custom";
/** Where an engine's binary comes from. Only Codex has a managed (Ret-installed) copy. */
export type EngineSource = CodexSource;

export interface EngineStatus {
  provider: ProviderId;
  /** "disabled" = turned off in Settings. */
  state: "starting" | "running" | "stopped" | "error" | "missing" | "disabled";
  /** Increments every time the engine gets a fresh connection. The renderer
   * re-runs `initialize` and re-subscribes to threads when this changes. */
  generation: number;
  version: string | null;
  binaryPath: string | null;
  source: EngineSource | null;
  /** Codex only: Ret's own app-server, or the shared daemon the Codex desktop app uses. */
  engine: "dedicated" | "shared";
  error: string | null;
  stderrTail: string[];
  /** Keeping the provider's own install current (Claude Code; Codex has its UpdaterState). */
  update?: EngineUpdate | null;
}

export interface EngineUpdate {
  /** waiting = a newer version is out, held until no thread is running. */
  phase: "idle" | "checking" | "waiting" | "updating" | "error";
  latest: string | null;
  error: string | null;
  checkedAt: number | null;
  /** Installs updates on its own (Settings switch). */
  auto: boolean;
}

/** @deprecated The Codex engine's status; use EngineStatus. */
export type CodexStatus = EngineStatus;

/** Which providers are on, and where the ones without a managed copy find their binary. */
export interface ProvidersSettings {
  enabled: Record<ProviderId, boolean>;
  claude: {
    source: "system" | "custom";
    customPath: string | null;
    /** Run Claude Code's own updater when a new version is out (its model list comes from it). */
    autoUpdate: boolean;
  };
}

export type ProvidersSettingsPatch = Partial<Omit<ProvidersSettings, "enabled" | "claude">> & {
  enabled?: Partial<Record<ProviderId, boolean>>;
  claude?: Partial<ProvidersSettings["claude"]>;
};

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

/** Ret's own updates, published as GitHub Releases. `unsupported` = dev/unpackaged build. */
export type AppUpdatePhase = "unsupported" | "idle" | "checking" | "downloading" | "ready" | "upToDate" | "error";

export interface AppUpdateState {
  phase: AppUpdatePhase;
  /** Newest release found; once `ready`, the version a restart installs. */
  version: string | null;
  /** 0..1 while downloading. */
  progress: number | null;
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
  /** One JSON-RPC pipe per provider's engine. */
  agents: {
    send(provider: ProviderId, line: string): void;
    onMessages(cb: (provider: ProviderId, lines: string[]) => void): () => void;
    onStatus(cb: (status: EngineStatus) => void): () => void;
    getStatus(provider: ProviderId): Promise<EngineStatus>;
    restart(provider: ProviderId): Promise<void>;
    getSettings(): Promise<ProvidersSettings>;
    onSettings(cb: (settings: ProvidersSettings) => void): () => void;
    setSettings(patch: ProvidersSettingsPatch): Promise<ProvidersSettings>;
    /** Opens a terminal running the provider's own sign-in. Ret never sees the credentials. */
    openLogin(provider: ProviderId): Promise<void>;
    /** Check for a newer version of the provider and install it (through its own updater). */
    update(provider: ProviderId): Promise<void>;
  };
  /** Codex's self-updater (the managed copy of codex). */
  updater: {
    getState(): Promise<UpdaterState>;
    onState(cb: (state: UpdaterState) => void): () => void;
    check(): Promise<UpdaterState>;
    /** Restart the app-server on the staged version. */
    apply(): Promise<void>;
    setSettings(patch: Partial<UpdaterSettings>): Promise<UpdaterState>;
  };
  appUpdate: {
    getState(): Promise<AppUpdateState>;
    onState(cb: (state: AppUpdateState) => void): () => void;
    check(): Promise<AppUpdateState>;
    /** Quits, installs the downloaded update and relaunches. */
    install(): Promise<void>;
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
    /** Folder → the same place in its main checkout, for those that are linked worktrees. */
    mainCheckouts(cwds: string[]): Promise<Record<string, string>>;
  };
  files: {
    saveImage(data: ArrayBuffer, ext: string): Promise<string>;
    stat(path: string): Promise<{ exists: boolean; isDir: boolean; size?: number }>;
    /** Where a dropped/pasted File lives on disk; null when it has no path (e.g. dragged from a web page). */
    pathFor(file: File): string | null;
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
  agentSend: "agent:send",
  agentMessages: "agent:messages",
  agentStatus: "agent:status",
  agentGetStatus: "agent:getStatus",
  agentRestart: "agent:restart",
  agentLogin: "agent:login",
  agentUpdate: "agent:update",
  providersGet: "providers:get",
  providersSet: "providers:set",
  providersState: "providers:state",
  updaterGet: "updater:get",
  updaterState: "updater:state",
  updaterCheck: "updater:check",
  updaterApply: "updater:apply",
  updaterSettings: "updater:settings",
  appUpdateGet: "appUpdate:get",
  appUpdateState: "appUpdate:state",
  appUpdateCheck: "appUpdate:check",
  appUpdateInstall: "appUpdate:install",
  pickFolder: "dialog:pickFolder",
  pickFile: "dialog:pickFile",
  openExternal: "shell:openExternal",
  openPath: "shell:openPath",
  gitInfo: "git:info",
  gitWorktree: "git:worktree",
  gitCheckouts: "git:checkouts",
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
