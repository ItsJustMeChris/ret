// Friendly re-exports of the generated app-server protocol (see scripts/gen-protocol.mjs).
import type { ClientRequest, ServerRequest, InitializeResponse } from "./generated";
import type * as v2 from "./generated/v2";

export type { ClientRequest, ServerRequest, InitializeResponse };
export type {
  Account,
  AskForApproval,
  CommandAction,
  CommandExecutionApprovalDecision,
  CommandExecutionRequestApprovalParams,
  FileChangeApprovalDecision,
  FileChangeRequestApprovalParams,
  FileUpdateChange,
  GetAccountRateLimitsResponse,
  GetAccountResponse,
  LoginAccountResponse,
  McpServerElicitationRequestParams,
  Model,
  ModelListResponse,
  PermissionsRequestApprovalParams,
  RateLimitSnapshot,
  SandboxMode,
  SandboxPolicy,
  Thread,
  ThreadForkResponse,
  ThreadItem,
  ThreadListResponse,
  ThreadResumeResponse,
  ThreadStartResponse,
  ThreadStatus,
  ThreadTokenUsage,
  ThreadTurnsListResponse,
  ToolRequestUserInputParams,
  Turn,
  TurnPlanStep,
  TurnStartResponse,
  UserInput,
} from "./generated/v2";

export type Method = ClientRequest["method"];
export type ParamsOf<M extends Method> = Extract<ClientRequest, { method: M }>["params"];

/** Response types for the requests Ret makes. Unlisted methods resolve to `unknown`. */
export interface ResultMap {
  initialize: InitializeResponse;
  "thread/start": v2.ThreadStartResponse;
  "thread/resume": v2.ThreadResumeResponse;
  "thread/fork": v2.ThreadForkResponse;
  "thread/list": v2.ThreadListResponse;
  "thread/read": v2.ThreadReadResponse;
  "thread/turns/list": v2.ThreadTurnsListResponse;
  "thread/loaded/list": v2.ThreadLoadedListResponse;
  "thread/goal/get": v2.ThreadGoalGetResponse;
  "thread/goal/set": v2.ThreadGoalSetResponse;
  "project/list": v2.ProjectListResponse;
  "turn/start": v2.TurnStartResponse;
  "model/list": v2.ModelListResponse;
  "account/read": v2.GetAccountResponse;
  "account/login/start": v2.LoginAccountResponse;
  "account/rateLimits/read": v2.GetAccountRateLimitsResponse;
  "account/usage/read": v2.GetAccountTokenUsageResponse;
}
export type ResultOf<M extends Method> = M extends keyof ResultMap ? ResultMap[M] : unknown;

/**
 * A turn plus its checklist and what it changed in files, which the Claude Code engine reads back
 * from the transcript (Ret's own extension). Codex sends a turn's plan and diff only while it runs,
 * as `turn/plan/updated` and `turn/diff/updated`.
 */
export type TurnWithPlan = v2.Turn & { plan?: v2.TurnPlanStep[] | null; diff?: string | null };

export type ServerRequestMethod = ServerRequest["method"];
export type ServerRequestOf<M extends ServerRequestMethod> = Extract<ServerRequest, { method: M }>;

/**
 * Work a thread left running after its turn ended (a background shell, subagent or monitor). The
 * agent takes the thread up again when it finishes. Ret's own extension, sent by the Claude Code
 * engine as `thread/backgroundTasks/updated`, which replaces the thread's whole list each time.
 */
export interface BackgroundTask {
  id: string;
  kind: "shell" | "agent" | "monitor" | "workflow" | "task";
  description: string;
  /** When it started (ms), or when Ret first saw it running. */
  startedAt: number;
}
export interface ThreadBackgroundTasksUpdatedNotification {
  threadId: string;
  tasks: BackgroundTask[];
}

/**
 * What one provider's agents did on each local day (YYYY-MM-DD), read from its transcripts on
 * this computer: Ret's own `ret/usage/activity`, answered by the Claude Code engine and, for
 * Codex, by Ret's main process ahead of the app-server. It covers the past year; days with
 * nothing are left out. While a read is underway, running totals arrive as
 * `account/usage/updated` with an `activity`.
 */
export interface UsageActivity {
  days: Record<string, UsageDay>;
}
export interface UsageDay {
  /** Tokens (input with cache, plus output), and the same split by model id. */
  tokens: number;
  models: Record<string, number>;
  /** Prompts the user sent (not subagents or the agent's own follow-ups), and by local hour, 0–23. */
  prompts: number;
  hours: number[];
}
