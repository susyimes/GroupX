import type { GroupXBroker } from "../broker/broker.js";
import type {
  BootstrapResponse,
  CancelTurnRequest,
  CancelTurnResult,
  CreateMessageAccepted,
  CreateMessageRequest,
  IdentityQuery,
  RememberIdentityRequest,
  RememberMemoryRequest,
  RestartAgentAccepted,
  RestartAgentRequest,
  RetractIdentityRequest,
  RetractMemoryRequest,
  SupersedeIdentityRequest,
  SupersedeMemoryRequest,
  MemoryQuery
} from "../contracts/rest.js";
import {
  parseBootstrapResponse,
  parseCancelTurnResult,
  parseCreateMessageAccepted
} from "../contracts/rest.js";
import { TRANSPORT_LIFECYCLE, type GroupXConfig } from "../config.js";
import type { BrokerApi, BrokerHealth, IdentityMutationAccepted, IdentityPage, MemoryMutationAccepted, MemoryPage } from "../web/server/types.js";
import {
  toIdentityRecordContract,
  toMemoryRecordContract
} from "./record-mappers.js";
import type { RuntimeReadiness } from "./readiness.js";
import type { RestartAgentCommandCoordinator } from "./restart-commands.js";

const DEFAULT_PAGE_LIMIT = 100;

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function nextCursor(cursor: number, limit: number, count: number): number | undefined {
  return count === limit ? cursor + count : undefined;
}

type WebBrokerSurface = Pick<
  GroupXBroker,
  | "health"
  | "bootstrap"
  | "acceptMessage"
  | "cancelFromBinding"
  | "queryMemory"
  | "queryIdentity"
  | "rememberMemory"
  | "rememberIdentity"
  | "supersedeMemory"
  | "retractMemory"
  | "supersedeIdentity"
  | "retractIdentity"
>;

export interface GroupXWebBrokerApiOptions {
  broker: WebBrokerSurface;
  restartCommands: Pick<RestartAgentCommandCoordinator, "restart">;
  readiness: Pick<RuntimeReadiness, "state" | "isReady" | "requireReady">;
  config: Pick<GroupXConfig, "transport" | "agents">;
  roomId: string;
  bindingId: string;
}

/** REST facade: all writes use one persisted local-rest binding. */
export class GroupXWebBrokerApi implements BrokerApi {
  readonly roomId: string;
  readonly #broker: WebBrokerSurface;
  readonly #restartCommands: GroupXWebBrokerApiOptions["restartCommands"];
  readonly #readiness: GroupXWebBrokerApiOptions["readiness"];
  readonly #config: GroupXWebBrokerApiOptions["config"];
  readonly #bindingId: string;

  constructor(options: GroupXWebBrokerApiOptions) {
    this.#broker = options.broker;
    this.#restartCommands = options.restartCommands;
    this.#readiness = options.readiness;
    this.#config = options.config;
    this.roomId = options.roomId;
    this.#bindingId = options.bindingId;
  }

  health(signal: AbortSignal): BrokerHealth {
    throwIfAborted(signal);
    const broker = this.#broker.health();
    return {
      status:
        this.#readiness.isReady && broker.store.available && broker.store.integrityOk
          ? "ok"
          : "degraded",
      readiness: this.#readiness.state,
      transport: this.#config.transport,
      transportLifecycle: TRANSPORT_LIFECYCLE[this.#config.transport],
      access: "unrestricted",
      ...broker
    };
  }

  bootstrap(signal: AbortSignal): BootstrapResponse {
    throwIfAborted(signal);
    const bootstrap = this.#broker.bootstrap({ roomId: this.roomId });
    return parseBootstrapResponse({
      ...bootstrap,
      agents: bootstrap.agents.map((agent) => {
        const agentId = agent.actorId.slice("agent:".length) as keyof GroupXConfig["agents"];
        const configured = this.#config.agents[agentId];
        return {
          ...agent,
          ...(configured === undefined
            ? {}
            : {
                cwd: configured.cwd,
                enabled: configured.enabled,
                capabilities: {
                  transport: this.#config.transport,
                  transportLifecycle: TRANSPORT_LIFECYCLE[this.#config.transport],
                  access: "unrestricted",
                  currentTurnMcp: this.#config.transport === "structured"
                }
              })
        };
      })
    });
  }

  async createMessage(
    request: CreateMessageRequest,
    signal: AbortSignal
  ): Promise<CreateMessageAccepted> {
    throwIfAborted(signal);
    this.#readiness.requireReady();
    const accepted = await this.#broker.acceptMessage({
      bindingId: this.#bindingId,
      request: {
        clientCommandId: request.clientCommandId,
        to: request.to,
        content: request.content,
        ...(request.replyToEventId === undefined
          ? {}
          : { replyToEventId: request.replyToEventId })
      },
      roomId: this.roomId,
      commandType: "message.send"
    });
    return parseCreateMessageAccepted({
      messageEventId: accepted.messageEventId,
      correlationId: accepted.correlationId,
      turns: accepted.turns.map((turn) => ({
        target: turn.target,
        turnId: turn.turnId,
        status: turn.status
      }))
    });
  }

