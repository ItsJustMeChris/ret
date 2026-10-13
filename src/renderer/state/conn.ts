import { create } from "zustand";
import type { AppUpdateState, EngineStatus, ProviderId, ProvidersSettings, UpdaterState } from "@shared/bridge";
import { PROVIDER_IDS } from "@shared/bridge";
import type { Account, GetAccountRateLimitsResponse, InitializeResponse, Model } from "@shared/protocol";

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

/** Everything Ret knows about one provider's engine and account. */
export interface ProviderConn {
  status: EngineStatus | null;
  info: InitializeResponse | null;
  account: AccountState | null;
  accountLoaded: boolean;
  rateLimits: GetAccountRateLimitsResponse | null;
  /** Tokens per local day (YYYY-MM-DD → tokens), from `account/usage/read`; when it was last read in full, and whether a read is underway. */
  tokenUsage: { at: number; days: Record<string, number>; loading: boolean } | null;
  models: Model[];
  /** Collaboration mode presets (Plan, Default) with their suggested model/effort. */
  modes: { name: string; mode: "plan" | "default" | null; model: string | null; reasoning_effort: string | null }[];
  /** Defaults new threads inherit from the provider's own config. */
  defaults: { model: string | null; effort: string | null; serviceTier: string | null };
  login: LoginFlow | null;
}

export interface ConnState {
  providers: Record<ProviderId, ProviderConn>;
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

export function patchProvider(provider: ProviderId, patch: Partial<ProviderConn> | ((c: ProviderConn) => Partial<ProviderConn>)) {
  useConn.setState((s) => {
    const cur = s.providers[provider];
    return { providers: { ...s.providers, [provider]: { ...cur, ...(typeof patch === "function" ? patch(cur) : patch) } } };
  });
}

/** One provider's slice of the connection state. */
export function useProvider<T>(provider: ProviderId, select: (c: ProviderConn) => T): T {
  return useConn((s) => select(s.providers[provider]));
}

/** Providers turned on in Settings (all of them until settings load). */
export function enabledProviders(s: ConnState = useConn.getState()): ProviderId[] {
  return PROVIDER_IDS.filter((p) => s.settings?.enabled[p] ?? true);
}

export function useEnabledProviders(): ProviderId[] {
  const enabled = useConn((s) => s.settings?.enabled);
  return PROVIDER_IDS.filter((p) => enabled?.[p] ?? true);
}

/** Signed in (any account kind). */
export const signedIn = (c: ProviderConn) => !!c.account?.account;
