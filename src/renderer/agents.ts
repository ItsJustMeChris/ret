import type { ProviderId } from "@shared/bridge";
import type { SandboxMode, SandboxPolicy } from "@shared/protocol";
import type { AskForApproval } from "@shared/protocol/generated/v2";

/**
 * What the UI needs to know about each agent backend. Everything provider-specific in the
 * renderer lives here; views ask a provider what it offers rather than which one it is.
 * The engines all speak the app-server protocol, so this is mostly labels, choices, and how a
 * choice is expressed in a request.
 */
export interface AccessOption {
  id: string;
  label: string;
  title: string;
}

export interface AgentProvider {
  id: ProviderId;
  /** Product name, as in "Claude Code is asking". */
  name: string;
  /** Short name for tight spots (chips, menus). */
  short: string;
  /** Composer's sandbox/permission choices; the first is the default ("whatever your config says"). */
  access: AccessOption[];
  accessLabel: string;
  /** thread/start params for an access choice. */
  threadAccess(access: string): Record<string, unknown>;
  /** turn/start params for an access choice. */
  turnAccess(access: string): Record<string, unknown>;
  /** Sign-in happens in Ret (Codex's ChatGPT flow) rather than in the provider's own CLI. */
  inAppLogin: boolean;
  /** Ret can see its threads running in other apps (Codex's state database, Claude Code's session registry). */
  external: boolean;
  /**
   * How long (seconds) an unfinished turn elsewhere counts as running after its thread last
   * changed. Codex can't tell a running turn from one whose app died, so a quiet one expires;
   * Claude Code's registry says outright (and Ret drops entries of exited processes): null.
   */
  externalQuietS: number | null;
  /** Keeps named workspaces of folders (`project/list`: the ChatGPT and Codex apps' projects) for the sidebar to group by. */
  workspaces: boolean;
  /** Ret titles its threads (Codex leaves that to each client; Claude Code titles its own sessions). */
  autoTitle: boolean;
  /** Where the provider's own settings live, for "inherit" labels. */
  configName: string;
  /** Which access choice a thread's reported settings amount to, when the engine doesn't name it. */
  accessOf?(approvalPolicy: unknown, sandbox: unknown): string | null;
}

function codexAccess(preset: string): { approvalPolicy?: AskForApproval; sandbox?: SandboxMode; sandboxPolicy?: SandboxPolicy } {
  switch (preset) {
    case "read-only":
      return { approvalPolicy: "on-request", sandbox: "read-only", sandboxPolicy: { type: "readOnly", networkAccess: false } };
    case "auto":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      };
    case "full":
      return { approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } };
    default:
      return {};
  }
}

const codex: AgentProvider = {
  id: "codex",
  name: "Codex",
  short: "Codex",
  accessLabel: "Sandbox & approvals",
  access: [
    { id: "config", label: "Default", title: "Whatever your config.toml sets" },
    { id: "read-only", label: "Read only", title: "Read files; ask before any change" },
    { id: "auto", label: "Workspace", title: "Edit inside the project; ask before anything else" },
    { id: "full", label: "Full access", title: "No sandbox and no approval prompts" },
  ],
  threadAccess: (a) => {
    const x = codexAccess(a);
    return { approvalPolicy: x.approvalPolicy, sandbox: x.sandbox };
  },
  turnAccess: (a) => {
    const x = codexAccess(a);
    return { approvalPolicy: x.approvalPolicy, sandboxPolicy: x.sandboxPolicy };
  },
  inAppLogin: true,
  external: true,
  externalQuietS: 10 * 60,
  workspaces: true,
  autoTitle: true,
  configName: "config.toml",
  accessOf: (approvalPolicy, sandbox) => {
    const type = (sandbox as { type?: string } | null)?.type;
    if (type === "dangerFullAccess" && approvalPolicy === "never") return "full";
    if (type === "workspaceWrite" && approvalPolicy === "on-request") return "auto";
    if (type === "readOnly" && approvalPolicy === "on-request") return "read-only";
    return null;
  },
};

const claude: AgentProvider = {
  id: "claude",
  name: "Claude Code",
  short: "Claude",
  accessLabel: "Permissions",
  access: [
    { id: "config", label: "Default", title: "Whatever your Claude Code settings say" },
    { id: "default", label: "Ask", title: "Ask before edits and commands" },
    { id: "acceptEdits", label: "Accept edits", title: "Edit files without asking; ask before commands" },
    { id: "auto", label: "Auto", title: "Claude Code decides what needs asking" },
    { id: "bypassPermissions", label: "Full access", title: "Never ask (bypass permissions)" },
  ],
  threadAccess: (a) => ({ access: a }),
  turnAccess: (a) => ({ access: a }),
  inAppLogin: false,
  external: true,
  // A session can sit busy for hours without writing (waiting on its subagents or teammates).
  externalQuietS: null,
  workspaces: false,
  autoTitle: false,
  configName: "Claude Code settings",
};

export const PROVIDERS: Record<ProviderId, AgentProvider> = { codex, claude };

export const providerInfo = (id: ProviderId | null | undefined): AgentProvider => PROVIDERS[id ?? "codex"] ?? codex;

/** A remembered access choice that this provider doesn't offer falls back to its default. */
export function accessFor(provider: ProviderId, access: string | undefined): string {
  return PROVIDERS[provider].access.some((o) => o.id === access) ? access! : "config";
}

/** The provider a new thread uses: the first of these choices that's still enabled, else the first enabled. */
export function pickProvider(enabled: ProviderId[], ...choices: (ProviderId | null | undefined)[]): ProviderId {
  return choices.find((p): p is ProviderId => !!p && enabled.includes(p)) ?? enabled[0] ?? "codex";
}
