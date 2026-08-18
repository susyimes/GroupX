import type {
  McpAskResult,
  McpMemoryRememberInput,
  McpMemorySearchInput,
  McpReadInput,
  McpReadResult,
  McpSendResult
} from "../contracts/mcp.js";
import {
  parseMcpAskResult,
  parseMcpReadResult,
  parseMcpSendResult
} from "../contracts/mcp.js";
import type {
  OperatorAgentCoreRememberInput,
  OperatorAgentRestartInput,
  OperatorContextCompactInput,
  OperatorContextResetInput,
  OperatorDispatchEventInput,
  OperatorIdentityRememberForInput,
  OperatorIdentityRetractInput,
  OperatorIdentitySearchInput,
  OperatorIdentitySearchResult,
  OperatorIdentitySupersedeInput,
  OperatorMemoryRetractInput,
  OperatorMemorySupersedeInput,
  OperatorSendInput,
  OperatorSetupSaveInput,
  OperatorSupervisionStatusInput,
  OperatorTurnCancelInput,
  OperatorTurnsCancelInput,
  OperatorWorkerAskInput,
  OperatorWorkerDispatchInput
} from "../contracts/operator.js";
import type { SetupSaveResponse, SetupSnapshot } from "../contracts/setup.js";
import { ASSISTANT_ACTOR_ID } from "../core/assistant.js";
import { GroupXError } from "../core/errors.js";
import type { ToolCallerContext } from "../mcp/server/broker-api.js";
import type { GroupXBroker } from "../broker/broker.js";
import type { GroupXConfig } from "../config.js";
import type { SetupApi } from "../web/server/types.js";
import {
  toIdentityRecordContract,
  toMemoryRecordContract
} from "./record-mappers.js";
import type { RestartAgentCommandCoordinator } from "./restart-commands.js";

const DEFAULT_PAGE_LIMIT = 100;
const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function nextCursor(cursor: number, limit: number, itemCount: number): number | undefined {
  return itemCount === limit ? cursor + itemCount : undefined;
}

function contentFromEventBody(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const content = (body as Record<string, unknown>).content;
  return typeof content === "string" ? content : undefined;
}

