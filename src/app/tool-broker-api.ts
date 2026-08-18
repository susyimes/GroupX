import type {
  McpAskInput,
  McpAskResult,
  McpCollectInput,
  McpCollectResult,
  McpCoreMemoryRememberInput,
  McpCoreMemoryRememberResult,
  McpIdentityReadInput,
  McpIdentityReadResult,
  McpIdentityRememberInput,
  McpIdentityRememberResult,
  McpMemoryRememberInput,
  McpMemoryRememberResult,
  McpMemorySearchInput,
  McpMemorySearchResult,
  McpPublishInput,
  McpPublishResult,
  McpReadInput,
  McpReadResult,
  McpSendInput,
  McpSendResult,
  McpSteerInput,
  McpSteerResult,
  McpWatchInput,
  McpWatchResult
} from "../contracts/mcp.js";
import {
  parseMcpAskResult,
  parseMcpCollectResult,
  parseMcpPublishResult,
  parseMcpReadResult,
  parseMcpSendResult,
  parseMcpSteerResult,
  parseMcpWatchResult
} from "../contracts/mcp.js";
import { GroupXBroker } from "../broker/broker.js";
import type { CorrelationWaitResult, TurnQueueSnapshot } from "../broker/types.js";
import { GroupXError } from "../core/errors.js";
import type {
  ToolBrokerApi,
  ToolCallerContext
} from "../mcp/server/broker-api.js";
import type { AcceptedTurnResult, TurnRecord } from "../storage/types.js";
import {
  toIdentityRecordContract,
  toMemoryRecordContract
} from "./record-mappers.js";
import { ActiveTurnCoordinator } from "./turn-lifecycle.js";

const DEFAULT_PAGE_LIMIT = 100;
const MAX_MCP_WAIT_MS = 60_000;

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

export interface GroupXToolBrokerApiOptions {
  broker: Pick<
    GroupXBroker,
    | "acceptMessage"
    | "assertObserverRouting"
    | "watchSubject"
    | "steerSubject"
    | "waitForCorrelation"
    | "inspectTurnQueue"
    | "cancelTurn"
    | "readCorrelation"
    | "queryMemory"
    | "rememberMemory"
    | "queryIdentity"
    | "rememberIdentity"
  >;
  turns: Pick<ActiveTurnCoordinator, "requireForCaller">;
  roomId: string;
  askTimeoutMs?: number;
}

/** Product ToolBrokerApi backed exclusively by the authoritative Broker. */
export class GroupXToolBrokerApi implements ToolBrokerApi {
  readonly #broker: GroupXToolBrokerApiOptions["broker"];
  readonly #turns: GroupXToolBrokerApiOptions["turns"];
  readonly #roomId: string;
  readonly #askTimeoutMs: number;

  constructor(options: GroupXToolBrokerApiOptions) {
    this.#broker = options.broker;
    this.#turns = options.turns;
    this.#roomId = options.roomId;
    const configuredAskTimeoutMs = options.askTimeoutMs ?? MAX_MCP_WAIT_MS;
    if (!Number.isSafeInteger(configuredAskTimeoutMs) || configuredAskTimeoutMs < 1) {
      throw new RangeError("askTimeoutMs must be a positive integer");
    }
    this.#askTimeoutMs = Math.min(configuredAskTimeoutMs, MAX_MCP_WAIT_MS);
  }

