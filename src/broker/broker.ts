import type {
  CancelResult,
  CliAdapter,
  NativeEvent,
  NativeSession
} from "../adapters/types.js";
import { AdapterRegistry } from "../adapters/registry.js";
import {
  asTransientEnvelope,
  BUILTIN_ACTORS,
  createId,
  DEFAULT_ROOM_ID,
  GROUPX_SCHEMA,
  type GroupXEnvelope,
  type GroupXEventType
} from "../core/envelope.js";
import { GroupXError, toGroupXError, type GroupXErrorCode } from "../core/errors.js";
import type {
  AcceptMessageResult,
  ClaimedTurn,
  GroupXStore,
  IdentityQuery,
  IdentityRecord,
  MemoryQuery,
  MemoryRecord,
  RecoveryResult,
  StoredEventRecord,
  TerminalToolProgressInput,
  TerminalTurnStatus,
  TurnRecord,
  TurnStatus
} from "../storage/types.js";
import type {
  ActiveBrokerTurnContext,
  AcceptBrokerMessageInput,
  BrokerBootstrap,
  BrokerDependencies,
  BrokerErrorContext,
  BrokerHealth,
  CancelTurnFromBindingInput,
  CancelTurnOutcome,
  CompactContextFromBindingInput,
  CorrelationWaitResult,
  CorrelationReadResult,
  DispatchPreparation,
  ReadCorrelationInput,
  RememberIdentityFromBindingInput,
  RememberMemoryFromBindingInput,
  RetractRecordFromBindingInput,
  SupersedeIdentityFromBindingInput,
  SupersedeMemoryFromBindingInput,
  WaitForCorrelationInput
} from "./types.js";

const TERMINAL_TURN_STATUSES = new Set<TurnStatus>([
  "completed",
  "failed",
  "cancelled",
  "interrupted"
]);

const DEFAULT_PARTIAL_CHECKPOINT_CHARS = 4_096;
const DEFAULT_NATIVE_CANCEL_TIMEOUT_MS = 5_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const MAX_EVENT_PAGE = 500;

interface ActiveDispatch {
  preparation: DispatchPreparation;
  controller: AbortController;
  partialText: string;
  reasoningText: string;
  toolProgress: TerminalToolProgressInput[];
  checkpointedLength: number;
  chunkIndex: number;
  started: boolean;
  terminal: boolean;
  durableStatus?: TurnStatus;
  cancelRequested: boolean;
  cancelResult?: CancelResult;
  nativeCancelPromise?: Promise<CancelResult>;
  nativeTerminalInFlight: boolean;
  nativeTurnId?: string;
  lifecycleContext: ActiveBrokerTurnContext;
  lifecycleActive: boolean;
  automaticRecoveryRequested: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringProperty(value: unknown, ...names: string[]): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

function messageContent(event: StoredEventRecord): string {
  const content = stringProperty(event.body, "content");
  if (content === undefined) {
    throw new GroupXError("INVALID_ENVELOPE", "Persisted source message has no text content");
  }
  return content;
}

function nativeErrorCode(event: NativeEvent, fallback: GroupXErrorCode): string {
  return stringProperty(event.payload, "errorCode", "code") ?? fallback;
}

function terminalContent(event: NativeEvent, accumulated: string): string {
  return stringProperty(event.payload, "content", "text", "message") ?? accumulated;
}

function toEnvelope(event: StoredEventRecord): GroupXEnvelope {
  return {
    schema: GROUPX_SCHEMA,
    eventId: event.eventId,
    seq: event.seq,
    roomId: event.roomId,
    type: event.eventType as GroupXEventType,
    actor: {
      actorId: event.actorId,
      kind: event.actorKind,
      displayName: event.actorDisplayName,
      ...(event.instanceId === undefined ? {} : { instanceId: event.instanceId })
    },
    to: [...event.targets],
    ...(event.replyToEventId === undefined ? {} : { replyToEventId: event.replyToEventId }),
    ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
    correlationId: event.correlationId,
    rootCorrelationId: event.correlationId,
    ...(event.idempotencyKey === undefined ? {} : { idempotencyKey: event.idempotencyKey }),
    occurredAt: event.occurredAt,
    durability: "durable",
    body: event.body,
    ...(event.provenance === undefined ? {} : { provenance: event.provenance })
  };
}

/**
 * Durable Broker application core. HTTP, MCP, process startup, and SQLite
 * ownership are composed outside this class.
 */
export class GroupXBroker {
  readonly #store: GroupXStore;
  readonly #adapters: AdapterRegistry;
  readonly #sessions: BrokerDependencies["sessions"];
  readonly #publisher: BrokerDependencies["publisher"];
  readonly #agentController: BrokerDependencies["agentController"];
  readonly #contextProvider: BrokerDependencies["contextProvider"];
  readonly #contextController: BrokerDependencies["contextController"];
  readonly #datedMemoryController: BrokerDependencies["datedMemoryController"];
  readonly #turnLifecycle: BrokerDependencies["turnLifecycle"];
  readonly #acceptMessageLimits: BrokerDependencies["acceptMessageLimits"];
  readonly #selectedTransport: BrokerDependencies["selectedTransport"];
  readonly #clock: NonNullable<BrokerDependencies["clock"]>;
  readonly #idFactory: NonNullable<BrokerDependencies["idFactory"]>;
  readonly #defaultRoomId: string;
  readonly #partialCheckpointChars: number;
  readonly #nativeCancelTimeoutMs: number;
  readonly #closeTimeoutMs: number;
  readonly #onError: BrokerDependencies["onError"];
  readonly #pumps = new Map<string, Promise<void>>();
  readonly #dirtyActors = new Set<string>();
  readonly #active = new Map<string, ActiveDispatch>();
  readonly #cancelFlights = new Map<string, Promise<CancelTurnOutcome>>();
  readonly #cancelCommandFlights = new Map<string, Promise<CancelTurnOutcome>>();
  readonly #contextCommandFlights = new Map<
    string,
    Promise<import("../memory/types.js").RoomContextCompactionResult>
  >();
  readonly #turnWaiters = new Map<string, Set<() => void>>();
  readonly #closingController = new AbortController();
  #closePromise?: Promise<void>;
  #closed = false;
  #storeWritesFenced = false;