export interface OperatorBrokerApi {
  send(caller: ToolCallerContext, input: OperatorSendInput): Promise<McpSendResult>;
  read(caller: ToolCallerContext, input: McpReadInput): Promise<McpReadResult>;
  roster(caller: ToolCallerContext): Promise<{
    agents: Array<{
      actorId: string;
      displayName: string;
      enabled: boolean;
      cwd?: string;
      status: string;
    }>;
    activeTurns: import("../broker/types.js").BrokerTurnProjection[];
    pairs: Array<{
      pairId: string;
      workers: string[];
      observers: string[];
      steerCount: number;
    }>;
    health: string;
  }>;
  contextUsage(caller: ToolCallerContext): Promise<import("../memory/types.js").RoomContextUsage>;
  contextCompact(
    caller: ToolCallerContext,
    input: OperatorContextCompactInput
  ): Promise<import("../memory/types.js").RoomContextCompactionResult>;
  contextReset(
    caller: ToolCallerContext,
    input: OperatorContextResetInput
  ): Promise<import("../memory/types.js").RoomContextResetResult>;
  turnCancel(caller: ToolCallerContext, input: OperatorTurnCancelInput): Promise<{
    turnId: string;
    accepted: boolean;
    status: string;
  }>;
  turnsCancel(
    caller: ToolCallerContext,
    input: OperatorTurnsCancelInput
  ): Promise<{
    cancelled: Array<{ turnId: string; accepted: boolean; status: string }>;
  }>;
  agentRestart(
    caller: ToolCallerContext,
    input: OperatorAgentRestartInput
  ): Promise<import("../contracts/rest.js").RestartAgentAccepted>;
  memorySearch(
    caller: ToolCallerContext,
    input: McpMemorySearchInput
  ): Promise<{ items: ReturnType<typeof toMemoryRecordContract>[]; nextCursor?: number }>;
  memoryRemember(
    caller: ToolCallerContext,
    input: McpMemoryRememberInput
  ): Promise<{ memory: ReturnType<typeof toMemoryRecordContract> }>;
  memorySupersede(
    caller: ToolCallerContext,
    input: OperatorMemorySupersedeInput
  ): Promise<{ memory: ReturnType<typeof toMemoryRecordContract> }>;
  memoryRetract(
    caller: ToolCallerContext,
    input: OperatorMemoryRetractInput
  ): Promise<{ memory: ReturnType<typeof toMemoryRecordContract> }>;
  agentCoreRemember(
    caller: ToolCallerContext,
    input: OperatorAgentCoreRememberInput
  ): Promise<{ memory: ReturnType<typeof toMemoryRecordContract> }>;
  identitySearch(
    caller: ToolCallerContext,
    input: OperatorIdentitySearchInput
  ): Promise<OperatorIdentitySearchResult>;
  identityRememberFor(
    caller: ToolCallerContext,
    input: OperatorIdentityRememberForInput
  ): Promise<{ identity: ReturnType<typeof toIdentityRecordContract> }>;
  identitySupersede(
    caller: ToolCallerContext,
    input: OperatorIdentitySupersedeInput
  ): Promise<{ identity: ReturnType<typeof toIdentityRecordContract> }>;
  identityRetract(
    caller: ToolCallerContext,
    input: OperatorIdentityRetractInput
  ): Promise<{ identity: ReturnType<typeof toIdentityRecordContract> }>;
  setupRead(caller: ToolCallerContext): Promise<SetupSnapshot>;
  setupSave(caller: ToolCallerContext, input: OperatorSetupSaveInput): Promise<SetupSaveResponse>;
  workerDispatch(
    caller: ToolCallerContext,
    input: OperatorWorkerDispatchInput
  ): Promise<McpSendResult>;
  workerAsk(caller: ToolCallerContext, input: OperatorWorkerAskInput): Promise<McpAskResult>;
  dispatchEvent(
    caller: ToolCallerContext,
    input: OperatorDispatchEventInput
  ): Promise<McpSendResult>;
  supervisionStatus(
    caller: ToolCallerContext,
    input: OperatorSupervisionStatusInput
  ): Promise<ReturnType<GroupXBroker["supervisionStatus"]>>;
}

export interface GroupXOperatorBrokerApiOptions {
  broker: Pick<
    GroupXBroker,
    | "acceptMessage"
    | "waitForCorrelation"
    | "cancelFromBinding"
    | "readCorrelation"
    | "queryMemory"
    | "rememberMemory"
    | "supersedeMemory"
    | "retractMemory"
    | "queryIdentity"
    | "rememberIdentity"
    | "supersedeIdentity"
    | "retractIdentity"
    | "contextUsage"
    | "compactContextFromBinding"
    | "resetContextFromBinding"
    | "supervisionStatus"
    | "health"
    | "bootstrap"
  >;
  restartCommands: Pick<RestartAgentCommandCoordinator, "restart">;
  config: Pick<GroupXConfig, "transport" | "agents">;
  roomId: string;
  bindingId: string;
  setupApi?: SetupApi;
  store: Pick<
    import("../storage/types.js").GroupXStore,
    | "getMemory"
    | "getEvent"
    | "listTurns"
    | "listSupervisionPairs"
    | "listSupervisionPairTurns"
    | "getSteerCount"
  >;
  askTimeoutMs?: number;
}

export class GroupXOperatorBrokerApi implements OperatorBrokerApi {
  readonly #broker: GroupXOperatorBrokerApiOptions["broker"];
  readonly #restartCommands: GroupXOperatorBrokerApiOptions["restartCommands"];
  readonly #config: GroupXOperatorBrokerApiOptions["config"];
  readonly #roomId: string;
  readonly #bindingId: string;
  readonly #setupApi: SetupApi | undefined;
  readonly #store: GroupXOperatorBrokerApiOptions["store"];
  readonly #askTimeoutMs: number;

