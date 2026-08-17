import type {
  McpAskInput,
  McpAskResult,
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
  McpReadInput,
  McpReadResult,
  McpSendInput,
  McpSendResult
} from "../contracts/mcp.js";
import {
  parseMcpReadResult,
  parseMcpSendResult
} from "../contracts/mcp.js";
import { GroupXBroker } from "../broker/broker.js";
import { GroupXError } from "../core/errors.js";
import type {
  ToolBrokerApi,
  ToolCallerContext
} from "../mcp/server/broker-api.js";
import type { TurnRecord } from "../storage/types.js";
import {
  toIdentityRecordContract,
  toMemoryRecordContract
} from "./record-mappers.js";
import { ActiveTurnCoordinator } from "./turn-lifecycle.js";

const DEFAULT_PAGE_LIMIT = 100;

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
    | "waitForCorrelation"
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
    this.#askTimeoutMs = options.askTimeoutMs ?? 120_000;
    if (!Number.isSafeInteger(this.#askTimeoutMs) || this.#askTimeoutMs < 1) {
      throw new RangeError("askTimeoutMs must be a positive integer");
    }
  }

  async send(caller: ToolCallerContext, input: McpSendInput): Promise<McpSendResult> {
    throwIfAborted(caller.signal);
    const active = this.#turns.requireForCaller(caller);
    const accepted = await this.#broker.acceptMessage({
      bindingId: caller.bindingId,
      request: {
        clientCommandId: input.clientCommandId,
        to: input.to,
        content: input.content,
        ...(input.replyToEventId === undefined
          ? {}
          : { replyToEventId: input.replyToEventId })
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
        status: turn.status
      }))
    });
  }

  async ask(caller: ToolCallerContext, input: McpAskInput): Promise<McpAskResult> {
    throwIfAborted(caller.signal);
    const active = this.#turns.requireForCaller(caller);
    const accepted = await this.#broker.acceptMessage({
      bindingId: caller.bindingId,
      request: {
        clientCommandId: input.clientCommandId,
        to: input.to,
        content: input.content,
        ...(input.replyToEventId === undefined
          ? {}
          : { replyToEventId: input.replyToEventId })
      },
      roomId: this.#roomId,
      commandType: "mcp.ask",
      causationId: active.turnId,
      correlationId: active.rootCorrelationId,
      parentTurnId: active.turnId,
      hopCount: active.hopCount + 1
    });
    const childTurnIds = accepted.turns.map((turn) => turn.turnId);
    const waited = await this.#broker.waitForCorrelation({
      correlationId: accepted.correlationId,
      childTurnIds,
      roomId: this.#roomId,
      timeoutMs: input.timeoutMs ?? this.#askTimeoutMs,
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

    const byTurnId = new Map(waited.turns.map((turn) => [turn.turnId, turn] as const));
    const byEventId = new Map(
      waited.responseEvents.map((event) => [event.eventId, event] as const)
    );
    return {
      messageEventId: accepted.messageEventId,
      correlationId: accepted.correlationId,
      results: accepted.turns.map((acceptedTurn) => {
        const turn = byTurnId.get(acceptedTurn.turnId);
        if (!turn || (waited.state === "timeout" && !isTerminal(turn))) {
          return {
            target: acceptedTurn.target,
            status: "timeout" as const,
            note:
              `${acceptedTurn.target} is still running; the timeout only stopped this wait. ` +
              `Nothing delivers the answer to you automatically after your turn ends. ` +
              `Poll groupx read with correlationId "${accepted.correlationId}" until this ` +
              `target's turn is terminal, or hand off explicitly with groupx send before finishing.`
          };
        }
        if (turn.status === "completed") {
          const responseEventId = turn.responseEventId;
          if (responseEventId === undefined) {
            return {
              target: acceptedTurn.target,
              status: "failed" as const,
              errorCode: "PROTOCOL_INVALID_MESSAGE"
            };
          }
          const content = contentFromEventBody(byEventId.get(responseEventId)?.body);
          return {
            target: acceptedTurn.target,
            status: "completed" as const,
            responseEventId,
            ...(content === undefined ? {} : { content })
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
    };
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
}

function isTerminal(turn: TurnRecord): boolean {
  return (
    turn.status === "completed" ||
    turn.status === "failed" ||
    turn.status === "cancelled" ||
    turn.status === "interrupted"
  );
}