  constructor(dependencies: BrokerDependencies) {
    this.#store = dependencies.store;
    this.#adapters = dependencies.adapters;
    this.#sessions = dependencies.sessions;
    this.#publisher = dependencies.publisher;
    this.#agentController = dependencies.agentController;
    this.#contextProvider = dependencies.contextProvider;
    this.#contextController = dependencies.contextController;
    this.#datedMemoryController = dependencies.datedMemoryController;
    this.#turnLifecycle = dependencies.turnLifecycle;
    this.#acceptMessageLimits = dependencies.acceptMessageLimits;
    this.#selectedTransport = dependencies.selectedTransport;
    this.#clock = dependencies.clock ?? { now: nowIso };
    this.#idFactory = dependencies.idFactory ?? createId;
    this.#defaultRoomId = dependencies.defaultRoomId ?? DEFAULT_ROOM_ID;
    this.#partialCheckpointChars =
      dependencies.partialCheckpointChars ?? DEFAULT_PARTIAL_CHECKPOINT_CHARS;
    this.#nativeCancelTimeoutMs =
      dependencies.nativeCancelTimeoutMs ?? DEFAULT_NATIVE_CANCEL_TIMEOUT_MS;
    this.#closeTimeoutMs = dependencies.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    this.#onError = dependencies.onError;

    if (!Number.isSafeInteger(this.#partialCheckpointChars) || this.#partialCheckpointChars < 1) {
      throw new RangeError("partialCheckpointChars must be a positive integer");
    }
    if (!Number.isSafeInteger(this.#nativeCancelTimeoutMs) || this.#nativeCancelTimeoutMs < 1) {
      throw new RangeError("nativeCancelTimeoutMs must be a positive integer");
    }
    if (!Number.isSafeInteger(this.#closeTimeoutMs) || this.#closeTimeoutMs < 1) {
      throw new RangeError("closeTimeoutMs must be a positive integer");
    }
    if (this.#selectedTransport !== "direct" && this.#selectedTransport !== "structured") {
      throw new RangeError("selectedTransport must be direct or structured");
    }
  }

  async acceptMessage(input: AcceptBrokerMessageInput): Promise<AcceptMessageResult> {
    this.#assertOpen();
    const targets = input.request.to.map((actorId) => {
      const adapter = this.#adapters.getByActor(actorId);
      return {
        actorId,
        adapterId: adapter.adapterId,
        transport: this.#selectedTransport,
        ...(input.parentTurnId === undefined ? {} : { parentTurnId: input.parentTurnId }),
        ...(input.hopCount === undefined ? {} : { hopCount: input.hopCount })
      };
    });
    const binding = this.#store.getSessionBinding(input.bindingId);
    const sourceKind = binding?.protocol === "local-rest" ? "web" : "mcp";
    const outcome = this.#store.acceptMessageWithDisposition({
      sourceBindingId: input.bindingId,
      clientCommandId: input.request.clientCommandId,
      commandType: input.commandType ?? "message.send",
      roomId: input.roomId ?? this.#defaultRoomId,
      targets,
      content: input.request.content,
      ...(input.request.replyToEventId === undefined
        ? {}
        : { replyToEventId: input.request.replyToEventId }),
      ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      occurredAt: this.#clock.now(),
      provenance: { sourceKind },
      ...(this.#acceptMessageLimits === undefined
        ? {}
        : { limits: this.#acceptMessageLimits })
    });

    if (outcome.disposition === "accepted") {
      const source = this.#store.getEvent(outcome.result.messageEventId);
      if (!source) {
        throw new GroupXError("STORE_UNAVAILABLE", "Accepted source event is missing");
      }
      await this.#publishStored(source);
      if (this.#closed) return outcome.result;
      for (const result of outcome.result.turns) {
        const turn = this.#store.getTurn(result.turnId);
        const queued = turn ? this.#store.getEvent(turn.queuedEventId) : undefined;
        if (!turn || !queued) {
          throw new GroupXError("STORE_UNAVAILABLE", "Accepted queued Turn evidence is missing");
        }
        await this.#publishStored(queued);
        if (this.#closed) return outcome.result;
        this.#scheduleActor(turn.targetActorId);
      }
    }
    return outcome.result;
  }

  contextUsage(roomId = this.#defaultRoomId): import("../memory/types.js").RoomContextUsage {
    this.#assertOpen();
    if (!this.#contextController) {
      throw new GroupXError("SESSION_NOT_AVAILABLE", "Room context controller is unavailable");
    }
    return this.#contextController.inspectUsage(roomId);
  }

  async compactContextFromBinding(
    input: CompactContextFromBindingInput
  ): Promise<import("../memory/types.js").RoomContextCompactionResult> {
    this.#assertOpen();
    if (!this.#contextController) {
      throw new GroupXError("SESSION_NOT_AVAILABLE", "Room context controller is unavailable");
    }
    const roomId = input.roomId ?? this.#defaultRoomId;
    const command = this.#store.beginClientCommand<
      import("../memory/types.js").RoomContextCompactionResult
    >({
      sourceBindingId: input.bindingId,
      clientCommandId: input.clientCommandId,
      commandType: "context.compact",
      canonicalPayload: { roomId },
      acceptedAt: this.#clock.now()
    });
    if (command.disposition === "replayed") return command.result;

    const commandKey = JSON.stringify([input.bindingId, input.clientCommandId]);
    const existingFlight = this.#contextCommandFlights.get(commandKey);
    if (existingFlight) return existingFlight;
    const flight = this.#completeContextCommand({ ...input, roomId });
    this.#contextCommandFlights.set(commandKey, flight);
    try {
      return await flight;
    } finally {
      if (this.#contextCommandFlights.get(commandKey) === flight) {
        this.#contextCommandFlights.delete(commandKey);
      }
    }
  }

  async #completeContextCommand(
    input: CompactContextFromBindingInput & { roomId: string }
  ): Promise<import("../memory/types.js").RoomContextCompactionResult> {
    try {
      const result = await this.#contextController!.compactNow(input.roomId);
      if (this.#storeWritesFenced) {
        throw new GroupXError(
          "SESSION_NOT_AVAILABLE",
          "Broker closed before the context command receipt was persisted"
        );
      }
      return this.#store.completeClientCommand({
        sourceBindingId: input.bindingId,
        clientCommandId: input.clientCommandId,
        result
      });
    } catch (error) {
      this.#report(error, { operation: "context" });
      throw error;
    }
  }

  async cancelTurn(turnId: string): Promise<CancelTurnOutcome> {
    this.#assertOpen();
    const existingFlight = this.#cancelFlights.get(turnId);
    if (existingFlight) return existingFlight;
    const flight = this.#cancelTurnOnce(turnId);
    this.#cancelFlights.set(turnId, flight);
    try {
      return await flight;
    } finally {
      if (this.#cancelFlights.get(turnId) === flight) this.#cancelFlights.delete(turnId);
    }
  }

  async #cancelTurnOnce(turnId: string): Promise<CancelTurnOutcome> {
    let turn = this.#store.getTurn(turnId);
    if (!turn) {
      throw new GroupXError("UNKNOWN_TARGET", "Turn does not exist");
    }
    if (TERMINAL_TURN_STATUSES.has(turn.status)) {
      return {
        turnId,
        accepted: false,
        status: turn.status
      };
    }
    if (turn.status === "queued") {
      let terminal;
      try {
        terminal = this.#store.cancelQueuedTurn(turnId, this.#clock.now());
      } catch (error) {
        const after = this.#store.getTurn(turnId);
        if (after && TERMINAL_TURN_STATUSES.has(after.status)) {
          return { turnId, accepted: false, status: after.status };
        }
        if (!after || (after.status !== "dispatching" && after.status !== "running" && after.status !== "cancelling")) {
          throw error;
        }
        // The FIFO pump can claim the queued Turn between our read and the
        // queued cancellation CAS. Continue against the freshly persisted
        // state instead of losing the cancellation intent to that race.
        turn = after;
      }
      if (terminal) {
        this.#notifyTurnTerminal(turnId);
        this.#scheduleActor(turn.targetActorId);
        await this.#publishStored(terminal.terminalEvent);
        return { turnId, accepted: true, status: terminal.turn.status };
      }
    }
    if (turn.status !== "cancelling") {
      try {
        turn = this.#store.requestTurnCancellation(turnId);
      } catch (error) {
        const after = this.#store.getTurn(turnId);
        if (after && TERMINAL_TURN_STATUSES.has(after.status)) {
          return { turnId, accepted: false, status: after.status };
        }
        if (after?.status === "cancelling") {
          turn = after;
        } else {
          throw error;
        }
      }
    }

    const active = this.#active.get(turnId);
    if (!active) {
      return this.#cancelOutcomeFromStore(turnId);
    }
    active.cancelRequested = true;
    if (!active.nativeTurnId) {
      active.controller.abort(
        new GroupXError("TURN_INTERRUPTED", "Cancellation arrived before a native Turn id")
      );
      return this.#cancelOutcomeFromStore(turnId);
    }

    try {
      const result = await this.#awaitNativeCancel(active);
      if (result.terminalObserved && !active.terminal) {
        await this.#terminalOnce(active, "cancelled");
        active.controller.abort(new GroupXError("TURN_INTERRUPTED", "Native cancellation completed"));
      }
      if (this.#storeWritesFenced) {
        return { turnId, accepted: true, status: active.durableStatus ?? "cancelling" };
      }
      return this.#cancelOutcomeFromStore(turnId);
    } catch (error) {
      this.#report(error, { operation: "dispatch", actorId: turn.targetActorId, turnId });
      if (this.#storeWritesFenced) {
        return { turnId, accepted: true, status: active.durableStatus ?? "cancelling" };
      }
      return this.#cancelOutcomeFromStore(turnId);
    }
  }

  async cancelFromBinding(input: CancelTurnFromBindingInput): Promise<CancelTurnOutcome> {
    this.#assertOpen();
    const command = this.#store.beginClientCommand<CancelTurnOutcome>({
      sourceBindingId: input.bindingId,
      clientCommandId: input.clientCommandId,
      commandType: "turn.cancel",
      canonicalPayload: { turnId: input.turnId },
      acceptedAt: this.#clock.now()
    });
    if (command.disposition === "replayed") return command.result;

    const commandKey = JSON.stringify([input.bindingId, input.clientCommandId]);
    const existingFlight = this.#cancelCommandFlights.get(commandKey);
    if (existingFlight) return existingFlight;

    const flight = this.#completeCancelCommand(input);
    this.#cancelCommandFlights.set(commandKey, flight);
    try {
      return await flight;
    } finally {
      if (this.#cancelCommandFlights.get(commandKey) === flight) {
        this.#cancelCommandFlights.delete(commandKey);
      }
    }
  }

