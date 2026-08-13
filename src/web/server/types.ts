import type { IncomingMessage, ServerResponse } from "node:http";

import type {
  BootstrapResponse,
  CancelTurnRequest,
  CancelTurnResult,
  CreateMessageAccepted,
  CreateMessageRequest,
  IdentityQuery,
  IdentityRecordContract,
  MemoryQuery,
  MemoryRecordContract,
  RememberIdentityRequest,
  RememberMemoryRequest,
  RestartAgentAccepted,
  RestartAgentRequest,
  RetractIdentityRequest,
  RetractMemoryRequest,
  SupersedeIdentityRequest,
  SupersedeMemoryRequest,
  SetupSaveRequest,
  SetupSaveResponse,
  SetupSnapshot
} from "../../contracts/index.js";
import type { SseRuntime } from "../sse/index.js";
import type { GroupXRuntimeIdentity } from "../../core/runtime-instance.js";

export type Awaitable<T> = T | Promise<T>;

export interface BrokerHealth {
  readonly status: string;
  readonly [key: string]: unknown;
}

export interface MemoryPage {
  readonly items: readonly MemoryRecordContract[];
  readonly nextCursor?: number;
}

export interface MemoryMutationAccepted {
  readonly memory: MemoryRecordContract;
}

export interface IdentityPage {
  readonly items: readonly IdentityRecordContract[];
  readonly nextCursor?: number;
}

export interface IdentityMutationAccepted {
  readonly identity: IdentityRecordContract;
}

export interface McpHttpHandler {
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
  close?(): Promise<void>;
}

export interface SetupApi {
  snapshot(signal: AbortSignal): Awaitable<SetupSnapshot>;
  save(request: SetupSaveRequest, signal: AbortSignal): Awaitable<SetupSaveResponse>;
}

/**
 * The HTTP layer deliberately knows only this command/query surface. Turn
 * state, idempotency, actor assignment and persistence remain Broker concerns.
 */
export interface BrokerApi {
  readonly roomId: string;

  health(signal: AbortSignal): Awaitable<BrokerHealth>;
  bootstrap(signal: AbortSignal): Awaitable<BootstrapResponse>;
  createMessage(
    request: CreateMessageRequest,
    signal: AbortSignal
  ): Awaitable<CreateMessageAccepted>;
  cancelTurn(
    turnId: string,
    request: CancelTurnRequest,
    signal: AbortSignal
  ): Awaitable<CancelTurnResult>;
  queryMemory(query: MemoryQuery, signal: AbortSignal): Awaitable<MemoryPage>;
  queryIdentity(query: IdentityQuery, signal: AbortSignal): Awaitable<IdentityPage>;
  rememberMemory(
    request: RememberMemoryRequest,
    signal: AbortSignal
  ): Awaitable<MemoryMutationAccepted>;
  rememberIdentity(
    request: RememberIdentityRequest,
    signal: AbortSignal
  ): Awaitable<IdentityMutationAccepted>;
  supersedeIdentity(
    identityId: string,
    request: SupersedeIdentityRequest,
    signal: AbortSignal
  ): Awaitable<IdentityMutationAccepted>;
  retractIdentity(
    identityId: string,
    request: RetractIdentityRequest,
    signal: AbortSignal
  ): Awaitable<IdentityMutationAccepted>;
  supersedeMemory(
    memoryId: string,
    request: SupersedeMemoryRequest,
    signal: AbortSignal
  ): Awaitable<MemoryMutationAccepted>;
  retractMemory(
    memoryId: string,
    request: RetractMemoryRequest,
    signal: AbortSignal
  ): Awaitable<MemoryMutationAccepted>;
  restartAgent(
    actorId: string,
    request: RestartAgentRequest,
    signal: AbortSignal
  ): Awaitable<RestartAgentAccepted>;
}

export interface GroupXHttpServerOptions {
  readonly broker: BrokerApi;
  readonly sse: SseRuntime;
  readonly host?: "127.0.0.1";
  /** Use zero only when the operating system should choose a test port. */
  readonly port?: number;
  readonly staticRoot?: string;
  readonly maxRequestBodyBytes?: number;
  readonly gracefulCloseTimeoutMs?: number;
  readonly mcpHandler?: McpHttpHandler;
  readonly setupApi?: SetupApi;
  /** Present on the product runtime; optional only for embedded/test servers. */
  readonly runtimeIdentity?: GroupXRuntimeIdentity;
}

export interface GroupXHttpServerAddress {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly origin: string;
}