  async send(caller: ToolCallerContext, input: McpSendInput): Promise<McpSendResult> {
    throwIfAborted(caller.signal);
    const active = this.#turns.requireForCaller(caller);
    this.#assertSupervision(caller.actorId, input.to, input.supervision?.observers);
    this.#broker.assertObserverRouting(active.turnId, input.to);
    const accepted = await this.#broker.acceptMessage({
      bindingId: caller.bindingId,
      request: {
        clientCommandId: input.clientCommandId,
        to: input.to,
        content: input.content,
        replyToEventId: input.replyToEventId ?? active.sourceEventId,
        ...(input.supervision === undefined ? {} : { supervision: input.supervision })
      },
      roomId: this.#roomId,
      commandType: "mcp.send",
      causationId: active.turnId,
      correlationId: active.rootCorrelationId,
      parentTurnId: active.turnId,
      hopCount: active.hopCount + 1
    });
    return parseMcpSendResult({
      messageEventId: accepted.messageEventId,
      correlationId: accepted.correlationId,
      turns: accepted.turns.map((turn) => ({
        target: turn.target,
        turnId: turn.turnId,
        status: turn.status,
        ...this.#queueFields(this.#broker.inspectTurnQueue(turn.turnId))
      }))
    });
  }

  async publish(caller: ToolCallerContext, input: McpPublishInput): Promise<McpPublishResult> {
    throwIfAborted(caller.signal);
    const active = this.#turns.requireForCaller(caller);
    const accepted = await this.#broker.acceptMessage({
      bindingId: caller.bindingId,
      request: {
        clientCommandId: input.clientCommandId,
        to: [],
        content: input.content,
        replyToEventId: input.replyToEventId ?? active.sourceEventId
      },
      roomId: this.#roomId,
      commandType: "mcp.publish",
      causationId: active.turnId,
      correlationId: active.rootCorrelationId
    });
    return parseMcpPublishResult({
      messageEventId: accepted.messageEventId,
      correlationId: accepted.correlationId
    });
  }

  async ask(caller: ToolCallerContext, input: McpAskInput): Promise<McpAskResult> {
    throwIfAborted(caller.signal);
    const active = this.#turns.requireForCaller(caller);
    this.#assertSupervision(caller.actorId, input.to, input.supervision?.observers);
    this.#broker.assertObserverRouting(active.turnId, input.to);
    const accepted = await this.#broker.acceptMessage({
      bindingId: caller.bindingId,
      request: {
        clientCommandId: input.clientCommandId,
        to: input.to,
        content: input.content,
        replyToEventId: input.replyToEventId ?? active.sourceEventId,
        ...(input.supervision === undefined ? {} : { supervision: input.supervision })
      },
      roomId: this.#roomId,
      commandType: "mcp.ask",
      causationId: active.turnId,
      correlationId: active.rootCorrelationId,
      parentTurnId: active.turnId,
      hopCount: active.hopCount + 1
    });
    const initialQueues = new Map(
      accepted.turns.map((turn) => [turn.turnId, this.#broker.inspectTurnQueue(turn.turnId)] as const)
    );
    if ([...initialQueues.values()].some((queue) => queue.queuePosition > 0)) {
      return this.#pendingResult(accepted.messageEventId, accepted.correlationId, accepted.turns, initialQueues);
    }
    const childTurnIds = accepted.turns.map((turn) => turn.turnId);
    const waited = await this.#broker.waitForCorrelation({
      correlationId: accepted.correlationId,
      childTurnIds,
      roomId: this.#roomId,
      timeoutMs: Math.min(input.timeoutMs ?? this.#askTimeoutMs, MAX_MCP_WAIT_MS),
      signal: caller.signal
    });
    if (waited.state === "aborted") {
      throwIfAborted(caller.signal);
      throw new GroupXError("TURN_INTERRUPTED", "GroupX ask was aborted");
    }
    if (waited.state === "timeout" && input.cancelOnTimeout === true) {
      await Promise.allSettled(
        waited.turns
          .filter((turn) => !isTerminal(turn))
          .map(async (turn) => await this.#broker.cancelTurn(turn.turnId))
      );
    }

    return this.#resultFromWait(
      accepted.messageEventId,
      accepted.correlationId,
      accepted.turns,
      waited
    );
  }

  async collect(caller: ToolCallerContext, input: McpCollectInput): Promise<McpCollectResult> {
    throwIfAborted(caller.signal);
    const active = this.#turns.requireForCaller(caller);
    const exact = {
      correlationId: active.rootCorrelationId,
      sourceEventId: input.messageEventId,
      roomId: this.#roomId,
      signal: caller.signal
    } as const;
    const snapshot = await this.#broker.waitForCorrelation({ ...exact, timeoutMs: 1 });
    if (snapshot.state === "aborted") {
      throwIfAborted(caller.signal);
      throw new GroupXError("TURN_INTERRUPTED", "GroupX collect was aborted");
    }
    const accepted = snapshot.turns.map((turn) => ({
      target: turn.targetActorId,
      turnId: turn.turnId,
      status: "queued" as const
    }));
    const queues = new Map(
      accepted.map((turn) => [turn.turnId, this.#broker.inspectTurnQueue(turn.turnId)] as const)
    );
    if (
      snapshot.state === "terminal" ||
      [...queues.values()].some((queue) => queue.queuePosition > 0)
    ) {
      return parseMcpCollectResult(
        this.#resultFromWait(
          input.messageEventId,
          active.rootCorrelationId,
          accepted,
          snapshot
        )
      );
    }
    const waited = await this.#broker.waitForCorrelation({
      ...exact,
      timeoutMs: Math.min(input.timeoutMs ?? this.#askTimeoutMs, MAX_MCP_WAIT_MS)
    });
    if (waited.state === "aborted") {
      throwIfAborted(caller.signal);
      throw new GroupXError("TURN_INTERRUPTED", "GroupX collect was aborted");
    }
    return parseMcpCollectResult(
      this.#resultFromWait(
        input.messageEventId,
        active.rootCorrelationId,
        accepted,
        waited
      )
    );
  }

  async watch(caller: ToolCallerContext, input: McpWatchInput): Promise<McpWatchResult> {
    throwIfAborted(caller.signal);
    const active = this.#turns.requireForCaller(caller);
    return parseMcpWatchResult(
      await this.#broker.watchSubject({
        watchTurnId: active.turnId,
        ...(input.subjectTurnId === undefined ? {} : { subjectTurnId: input.subjectTurnId }),
        ...(input.afterSeq === undefined ? {} : { afterSeq: input.afterSeq }),
        until: input.until,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        signal: caller.signal
      })
    );
  }

  async steer(caller: ToolCallerContext, input: McpSteerInput): Promise<McpSteerResult> {
    throwIfAborted(caller.signal);
    const active = this.#turns.requireForCaller(caller);
    return parseMcpSteerResult(
      await this.#broker.steerSubject({
        bindingId: caller.bindingId,
        watchTurnId: active.turnId,
        ...(input.subjectTurnId === undefined ? {} : { subjectTurnId: input.subjectTurnId }),
        action: input.action,
        reason: input.reason,
        content: input.content,
        clientCommandId: input.clientCommandId
      })
    );
  }

  async read(caller: ToolCallerContext, input: McpReadInput): Promise<McpReadResult> {
    throwIfAborted(caller.signal);
    const active = this.#turns.requireForCaller(caller);
    return parseMcpReadResult(this.#broker.readCorrelation({
      correlationId: input.correlationId ?? active.rootCorrelationId,
      roomId: this.#roomId,
      ...(input.afterSeq === undefined ? {} : { afterSeq: input.afterSeq }),
      ...(input.limit === undefined ? {} : { limit: input.limit })
    }));
  }

  async memorySearch(
    caller: ToolCallerContext,
    input: McpMemorySearchInput
  ): Promise<McpMemorySearchResult> {
    throwIfAborted(caller.signal);
    this.#turns.requireForCaller(caller);
    const cursor = input.cursor ?? 0;
    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
    const items = this.#broker.queryMemory({
      ...(input.query === undefined ? {} : { text: input.query }),
      ...(input.scope === undefined
        ? {}
        : { scopeType: input.scope.type, scopeId: input.scope.id }),
      ...(input.agentMemoryType === undefined
        ? {}
        : { agentMemoryType: input.agentMemoryType }),
      ...(input.kind === undefined ? {} : { kind: input.kind }),
      ...(input.subjectActorId === undefined
        ? {}
        : { subjectActorId: input.subjectActorId }),
      ...(input.includeHistory === undefined
        ? {}
        : { includeHistory: input.includeHistory }),
      cursor,
      limit
    }).map(toMemoryRecordContract);
    const next = nextCursor(cursor, limit, items.length);
    return { items, ...(next === undefined ? {} : { nextCursor: next }) };
  }

  async memoryRemember(
    caller: ToolCallerContext,
    input: McpMemoryRememberInput
  ): Promise<McpMemoryRememberResult> {
    throwIfAborted(caller.signal);
    const active = this.#turns.requireForCaller(caller);
    const memory = await this.#broker.rememberMemory({
      bindingId: caller.bindingId,
      clientCommandId: input.clientCommandId,
      scopeType: input.scope.type,
      scopeId: input.scope.id,
      kind: input.kind,
      content: input.content,
      ...(input.subjectActorId === undefined
        ? {}
        : { subjectActorId: input.subjectActorId }),
      ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
      roomId: this.#roomId,
      correlationId: active.rootCorrelationId
    });
    return { memory: toMemoryRecordContract(memory) };
  }

  async coreMemoryRemember(
    caller: ToolCallerContext,
    input: McpCoreMemoryRememberInput
  ): Promise<McpCoreMemoryRememberResult> {
    throwIfAborted(caller.signal);
    const active = this.#turns.requireForCaller(caller);
    const memory = await this.#broker.rememberMemory({
      bindingId: caller.bindingId,
      clientCommandId: input.clientCommandId,
      scopeType: "agent",
      scopeId: caller.actorId,
      agentMemoryType: "core",
      subjectActorId: caller.actorId,
      kind: input.kind,
      content: input.content,
      ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
      roomId: this.#roomId,
      correlationId: active.rootCorrelationId
    });
    return { memory: toMemoryRecordContract(memory) };
  }

  async identityRead(
    caller: ToolCallerContext,
    input: McpIdentityReadInput
  ): Promise<McpIdentityReadResult> {
    throwIfAborted(caller.signal);
    this.#turns.requireForCaller(caller);
    const cursor = input.cursor ?? 0;
    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
    const items = this.#broker.queryIdentity({
      subjectActorId: caller.actorId,
      ...(input.includeHistory === undefined
        ? {}
        : { includeHistory: input.includeHistory }),
      cursor,
      limit
    }).map(toIdentityRecordContract);
    const next = nextCursor(cursor, limit, items.length);
    return { items, ...(next === undefined ? {} : { nextCursor: next }) };
  }

  async identityRemember(
    caller: ToolCallerContext,
    input: McpIdentityRememberInput
  ): Promise<McpIdentityRememberResult> {
    throwIfAborted(caller.signal);
    const active = this.#turns.requireForCaller(caller);
    const identity = await this.#broker.rememberIdentity({
      bindingId: caller.bindingId,
      clientCommandId: input.clientCommandId,
      subjectActorId: caller.actorId,
      kind: input.kind,
      content: input.content,
      ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
      roomId: this.#roomId,
      correlationId: active.rootCorrelationId
    });
    return { identity: toIdentityRecordContract(identity) };
  }

  #queueFields(queue: TurnQueueSnapshot): {
    queuePosition: number;
    activeTurnId?: string;
  } {
    return {
      queuePosition: queue.queuePosition,
      ...(queue.activeTurnId === undefined ? {} : { activeTurnId: queue.activeTurnId })
    };
  }

  #pendingResult(
    messageEventId: string,
    correlationId: string,
    turns: readonly AcceptedTurnResult[],
    queues = new Map<string, TurnQueueSnapshot>()
  ): McpAskResult {
    return parseMcpAskResult({
      messageEventId,
      correlationId,
      state: "pending",
      results: turns.map((turn) => {
        const queue = queues.get(turn.turnId) ?? this.#broker.inspectTurnQueue(turn.turnId);
        return {
          target: turn.target,
          turnId: turn.turnId,
          status: "pending" as const,
          ...this.#queueFields(queue),
          note:
            `${turn.target} is queued or still running. Collect this exact request with ` +
            `messageEventId "${messageEventId}"; do not send the same question again.`
        };
      })
    });
  }

  #resultFromWait(
    messageEventId: string,
    correlationId: string,
    acceptedTurns: readonly AcceptedTurnResult[],
    waited: CorrelationWaitResult
  ): McpAskResult {
    const byTurnId = new Map(waited.turns.map((turn) => [turn.turnId, turn] as const));
    const byEventId = new Map(
      waited.responseEvents.map((event) => [event.eventId, event] as const)
    );
    const results = acceptedTurns.map((acceptedTurn) => {
      const queue = this.#broker.inspectTurnQueue(acceptedTurn.turnId);
      const queueFields = this.#queueFields(queue);
      const turn = byTurnId.get(acceptedTurn.turnId);
      if (!turn || !isTerminal(turn)) {
        return {
          target: acceptedTurn.target,
          turnId: acceptedTurn.turnId,
          status: "pending" as const,
          ...queueFields,
          note:
            `${acceptedTurn.target} is queued or still running. Collect this exact request with ` +
            `messageEventId "${messageEventId}"; do not send the same question again.`
        };
      }
      if (turn.status === "completed") {
        const responseEventId = turn.responseEventId;
        if (responseEventId === undefined) {
          return {
            target: acceptedTurn.target,
            turnId: acceptedTurn.turnId,
            status: "failed" as const,
            ...queueFields,
            errorCode: "PROTOCOL_INVALID_MESSAGE"
          };
        }
        const content = contentFromEventBody(byEventId.get(responseEventId)?.body);
        return {
          target: acceptedTurn.target,
          turnId: acceptedTurn.turnId,
          status: "completed" as const,
          ...queueFields,
          responseEventId,
          ...(content === undefined ? {} : { content })
        };
      }
      if (turn.status === "cancelled") {
        return {
          target: acceptedTurn.target,
          turnId: acceptedTurn.turnId,
          status: "cancelled" as const,
          ...queueFields
        };
      }
      return {
        target: acceptedTurn.target,
        turnId: acceptedTurn.turnId,
        status: "failed" as const,
        ...queueFields,
        ...(turn.errorCode === undefined ? {} : { errorCode: turn.errorCode })
      };
    });
    return parseMcpAskResult({
      messageEventId,
      correlationId,
      state: results.some((result) => result.status === "pending") ? "pending" : "terminal",
      results
    });
  }

  #assertSupervision(
    callerActorId: string,
    workers: readonly string[],
    observers: readonly string[] | undefined
  ): void {
    if (observers === undefined) return;
    if (observers.includes(callerActorId)) {
      throw new GroupXError(
        "SUPERVISION_PAIR_INVALID",
        "The calling Agent cannot be a supervision observer on its own send or ask"
      );
    }
    void workers;
  }
}

function isTerminal(turn: TurnRecord): boolean {
  return (
    turn.status === "completed" ||
    turn.status === "failed" ||
    turn.status === "cancelled" ||
    turn.status === "interrupted"
  );
}
