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
  "project/list": v2.ProjectListResponse;
  "turn/start": v2.TurnStartResponse;
  "model/list": v2.ModelListResponse;
  "account/read": v2.GetAccountResponse;
  "account/login/start": v2.LoginAccountResponse;
  "account/rateLimits/read": v2.GetAccountRateLimitsResponse;
}
export type ResultOf<M extends Method> = M extends keyof ResultMap ? ResultMap[M] : unknown;

export type ServerRequestMethod = ServerRequest["method"];
export type ServerRequestOf<M extends ServerRequestMethod> = Extract<ServerRequest, { method: M }>;
