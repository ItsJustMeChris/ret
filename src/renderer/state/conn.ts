import { create } from "zustand";
import type { AppUpdateState, EngineId, EngineStatus, ProviderId, ProvidersSettings, UpdaterState } from "@shared/bridge";
import { PROVIDER_IDS, engineId } from "@shared/bridge";
import type { Account, GetAccountRateLimitsResponse, InitializeResponse, Model, UsageActivity } from "@shared/protocol";

export interface LoginFlow {
  loginId: string;
  kind: "browser" | "device" | "terminal";
  authUrl?: string;
  verificationUrl?: string;
  userCode?: string;
  error?: string | null;
}

/** Accounts as engines report them: Codex's, plus what other providers sign in with. */
export type ProviderAccount =
  | Account
  | { type: "claudeAi"; email: string | null; planType: string | null; organization?: string | null }
  | { type: "cloud"; provider: string };

export interface AccountState {
  account: ProviderAccount | null;
  requiresOpenaiAuth: boolean;
}

export interface TokenUsage {
  at: number;
  loading: boolean;
  /** Tokens per local day (YYYY-MM-DD → tokens), from `account/usage/read`: Codex's server counts every device. */
  days: Record<string, number>;
  /** Streaks the provider keeps itself (Codex), which can reach back past the days it lists. */
  streaks: { current: number; longest: number } | null;
  /** Each day's tokens by model and prompts by hour, from transcripts on this computer (`ret/usage/activity`). */
  activity: UsageActivity | null;
}

/** Everything Ret knows about one provider's engine and account. */
export interface ProviderConn {
  status: EngineStatus | null;
  info: InitializeResponse | null;
  account: AccountState | null;
  accountLoaded: boolean;
  rateLimits: GetAccountRateLimitsResponse | null;
  /** Usage for the home screen; when it was last read in full, and whether a read is underway. */
  tokenUsage: TokenUsage | null;
  models: Model[];
  /** Collaboration mode presets (Plan, Default) with their suggested model/effort. */
  modes: { name: string; mode: "plan" | "default" | null; model: string | null; reasoning_effort: string | null }[];
  /** Defaults new threads inherit from the provider's own config. */
  defaults: { model: string | null; effort: string | null; serviceTier: string | null };
  login: LoginFlow | null;
}

export interface ConnState {
  /**
   * By engine: this computer's under their provider ("codex", always there), paired devices'
   * as "codex@<host>" (while the device is paired).
   */
  providers: Record<EngineId, ProviderConn>;
  /** Which providers are on, the default for new threads, where Claude Code lives. */
  settings: ProvidersSettings | null;
  /** Codex's self-updater (its managed copy). */
  updater: UpdaterState | null;
  /** Ret's own updates. */
  appUpdate: AppUpdateState | null;
}

export const emptyProviderConn = (): ProviderConn => ({
  status: null,
  info: null,
  account: null,
  accountLoaded: false,
  rateLimits: null,
  tokenUsage: null,
  models: [],
  modes: [],
  defaults: { model: null, effort: null, serviceTier: null },
  login: null,
});

export const useConn = create<ConnState>(() => ({
  providers: Object.fromEntries(PROVIDER_IDS.map((p) => [p, emptyProviderConn()])) as Record<ProviderId, ProviderConn>,
  settings: null,
  updater: null,
  appUpdate: null,
}));

export function patchProvider(engine: EngineId, patch: Partial<ProviderConn> | ((c: ProviderConn) => Partial<ProviderConn>)) {
  useConn.setState((s) => {
    const cur = s.providers[engine] ?? emptyProviderConn();
    return { providers: { ...s.providers, [engine]: { ...cur, ...(typeof patch === "function" ? patch(cur) : patch) } } };
  });
}

/** A paired device's engine went away with it. */
export function dropProvider(engine: EngineId) {
  useConn.setState((s) => {
    if (!s.providers[engine]) return s;
    const providers = { ...s.providers };
    delete providers[engine];
    return { providers };
  });
}

const NO_CONN = emptyProviderConn();

/** One engine's slice of the connection state (an empty one for an engine not heard from). */
export function useProvider<T>(engine: EngineId, select: (c: ProviderConn) => T): T {
  return useConn((s) => select(s.providers[engine] ?? NO_CONN));
}

/** Providers turned on in Settings (all of them until settings load). */
export function enabledProviders(s: ConnState = useConn.getState()): ProviderId[] {
  return PROVIDER_IDS.filter((p) => s.settings?.enabled[p] ?? true);
}

/**
 * Agents on a device: this computer's per Settings, a paired device's as its engines report
 * (all of them until they do).
 */
export function enabledProvidersOn(host: string | null, s: ConnState = useConn.getState()): ProviderId[] {
  if (!host) return enabledProviders(s);
  return PROVIDER_IDS.filter((p) => {
    const st = s.providers[engineId(p, host)]?.status?.state;
    return st !== "disabled" && st !== "missing";
  });
}

/** The agents on a device (see enabledProvidersOn), kept current. */
export function useEnabledProvidersOn(host: string | null): ProviderId[] {
  const key = useConn((s) => enabledProvidersOn(host, s).join(","));
  return key ? (key.split(",") as ProviderId[]) : [];
}

export function useEnabledProviders(): ProviderId[] {
  const enabled = useConn((s) => s.settings?.enabled);
  return PROVIDER_IDS.filter((p) => enabled?.[p] ?? true);
}

/** Signed in (any account kind). */
export const signedIn = (c: ProviderConn) => !!c.account?.account;
