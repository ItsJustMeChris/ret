import { create } from "zustand";
import type { AppUpdateState, CodexStatus, UpdaterState } from "@shared/bridge";
import type { GetAccountRateLimitsResponse, GetAccountResponse, InitializeResponse, Model } from "../protocol";

export interface LoginFlow {
  loginId: string;
  kind: "browser" | "device";
  authUrl?: string;
  verificationUrl?: string;
  userCode?: string;
  error?: string | null;
}

export interface ConnState {
  codex: CodexStatus | null;
  updater: UpdaterState | null;
  /** Ret's own updates (the `updater` above is codex's). */
  appUpdate: AppUpdateState | null;
  info: InitializeResponse | null;
  account: GetAccountResponse | null;
  accountLoaded: boolean;
  rateLimits: GetAccountRateLimitsResponse | null;
  models: Model[];
  /** config.toml defaults new threads inherit. */
  defaults: { model: string | null; effort: string | null; serviceTier: string | null };
  login: LoginFlow | null;
}

export const useConn = create<ConnState>(() => ({
  codex: null,
  updater: null,
  appUpdate: null,
  info: null,
  account: null,
  accountLoaded: false,
  rateLimits: null,
  models: [],
  defaults: { model: null, effort: null, serviceTier: null },
  login: null,
}));