  constructor(options: GroupXOperatorBrokerApiOptions) {
    this.#broker = options.broker;
    this.#restartCommands = options.restartCommands;
    this.#config = options.config;
    this.#roomId = options.roomId;
    this.#bindingId = options.bindingId;
    this.#setupApi = options.setupApi;
    this.#store = options.store;
    this.#askTimeoutMs = options.askTimeoutMs ?? 120_000;
  }

  async send(caller: ToolCallerContext, input: OperatorSendInput): Promise<McpSendResult> {
    this.#requireOperator(caller);
    this.#assertSupervision(input.to, input.supervision?.observers);
    const accepted = await this.#broker.acceptMessage({
      bindingId: caller.bindingId,
      request: {
        clientCommandId: input.clientCommandId,
        to: input.to,
        content: input.content,
        ...(input.replyToEventId === undefined ? {} : { replyToEventId: input.replyToEventId }),
        ...(input.supervision === undefined ? {} : { supervision: input.supervision })
      },
      roomId: this.#roomId,
      commandType: "operator.send",
      sourceEventType: "message.created",
      operation: "send"
    });
    return parseMcpSendResult({
      messageEventId: accepted.messageEventId,
      correlationId: accepted.correlationId,
      turns: accepted.turns.map((turn) => ({
        target: turn.target,
        turnId: turn.turnId,
        status: turn.status
      }))
    });
  }

  async read(caller: ToolCallerContext, input: McpReadInput): Promise<McpReadResult> {
    this.#requireOperator(caller);
    return parseMcpReadResult(
      this.#broker.readCorrelation({
        ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
        roomId: this.#roomId,
        ...(input.afterSeq === undefined ? {} : { afterSeq: input.afterSeq }),
        ...(input.limit === undefined ? {} : { limit: input.limit })
      })
    );
  }

  async roster(caller: ToolCallerContext) {
    this.#requireOperator(caller);
    const bootstrap = this.#broker.bootstrap({ roomId: this.#roomId });
    const health = this.#broker.health();
    const agents = bootstrap.agents
      .filter((agent) => agent.actorId.startsWith("agent:"))
      .map((agent) => {
        const agentId = agent.actorId.slice("agent:".length);
        const configured = this.#config.agents[agentId];
        return {
          actorId: agent.actorId,
          displayName: agent.displayName,
          enabled: configured?.enabled !== false,
          ...(configured?.cwd === undefined ? {} : { cwd: configured.cwd }),
          status: agent.status
        };
      });
    const pairs = this.#store.listSupervisionPairs({ roomId: this.#roomId }).map((pair) => {
      const members = this.#store.listSupervisionPairTurns(pair.pairId);
      const workers = members.filter((member) => member.role === "worker").map((member) => member.actorId);
      const observers = members
        .filter((member) => member.role === "observer")
        .map((member) => member.actorId);
      const steerCount = members
        .filter((member) => member.role === "worker")
        .reduce((total, member) => total + this.#store.getSteerCount(member.turnId), 0);
      return { pairId: pair.pairId, workers, observers, steerCount };
    });
    return {
      agents,
      activeTurns: bootstrap.activeTurns,
      pairs,
      health: health.store.available && health.store.integrityOk ? "ok" : "degraded"
    };
  }

  async contextUsage(
    caller: ToolCallerContext
  ): Promise<import("../memory/types.js").RoomContextUsage> {
    this.#requireOperator(caller);
    return this.#broker.contextUsage(this.#roomId);
  }

  async contextCompact(
    caller: ToolCallerContext,
    input: OperatorContextCompactInput
  ): Promise<import("../memory/types.js").RoomContextCompactionResult> {
    this.#requireOperator(caller);
    return await this.#broker.compactContextFromBinding({
      bindingId: caller.bindingId,
      clientCommandId: input.clientCommandId,
      roomId: this.#roomId
    });
  }

  async contextReset(
    caller: ToolCallerContext,
    input: OperatorContextResetInput
  ): Promise<import("../memory/types.js").RoomContextResetResult> {
    this.#requireOperator(caller);
    return await this.#broker.resetContextFromBinding({
      bindingId: caller.bindingId,
      clientCommandId: input.clientCommandId,
      roomId: this.#roomId,
      ...(input.resetNativeSessions === undefined
        ? {}
        : { resetNativeSessions: input.resetNativeSessions })
    });
  }

  async turnCancel(
    caller: ToolCallerContext,
    input: OperatorTurnCancelInput
  ): Promise<{ turnId: string; accepted: boolean; status: string }> {
    this.#requireOperator(caller);
    return await this.#broker.cancelFromBinding({
      turnId: input.turnId,
      bindingId: caller.bindingId,
      clientCommandId: input.clientCommandId
    });
  }

  async turnsCancel(
    caller: ToolCallerContext,
    input: OperatorTurnsCancelInput
  ): Promise<{ cancelled: Array<{ turnId: string; accepted: boolean; status: string }> }> {
    this.#requireOperator(caller);
    const wanted = input.to === undefined ? undefined : new Set(input.to);
    const turns = this.#store
      .listTurns()
      .filter((turn) => !TERMINAL.has(turn.status))
      .filter((turn) => wanted === undefined || wanted.has(turn.targetActorId));
    const cancelled = [];
    for (const [index, turn] of turns.entries()) {
      cancelled.push(
        await this.#broker.cancelFromBinding({
          turnId: turn.turnId,
          bindingId: caller.bindingId,
          clientCommandId: `${input.clientCommandId}:${index}:${turn.turnId}`
        })
      );
    }
    return { cancelled };
  }

  async agentRestart(
    caller: ToolCallerContext,
    input: OperatorAgentRestartInput
  ): Promise<import("../contracts/rest.js").RestartAgentAccepted> {
    this.#requireOperator(caller);
    return await this.#restartCommands.restart({
      actorId: input.actorId,
      bindingId: caller.bindingId,
      clientCommandId: input.clientCommandId
    });
  }

  async memorySearch(
    caller: ToolCallerContext,
    input: McpMemorySearchInput
  ): Promise<{ items: ReturnType<typeof toMemoryRecordContract>[]; nextCursor?: number }> {
    this.#requireOperator(caller);
    const cursor = input.cursor ?? 0;
    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
    const items = this.#broker
      .queryMemory({
        ...(input.query === undefined ? {} : { text: input.query }),
        ...(input.scope === undefined ? {} : { scopeType: input.scope.type, scopeId: input.scope.id }),
        ...(input.agentMemoryType === undefined ? {} : { agentMemoryType: input.agentMemoryType }),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.subjectActorId === undefined ? {} : { subjectActorId: input.subjectActorId }),
        ...(input.includeHistory === undefined ? {} : { includeHistory: input.includeHistory }),
        cursor,
        limit
      })
      .map(toMemoryRecordContract);
    const next = nextCursor(cursor, limit, items.length);
    return { items, ...(next === undefined ? {} : { nextCursor: next }) };
  }

  async memoryRemember(
    caller: ToolCallerContext,
    input: McpMemoryRememberInput
  ): Promise<{ memory: ReturnType<typeof toMemoryRecordContract> }> {
    this.#requireOperator(caller);
    if (input.scope.type === "agent") {
      throw new GroupXError(
        "INVALID_ENVELOPE",
        "Use agent_core_remember for Agent core memory; dated memory cannot be written"
      );
    }
    const memory = await this.#broker.rememberMemory({
      bindingId: caller.bindingId,
      clientCommandId: input.clientCommandId,
      scopeType: input.scope.type,
      scopeId: input.scope.id,
      kind: input.kind,
      content: input.content,
      ...(input.subjectActorId === undefined ? {} : { subjectActorId: input.subjectActorId }),
      ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
      roomId: this.#roomId
    });
    return { memory: toMemoryRecordContract(memory) };
  }

  async memorySupersede(
    caller: ToolCallerContext,
    input: OperatorMemorySupersedeInput
  ): Promise<{ memory: ReturnType<typeof toMemoryRecordContract> }> {
    this.#requireOperator(caller);
    const previous = this.#store.getMemory(input.memoryId);
    if (previous?.agentMemoryType === "dated") {
      throw new GroupXError("INVALID_ENVELOPE", "Dated memory cannot be rewritten");
    }
    const memory = await this.#broker.supersedeMemory(input.memoryId, {
      bindingId: caller.bindingId,
      clientCommandId: input.clientCommandId,
      content: input.content,
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      roomId: this.#roomId
    });
    return { memory: toMemoryRecordContract(memory) };
  }

  async memoryRetract(
    caller: ToolCallerContext,
    input: OperatorMemoryRetractInput
  ): Promise<{ memory: ReturnType<typeof toMemoryRecordContract> }> {
    this.#requireOperator(caller);
    const memory = await this.#broker.retractMemory(input.memoryId, {
      bindingId: caller.bindingId,
      clientCommandId: input.clientCommandId,
      roomId: this.#roomId
    });
    return { memory: toMemoryRecordContract(memory) };
  }

  async agentCoreRemember(
    caller: ToolCallerContext,
    input: OperatorAgentCoreRememberInput
  ): Promise<{ memory: ReturnType<typeof toMemoryRecordContract> }> {
    this.#requireOperator(caller);
    const memory = await this.#broker.rememberMemory({
      bindingId: caller.bindingId,
      clientCommandId: input.clientCommandId,
      scopeType: "agent",
      scopeId: input.subjectActorId,
      agentMemoryType: "core",
      subjectActorId: input.subjectActorId,
      kind: input.kind,
      content: input.content,
      roomId: this.#roomId
    });
    return { memory: toMemoryRecordContract(memory) };
  }

  async identitySearch(
    caller: ToolCallerContext,
    input: OperatorIdentitySearchInput
  ): Promise<OperatorIdentitySearchResult> {
    this.#requireOperator(caller);
    const cursor = input.cursor ?? 0;
    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
    const items = this.#broker
      .queryIdentity({
        ...(input.subjectActorId === undefined ? {} : { subjectActorId: input.subjectActorId }),
        ...(input.includeHistory === undefined ? {} : { includeHistory: input.includeHistory }),
        cursor,
        limit
      })
      .map(toIdentityRecordContract);
    const next = nextCursor(cursor, limit, items.length);
    return { items, ...(next === undefined ? {} : { nextCursor: next }) };
  }

  async identityRememberFor(
    caller: ToolCallerContext,
    input: OperatorIdentityRememberForInput
  ): Promise<{ identity: ReturnType<typeof toIdentityRecordContract> }> {
    this.#requireOperator(caller);
    const identity = await this.#broker.rememberIdentity({
      bindingId: caller.bindingId,
      clientCommandId: input.clientCommandId,
      subjectActorId: input.subjectActorId,
      kind: input.kind,
      content: input.content,
      roomId: this.#roomId
    });
    return { identity: toIdentityRecordContract(identity) };
  }

  async identitySupersede(
    caller: ToolCallerContext,
    input: OperatorIdentitySupersedeInput
  ): Promise<{ identity: ReturnType<typeof toIdentityRecordContract> }> {
    this.#requireOperator(caller);
    const identity = await this.#broker.supersedeIdentity(input.identityId, {
      bindingId: caller.bindingId,
      clientCommandId: input.clientCommandId,
      content: input.content,
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      roomId: this.#roomId
    });
    return { identity: toIdentityRecordContract(identity) };
  }

  async identityRetract(
    caller: ToolCallerContext,
    input: OperatorIdentityRetractInput
  ): Promise<{ identity: ReturnType<typeof toIdentityRecordContract> }> {
    this.#requireOperator(caller);
    const identity = await this.#broker.retractIdentity(input.identityId, {
      bindingId: caller.bindingId,
      clientCommandId: input.clientCommandId,
      roomId: this.#roomId
    });
    return { identity: toIdentityRecordContract(identity) };
  }

  async setupRead(caller: ToolCallerContext): Promise<SetupSnapshot> {
    this.#requireOperator(caller);
    if (!this.#setupApi) {
      throw new GroupXError("SESSION_NOT_AVAILABLE", "The setup API is not available");
    }
    return await this.#setupApi.snapshot(caller.signal);
  }

  async setupSave(
    caller: ToolCallerContext,
    input: OperatorSetupSaveInput
  ): Promise<SetupSaveResponse> {
    this.#requireOperator(caller);
    if (!this.#setupApi) {
      throw new GroupXError("SESSION_NOT_AVAILABLE", "The setup API is not available");
    }
    return await this.#setupApi.save({ config: input.config }, caller.signal);
  }

  async workerDispatch(
    caller: ToolCallerContext,
    input: OperatorWorkerDispatchInput
  ): Promise<McpSendResult> {
    return await this.#dispatch(caller, input, "worker_dispatch");
  }

  async workerAsk(
    caller: ToolCallerContext,
    input: OperatorWorkerAskInput
  ): Promise<McpAskResult> {
    this.#requireOperator(caller);
    const accepted = await this.#dispatch(caller, input, "worker_ask");
    const waited = await this.#broker.waitForCorrelation({
      correlationId: accepted.correlationId,
      childTurnIds: accepted.turns.map((turn) => turn.turnId),
      roomId: this.#roomId,
      timeoutMs: input.timeoutMs ?? this.#askTimeoutMs,
      signal: caller.signal
    });
    if (waited.state === "aborted") {
      throwIfAborted(caller.signal);
      throw new GroupXError("TURN_INTERRUPTED", "Operator ask was aborted");
    }
    if (waited.state === "timeout" && input.cancelOnTimeout === true) {
      await Promise.allSettled(
        waited.turns
          .filter((turn) => !TERMINAL.has(turn.status))
          .map(async (turn) =>
            this.#broker.cancelFromBinding({
              turnId: turn.turnId,
              bindingId: caller.bindingId,
              clientCommandId: `${input.clientCommandId}:timeout:${turn.turnId}`
            })
          )
      );
    }
    const byTurnId = new Map(waited.turns.map((turn) => [turn.turnId, turn] as const));
    const byEventId = new Map(waited.responseEvents.map((event) => [event.eventId, event] as const));
    return parseMcpAskResult({
      messageEventId: accepted.messageEventId,
      correlationId: accepted.correlationId,
      results: accepted.turns.map((acceptedTurn) => {
        const turn = byTurnId.get(acceptedTurn.turnId);
        if (!turn || (waited.state === "timeout" && !TERMINAL.has(turn.status))) {
          return {
            target: acceptedTurn.target,
            status: "timeout" as const,
            note: `${acceptedTurn.target} is still running; poll read with correlationId "${accepted.correlationId}".`
          };
        }
        if (turn.status === "completed") {
          const responseEventId = turn.responseEventId;
          if (responseEventId === undefined) {
            return { target: acceptedTurn.target, status: "failed" as const, errorCode: "PROTOCOL_INVALID_MESSAGE" };
          }
          return {
            target: acceptedTurn.target,
            status: "completed" as const,
            responseEventId,
            ...(contentFromEventBody(byEventId.get(responseEventId)?.body) === undefined
              ? {}
              : { content: contentFromEventBody(byEventId.get(responseEventId)?.body) })
          };
        }
        if (turn.status === "cancelled") {
          return { target: acceptedTurn.target, status: "cancelled" as const };
        }
        return {
          target: acceptedTurn.target,
          status: "failed" as const,
          ...(turn.errorCode === undefined ? {} : { errorCode: turn.errorCode })
        };
      })
    });
  }

  async dispatchEvent(
    caller: ToolCallerContext,
    input: OperatorDispatchEventInput
  ): Promise<McpSendResult> {
    this.#requireOperator(caller);
    this.#assertSupervision(input.to, input.supervision?.observers);
    const source = this.#store.getEvent(input.sourceEventId);
    if (!source) {
      throw new GroupXError("UNKNOWN_TARGET", "The source event does not exist");
    }
    const content = contentFromEventBody(source.body);
    if (content === undefined) {
      throw new GroupXError("INVALID_ENVELOPE", "The source event has no text content");
    }
    const accepted = await this.#broker.acceptMessage({
      bindingId: caller.bindingId,
      request: {
        clientCommandId: input.clientCommandId,
        to: input.to,
        content,
        ...(input.supervision === undefined ? {} : { supervision: input.supervision })
      },
      roomId: this.#roomId,
      commandType: "operator.dispatch_event",
      sourceEventType: "message.created",
      operation: "dispatch_event",
      existingSourceEventId: input.sourceEventId
    });
    return parseMcpSendResult({
      messageEventId: accepted.messageEventId,
      correlationId: accepted.correlationId,
      turns: accepted.turns.map((turn) => ({
        target: turn.target,
        turnId: turn.turnId,
        status: turn.status
      }))
    });
  }

  async supervisionStatus(
    caller: ToolCallerContext,
    input: OperatorSupervisionStatusInput
  ): Promise<ReturnType<GroupXBroker["supervisionStatus"]>> {
    this.#requireOperator(caller);
    return this.#broker.supervisionStatus({
      ...(input.pairId === undefined ? {} : { pairId: input.pairId }),
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId })
    });
  }

  async #dispatch(
    caller: ToolCallerContext,
    input: OperatorWorkerDispatchInput,
    operation: "worker_dispatch" | "worker_ask"
  ): Promise<McpSendResult> {
    this.#requireOperator(caller);
    this.#assertSupervision(input.to, input.supervision?.observers);
    const accepted = await this.#broker.acceptMessage({
      bindingId: caller.bindingId,
      request: {
        clientCommandId: input.clientCommandId,
        to: input.to,
        content: input.content,
        ...(input.supervision === undefined ? {} : { supervision: input.supervision })
      },
      roomId: this.#roomId,
      commandType: `operator.${operation}`,
      sourceEventType: "operator.dispatch",
      operation
    });
    return parseMcpSendResult({
      messageEventId: accepted.messageEventId,
      correlationId: accepted.correlationId,
      turns: accepted.turns.map((turn) => ({
        target: turn.target,
        turnId: turn.turnId,
        status: turn.status
      }))
    });
  }

  #requireOperator(caller: ToolCallerContext): void {
    throwIfAborted(caller.signal);
    if (caller.bindingId !== this.#bindingId || caller.actorId !== ASSISTANT_ACTOR_ID) {
      throw new GroupXError(
        "MCP_BINDING_MISMATCH",
        "Operator tools are only available on the local-operator assistant binding"
      );
    }
  }

  #assertSupervision(workers: readonly string[], observers: readonly string[] | undefined): void {
    if (observers === undefined) return;
    for (const observer of observers) {
      if (!observer.startsWith("agent:") || observer === ASSISTANT_ACTOR_ID) {
        throw new GroupXError(
          "SUPERVISION_PAIR_INVALID",
          "A supervision observer must be an enabled room Agent",
          { actorId: observer }
        );
      }
      const agentId = observer.slice("agent:".length);
      if (this.#config.agents[agentId]?.enabled !== true) {
        throw new GroupXError(
          "SUPERVISION_PAIR_INVALID",
          "A supervision observer must be enabled",
          { actorId: observer }
        );
      }
    }
    void workers;
  }
}