  async cancelTurn(
    turnId: string,
    request: CancelTurnRequest,
    signal: AbortSignal
  ): Promise<CancelTurnResult> {
    throwIfAborted(signal);
    this.#readiness.requireReady();
    const result = await this.#broker.cancelFromBinding({
      turnId,
      bindingId: this.#bindingId,
      clientCommandId: request.clientCommandId
    });
    return parseCancelTurnResult({
      turnId: result.turnId,
      accepted: result.accepted,
      status: result.status
    });
  }

  queryMemory(query: MemoryQuery, signal: AbortSignal): MemoryPage {
    throwIfAborted(signal);
    const cursor = query.cursor ?? 0;
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    const items = this.#broker.queryMemory({
      ...(query.scopeType === undefined ? {} : { scopeType: query.scopeType }),
      ...(query.scopeId === undefined ? {} : { scopeId: query.scopeId }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.authorActorId === undefined ? {} : { authorActorId: query.authorActorId }),
      ...(query.subjectActorId === undefined ? {} : { subjectActorId: query.subjectActorId }),
      ...(query.includeHistory === undefined ? {} : { includeHistory: query.includeHistory }),
      cursor,
      limit
    }).map(toMemoryRecordContract);
    const next = nextCursor(cursor, limit, items.length);
    return { items, ...(next === undefined ? {} : { nextCursor: next }) };
  }

  queryIdentity(query: IdentityQuery, signal: AbortSignal): IdentityPage {
    throwIfAborted(signal);
    const cursor = query.cursor ?? 0;
    const limit = query.limit ?? DEFAULT_PAGE_LIMIT;
    const items = this.#broker.queryIdentity({
      ...(query.subjectActorId === undefined ? {} : { subjectActorId: query.subjectActorId }),
      ...(query.authorActorId === undefined ? {} : { authorActorId: query.authorActorId }),
      ...(query.kind === undefined ? {} : { kind: query.kind }),
      ...(query.includeHistory === undefined ? {} : { includeHistory: query.includeHistory }),
      cursor,
      limit
    }).map(toIdentityRecordContract);
    const next = nextCursor(cursor, limit, items.length);
    return { items, ...(next === undefined ? {} : { nextCursor: next }) };
  }

  async rememberMemory(
    request: RememberMemoryRequest,
    signal: AbortSignal
  ): Promise<MemoryMutationAccepted> {
    this.#requireWritable(signal);
    const record = await this.#broker.rememberMemory({
      bindingId: this.#bindingId,
      clientCommandId: request.clientCommandId,
      scopeType: request.scope.type,
      scopeId: request.scope.id,
      kind: request.kind,
      content: request.content,
      ...(request.subjectActorId === undefined ? {} : { subjectActorId: request.subjectActorId }),
      ...(request.sourceEventId === undefined ? {} : { sourceEventId: request.sourceEventId }),
      roomId: this.roomId
    });
    return { memory: toMemoryRecordContract(record) };
  }

  async supersedeMemory(
    memoryId: string,
    request: SupersedeMemoryRequest,
    signal: AbortSignal
  ): Promise<MemoryMutationAccepted> {
    this.#requireWritable(signal);
    const record = await this.#broker.supersedeMemory(memoryId, {
      bindingId: this.#bindingId,
      clientCommandId: request.clientCommandId,
      content: request.content,
      ...(request.kind === undefined ? {} : { kind: request.kind }),
      ...(request.sourceEventId === undefined ? {} : { sourceEventId: request.sourceEventId }),
      roomId: this.roomId
    });
    return { memory: toMemoryRecordContract(record) };
  }

  async retractMemory(
    memoryId: string,
    request: RetractMemoryRequest,
    signal: AbortSignal
  ): Promise<MemoryMutationAccepted> {
    this.#requireWritable(signal);
    const record = await this.#broker.retractMemory(memoryId, {
      bindingId: this.#bindingId,
      clientCommandId: request.clientCommandId,
      roomId: this.roomId
    });
    return { memory: toMemoryRecordContract(record) };
  }

  async rememberIdentity(
    request: RememberIdentityRequest,
    signal: AbortSignal
  ): Promise<IdentityMutationAccepted> {
    this.#requireWritable(signal);
    const record = await this.#broker.rememberIdentity({
      bindingId: this.#bindingId,
      clientCommandId: request.clientCommandId,
      subjectActorId: request.subjectActorId,
      kind: request.kind,
      content: request.content,
      ...(request.sourceEventId === undefined ? {} : { sourceEventId: request.sourceEventId }),
      roomId: this.roomId
    });
    return { identity: toIdentityRecordContract(record) };
  }

  async supersedeIdentity(
    identityId: string,
    request: SupersedeIdentityRequest,
    signal: AbortSignal
  ): Promise<IdentityMutationAccepted> {
    this.#requireWritable(signal);
    const record = await this.#broker.supersedeIdentity(identityId, {
      bindingId: this.#bindingId,
      clientCommandId: request.clientCommandId,
      content: request.content,
      ...(request.kind === undefined ? {} : { kind: request.kind }),
      ...(request.sourceEventId === undefined ? {} : { sourceEventId: request.sourceEventId }),
      roomId: this.roomId
    });
    return { identity: toIdentityRecordContract(record) };
  }

  async retractIdentity(
    identityId: string,
    request: RetractIdentityRequest,
    signal: AbortSignal
  ): Promise<IdentityMutationAccepted> {
    this.#requireWritable(signal);
    const record = await this.#broker.retractIdentity(identityId, {
      bindingId: this.#bindingId,
      clientCommandId: request.clientCommandId,
      roomId: this.roomId
    });
    return { identity: toIdentityRecordContract(record) };
  }

  async restartAgent(
    actorId: string,
    request: RestartAgentRequest,
    signal: AbortSignal
  ): Promise<RestartAgentAccepted> {
    this.#requireWritable(signal);
    return await this.#restartCommands.restart({
      actorId,
      bindingId: this.#bindingId,
      clientCommandId: request.clientCommandId
    });
  }

  #requireWritable(signal: AbortSignal): void {
    throwIfAborted(signal);
    this.#readiness.requireReady();
  }
}