  async #completeCancelCommand(
    input: CancelTurnFromBindingInput
  ): Promise<CancelTurnOutcome> {
    const result = await this.cancelTurn(input.turnId);
    if (this.#storeWritesFenced) {
      throw new GroupXError(
        "SESSION_NOT_AVAILABLE",
        "Broker closed before the cancel command receipt was persisted"
      );
    }
    return this.#store.completeClientCommand({
      sourceBindingId: input.bindingId,
      clientCommandId: input.clientCommandId,
      result
    });
  }

  readCorrelation(input: ReadCorrelationInput = {}): CorrelationReadResult {
    return this.#readCorrelation(input, true);
  }

  #readCorrelation(input: ReadCorrelationInput, assertOpen: boolean): CorrelationReadResult {
    if (assertOpen) this.#assertOpen();
    const roomId = input.roomId ?? this.#defaultRoomId;
    const afterSeq = input.afterSeq ?? 0;
    const limit = Math.min(Math.max(input.limit ?? 100, 1), MAX_EVENT_PAGE);
    const events: GroupXEnvelope[] = [];
    let cursor = afterSeq;
    let exhausted = false;

    while (events.length < limit && !exhausted) {
      const page = this.#store.listEvents({ roomId, afterSeq: cursor, limit: MAX_EVENT_PAGE });
      if (page.events.length === 0) {
        exhausted = true;
        break;
      }
      for (const event of page.events) {
        cursor = event.seq;
        if (input.correlationId === undefined || event.correlationId === input.correlationId) {
          events.push(toEnvelope(event));
          if (events.length >= limit) break;
        }
      }
      if (!page.hasMore) exhausted = true;
    }

    const turns = (input.correlationId
      ? this.#store.listTurns({ rootCorrelationId: input.correlationId })
      : []
    ).map((turn) => ({
      target: turn.targetActorId,
      turnId: turn.turnId,
      status: turn.status,
      ...(turn.responseEventId === undefined ? {} : { responseEventId: turn.responseEventId }),
      ...(turn.errorCode === undefined ? {} : { errorCode: turn.errorCode })
    }));
    return {
      ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
      events,
      turns,
      ...(cursor <= afterSeq ? {} : { nextAfterSeq: cursor })
    };
  }

  async waitForCorrelation(input: WaitForCorrelationInput): Promise<CorrelationWaitResult> {
    this.#assertOpen();
    const timeoutMs = input.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new RangeError("timeoutMs must be a positive integer");
    }
    const initialTurns = input.childTurnIds
      ? input.childTurnIds.map((turnId) => {
          const turn = this.#store.getTurn(turnId);
          if (!turn || turn.rootCorrelationId !== input.correlationId) {
            throw new GroupXError(
              "UNKNOWN_TARGET",
              "A requested child Turn does not belong to the correlation"
            );
          }
          return turn;
        })
      : this.#store.listTurns({ rootCorrelationId: input.correlationId });
    const turnIds = [...new Set(initialTurns.map((turn) => turn.turnId))];
    if (turnIds.length === 0) {
      throw new GroupXError("UNKNOWN_TARGET", "The correlation has no child Turns to wait for");
    }

    const allTerminal = (): boolean =>
      turnIds.every((turnId) => {
        const turn = this.#store.getTurn(turnId);
        return turn !== undefined && TERMINAL_TURN_STATUSES.has(turn.status);
      });

    let state: CorrelationWaitResult["state"] = "terminal";
    if (!allTerminal()) {
      state = await new Promise<CorrelationWaitResult["state"]>((resolve) => {
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const subscribed = new Set<string>();

        const cleanup = (): void => {
          if (timer) clearTimeout(timer);
          input.signal?.removeEventListener("abort", onAbort);
          this.#closingController.signal.removeEventListener("abort", onBrokerClose);
          for (const turnId of subscribed) {
            const listeners = this.#turnWaiters.get(turnId);
            listeners?.delete(onTerminal);
            if (listeners?.size === 0) this.#turnWaiters.delete(turnId);
          }
        };
        const finish = (result: CorrelationWaitResult["state"]): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(result);
        };
        const onTerminal = (): void => {
          if (allTerminal()) finish("terminal");
        };
        const onAbort = (): void => finish("aborted");
        const onBrokerClose = (): void => finish("aborted");

        for (const turnId of turnIds) {
          const turn = this.#store.getTurn(turnId);
          if (turn && !TERMINAL_TURN_STATUSES.has(turn.status)) {
            const listeners = this.#turnWaiters.get(turnId) ?? new Set<() => void>();
            listeners.add(onTerminal);
            this.#turnWaiters.set(turnId, listeners);
            subscribed.add(turnId);
          }
        }
        // Close the check/subscribe race before arming the timeout.
        if (allTerminal()) {
          finish("terminal");
          return;
        }
        if (input.signal?.aborted || this.#closingController.signal.aborted) {
          finish("aborted");
          return;
        }
        input.signal?.addEventListener("abort", onAbort, { once: true });
        this.#closingController.signal.addEventListener("abort", onBrokerClose, { once: true });
        timer = setTimeout(() => finish("timeout"), timeoutMs);
      });
    }

    const turns = turnIds
      .map((turnId) => this.#store.getTurn(turnId))
      .filter((turn): turn is TurnRecord => turn !== undefined);
    const responseEvents = turns.flatMap((turn) => {
      if (turn.responseEventId === undefined) return [];
      const event = this.#store.getEvent(turn.responseEventId);
      if (
        event === undefined ||
        event.roomId !== (input.roomId ?? this.#defaultRoomId) ||
        event.correlationId !== input.correlationId
      ) {
        return [];
      }
      return [toEnvelope(event)];
    });
    return {
      state,
      correlationId: input.correlationId,
      turns,
      read: this.#readCorrelation({
        correlationId: input.correlationId,
        ...(input.roomId === undefined ? {} : { roomId: input.roomId })
      }, false),
      responseEvents
    };
  }

  async recoverAfterRestart(): Promise<RecoveryResult> {
    this.#assertOpen();
    try {
      const recovered = this.#store.recoverAfterRestart(this.#clock.now());
      for (const turn of recovered.interruptedTurns) {
        if (turn.terminalEventId) {
          const event = this.#store.getEvent(turn.terminalEventId);
          if (event) await this.#publishStored(event);
        }
        this.#notifyTurnTerminal(turn.turnId);
      }
      for (const actorId of new Set(recovered.queuedTurns.map((turn) => turn.targetActorId))) {
        this.#scheduleActor(actorId);
      }
      return recovered;
    } catch (error) {
      this.#report(error, { operation: "recovery" });
      throw error;
    }
  }

  notifySessionReady(actorId: string): void {
    this.#assertOpen();
    this.#adapters.getByActor(actorId);
    this.#scheduleActor(actorId);
  }

  async restartAgent(actorId: string): Promise<void> {
    this.#assertOpen();
    this.#adapters.getByActor(actorId);
    if (!this.#agentController) {
      throw new GroupXError("SESSION_NOT_AVAILABLE", "No Agent restart controller is attached");
    }
    try {
      await this.#agentController.restart(actorId);
      this.#scheduleActor(actorId);
    } catch (error) {
      this.#report(error, { operation: "restart", actorId });
      throw error;
    }
  }

  health(): BrokerHealth {
    this.#assertOpen();
    try {
      const integrity = this.#store.integrityCheck();
      return {
        store: {
          available: true,
          integrityOk: integrity.ok,
          schemaVersion: this.#store.getSchemaVersion(),
          journalMode: this.#store.getJournalMode()
        },
        agents: this.#adapters.health(),
        activeTurns: this.#active.size,
        queuedTurns: this.#store.listTurns({ status: "queued" }).length
      };
    } catch {
      return {
        store: { available: false, integrityOk: false, schemaVersion: 0, journalMode: "unknown" },
        agents: this.#adapters.health(),
        activeTurns: this.#active.size,
        queuedTurns: 0
      };
    }
  }

  bootstrap(input: { roomId?: string; recentLimit?: number } = {}): BrokerBootstrap {
    this.#assertOpen();
    const roomId = input.roomId ?? this.#defaultRoomId;
    const recentLimit = Math.min(Math.max(input.recentLimit ?? 100, 1), MAX_EVENT_PAGE);
    const snapshot = this.#store.readRoomBootstrapSnapshot({ roomId, recentLimit });
    const healthByActor = new Map(
      this.#adapters.list().map((adapter) => [adapter.actorId, adapter.health()] as const)
    );
    return {
      schema: "groupx.bootstrap/0.1",
      room: { roomId, throughSeq: snapshot.throughSeq },
      agents: this.#adapters.list().map((adapter) => {
        const actor = this.#store.getActor(adapter.actorId);
        const health = healthByActor.get(adapter.actorId)!;
        return {
          actorId: adapter.actorId,
          displayName: actor?.displayName ?? adapter.actorId,
          status: health.status,
          ...(health.instanceId === undefined ? {} : { instanceId: health.instanceId })
        };
      }),
      recentEvents: snapshot.recentEvents.map(toEnvelope),
      activeTurns: snapshot.activeTurns.map((turn) => ({
        turnId: turn.turnId,
        targetActorId: turn.targetActorId,
        status: turn.status,
        sourceEventId: turn.sourceEventId
      }))
    };
  }

  queryMemory(input: MemoryQuery = {}): MemoryRecord[] {
    this.#assertOpen();
    return this.#store.searchMemory(input);
  }

  queryIdentity(input: IdentityQuery = {}): IdentityRecord[] {
    this.#assertOpen();
    return this.#store.readIdentity(input);
  }

  async rememberMemory(input: RememberMemoryFromBindingInput): Promise<MemoryRecord> {
    this.#assertOpen();
    const {
      bindingId,
      clientCommandId,
      roomId = this.#defaultRoomId,
      correlationId,
      ...record
    } = input;
    const binding = this.#requireBinding(bindingId);
    const outcome = this.#store.mutateMemoryWithDisposition({
      sourceBindingId: bindingId,
      clientCommandId,
      roomId,
      ...(correlationId === undefined ? {} : { correlationId }),
      occurredAt: this.#clock.now(),
      mutation: {
        kind: "remember",
        record: {
          ...record,
          ...(record.scopeType === "agent"
            ? { agentMemoryType: record.agentMemoryType ?? "core" }
            : {}),
          authorActorId: binding.actorId,
          sourceKind: this.#sourceKindForBinding(binding)
        }
      }
    });
    if (outcome.disposition === "accepted") await this.#publishStored(outcome.result.event);
    return outcome.result.record;
  }

  async supersedeMemory(
    memoryId: string,
    input: SupersedeMemoryFromBindingInput
  ): Promise<MemoryRecord> {
    this.#assertOpen();
    const {
      bindingId,
      clientCommandId,
      roomId = this.#defaultRoomId,
      correlationId,
      kind,
      content,
      sourceEventId
    } = input;
    const binding = this.#requireBinding(bindingId);
    const previous = this.#store.getMemory(memoryId);
    if (!previous) throw new GroupXError("UNKNOWN_TARGET", "Memory does not exist");
    const outcome = this.#store.mutateMemoryWithDisposition({
      sourceBindingId: bindingId,
      clientCommandId,
      roomId,
      ...(correlationId === undefined ? {} : { correlationId }),
      occurredAt: this.#clock.now(),
      mutation: {
        kind: "supersede",
        memoryId,
        replacement: {
          scopeType: previous.scopeType,
          scopeId: previous.scopeId,
          ...(previous.agentMemoryType === undefined
            ? {}
            : { agentMemoryType: previous.agentMemoryType }),
          kind: kind ?? previous.kind,
          content,
          ...(previous.subjectActorId === undefined
            ? {}
            : { subjectActorId: previous.subjectActorId }),
          ...(sourceEventId === undefined ? {} : { sourceEventId }),
          authorActorId: binding.actorId,
          sourceKind: this.#sourceKindForBinding(binding)
        }
      }
    });
    if (outcome.disposition === "accepted") await this.#publishStored(outcome.result.event);
    return outcome.result.record;
  }

  async retractMemory(
    memoryId: string,
    input: RetractRecordFromBindingInput
  ): Promise<MemoryRecord> {
    this.#assertOpen();
    const {
      bindingId,
      clientCommandId,
      roomId = this.#defaultRoomId,
      correlationId
    } = input;
    this.#requireBinding(bindingId);
    const outcome = this.#store.mutateMemoryWithDisposition({
      sourceBindingId: bindingId,
      clientCommandId,
      roomId,
      ...(correlationId === undefined ? {} : { correlationId }),
      occurredAt: this.#clock.now(),
      mutation: { kind: "retract", memoryId }
    });
    if (outcome.disposition === "accepted") await this.#publishStored(outcome.result.event);
    return outcome.result.record;
  }

  async rememberIdentity(input: RememberIdentityFromBindingInput): Promise<IdentityRecord> {
    this.#assertOpen();
    const {
      bindingId,
      clientCommandId,
      roomId = this.#defaultRoomId,
      correlationId,
      ...record
    } = input;
    const binding = this.#requireBinding(bindingId);
    const identityRecord = this.#identityRecordForBinding(binding, record);
    const outcome = this.#store.mutateIdentityWithDisposition({
      sourceBindingId: bindingId,
      clientCommandId,
      roomId,
      ...(correlationId === undefined ? {} : { correlationId }),
      occurredAt: this.#clock.now(),
      mutation: {
        kind: "remember",
        record: identityRecord
      }
    });
    if (outcome.disposition === "accepted") await this.#publishStored(outcome.result.event);
    return outcome.result.record;
  }

  async supersedeIdentity(
    identityId: string,
    input: SupersedeIdentityFromBindingInput
  ): Promise<IdentityRecord> {
    this.#assertOpen();
    const {
      bindingId,
      clientCommandId,
      roomId = this.#defaultRoomId,
      correlationId,
      kind,
      content,
      sourceEventId
    } = input;
    const binding = this.#requireBinding(bindingId);
    const previous = this.#store.getIdentity(identityId);
    if (!previous) throw new GroupXError("UNKNOWN_TARGET", "Identity does not exist");
    const identityRecord = this.#identityRecordForBinding(binding, {
      subjectActorId: previous.subjectActorId,
      kind: kind ?? previous.kind,
      content,
      ...(sourceEventId === undefined ? {} : { sourceEventId })
    });
    const outcome = this.#store.mutateIdentityWithDisposition({
      sourceBindingId: bindingId,
      clientCommandId,
      roomId,
      ...(correlationId === undefined ? {} : { correlationId }),
      occurredAt: this.#clock.now(),
      mutation: {
        kind: "supersede",
        identityId,
        replacement: identityRecord
      }
    });
    if (outcome.disposition === "accepted") await this.#publishStored(outcome.result.event);
    return outcome.result.record;
  }

  async retractIdentity(
    identityId: string,
    input: RetractRecordFromBindingInput
  ): Promise<IdentityRecord> {
    this.#assertOpen();
    const {
      bindingId,
      clientCommandId,
      roomId = this.#defaultRoomId,
      correlationId
    } = input;
    this.#requireBinding(bindingId);
    const outcome = this.#store.mutateIdentityWithDisposition({
      sourceBindingId: bindingId,
      clientCommandId,
      roomId,
      ...(correlationId === undefined ? {} : { correlationId }),
      occurredAt: this.#clock.now(),
      mutation: { kind: "retract", identityId }
    });
    if (outcome.disposition === "accepted") await this.#publishStored(outcome.result.event);
    return outcome.result.record;
  }

  async waitForIdle(): Promise<void> {
    while (this.#pumps.size > 0) {
      await Promise.allSettled([...this.#pumps.values()]);
    }
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.#performClose();
    return this.#closePromise;
  }

  async #performClose(): Promise<void> {
    this.#closed = true;
    this.#closingController.abort(new GroupXError("TURN_INTERRUPTED", "Broker is closing"));
    for (const active of this.#active.values()) {
      active.controller.abort(new GroupXError("TURN_INTERRUPTED", "Broker is closing"));
      this.#deactivateTurnLifecycle(active);
    }
    const settled = Promise.allSettled([
      ...this.#pumps.values(),
      ...this.#cancelFlights.values(),
      ...this.#cancelCommandFlights.values(),
      ...this.#contextCommandFlights.values()
    ]).then(() => true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), this.#closeTimeoutMs);
    });
    const completed = await Promise.race([settled, timedOut]);
    if (timer) clearTimeout(timer);
    if (!completed) {
      this.#report(new GroupXError("TURN_INTERRUPTED", "Broker close deadline elapsed"), {
        operation: "dispatch"
      });
    }
    // From this point callers may close the Store. Any ignored/late native or
    // composition continuation must unwind without touching durable state.
    this.#storeWritesFenced = true;
    for (const active of this.#active.values()) active.terminal = true;
  }

  #scheduleActor(actorId: string): void {
    if (this.#closed) return;
    this.#dirtyActors.add(actorId);
    if (this.#pumps.has(actorId)) return;

    const pump = this.#runActorPump(actorId)
      .catch((error: unknown) => {
        this.#report(error, { operation: "dispatch", actorId });
      })
      .finally(() => {
        this.#pumps.delete(actorId);
        if (!this.#closed && this.#dirtyActors.has(actorId)) {
          queueMicrotask(() => this.#scheduleActor(actorId));
        }
      });
    this.#pumps.set(actorId, pump);
  }

  async #runActorPump(actorId: string): Promise<void> {
    while (!this.#closed) {
      this.#dirtyActors.delete(actorId);
      while (!this.#closed) {
        const preparation = await this.#prepareNext(actorId);
        if (!preparation) break;
        if (this.#closed) return;
        await this.#execute(preparation);
      }
      if (!this.#dirtyActors.has(actorId)) return;
    }
  }

  async #prepareNext(actorId: string): Promise<DispatchPreparation | undefined> {
    while (!this.#closed) {
      const head = this.#store.listTurns({ status: "queued", targetActorId: actorId })[0];
      if (!head) return undefined;
      if (head.transport !== this.#selectedTransport) {
        await this.#failQueuedTransportMismatch(head, "persisted_transport_mismatch");
        continue;
      }
      const adapter = this.#adapters.getByActor(actorId);
      let session: NativeSession;
      try {
        session = await this.#sessions.resolve({ actorId, adapterId: adapter.adapterId });
      } catch (error) {
        this.#report(error, { operation: "dispatch", actorId, turnId: head.turnId });
        return undefined;
      }
      if (this.#closed) return undefined;
      this.#assertSession(adapter, session, actorId);

      const sourceEvent = this.#store.getEvent(head.sourceEventId);
      if (!sourceEvent) {
        throw new GroupXError("STORE_UNAVAILABLE", "Queued Turn source event is missing");
      }
      const cursor = this.#store.getDeliveryCursor(actorId, sourceEvent.roomId);
      const lastDeliveredSeq = cursor?.lastDeliveredSeq ?? 0;
      let contextThroughSeq = Math.max(sourceEvent.seq, lastDeliveredSeq);
      let summaryThroughSeq: number | undefined;
      let contextPacket: string | undefined;
      if (this.#contextProvider) {
        try {
          const prepared = await this.#contextProvider.prepare({
            turn: head,
            sourceEvent,
            lastDeliveredSeq
          });
          if (
            !Number.isSafeInteger(prepared.contextThroughSeq) ||
            prepared.contextThroughSeq < sourceEvent.seq
          ) {
            throw new GroupXError(
              "INVALID_ENVELOPE",
              "Context provider cursor must include the source message"
            );
          }
          // A previous confirmed attempt may already have delivered beyond
          // this queued source. Preserve that durable watermark without
          // requiring the provider to rebuild already-delivered context.
          contextThroughSeq = Math.max(prepared.contextThroughSeq, lastDeliveredSeq);
          if (prepared.summaryThroughSeq !== undefined) {
            if (
              !Number.isSafeInteger(prepared.summaryThroughSeq) ||
              prepared.summaryThroughSeq < 0 ||
              prepared.summaryThroughSeq > prepared.contextThroughSeq
            ) {
              throw new GroupXError(
                "INVALID_ENVELOPE",
                "Context summary cursor must be within the prepared context boundary"
              );
            }
            summaryThroughSeq = prepared.summaryThroughSeq;
          }
          contextPacket = prepared.contextPacket;
        } catch (error) {
          this.#report(error, { operation: "context", actorId, turnId: head.turnId });
          await this.#failQueuedContext(head, error);
          continue;
        }
      } else if (!this.#canDeliverCurrentMessageOnly(sourceEvent, lastDeliveredSeq)) {
        this.#report(
          new GroupXError(
            "SESSION_NOT_AVAILABLE",
            "A Context provider is required before advancing across undelivered room events"
          ),
          { operation: "context", actorId, turnId: head.turnId }
        );
        return undefined;
      }
      if (this.#closed) return undefined;

      let claim: ClaimedTurn | undefined;
      try {
        claim = this.#store.claimNextQueuedTurn({
          targetActorId: actorId,
          bindingId: session.bindingId,
          instanceId: session.instanceId,
          contextThroughSeq,
          ...(summaryThroughSeq === undefined ? {} : { summaryThroughSeq }),
          expectedTurnId: head.turnId,
          expectedTransport: this.#selectedTransport,
          claimedAt: this.#clock.now()
        });
      } catch (error) {
        if (error instanceof GroupXError && error.code === "TRANSPORT_MODE_MISMATCH") {
          await this.#failQueuedTransportMismatch(head, "runtime_binding_mismatch");
          continue;
        }
        if (
          error instanceof GroupXError &&
          error.code === "STORE_CONFLICT" &&
          error.details?.reason === "summary_checkpoint_changed"
        ) {
          // Another lane advanced the room checkpoint after this lane built
          // its packet. Rebuild against the new active summary; never dispatch
          // a packet whose durable summary watermark was superseded.
          continue;
        }
        throw error;
      }
      if (!claim) {
        const currentHead = this.#store.listTurns({
          status: "queued",
          targetActorId: actorId
        })[0];
        // Preparation is asynchronous. If its observed head changed, prepare
        // the new head; if it did not, the lane is blocked by another active
        // claimant and must not hot-loop.
        if (currentHead && currentHead.turnId !== head.turnId) continue;
        return undefined;
      }
      if (claim.turn.turnId !== head.turnId) {
        throw new GroupXError("STORE_CONFLICT", "Claimed Turn did not match the observed FIFO head");
      }
      return {
        claim,
        adapter,
        session,
        sourceEvent,
        promptContent: messageContent(sourceEvent),
        ...(contextPacket === undefined ? {} : { contextPacket })
      };
    }
    return undefined;
  }

  async #failQueuedTransportMismatch(
    turn: TurnRecord,
    reason: "persisted_transport_mismatch" | "runtime_binding_mismatch"
  ): Promise<void> {
    try {
      const terminal = this.#store.failQueuedTurn(
        turn.turnId,
        "TRANSPORT_MODE_MISMATCH",
        this.#clock.now(),
        {
          reason,
          persistedTransport: turn.transport,
          selectedTransport: this.#selectedTransport
        }
      );
      await this.#publishStored(terminal.terminalEvent);
    } catch (error) {
      const after = this.#store.getTurn(turn.turnId);
      if (!after || !TERMINAL_TURN_STATUSES.has(after.status)) throw error;
    }
    this.#notifyTurnTerminal(turn.turnId);
  }

  async #failQueuedContext(turn: TurnRecord, error: unknown): Promise<void> {
    const normalized = toGroupXError(error, "CONTEXT_BUDGET_EXCEEDED");
    const errorCode: GroupXErrorCode =
      normalized.code === "STORE_UNAVAILABLE" ||
      normalized.code === "CONTEXT_BUDGET_EXCEEDED" ||
      normalized.code === "SESSION_NOT_AVAILABLE" ||
      normalized.code === "TURN_INTERRUPTED"
        ? normalized.code
        : "CONTEXT_BUDGET_EXCEEDED";
    try {
      const terminal = this.#store.failQueuedTurn(
        turn.turnId,
        errorCode,
        this.#clock.now(),
        { reason: "context_preparation_failed" }
      );
      await this.#publishStored(terminal.terminalEvent);
    } catch (caught) {
      const after = this.#store.getTurn(turn.turnId);
      if (!after || !TERMINAL_TURN_STATUSES.has(after.status)) throw caught;
    }
    this.#notifyTurnTerminal(turn.turnId);
  }

  async #execute(preparation: DispatchPreparation): Promise<void> {
    if (this.#storeWritesFenced) return;
    const { claim, adapter, session, sourceEvent } = preparation;
    const lifecycleContext: ActiveBrokerTurnContext = {
      bindingId: claim.attempt.bindingId,
      turnId: claim.turn.turnId,
      rootCorrelationId: claim.turn.rootCorrelationId,
      hopCount: claim.turn.hopCount
    };
    const active: ActiveDispatch = {
      preparation,
      controller: new AbortController(),
      partialText: "",
      reasoningText: "",
      toolProgress: [],
      checkpointedLength: 0,
      chunkIndex: 0,
      started: false,
      terminal: false,
      cancelRequested: false,
      nativeTerminalInFlight: false,
      lifecycleContext,
      lifecycleActive: false,
      automaticRecoveryRequested: false
    };
    this.#active.set(claim.turn.turnId, active);

    try {
      if (this.#closingController.signal.aborted) {
        active.controller.abort(
          new GroupXError("TURN_INTERRUPTED", "Broker closed before prompt invocation")
        );
      }
      if (this.#turnLifecycle) {
        active.lifecycleActive = true;
        this.#turnLifecycle.activate(lifecycleContext);
      }
      if (await this.#finishBeforePromptIfStopped(active)) return;

      const dispatched = this.#store.appendDurableEvent({
        roomId: sourceEvent.roomId,
        eventType: "turn.dispatched",
        actorId: BUILTIN_ACTORS.system.actorId,
        targets: [claim.turn.targetActorId],
        replyToEventId: claim.turn.sourceEventId,
        causationId: claim.turn.turnId,
        correlationId: claim.turn.rootCorrelationId,
        occurredAt: this.#clock.now(),
        body: {
          turnId: claim.turn.turnId,
          attemptId: claim.attempt.attemptId,
          targetActorId: claim.turn.targetActorId
        },
        provenance: { sourceKind: "system", sourceEventId: claim.turn.sourceEventId }
      });
      await this.#publishStored(dispatched);
      if (this.#storeWritesFenced) return;
      if (await this.#finishBeforePromptIfStopped(active)) return;

      this.#store.markPromptInvoked(claim.attempt.attemptId, this.#clock.now());
      const stream = adapter.prompt(session, {
        turnId: claim.turn.turnId,
        content: preparation.promptContent,
        ...(preparation.contextPacket === undefined
          ? {}
          : { contextPacket: preparation.contextPacket }),
        correlationId: claim.turn.rootCorrelationId,
        signal: active.controller.signal
      });
      for await (const event of stream) {
        await this.#handleNativeEvent(active, event);
        if (active.terminal || this.#storeWritesFenced) break;
      }

      if (this.#storeWritesFenced) return;
      if (!active.terminal) {
        if (active.cancelRequested) {
          let result = active.cancelResult;
          if (!result && active.nativeCancelPromise) {
            try {
              result = await this.#awaitNativeCancel(active);
            } catch (error) {
              this.#report(error, {
                operation: "dispatch",
                actorId: claim.turn.targetActorId,
                turnId: claim.turn.turnId
              });
            }
          }
          if (this.#storeWritesFenced) return;
          if (result?.terminalObserved) {
            await this.#terminalOnce(active, "cancelled");
          } else {
            await this.#terminalOnce(active, "interrupted", {
              errorCode: "TURN_INTERRUPTED"
            });
          }
        } else if (active.controller.signal.aborted) {
          await this.#terminalOnce(active, "interrupted", { errorCode: "TURN_INTERRUPTED" });
        } else {
          await this.#terminalOnce(active, "failed", {
            errorCode: "PROTOCOL_INVALID_MESSAGE"
          });
        }
      }
    } catch (error) {
      if (!active.terminal) {
        const interrupted = active.cancelRequested || active.controller.signal.aborted;
        try {
          await this.#terminalOnce(active, interrupted ? "interrupted" : "failed", {
            errorCode: interrupted ? "TURN_INTERRUPTED" : this.#errorCode(error)
          });
        } catch (terminalError) {
          this.#report(terminalError, {
            operation: "dispatch",
            actorId: claim.turn.targetActorId,
            turnId: claim.turn.turnId
          });
        }
      }
      this.#report(error, {
        operation: "dispatch",
        actorId: claim.turn.targetActorId,
        turnId: claim.turn.turnId
      });
    } finally {
      this.#deactivateTurnLifecycle(active);
      this.#active.delete(claim.turn.turnId);
      if (active.automaticRecoveryRequested && !this.#closed) {
        await this.#recoverAgentAfterProtocolFailure(active);
      }
    }
  }

  async #recoverAgentAfterProtocolFailure(active: ActiveDispatch): Promise<void> {
    if (!this.#agentController) return;
    const actorId = active.preparation.claim.turn.targetActorId;
    try {
      // The failed Turn is already terminal and is never replayed. Restarting
      // only replaces the poisoned process/session for subsequent queued work.
      await this.#agentController.restart(actorId);
    } catch (error) {
      this.#report(error, {
        operation: "recovery",
        actorId,
        turnId: active.preparation.claim.turn.turnId
      });
    }
  }

  #requestAutomaticRecovery(
    active: ActiveDispatch,
    status: TurnStatus,
    errorCode: string | undefined
  ): void {
    if (
      status === "failed" &&
      errorCode === "PROTOCOL_INVALID_MESSAGE" &&
      this.#selectedTransport === "structured" &&
      this.#agentController !== undefined
    ) {
      active.automaticRecoveryRequested = true;
    }
  }

  #deactivateTurnLifecycle(active: ActiveDispatch): void {
    if (!active.lifecycleActive || !this.#turnLifecycle) return;
    active.lifecycleActive = false;
    try {
      this.#turnLifecycle.deactivate(active.lifecycleContext);
    } catch (error) {
      this.#report(error, {
        operation: "dispatch",
        actorId: active.preparation.claim.turn.targetActorId,
        turnId: active.preparation.claim.turn.turnId
      });
    }
  }

  async #finishBeforePromptIfStopped(active: ActiveDispatch): Promise<boolean> {
    if (this.#storeWritesFenced) {
      active.terminal = true;
      this.#deactivateTurnLifecycle(active);
      return true;
    }
    const turnId = active.preparation.claim.turn.turnId;
    const current = this.#store.getTurn(turnId);
    if (!current) {
      throw new GroupXError("STORE_UNAVAILABLE", "Claimed Turn disappeared before prompt");
    }
    if (TERMINAL_TURN_STATUSES.has(current.status)) {
      active.terminal = true;
      this.#deactivateTurnLifecycle(active);
      this.#notifyTurnTerminal(turnId);
      return true;
    }
    if (current.status === "cancelling") {
      active.cancelRequested = true;
      await this.#terminalOnce(active, "cancelled");
      return true;
    }
    if (active.controller.signal.aborted) {
      await this.#terminalOnce(active, "interrupted", { errorCode: "TURN_INTERRUPTED" });
      return true;
    }
    if (current.status !== "dispatching") {
      throw new GroupXError(
        "STORE_CONFLICT",
        `Turn cannot invoke a native prompt from status ${current.status}`
      );
    }
    return false;
  }

  async #handleNativeEvent(active: ActiveDispatch, event: NativeEvent): Promise<void> {
    const { adapter, session, claim, sourceEvent } = active.preparation;
    if (active.terminal || this.#storeWritesFenced) return;
    if (event.adapterId !== adapter.adapterId || event.instanceId !== session.instanceId) {
      throw new GroupXError(
        "PROTOCOL_INVALID_MESSAGE",
        "Native event did not belong to the active Adapter instance"
      );
    }
    if (
      event.nativeSessionId !== undefined &&
      session.nativeSessionId !== undefined &&
      event.nativeSessionId !== session.nativeSessionId
    ) {
      throw new GroupXError(
        "PROTOCOL_INVALID_MESSAGE",
        "Native event did not belong to the active session"
      );
    }

    if (event.type === "session.started") return;
    if (event.nativeTurnId !== undefined) {
      this.#bindNativeTurnId(active, event.nativeTurnId);
    }
    if (event.type === "transport.error") {
      await this.#terminalOnce(active, "failed", {
        errorCode: nativeErrorCode(event, "PROTOCOL_INVALID_MESSAGE")
      });
      return;
    }

    await this.#markStarted(active, event.nativeTurnId, event.occurredAt);
    if (active.terminal || this.#storeWritesFenced) return;
    switch (event.type) {
      case "turn.started":
        return;
      case "content.delta": {
        const text = stringProperty(event.payload, "text", "content") ?? "";
        if (text !== "") {
          active.partialText += text;
          active.chunkIndex += 1;
          if (
            active.partialText.length - active.checkpointedLength >=
            this.#partialCheckpointChars
          ) {
            this.#store.saveTurnPartialText(claim.turn.turnId, active.partialText);
            active.checkpointedLength = active.partialText.length;
          }
          await this.#publishTransient(active, "turn.content.delta", event.occurredAt, {
            turnId: claim.turn.turnId,
            chunkIndex: active.chunkIndex,
            text
          });
        }
        return;
      }
      case "reasoning.delta": {
        const text = stringProperty(event.payload, "text", "content") ?? "";
        if (text !== "") {
          active.reasoningText += text;
          await this.#publishTransient(active, "turn.reasoning.delta", event.occurredAt, {
            turnId: claim.turn.turnId,
            text
          });
        }
        return;
      }
      case "tool.started":
      case "tool.completed": {
        const progress: TerminalToolProgressInput = {
          occurredAt: event.occurredAt,
          nativeType: event.type,
          ...(event.nativeEventId === undefined
            ? {}
            : { toolCallId: event.nativeEventId }),
          details: event.payload
        };
        active.toolProgress.push(progress);
        await this.#publishTransient(active, "tool.progress", event.occurredAt, {
          turnId: claim.turn.turnId,
          nativeType: progress.nativeType,
          ...(progress.toolCallId === undefined
            ? {}
            : { toolCallId: progress.toolCallId }),
          details: progress.details
        });
        return;
      }
      case "turn.completed":
        await this.#terminalOnce(active, "completed", {
          content: terminalContent(event, active.partialText)
        });
        return;
      case "turn.cancelled":
        await this.#terminalOnce(active, "cancelled");
        return;
      case "turn.failed":
        await this.#terminalOnce(active, "failed", {
          errorCode: nativeErrorCode(event, "PROTOCOL_INVALID_MESSAGE")
        });
        return;
    }

    throw new GroupXError(
      "UNEXPECTED_NATIVE_INTERACTION",
      `Unsupported native interaction: ${String(event.type)}`
    );
  }

  async #markStarted(
    active: ActiveDispatch,
    nativeTurnId: string | undefined,
    occurredAt: string
  ): Promise<void> {
    if (active.started) return;
    const { claim, session, sourceEvent } = active.preparation;
    const running = this.#store.markAttemptRunning(
      claim.attempt.attemptId,
      nativeTurnId,
      occurredAt
    );
    active.started = true;
    if (running.attempt.nativeTurnId !== undefined) {
      active.nativeTurnId = running.attempt.nativeTurnId;
    }
    const event = this.#store.appendDurableEvent({
      roomId: sourceEvent.roomId,
      eventType: "turn.started",
      actorId: claim.turn.targetActorId,
      instanceId: session.instanceId,
      targets: [],
      replyToEventId: claim.turn.sourceEventId,
      causationId: claim.turn.turnId,
      correlationId: claim.turn.rootCorrelationId,
      occurredAt,
      body: {
        turnId: claim.turn.turnId,
        attemptId: claim.attempt.attemptId,
        ...(nativeTurnId === undefined ? {} : { nativeTurnId })
      },
      provenance: {
        sourceKind: "adapter",
        authorActorId: claim.turn.targetActorId,
        sourceEventId: claim.turn.sourceEventId
      }
    });
    await this.#publishStored(event);
  }

  #bindNativeTurnId(active: ActiveDispatch, nativeTurnId: string): void {
    if (active.nativeTurnId !== undefined) {
      if (active.nativeTurnId !== nativeTurnId) {
        throw new GroupXError(
          "PROTOCOL_INVALID_MESSAGE",
          "Native Turn id changed during one GroupX Turn attempt"
        );
      }
      return;
    }
    const bound = this.#store.bindAttemptNativeTurnId(
      active.preparation.claim.attempt.attemptId,
      nativeTurnId
    );
    if (bound.attempt.nativeTurnId !== nativeTurnId) {
      throw new GroupXError("STORE_CONFLICT", "Native Turn id binding was not persisted");
    }
    active.nativeTurnId = nativeTurnId;
    if (active.cancelRequested) this.#triggerNativeCancel(active);
  }

  #triggerNativeCancel(active: ActiveDispatch): void {
    void this.#sendNativeCancel(active).catch(() => undefined);
  }

  async #terminalOnce(
    active: ActiveDispatch,
    status: TerminalTurnStatus,
    input: {
      content?: string;
      errorCode?: string;
      eventBody?: Readonly<Record<string, unknown>>;
    } = {}
  ): Promise<void> {
    if (active.terminal) return;
    if (this.#storeWritesFenced) {
      active.terminal = true;
      this.#deactivateTurnLifecycle(active);
      return;
    }
    const current = this.#store.getTurn(active.preparation.claim.turn.turnId);
    if (current && TERMINAL_TURN_STATUSES.has(current.status)) {
      this.#requestAutomaticRecovery(active, current.status, current.errorCode);
      active.terminal = true;
      active.durableStatus = current.status;
      this.#deactivateTurnLifecycle(active);
      this.#notifyTurnTerminal(current.turnId);
      return;
    }
    active.terminal = true;
    try {
      if (
        status !== "completed" &&
        active.partialText !== "" &&
        active.checkpointedLength < active.partialText.length
      ) {
        this.#store.saveTurnPartialText(
          active.preparation.claim.turn.turnId,
          active.partialText
        );
        active.checkpointedLength = active.partialText.length;
      }
      const terminal = this.#store.terminalizeTurn({
        turnId: active.preparation.claim.turn.turnId,
        attemptId: active.preparation.claim.attempt.attemptId,
        status,
        ...(input.content === undefined ? {} : { content: input.content }),
        ...(active.reasoningText === "" ? {} : { reasoning: active.reasoningText }),
        ...(active.toolProgress.length === 0
          ? {}
          : { toolProgress: active.toolProgress }),
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
        ...(input.eventBody === undefined ? {} : { eventBody: input.eventBody }),
        occurredAt: this.#clock.now()
      });
      this.#requestAutomaticRecovery(active, terminal.turn.status, terminal.turn.errorCode);
      active.durableStatus = terminal.turn.status;
      this.#deactivateTurnLifecycle(active);
      this.#notifyTurnTerminal(terminal.turn.turnId);
      if (terminal.reasoningEvent) await this.#publishStored(terminal.reasoningEvent);
      for (const toolProgressEvent of terminal.toolProgressEvents ?? []) {
        await this.#publishStored(toolProgressEvent);
      }
      if (terminal.responseEvent) await this.#publishStored(terminal.responseEvent);
      await this.#publishStored(terminal.terminalEvent);
      if (terminal.datedMemoryRollup !== undefined) {
        try {
          this.#datedMemoryController?.noteCompleted(terminal.datedMemoryRollup);
        } catch (error) {
          this.#report(error, {
            operation: "memory",
            actorId: terminal.turn.targetActorId,
            turnId: terminal.turn.turnId
          });
        }
      }
    } catch (error) {
      const after = this.#store.getTurn(active.preparation.claim.turn.turnId);
      if (after && TERMINAL_TURN_STATUSES.has(after.status)) {
        this.#requestAutomaticRecovery(active, after.status, after.errorCode);
      }
      if (!after || !TERMINAL_TURN_STATUSES.has(after.status)) {
        active.terminal = false;
      }
      throw error;
    }
  }

  async #publishTransient(
    active: ActiveDispatch,
    type: Extract<
      GroupXEventType,
      "turn.content.delta" | "turn.reasoning.delta" | "tool.progress"
    >,
    occurredAt: string,
    body: Record<string, unknown>
  ): Promise<void> {
    const { claim, session, sourceEvent } = active.preparation;
    const actor = this.#store.getActor(claim.turn.targetActorId);
    const envelope = asTransientEnvelope({
      eventId: this.#idFactory("evt"),
      roomId: sourceEvent.roomId,
      type,
      actor: {
        actorId: claim.turn.targetActorId,
        kind: actor?.kind ?? "agent",
        displayName: actor?.displayName ?? claim.turn.targetActorId,
        instanceId: session.instanceId
      },
      to: [],
      causationId: claim.turn.turnId,
      correlationId: claim.turn.rootCorrelationId,
      rootCorrelationId: claim.turn.rootCorrelationId,
      body,
      occurredAt
    });
    await this.#safePublish(envelope, {
      operation: "publish",
      actorId: claim.turn.targetActorId,
      turnId: claim.turn.turnId
    });
  }

  #sendNativeCancel(active: ActiveDispatch): Promise<CancelResult> {
    if (active.nativeCancelPromise) return active.nativeCancelPromise;
    if (!active.nativeTurnId) {
      throw new GroupXError("TURN_INTERRUPTED", "Native Turn id is not available for cancellation");
    }
    const nativeTurnId = active.nativeTurnId;
    const promise = Promise.resolve().then(() =>
      active.preparation.adapter.cancel(active.preparation.session, nativeTurnId)
    );
    active.nativeCancelPromise = promise;
    void promise
      .then(async (result) => {
        active.cancelResult = result;
        if (result.terminalObserved && !active.terminal) {
          await this.#terminalOnce(active, "cancelled");
          active.controller.abort(
            new GroupXError("TURN_INTERRUPTED", "Native cancellation completed")
          );
        }
      })
      .catch((error: unknown) => {
        if (active.nativeCancelPromise === promise) {
          // A failed native cancellation attempt is not a durable receipt.
          // Let a later explicit cancellation retry instead of pinning the
          // rejected promise for the lifetime of the active Turn.
          delete active.nativeCancelPromise;
        }
        this.#report(error, {
          operation: "dispatch",
          actorId: active.preparation.claim.turn.targetActorId,
          turnId: active.preparation.claim.turn.turnId
        });
      });
    return promise;
  }

  async #awaitNativeCancel(active: ActiveDispatch): Promise<CancelResult> {
    const cancel = this.#sendNativeCancel(active);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        cancel,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new GroupXError("TURN_INTERRUPTED", "Native cancellation deadline elapsed")
              ),
            this.#nativeCancelTimeoutMs
          );
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #cancelOutcomeFromStore(turnId: string): CancelTurnOutcome {
    const current = this.#store.getTurn(turnId);
    if (!current) throw new GroupXError("STORE_UNAVAILABLE", "Cancelled Turn disappeared");
    return {
      turnId,
      accepted: true,
      status: current.status
    };
  }

  async #publishStored(event: StoredEventRecord): Promise<void> {
    await this.#safePublish(toEnvelope(event), { operation: "publish" });
  }

  async #safePublish(envelope: GroupXEnvelope, context: BrokerErrorContext): Promise<void> {
    try {
      await this.#publisher.publish(envelope);
    } catch (error) {
      this.#report(error, context);
    }
  }

  #assertSession(adapter: CliAdapter, session: NativeSession, actorId: string): void {
    if (
      session.adapterId !== adapter.adapterId ||
      session.actorId !== actorId ||
      session.bindingId === "" ||
      session.instanceId === ""
    ) {
      throw new GroupXError(
        "MCP_BINDING_MISMATCH",
        "Resolved native session does not match the target Adapter binding"
      );
    }
  }

  #requireBinding(bindingId: string) {
    const binding = this.#store.getSessionBinding(bindingId);
    if (!binding || binding.closedAt !== undefined || binding.status === "closed") {
      throw new GroupXError("MCP_BINDING_MISMATCH", "Binding is missing or closed");
    }
    return binding;
  }

  #sourceKindForBinding(binding: { protocol: string }): "web" | "mcp" {
    return binding.protocol === "local-rest" ? "web" : "mcp";
  }

  #identityRecordForBinding(
    binding: { actorId: string; protocol: string },
    record: Omit<RememberIdentityFromBindingInput, "bindingId" | "clientCommandId" | "roomId" | "correlationId">
  ) {
    if (binding.actorId.startsWith("agent:") && record.subjectActorId !== binding.actorId) {
      return {
        ...record,
        authorActorId: binding.actorId,
        kind: "note",
        sourceKind: "adapter"
      };
    }
    return {
      ...record,
      authorActorId: binding.actorId,
      sourceKind: this.#sourceKindForBinding(binding)
    };
  }

  #canDeliverCurrentMessageOnly(
    sourceEvent: StoredEventRecord,
    lastDeliveredSeq: number
  ): boolean {
    if (lastDeliveredSeq >= sourceEvent.seq) return true;
    const next = this.#store.listEvents({
      roomId: sourceEvent.roomId,
      afterSeq: lastDeliveredSeq,
      limit: 1
    }).events[0];
    return next?.eventId === sourceEvent.eventId;
  }

  #errorCode(error: unknown): string {
    return error instanceof GroupXError ? error.code : "PROTOCOL_INVALID_MESSAGE";
  }

  #report(error: unknown, context: BrokerErrorContext): void {
    try {
      this.#onError?.(error, context);
    } catch {
      // Error reporting is observational and cannot alter Broker state.
    }
  }

  #notifyTurnTerminal(turnId: string): void {
    const listeners = this.#turnWaiters.get(turnId);
    if (!listeners) return;
    for (const listener of [...listeners]) listener();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new GroupXError("SESSION_NOT_AVAILABLE", "Broker is closed");
    }
  }
}
