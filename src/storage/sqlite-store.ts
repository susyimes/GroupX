import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import {
  BUILTIN_ACTORS,
  GROUPX_SCHEMA,
  canonicalHash,
  createCorrelationId,
  createId
} from "../core/envelope.js";
import { GroupXError, toGroupXError } from "../core/errors.js";
import {
  SUPERVISION_WATCH_KIND,
  buildSupervisionWatchBrief,
  isSupervisionWatchMessage
} from "../core/supervision.js";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "./schema.js";
import { DEFAULT_ACCEPT_MESSAGE_LIMITS } from "./types.js";
import type {
  AcceptedTurnResult,
  AcceptMessageInput,
  AcceptMessageLimits,
  AcceptMessageOutcome,
  AcceptMessageResult,
  ActorRecord,
  AgentDatedMemoryRollupRecord,
  AppendAssistantMessageInput,
  AssistantConversationMessageRecord,
  AgentDatedMemorySourceRecord,
  AgentInstanceRecord,
  BeginClientCommandInput,
  BeginClientCommandOutcome,
  ClaimedTurn,
  ClientCommandRecord,
  CommitAgentDatedMemoryRollupInput,
  ContextResetRecord,
  CommitAgentDatedMemoryRollupResult,
  CompleteClientCommandInput,
  CreateAgentInstanceInput,
  CreateIdentityInput,
  CreateMemoryInput,
  CreateSessionBindingInput,
  DeliveryCursorRecord,
  DurableEventInput,
  EnqueueTurnInput,
  EventPage,
  FinishAgentInstanceInput,
  GroupXStore,
  IdentityQuery,
  IdentityRecord,
  IdentityMutationOutcome,
  IntegrityCheckResult,
  MemoryQuery,
  MemoryRecord,
  MemoryMutationOutcome,
  MarkSessionBindingFailedInput,
  MarkSessionBindingReadyInput,
  MutateIdentityInput,
  MutateMemoryInput,
  RecoveryResult,
  RecordAgentDatedMemoryRollupFailureInput,
  ReplaceRoomSummaryInput,
  RoomBootstrapSnapshot,
  RuntimeRecoveryResult,
  SessionBindingRecord,
  StoredEventRecord,
  SupervisionPairRecord,
  SupervisionPairTurnRecord,
  SupervisionTurnRole,
  SummaryRecord,
  TerminalTurnInput,
  TerminalTurnResult,
  TurnAttemptRecord,
  TurnRecord,
  TurnStatus,
  TurnTargetInput,
  UpsertActorInput
} from "./types.js";

type SqliteDatabase = Database.Database;
type Row = Record<string, unknown>;

const OPEN_FILE_DATABASES = new Set<string>();
const TERMINAL_STATUSES = new Set<TurnStatus>([
  "completed",
  "failed",
  "cancelled",
  "interrupted"
]);
const TRANSIENT_EVENT_TYPES = new Set([
  "turn.content.delta",
  "turn.reasoning.delta",
  "turn.progress",
  "tool.progress",
  "adapter.heartbeat"
]);
const WAITS_FOR_CHILDREN_COMMAND_TYPES = new Set(["mcp.ask"]);
const MAX_AGENT_DATED_MEMORY_CHARS = 8_000;

function nowIso(): string {
  return new Date().toISOString();
}

function localDateKey(occurredAt: string): string {
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) {
    throw new GroupXError("INVALID_ENVELOPE", "occurredAt must be a valid timestamp");
  }
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function jsonText(value: unknown): string {
  return JSON.stringify(value);
}

function boundedJsonText(value: unknown, field: string, maxBytes = 64 * 1024): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new GroupXError("INVALID_ENVELOPE", `${field} must be JSON serializable`, undefined, {
      cause: error
    });
  }
  if (typeof encoded !== "string") {
    throw new GroupXError("INVALID_ENVELOPE", `${field} must be a JSON value`);
  }
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) {
    throw new GroupXError(
      "INVALID_ENVELOPE",
      `${field} exceeds the ${maxBytes} byte storage limit`
    );
  }
  return encoded;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") {
    return fallback;
  }
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new GroupXError("STORE_UNAVAILABLE", "Stored JSON is malformed", undefined, {
      cause: error
    });
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new GroupXError("STORE_UNAVAILABLE", `Stored ${field} is invalid`);
  }
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number") {
    throw new GroupXError("STORE_UNAVAILABLE", `Stored ${field} is invalid`);
  }
  return value;
}

function boundedLimit(limit: number | undefined, defaultValue = 100): number {
  if (limit === undefined) {
    return defaultValue;
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new GroupXError("INVALID_ENVELOPE", "limit must be an integer between 1 and 1000");
  }
  return limit;
}

function boundedQueryCursor(cursor: number | undefined): number {
  if (cursor === undefined) {
    return 0;
  }
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > Number.MAX_SAFE_INTEGER) {
    throw new GroupXError(
      "INVALID_ENVELOPE",
      `cursor must be a non-negative safe integer no greater than ${Number.MAX_SAFE_INTEGER}`
    );
  }
  return cursor;
}

function normalizeAcceptMessageLimits(input: AcceptMessageLimits | undefined): AcceptMessageLimits {
  const limits: AcceptMessageLimits = {
    rootTurns: input?.rootTurns ?? DEFAULT_ACCEPT_MESSAGE_LIMITS.rootTurns,
    hopCount: input?.hopCount ?? DEFAULT_ACCEPT_MESSAGE_LIMITS.hopCount,
    actorCallsPerRoot:
      input?.actorCallsPerRoot ?? DEFAULT_ACCEPT_MESSAGE_LIMITS.actorCallsPerRoot,
    queuePerActor: input?.queuePerActor ?? DEFAULT_ACCEPT_MESSAGE_LIMITS.queuePerActor
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new GroupXError(
        "INVALID_ENVELOPE",
        `${name} must be a positive safe integer`
      );
    }
  }
  return limits;
}

function mapActor(row: Row): ActorRecord {
  return {
    actorId: requiredString(row.actor_id, "actor_id"),
    kind: requiredString(row.kind, "kind") as ActorRecord["kind"],
    displayName: requiredString(row.display_name, "display_name"),
    enabled: row.enabled === 1,
    createdAt: requiredString(row.created_at, "created_at"),
    updatedAt: requiredString(row.updated_at, "updated_at")
  };
}

function mapAgentInstance(row: Row): AgentInstanceRecord {
  const record: AgentInstanceRecord = {
    instanceId: requiredString(row.instance_id, "instance_id"),
    actorId: requiredString(row.actor_id, "actor_id"),
    adapterId: requiredString(row.adapter_id, "adapter_id"),
    processStartedAt: requiredString(row.process_started_at, "process_started_at"),
    status: requiredString(row.status, "status") as AgentInstanceRecord["status"]
  };
  const processEndedAt = optionalString(row.process_ended_at);
  const transport = optionalString(row.transport) as AgentInstanceRecord["transport"];
  if (transport !== undefined) record.transport = transport;
  if (processEndedAt !== undefined) {
    record.processEndedAt = processEndedAt;
  }
  return record;
}

function mapSessionBinding(row: Row): SessionBindingRecord {
  const record: SessionBindingRecord = {
    bindingId: requiredString(row.binding_id, "binding_id"),
    instanceId: requiredString(row.instance_id, "instance_id"),
    actorId: requiredString(row.actor_id, "actor_id"),
    protocol: requiredString(row.protocol, "protocol"),
    status: requiredString(row.status, "status") as SessionBindingRecord["status"],
    capabilities: parseJson(row.capabilities_json, {}),
    createdAt: requiredString(row.created_at, "created_at")
  };
  const nativeSessionId = optionalString(row.native_session_id);
  const transport = optionalString(row.transport) as SessionBindingRecord["transport"];
  const protocolVersion = optionalString(row.protocol_version);
  const lastReadyAt = optionalString(row.last_ready_at);
  const closedAt = optionalString(row.closed_at);
  if (nativeSessionId !== undefined) record.nativeSessionId = nativeSessionId;
  if (transport !== undefined) record.transport = transport;
  if (protocolVersion !== undefined) record.protocolVersion = protocolVersion;
  if (lastReadyAt !== undefined) record.lastReadyAt = lastReadyAt;
  if (closedAt !== undefined) record.closedAt = closedAt;
  return record;
}

function mapClientCommand<TResult>(row: Row): ClientCommandRecord<TResult> {
  return {
    commandId: requiredString(row.command_id, "command_id"),
    sourceBindingId: requiredString(row.source_binding_id, "source_binding_id"),
    clientCommandId: requiredString(row.client_command_id, "client_command_id"),
    commandType: requiredString(row.command_type, "command_type"),
    canonicalHash: requiredString(row.canonical_hash, "canonical_hash"),
    completed: row.result_json !== null,
    result: row.result_json === null ? null : parseJson<TResult>(row.result_json, null as TResult),
    acceptedAt: requiredString(row.accepted_at, "accepted_at")
  };
}

function mapEvent(row: Row): StoredEventRecord {
  const record: StoredEventRecord = {
    seq: requiredNumber(row.seq, "seq"),
    eventId: requiredString(row.event_id, "event_id"),
    schemaVersion: requiredString(row.schema_version, "schema_version"),
    roomId: requiredString(row.room_id, "room_id"),
    eventType: requiredString(row.event_type, "event_type"),
    actorId: requiredString(row.actor_id, "actor_id"),
    actorKind: requiredString(row.actor_kind, "actor_kind") as ActorRecord["kind"],
    actorDisplayName: requiredString(row.actor_display_name, "actor_display_name"),
    targets: parseJson<string[]>(row.targets_json, []),
    correlationId: requiredString(row.correlation_id, "correlation_id"),
    occurredAt: requiredString(row.occurred_at, "occurred_at"),
    body: parseJson(row.body_json, null)
  };
  const instanceId = optionalString(row.instance_id);
  const replyToEventId = optionalString(row.reply_to_event_id);
  const causationId = optionalString(row.causation_id);
  const idempotencyKey = optionalString(row.idempotency_key);
  if (instanceId !== undefined) record.instanceId = instanceId;
  if (replyToEventId !== undefined) record.replyToEventId = replyToEventId;
  if (causationId !== undefined) record.causationId = causationId;
  if (idempotencyKey !== undefined) record.idempotencyKey = idempotencyKey;
  if (row.provenance_json !== null) {
    record.provenance = parseJson(
      row.provenance_json,
      {} as NonNullable<StoredEventRecord["provenance"]>
    );
  }
  return record;
}

function mapSupervisionPair(row: Row): SupervisionPairRecord {
  return {
    pairId: requiredString(row.pair_id, "pair_id"),
    roomId: requiredString(row.room_id, "room_id"),
    correlationId: requiredString(row.correlation_id, "correlation_id"),
    sourceEventId: requiredString(row.source_event_id, "source_event_id"),
    watchEventId: requiredString(row.watch_event_id, "watch_event_id"),
    pairEventId: requiredString(row.pair_event_id, "pair_event_id"),
    mode: requiredString(row.mode, "mode") as SupervisionPairRecord["mode"],
    createdAt: requiredString(row.created_at, "created_at")
  };
}

function mapSupervisionPairTurn(row: Row): SupervisionPairTurnRecord {
  return {
    pairId: requiredString(row.pair_id, "pair_id"),
    turnId: requiredString(row.turn_id, "turn_id"),
    role: requiredString(row.role, "role") as SupervisionTurnRole,
    actorId: requiredString(row.actor_id, "actor_id"),
    createdAt: requiredString(row.created_at, "created_at")
  };
}

function mapAssistantMessage(row: Row): AssistantConversationMessageRecord {
  return {
    messageId: requiredString(row.message_id, "message_id"),
    role: requiredString(row.role, "role") as AssistantConversationMessageRecord["role"],
    content: requiredString(row.content, "content"),
    createdAt: requiredString(row.created_at, "created_at"),
    ...(row.client_command_id == null
      ? {}
      : { clientCommandId: requiredString(row.client_command_id, "client_command_id") })
  };
}

function mapTurn(row: Row): TurnRecord {
  const record: TurnRecord = {
    turnId: requiredString(row.turn_id, "turn_id"),
    sourceEventId: requiredString(row.source_event_id, "source_event_id"),
    targetActorId: requiredString(row.target_actor_id, "target_actor_id"),
    adapterId: requiredString(row.adapter_id, "adapter_id"),
    transport: requiredString(row.transport, "transport") as TurnRecord["transport"],
    rootCorrelationId: requiredString(row.root_correlation_id, "root_correlation_id"),
    hopCount: requiredNumber(row.hop_count, "hop_count"),
    queuedEventId: requiredString(row.queued_event_id, "queued_event_id"),
    enqueueSeq: requiredNumber(row.enqueue_seq, "enqueue_seq"),
    status: requiredString(row.status, "status") as TurnStatus,
    queuedAt: requiredString(row.queued_at, "queued_at")
  };
  const optionalFields = {
    bindingId: optionalString(row.binding_id),
    nativeTurnId: optionalString(row.native_turn_id),
    parentTurnId: optionalString(row.parent_turn_id),
    partialText: optionalString(row.partial_text),
    responseEventId: optionalString(row.response_event_id),
    terminalEventId: optionalString(row.terminal_event_id),
    errorCode: optionalString(row.error_code),
    startedAt: optionalString(row.started_at),
    terminalAt: optionalString(row.terminal_at)
  };
  for (const [key, value] of Object.entries(optionalFields)) {
    if (value !== undefined) {
      Object.assign(record, { [key]: value });
    }
  }
  return record;
}

function mapTurnAttempt(row: Row): TurnAttemptRecord {
  const record: TurnAttemptRecord = {
    attemptId: requiredString(row.attempt_id, "attempt_id"),
    turnId: requiredString(row.turn_id, "turn_id"),
    bindingId: requiredString(row.binding_id, "binding_id"),
    instanceId: requiredString(row.instance_id, "instance_id"),
    contextThroughSeq: requiredNumber(row.context_through_seq, "context_through_seq"),
    dispatchPhase: requiredString(
      row.dispatch_phase,
      "dispatch_phase"
    ) as TurnAttemptRecord["dispatchPhase"],
    claimedAt: requiredString(row.claimed_at, "claimed_at"),
    deliveryCertainty: requiredString(
      row.delivery_certainty,
      "delivery_certainty"
    ) as TurnAttemptRecord["deliveryCertainty"]
  };
  const nativeTurnId = optionalString(row.native_turn_id);
  const summaryThroughSeq =
    typeof row.summary_through_seq === "number" ? row.summary_through_seq : undefined;
  const promptInvokedAt = optionalString(row.prompt_invoked_at);
  const startedAt = optionalString(row.started_at);
  const terminalAt = optionalString(row.terminal_at);
  if (nativeTurnId !== undefined) record.nativeTurnId = nativeTurnId;
  if (summaryThroughSeq !== undefined) record.summaryThroughSeq = summaryThroughSeq;
  if (promptInvokedAt !== undefined) record.promptInvokedAt = promptInvokedAt;
  if (startedAt !== undefined) record.startedAt = startedAt;
  if (terminalAt !== undefined) record.terminalAt = terminalAt;
  return record;
}

function mapSummary(row: Row): SummaryRecord {
  return {
    summaryId: requiredString(row.summary_id, "summary_id"),
    roomId: requiredString(row.room_id, "room_id"),
    fromSeq: requiredNumber(row.from_seq, "from_seq"),
    throughSeq: requiredNumber(row.through_seq, "through_seq"),
    content: requiredString(row.content, "content"),
    generatorActorId: requiredString(row.generator_actor_id, "generator_actor_id"),
    status: requiredString(row.status, "status") as SummaryRecord["status"],
    createdAt: requiredString(row.created_at, "created_at")
  };
}

function mapCursor(row: Row): DeliveryCursorRecord {
  const record: DeliveryCursorRecord = {
    actorId: requiredString(row.actor_id, "actor_id"),
    roomId: requiredString(row.room_id, "room_id"),
    lastDeliveredSeq: requiredNumber(row.last_delivered_seq, "last_delivered_seq"),
    updatedAt: requiredString(row.updated_at, "updated_at")
  };
  if (typeof row.last_summary_seq === "number") {
    record.lastSummarySeq = row.last_summary_seq;
  }
  return record;
}

function mapMemory(row: Row): MemoryRecord {
  const record: MemoryRecord = {
    memoryId: requiredString(row.memory_id, "memory_id"),
    scopeType: requiredString(row.scope_type, "scope_type") as MemoryRecord["scopeType"],
    scopeId: requiredString(row.scope_id, "scope_id"),
    kind: requiredString(row.kind, "kind") as MemoryRecord["kind"],
    authorActorId: requiredString(row.author_actor_id, "author_actor_id"),
    content: requiredString(row.content, "content"),
    sourceKind: requiredString(row.source_kind, "source_kind"),
    status: requiredString(row.status, "status") as MemoryRecord["status"],
    createdAt: requiredString(row.created_at, "created_at")
  };
  const optionalFields = {
    agentMemoryType: optionalString(row.agent_memory_type),
    subjectActorId: optionalString(row.subject_actor_id),
    sourceEventId: optionalString(row.source_event_id),
    supersedesMemoryId: optionalString(row.supersedes_memory_id),
    retractedAt: optionalString(row.retracted_at)
  };
  for (const [key, value] of Object.entries(optionalFields)) {
    if (value !== undefined) Object.assign(record, { [key]: value });
  }
  return record;
}

function mapAgentDatedMemoryRollup(row: Row): AgentDatedMemoryRollupRecord {
  const record: AgentDatedMemoryRollupRecord = {
    roomId: requiredString(row.room_id, "room_id"),
    actorId: requiredString(row.actor_id, "actor_id"),
    localDate: requiredString(row.local_date, "local_date"),
    summarizedThroughSeq: requiredNumber(row.summarized_through_seq, "summarized_through_seq"),
    pendingTurns: requiredNumber(row.pending_turns, "pending_turns"),
    pendingChars: requiredNumber(row.pending_chars, "pending_chars"),
    failureCount: requiredNumber(row.failure_count, "failure_count"),
    updatedAt: requiredString(row.updated_at, "updated_at")
  };
  const memoryId = optionalString(row.memory_id);
  const pendingThroughSeq =
    typeof row.pending_through_seq === "number" ? row.pending_through_seq : undefined;
  const firstPendingAt = optionalString(row.first_pending_at);
  const lastPendingAt = optionalString(row.last_pending_at);
  const lastAttemptAt = optionalString(row.last_attempt_at);
  const nextAttemptAt = optionalString(row.next_attempt_at);
  const lastErrorCode = optionalString(row.last_error_code);
  if (memoryId !== undefined) record.memoryId = memoryId;
  if (pendingThroughSeq !== undefined) record.pendingThroughSeq = pendingThroughSeq;
  if (firstPendingAt !== undefined) record.firstPendingAt = firstPendingAt;
  if (lastPendingAt !== undefined) record.lastPendingAt = lastPendingAt;
  if (lastAttemptAt !== undefined) record.lastAttemptAt = lastAttemptAt;
  if (nextAttemptAt !== undefined) record.nextAttemptAt = nextAttemptAt;
  if (lastErrorCode !== undefined) record.lastErrorCode = lastErrorCode;
  return record;
}

function mapAgentDatedMemorySource(row: Row): AgentDatedMemorySourceRecord {
  const sourceBody = parseJson<Record<string, unknown>>(row.source_body_json, {});
  const responseBody = parseJson<Record<string, unknown>>(row.response_body_json, {});
  if (typeof sourceBody.content !== "string" || typeof responseBody.content !== "string") {
    throw new GroupXError(
      "STORE_UNAVAILABLE",
      "A dated-memory source is missing its message content"
    );
  }
  const record: AgentDatedMemorySourceRecord = {
    turnId: requiredString(row.turn_id, "turn_id"),
    roomId: requiredString(row.room_id, "room_id"),
    actorId: requiredString(row.actor_id, "actor_id"),
    localDate: requiredString(row.local_date, "local_date"),
    sourceEventId: requiredString(row.source_event_id, "source_event_id"),
    sourceSeq: requiredNumber(row.source_seq, "source_seq"),
    responseEventId: requiredString(row.response_event_id, "response_event_id"),
    responseSeq: requiredNumber(row.response_seq, "response_seq"),
    currentMessage: sourceBody.content,
    finalResponse: responseBody.content,
    sourceChars: requiredNumber(row.source_chars, "source_chars"),
    terminalAt: requiredString(row.terminal_at, "terminal_at")
  };
  const processedAt = optionalString(row.processed_at);
  const memoryId = optionalString(row.memory_id);
  if (processedAt !== undefined) record.processedAt = processedAt;
  if (memoryId !== undefined) record.memoryId = memoryId;
  return record;
}

function mapIdentity(row: Row): IdentityRecord {
  const record: IdentityRecord = {
    identityId: requiredString(row.identity_id, "identity_id"),
    subjectActorId: requiredString(row.subject_actor_id, "subject_actor_id"),
    authorActorId: requiredString(row.author_actor_id, "author_actor_id"),
    kind: requiredString(row.kind, "kind"),
    content: requiredString(row.content, "content"),
    sourceKind: requiredString(row.source_kind, "source_kind"),
    status: requiredString(row.status, "status") as IdentityRecord["status"],
    createdAt: requiredString(row.created_at, "created_at")
  };
  const optionalFields = {
    sourceEventId: optionalString(row.source_event_id),
    supersedesIdentityId: optionalString(row.supersedes_identity_id),
    retractedAt: optionalString(row.retracted_at)
  };
  for (const [key, value] of Object.entries(optionalFields)) {
    if (value !== undefined) Object.assign(record, { [key]: value });
  }
  return record;
}

export class SqliteGroupXStore implements GroupXStore {
  readonly databasePath: string;
  readonly #registryKey: string | undefined;
  #database: SqliteDatabase;
  #closed = false;
  #journalMode = "unknown";

  constructor(databasePath: string) {
    this.databasePath = databasePath === ":memory:" ? databasePath : resolve(databasePath);
    this.#registryKey = databasePath === ":memory:" ? undefined : this.databasePath.toLowerCase();

    if (this.#registryKey !== undefined) {
      if (OPEN_FILE_DATABASES.has(this.#registryKey)) {
        throw new GroupXError(
          "STORE_CONFLICT",
          "The database already has an in-process GroupX writer"
        );
      }
      mkdirSync(dirname(this.databasePath), { recursive: true });
      OPEN_FILE_DATABASES.add(this.#registryKey);
    }

    let database: SqliteDatabase | undefined;
    try {
      database = new Database(this.databasePath);
      this.#database = database;
      this.#database.pragma("foreign_keys = ON");
      this.#database.pragma("busy_timeout = 5000");
      this.#journalMode = String(this.#database.pragma("journal_mode = WAL", { simple: true }));
      this.#database.pragma("synchronous = NORMAL");
      this.#migrate();
      this.#seedBuiltInActors();
    } catch (error) {
      let closeError: unknown;
      try {
        database?.close();
      } catch (caught) {
        closeError = caught;
      }
      this.#closed = closeError === undefined;
      if (closeError === undefined) {
        this.#registryKey && OPEN_FILE_DATABASES.delete(this.#registryKey);
      }
      if (closeError !== undefined) {
        throw new GroupXError(
          "STORE_UNAVAILABLE",
          "Store initialization failed and the database handle could not be closed",
          undefined,
          { cause: new AggregateError([error, closeError]) }
        );
      }
      throw toGroupXError(error);
    }
  }

  getSchemaVersion(): number {
    this.#assertOpen();
    return Number(this.#database.pragma("user_version", { simple: true }));
  }

  getJournalMode(): string {
    this.#assertOpen();
    return this.#journalMode;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new GroupXError("STORE_UNAVAILABLE", "The GroupX store is closed");
    }
  }

  #migrate(): void {
    const currentVersion = Number(this.#database.pragma("user_version", { simple: true }));
    if (currentVersion > CURRENT_SCHEMA_VERSION) {
      throw new GroupXError(
        "STORE_UNAVAILABLE",
        `Database schema ${currentVersion} is newer than supported ${CURRENT_SCHEMA_VERSION}`
      );
    }

    for (const migration of MIGRATIONS) {
      if (migration.version <= currentVersion) continue;
      this.#withImmediateTransaction(() => {
        this.#database.exec(migration.sql);
        this.#database
          .prepare(
            "INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)"
          )
          .run(migration.version, migration.name, nowIso());
        this.#database.exec(`PRAGMA user_version = ${migration.version}`);
      });
    }
  }

  #seedBuiltInActors(): void {
    const timestamp = nowIso();
    const insert = this.#database.prepare(`
      INSERT OR IGNORE INTO actors(
        actor_id, kind, display_name, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, ?)
    `);
    this.#withImmediateTransaction(() => {
      for (const actor of Object.values(BUILTIN_ACTORS)) {
        insert.run(actor.actorId, actor.kind, actor.displayName, timestamp, timestamp);
      }
    });
  }

  #withImmediateTransaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.#database.inTransaction) {
        this.#database.exec("ROLLBACK");
      }
      throw error;
    }
  }

  #withReadTransaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.#database.inTransaction) {
        this.#database.exec("ROLLBACK");
      }
      throw error;
    }
  }

  #mapConstraint(error: unknown, duplicateTurn = false): never {
    if (error instanceof GroupXError) throw error;
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code: unknown }).code)
        : "";
    const message = error instanceof Error ? error.message : "";
    if (
      duplicateTurn &&
      code.includes("SQLITE_CONSTRAINT_UNIQUE") &&
      message.includes("turns.source_event_id") &&
      message.includes("turns.target_actor_id")
    ) {
      throw new GroupXError("DUPLICATE_DISPATCH", "A Turn already exists for this event target", {
        sqliteCode: code
      });
    }
    if (code.startsWith("SQLITE_CONSTRAINT")) {
      throw new GroupXError("STORE_CONFLICT", "A durable store constraint rejected the write", {
        sqliteCode: code
      });
    }
    throw toGroupXError(error);
  }

  upsertActor(input: UpsertActorInput): ActorRecord {
    this.#assertOpen();
    const timestamp = input.now ?? nowIso();
    this.#database
      .prepare(`
        INSERT INTO actors(actor_id, kind, display_name, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(actor_id) DO UPDATE SET
          kind = excluded.kind,
          display_name = excluded.display_name,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
      `)
      .run(input.actorId, input.kind, input.displayName, input.enabled === false ? 0 : 1, timestamp, timestamp);
    return this.getActor(input.actorId)!;
  }

  getActor(actorId: string): ActorRecord | undefined {
    this.#assertOpen();
    const row = this.#database.prepare("SELECT * FROM actors WHERE actor_id = ?").get(actorId) as
      | Row
      | undefined;
    return row ? mapActor(row) : undefined;
  }

  listActors(): ActorRecord[] {
    this.#assertOpen();
    return (this.#database.prepare("SELECT * FROM actors ORDER BY actor_id").all() as Row[]).map(mapActor);
  }

  createAgentInstance(input: CreateAgentInstanceInput): AgentInstanceRecord {
    this.#assertOpen();
    const actor = this.getActor(input.actorId);
    if (!actor) {
      throw new GroupXError("UNKNOWN_ACTOR", `Unknown Agent instance actor: ${input.actorId}`);
    }
    if (actor.kind === "agent" && input.transport === undefined) {
      throw new GroupXError(
        "INVALID_ENVELOPE",
        "Agent instances must snapshot direct or structured transport"
      );
    }
    try {
      this.#database
        .prepare(`
          INSERT INTO agent_instances(
            instance_id, actor_id, adapter_id, transport, process_started_at, status
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.instanceId,
          input.actorId,
          input.adapterId,
          input.transport ?? null,
          input.processStartedAt ?? nowIso(),
          input.status ?? "starting"
        );
      return this.getAgentInstance(input.instanceId)!;
    } catch (error) {
      this.#mapConstraint(error);
    }
  }

  getAgentInstance(instanceId: string): AgentInstanceRecord | undefined {
    this.#assertOpen();
    const row = this.#database
      .prepare("SELECT * FROM agent_instances WHERE instance_id = ?")
      .get(instanceId) as Row | undefined;
    return row ? mapAgentInstance(row) : undefined;
  }

  finishAgentInstance(
    instanceId: string,
    input: FinishAgentInstanceInput
  ): AgentInstanceRecord {
    this.#assertOpen();
    return this.#withImmediateTransaction(() => {
      const existing = this.getAgentInstance(instanceId);
      if (!existing) {
        throw new GroupXError("STORE_CONFLICT", "Agent instance does not exist");
      }
      if (existing.processEndedAt !== undefined) {
        if (
          existing.status !== input.status ||
          (input.processEndedAt !== undefined && input.processEndedAt !== existing.processEndedAt)
        ) {
          throw new GroupXError("STORE_CONFLICT", "Agent instance is already terminal");
        }
      } else {
        const endedAt = input.processEndedAt ?? nowIso();
        const result = this.#database
          .prepare(`
            UPDATE agent_instances
            SET status = ?, process_ended_at = ?
            WHERE instance_id = ? AND process_ended_at IS NULL
          `)
          .run(input.status, endedAt, instanceId);
        if (result.changes !== 1) {
          throw new GroupXError("STORE_CONFLICT", "Agent instance finish compare-and-set failed");
        }
      }

      const terminal = this.getAgentInstance(instanceId)!;
      const bindingStatus = input.status === "stopped" ? "closed" : input.status;
      this.#database
        .prepare(`
          UPDATE session_bindings
          SET status = ?, closed_at = ?
          WHERE instance_id = ? AND closed_at IS NULL
        `)
        .run(bindingStatus, terminal.processEndedAt!, instanceId);
      return terminal;
    });
  }

  createSessionBinding(input: CreateSessionBindingInput): SessionBindingRecord {
    this.#assertOpen();
    const instance = this.getAgentInstance(input.instanceId);
    if (!instance || instance.actorId !== input.actorId) {
      throw new GroupXError(
        "MCP_BINDING_MISMATCH",
        "Session binding actor does not match its process instance"
      );
    }
    if (
      instance.processEndedAt !== undefined ||
      (instance.status !== "starting" && instance.status !== "ready")
    ) {
      throw new GroupXError(
        "MCP_BINDING_MISMATCH",
        "Session binding instance is not active"
      );
    }
    const actor = this.getActor(input.actorId);
    if (!actor) {
      throw new GroupXError("UNKNOWN_ACTOR", `Unknown Session binding actor: ${input.actorId}`);
    }
    if (
      actor.kind === "agent" &&
      (input.transport === undefined || input.transport !== instance.transport)
    ) {
      throw new GroupXError(
        "TRANSPORT_MODE_MISMATCH",
        "Session binding transport must match its Agent instance"
      );
    }
    if (
      input.transport !== undefined &&
      instance.transport !== undefined &&
      input.transport !== instance.transport
    ) {
      throw new GroupXError(
        "TRANSPORT_MODE_MISMATCH",
        "Session binding transport must match its process instance"
      );
    }
    try {
      this.#database
        .prepare(`
          INSERT INTO session_bindings(
            binding_id, instance_id, actor_id, native_session_id, protocol,
            transport, protocol_version, status, capabilities_json, created_at, last_ready_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.bindingId,
          input.instanceId,
          input.actorId,
          input.nativeSessionId ?? null,
          input.protocol,
          input.transport ?? null,
          input.protocolVersion ?? null,
          input.status ?? "ready",
          boundedJsonText(input.capabilities ?? {}, "capabilities"),
          input.createdAt ?? nowIso(),
          input.lastReadyAt ?? null
        );
      return this.getSessionBinding(input.bindingId)!;
    } catch (error) {
      this.#mapConstraint(error);
    }
  }

  getSessionBinding(bindingId: string): SessionBindingRecord | undefined {
    this.#assertOpen();
    const row = this.#database
      .prepare("SELECT * FROM session_bindings WHERE binding_id = ?")
      .get(bindingId) as Row | undefined;
    return row ? mapSessionBinding(row) : undefined;
  }

  listSessionBindings(): SessionBindingRecord[] {
    this.#assertOpen();
    return (
      this.#database.prepare("SELECT * FROM session_bindings ORDER BY created_at, binding_id").all() as Row[]
    ).map(mapSessionBinding);
  }

  markSessionBindingReady(
    bindingId: string,
    input: MarkSessionBindingReadyInput = {}
  ): SessionBindingRecord {
    this.#assertOpen();
    return this.#withImmediateTransaction(() => {
      const binding = this.getSessionBinding(bindingId);
      if (!binding || binding.closedAt !== undefined) {
        throw new GroupXError("STORE_CONFLICT", "Session binding is missing or already closed");
      }
      const instance = this.getAgentInstance(binding.instanceId);
      if (!instance || instance.processEndedAt !== undefined) {
        throw new GroupXError("STORE_CONFLICT", "Session binding instance is not active");
      }
      if (
        input.nativeSessionId !== undefined &&
        binding.nativeSessionId !== undefined &&
        input.nativeSessionId !== binding.nativeSessionId
      ) {
        throw new GroupXError(
          "STORE_CONFLICT",
          "Session binding native id is already bound to a different value"
        );
      }
      if (
        input.protocolVersion !== undefined &&
        binding.protocolVersion !== undefined &&
        input.protocolVersion !== binding.protocolVersion
      ) {
        throw new GroupXError(
          "STORE_CONFLICT",
          "Session binding protocol version cannot change in place"
        );
      }
      const readyAt = input.lastReadyAt ?? nowIso();
      const bindingUpdated = this.#database
        .prepare(`
          UPDATE session_bindings
          SET status = 'ready',
              native_session_id = COALESCE(native_session_id, ?),
              protocol_version = COALESCE(protocol_version, ?),
              capabilities_json = ?,
              last_ready_at = ?
          WHERE binding_id = ? AND closed_at IS NULL
        `)
        .run(
          input.nativeSessionId ?? null,
          input.protocolVersion ?? null,
          boundedJsonText(input.capabilities ?? binding.capabilities, "capabilities"),
          readyAt,
          bindingId
        );
      const instanceUpdated = this.#database
        .prepare(`
          UPDATE agent_instances
          SET status = 'ready'
          WHERE instance_id = ? AND process_ended_at IS NULL
        `)
        .run(binding.instanceId);
      if (bindingUpdated.changes !== 1 || instanceUpdated.changes !== 1) {
        throw new GroupXError("STORE_CONFLICT", "Session ready compare-and-set failed");
      }
      return this.getSessionBinding(bindingId)!;
    });
  }

  markSessionBindingFailed(
    bindingId: string,
    input: MarkSessionBindingFailedInput = {}
  ): SessionBindingRecord {
    this.#assertOpen();
    const existing = this.getSessionBinding(bindingId);
    const status = input.status ?? "failed";
    if (!existing) {
      throw new GroupXError("STORE_CONFLICT", "Session binding does not exist");
    }
    if (existing.closedAt !== undefined) {
      if (
        existing.status === status &&
        (input.closedAt === undefined || input.closedAt === existing.closedAt)
      ) {
        return existing;
      }
      throw new GroupXError("STORE_CONFLICT", "Session binding is already closed");
    }
    const closedAt = input.closedAt ?? nowIso();
    const result = this.#database
      .prepare(`
        UPDATE session_bindings
        SET status = ?, closed_at = ?
        WHERE binding_id = ? AND closed_at IS NULL
      `)
      .run(status, closedAt, bindingId);
    if (result.changes !== 1) {
      throw new GroupXError("STORE_CONFLICT", "Session failure compare-and-set failed");
    }
    return this.getSessionBinding(bindingId)!;
  }

  closeSessionBinding(bindingId: string, closedAt = nowIso()): SessionBindingRecord {
    this.#assertOpen();
    const result = this.#database
      .prepare(`
        UPDATE session_bindings
        SET status = 'closed', closed_at = ?
        WHERE binding_id = ? AND closed_at IS NULL
      `)
      .run(closedAt, bindingId);
    if (result.changes !== 1) {
      throw new GroupXError("STORE_CONFLICT", "Session binding is missing or already closed");
    }
    return this.getSessionBinding(bindingId)!;
  }

  recoverStaleRuntimeRecords(now = nowIso()): RuntimeRecoveryResult {
    this.#assertOpen();
    return this.#withImmediateTransaction(() => {
      // local-rest Web rows are stable logical idempotency scopes, not process or auth state.
      const bindingIds = (
        this.#database
          .prepare(`
            SELECT session_bindings.binding_id
            FROM session_bindings
            JOIN actors ON actors.actor_id = session_bindings.actor_id
            WHERE session_bindings.closed_at IS NULL
              AND actors.kind = 'agent'
            ORDER BY session_bindings.created_at, session_bindings.binding_id
          `)
          .all() as Row[]
      ).map((row) => requiredString(row.binding_id, "binding_id"));
      const instanceIds = (
        this.#database
          .prepare(`
            SELECT agent_instances.instance_id
            FROM agent_instances
            JOIN actors ON actors.actor_id = agent_instances.actor_id
            WHERE agent_instances.process_ended_at IS NULL
              AND actors.kind = 'agent'
            ORDER BY agent_instances.process_started_at, agent_instances.instance_id
          `)
          .all() as Row[]
      ).map((row) => requiredString(row.instance_id, "instance_id"));

      if (bindingIds.length > 0) {
        this.#database
          .prepare(`
            UPDATE session_bindings
            SET status = 'interrupted', closed_at = ?
            WHERE closed_at IS NULL
              AND actor_id IN (SELECT actor_id FROM actors WHERE kind = 'agent')
          `)
          .run(now);
      }
      if (instanceIds.length > 0) {
        this.#database
          .prepare(`
            UPDATE agent_instances
            SET status = 'interrupted', process_ended_at = ?
            WHERE process_ended_at IS NULL
              AND actor_id IN (SELECT actor_id FROM actors WHERE kind = 'agent')
          `)
          .run(now);
      }

      return {
        sessionBindings: bindingIds.map((bindingId) => this.getSessionBinding(bindingId)!),
        agentInstances: instanceIds.map((instanceId) => this.getAgentInstance(instanceId)!)
      };
    });
  }

  getClientCommand<TResult = unknown>(
    sourceBindingId: string,
    clientCommandId: string
  ): ClientCommandRecord<TResult> | undefined {
    this.#assertOpen();
    const row = this.#database
      .prepare(`
        SELECT * FROM client_commands
        WHERE source_binding_id = ? AND client_command_id = ?
      `)
      .get(sourceBindingId, clientCommandId) as Row | undefined;
    return row ? mapClientCommand<TResult>(row) : undefined;
  }

  beginClientCommand<TResult = unknown>(
    input: BeginClientCommandInput
  ): BeginClientCommandOutcome<TResult> {
    this.#assertOpen();
    if (input.commandType.trim() === "") {
      throw new GroupXError("INVALID_ENVELOPE", "commandType must not be empty");
    }
    boundedJsonText(input.canonicalPayload, "canonicalPayload");
    const hash = canonicalHash({
      commandType: input.commandType,
      canonicalPayload: input.canonicalPayload
    });
    try {
      return this.#withImmediateTransaction(() => {
        const existing = this.getClientCommand<TResult>(
          input.sourceBindingId,
          input.clientCommandId
        );
        if (existing !== undefined) {
          if (existing.commandType !== input.commandType || existing.canonicalHash !== hash) {
            throw new GroupXError(
              "CLIENT_COMMAND_CONFLICT",
              "The client command id was already used with a different canonical payload"
            );
          }
          return existing.completed
            ? { disposition: "replayed", result: existing.result as TResult }
            : { disposition: "pending" };
        }

        this.#requireOpenBinding(input.sourceBindingId);
        this.#database
          .prepare(`
            INSERT INTO client_commands(
              command_id, source_binding_id, client_command_id, command_type,
              canonical_hash, result_json, accepted_at
            ) VALUES (?, ?, ?, ?, ?, NULL, ?)
          `)
          .run(
            createId("cmd"),
            input.sourceBindingId,
            input.clientCommandId,
            input.commandType,
            hash,
            input.acceptedAt ?? nowIso()
          );
        return { disposition: "accepted" };
      });
    } catch (error) {
      this.#mapConstraint(error);
    }
  }

  completeClientCommand<TResult = unknown>(
    input: CompleteClientCommandInput<TResult>
  ): TResult {
    this.#assertOpen();
    const encodedResult = boundedJsonText(input.result, "client command result");
    return this.#withImmediateTransaction(() => {
      const existing = this.getClientCommand<TResult>(
        input.sourceBindingId,
        input.clientCommandId
      );
      if (existing === undefined) {
        throw new GroupXError("STORE_CONFLICT", "Client command was not claimed");
      }
      if (existing.completed) {
        if (canonicalHash(existing.result) !== canonicalHash(input.result)) {
          throw new GroupXError(
            "CLIENT_COMMAND_CONFLICT",
            "Client command was already completed with a different result"
          );
        }
        return existing.result as TResult;
      }

      const completed = this.#database
        .prepare(`
          UPDATE client_commands SET result_json = ?
          WHERE source_binding_id = ? AND client_command_id = ?
            AND result_json IS NULL
        `)
        .run(encodedResult, input.sourceBindingId, input.clientCommandId);
      if (completed.changes !== 1) {
        throw new GroupXError("STORE_CONFLICT", "Client command result compare-and-set failed");
      }
      return input.result;
    });
  }

  acceptMessage(input: AcceptMessageInput): AcceptMessageResult {
    return this.acceptMessageWithDisposition(input).result;
  }

  acceptMessageWithDisposition(input: AcceptMessageInput): AcceptMessageOutcome {
    this.#assertOpen();
    const commandType = input.commandType ?? "message.send";
    const isPublication = commandType === "mcp.publish";
    if (input.targets.length === 0 && !isPublication) {
      throw new GroupXError("INVALID_ENVELOPE", "At least one target is required");
    }
    if (isPublication && input.targets.length !== 0) {
      throw new GroupXError("INVALID_ENVELOPE", "mcp.publish cannot create target Turns");
    }
    if (isPublication && input.supervision !== undefined) {
      throw new GroupXError("SUPERVISION_PAIR_INVALID", "mcp.publish cannot create supervision Turns");
    }

    const normalizedTargets = this.#normalizeTurnTargets(input.targets);
    const normalizedObservers =
      input.supervision === undefined
        ? []
        : this.#normalizeTurnTargets(input.supervision.observers);
    if (input.supervision !== undefined) {
      if (normalizedObservers.length === 0) {
        throw new GroupXError(
          "SUPERVISION_PAIR_INVALID",
          "A supervision pair requires at least one observer"
        );
      }
      const workers = new Set(normalizedTargets.map((target) => target.actorId));
      const overlap = normalizedObservers.find((observer) => workers.has(observer.actorId));
      if (overlap !== undefined) {
        throw new GroupXError(
          "SUPERVISION_PAIR_INVALID",
          "A supervision observer cannot also be a worker in the same command",
          { actorId: overlap.actorId }
        );
      }
    }

    const canonicalPayload = {
      commandType,
      roomId: input.roomId,
      targets: normalizedTargets.map((target) => ({
        actorId: target.actorId,
        adapterId: target.adapterId,
        bindingId: target.bindingId ?? null,
        parentTurnId: target.parentTurnId ?? null,
        hopCount: target.hopCount ?? 0
      })),
      content: input.content,
      replyToEventId: input.replyToEventId ?? null,
      causationId: input.causationId ?? null,
      correlationId: input.correlationId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      provenance: input.provenance ?? null,
      sourceEventType: input.sourceEventType ?? "message.created",
      operation: input.operation ?? null,
      existingSourceEventId: input.existingSourceEventId ?? null,
      supervision:
        input.supervision === undefined
          ? null
          : {
              mode: input.supervision.mode,
              observers: normalizedObservers.map((target) => ({
                actorId: target.actorId,
                adapterId: target.adapterId,
                bindingId: target.bindingId ?? null,
                parentTurnId: target.parentTurnId ?? null,
                hopCount: target.hopCount ?? 0
              }))
            }
    };
    const hash = canonicalHash(canonicalPayload);
    const existing = this.getClientCommand<AcceptMessageResult>(
      input.sourceBindingId,
      input.clientCommandId
    );
    if (existing) {
      if (existing.commandType !== commandType || existing.canonicalHash !== hash) {
        throw new GroupXError(
          "CLIENT_COMMAND_CONFLICT",
          "The client command id was already used with a different canonical payload"
        );
      }
      if (existing.result === null) {
        throw new GroupXError("STORE_UNAVAILABLE", "Committed command is missing its result");
      }
      return { result: existing.result, disposition: "replayed" };
    }

    const acceptedAt = input.occurredAt ?? nowIso();
    const correlationId = input.correlationId ?? createCorrelationId();

    try {
      return this.#withImmediateTransaction<AcceptMessageOutcome>(() => {
        const raced = this.getClientCommand<AcceptMessageResult>(
          input.sourceBindingId,
          input.clientCommandId
        );
        if (raced !== undefined) {
          if (raced.commandType !== commandType || raced.canonicalHash !== hash) {
            throw new GroupXError(
              "CLIENT_COMMAND_CONFLICT",
              "The client command id was already used with a different canonical payload"
            );
          }
          if (raced.result === null) {
            throw new GroupXError("STORE_UNAVAILABLE", "Committed command is missing its result");
          }
          return { result: raced.result, disposition: "replayed" };
        }

        const limits = normalizeAcceptMessageLimits(input.limits);
        const binding = this.#requireOpenBinding(input.sourceBindingId);
        this.#database
          .prepare(`
            INSERT INTO client_commands(
              command_id, source_binding_id, client_command_id, command_type,
              canonical_hash, result_json, accepted_at
            ) VALUES (?, ?, ?, ?, ?, NULL, ?)
          `)
          .run(
            createId("cmd"),
            input.sourceBindingId,
            input.clientCommandId,
            commandType,
            hash,
            acceptedAt
          );

        if (!isPublication) {
          const limitTargets = [...normalizedTargets, ...normalizedObservers];
          this.#enforceAcceptMessageLimitsUnsafe(
            limitTargets,
            correlationId,
            limits
          );
          this.#enforceCausalGraphUnsafe({
            targets: limitTargets,
            rootCorrelationId: correlationId,
            ...(input.correlationId === undefined
              ? {}
              : { requestedCorrelationId: input.correlationId }),
            roomId: input.roomId,
            sourceActorId: binding.actorId,
            commandType
          });
        }

        const sourceEventType = input.sourceEventType ?? "message.created";
        if (sourceEventType !== "message.created" && sourceEventType !== "operator.dispatch") {
          throw new GroupXError("INVALID_ENVELOPE", "Unsupported source event type");
        }
        if (
          input.existingSourceEventId !== undefined &&
          sourceEventType === "operator.dispatch"
        ) {
          throw new GroupXError(
            "INVALID_ENVELOPE",
            "dispatch_event cannot create an operator.dispatch source"
          );
        }

        let event: StoredEventRecord;
        if (input.existingSourceEventId !== undefined) {
          const existing = this.getEvent(input.existingSourceEventId);
          if (!existing || existing.roomId !== input.roomId) {
            throw new GroupXError("UNKNOWN_TARGET", "The source event does not exist in this room");
          }
          if (existing.eventType !== "message.created") {
            throw new GroupXError(
              "INVALID_ENVELOPE",
              "dispatch_event can only reference a public room message"
            );
          }
          if (isSupervisionWatchMessage(existing.body)) {
            throw new GroupXError(
              "INVALID_ENVELOPE",
              "dispatch_event cannot reuse a supervision watch brief"
            );
          }
          event = existing;
        } else {
          const operation =
            input.operation ??
            (sourceEventType === "operator.dispatch" ? "worker_dispatch" : "send");
          event = this.#insertEventUnsafe({
            roomId: input.roomId,
            eventType: sourceEventType,
            actorId: binding.actorId,
            instanceId: binding.instanceId,
            targets: normalizedTargets.map((target) => target.actorId),
            ...(input.replyToEventId === undefined
              ? {}
              : { replyToEventId: input.replyToEventId }),
            ...(input.causationId === undefined ? {} : { causationId: input.causationId }),
            correlationId,
            ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
            occurredAt: acceptedAt,
            body:
              sourceEventType === "operator.dispatch"
                ? {
                    content: input.content,
                    operation,
                    promptLength: input.content.length,
                    targets: normalizedTargets.map((target) => target.actorId)
                  }
                : { content: input.content },
            ...(input.provenance === undefined ? {} : { provenance: input.provenance })
          });
        }

        const workerTurns = normalizedTargets.map((target) => {
          const turn = this.#insertTurnUnsafe({
            turnId: createId("turn"),
            sourceEventId: event.eventId,
            targetActorId: target.actorId,
            adapterId: target.adapterId,
            transport: target.transport,
            rootCorrelationId: correlationId,
            ...(target.bindingId === undefined ? {} : { bindingId: target.bindingId }),
            ...(target.parentTurnId === undefined
              ? {}
              : { parentTurnId: target.parentTurnId }),
            hopCount: target.hopCount ?? 0,
            queuedAt: acceptedAt
          });
          return { target: target.actorId, turnId: turn.turnId, status: "queued" as const };
        });

        let watchTurns: AcceptedTurnResult[] | undefined;
        let watchEventId: string | undefined;
        let pairEventId: string | undefined;
        if (input.supervision !== undefined) {
          const watchBrief = buildSupervisionWatchBrief({
            task: input.content,
            workers: workerTurns.map((turn) => ({
              actorId: turn.target,
              turnId: turn.turnId
            })),
            observers: normalizedObservers.map((observer) => observer.actorId)
          });
          const watchEvent = this.#insertEventUnsafe({
            roomId: input.roomId,
            eventType: "message.created",
            actorId: BUILTIN_ACTORS.system.actorId,
            targets: normalizedObservers.map((observer) => observer.actorId),
            replyToEventId: event.eventId,
            causationId: event.eventId,
            correlationId,
            occurredAt: acceptedAt,
            body: { content: watchBrief, kind: SUPERVISION_WATCH_KIND },
            provenance: {
              sourceKind: "supervision",
              authorActorId: binding.actorId,
              sourceEventId: event.eventId,
              labels: ["supervision.watch"]
            }
          });
          watchEventId = watchEvent.eventId;
          watchTurns = normalizedObservers.map((observer) => {
            const turn = this.#insertTurnUnsafe({
              turnId: createId("turn"),
              sourceEventId: watchEvent.eventId,
              targetActorId: observer.actorId,
              adapterId: observer.adapterId,
              transport: observer.transport,
              rootCorrelationId: correlationId,
              ...(observer.bindingId === undefined ? {} : { bindingId: observer.bindingId }),
              ...(observer.parentTurnId === undefined
                ? {}
                : { parentTurnId: observer.parentTurnId }),
              hopCount: observer.hopCount ?? 0,
              queuedAt: acceptedAt
            });
            return { target: observer.actorId, turnId: turn.turnId, status: "queued" as const };
          });
          const pairId = createId("pair");
          const pairEvent = this.#insertEventUnsafe({
            roomId: input.roomId,
            eventType: "supervision.paired",
            actorId: BUILTIN_ACTORS.system.actorId,
            targets: [
              ...normalizedTargets.map((target) => target.actorId),
              ...normalizedObservers.map((observer) => observer.actorId)
            ],
            replyToEventId: event.eventId,
            causationId: event.eventId,
            correlationId,
            occurredAt: acceptedAt,
            body: {
              pairId,
              mode: input.supervision.mode,
              sourceEventId: event.eventId,
              watchEventId: watchEvent.eventId,
              workers: workerTurns.map((turn) => ({
                actorId: turn.target,
                turnId: turn.turnId
              })),
              observers: watchTurns.map((turn) => ({
                actorId: turn.target,
                turnId: turn.turnId
              }))
            },
            provenance: {
              sourceKind: "supervision",
              authorActorId: binding.actorId,
              sourceEventId: event.eventId
            }
          });
          pairEventId = pairEvent.eventId;
          this.#database
            .prepare(`
              INSERT INTO supervision_pairs(
                pair_id, room_id, correlation_id, source_event_id, watch_event_id,
                pair_event_id, mode, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .run(
              pairId,
              input.roomId,
              correlationId,
              event.eventId,
              watchEvent.eventId,
              pairEvent.eventId,
              input.supervision.mode,
              acceptedAt
            );
          const insertPairTurn = this.#database.prepare(`
            INSERT INTO supervision_pair_turns(turn_id, pair_id, role, actor_id, created_at)
            VALUES (?, ?, ?, ?, ?)
          `);
          for (const turn of workerTurns) {
            insertPairTurn.run(turn.turnId, pairId, "worker", turn.target, acceptedAt);
          }
          for (const turn of watchTurns) {
            insertPairTurn.run(turn.turnId, pairId, "observer", turn.target, acceptedAt);
          }
        }

        const acceptance: AcceptMessageResult = {
          messageEventId: event.eventId,
          correlationId,
          turns: workerTurns,
          ...(watchTurns === undefined ? {} : { watchTurns }),
          ...(watchEventId === undefined ? {} : { watchEventId }),
          ...(pairEventId === undefined ? {} : { pairEventId })
        };
        const commandUpdated = this.#database
          .prepare(`
            UPDATE client_commands SET result_json = ?
            WHERE source_binding_id = ? AND client_command_id = ?
          `)
          .run(jsonText(acceptance), input.sourceBindingId, input.clientCommandId);
        if (commandUpdated.changes !== 1) {
          throw new GroupXError("STORE_CONFLICT", "Command result compare-and-set failed");
        }
        return { result: acceptance, disposition: "accepted" };
      });
    } catch (error) {
      this.#mapConstraint(error, true);
    }
  }

  #enforceCausalGraphUnsafe(input: {
    targets: readonly TurnTargetInput[];
    rootCorrelationId: string;
    requestedCorrelationId?: string;
    roomId: string;
    sourceActorId: string;
    commandType: string;
  }): void {
    const first = input.targets[0]!;
    const parentTurnId = first.parentTurnId;
    const hopCount = first.hopCount ?? 0;
    for (const target of input.targets) {
      if (target.parentTurnId !== parentTurnId || (target.hopCount ?? 0) !== hopCount) {
        throw new GroupXError(
          "INVALID_ENVELOPE",
          "Every Turn in one message fan-out must share one parent and hop count"
        );
      }
    }

    if (parentTurnId === undefined) {
      if (hopCount !== 0) {
        throw new GroupXError("INVALID_ENVELOPE", "A root Turn must have hopCount 0");
      }
      return;
    }
    if (input.requestedCorrelationId === undefined) {
      throw new GroupXError(
        "INVALID_ENVELOPE",
        "A child Turn must provide its root correlation id"
      );
    }

    let current = this.#getTurnUnsafe(parentTurnId);
    if (!current) {
      throw new GroupXError("INVALID_ENVELOPE", "The parent Turn does not exist");
    }
    if (current.rootCorrelationId !== input.rootCorrelationId) {
      throw new GroupXError(
        "INVALID_ENVELOPE",
        "A child Turn must preserve its parent's root correlation id"
      );
    }
    if (hopCount !== current.hopCount + 1) {
      throw new GroupXError(
        "INVALID_ENVELOPE",
        "A child Turn hopCount must equal parent hopCount plus one"
      );
    }
    if (current.targetActorId !== input.sourceActorId) {
      throw new GroupXError(
        "MCP_BINDING_MISMATCH",
        "The source binding actor does not own the parent Turn"
      );
    }

    const ancestorActorIds = new Set<string>();
    const seenTurnIds = new Set<string>();
    let firstAncestor = true;
    while (current !== undefined) {
      if (seenTurnIds.has(current.turnId)) {
        throw new GroupXError("CAUSAL_CYCLE", "The stored parent Turn chain contains a cycle");
      }
      seenTurnIds.add(current.turnId);
      ancestorActorIds.add(current.targetActorId);

      if (current.rootCorrelationId !== input.rootCorrelationId) {
        throw new GroupXError("STORE_UNAVAILABLE", "The stored parent Turn chain changed roots");
      }
      const source = this.#database
        .prepare("SELECT room_id FROM events WHERE event_id = ?")
        .get(current.sourceEventId) as Row | undefined;
      if (!source || requiredString(source.room_id, "room_id") !== input.roomId) {
        throw new GroupXError(
          firstAncestor ? "INVALID_ENVELOPE" : "STORE_UNAVAILABLE",
          "The parent Turn chain does not belong to the requested room"
        );
      }

      if (current.parentTurnId === undefined) {
        if (current.hopCount !== 0) {
          throw new GroupXError("STORE_UNAVAILABLE", "The stored root Turn has a non-zero hop");
        }
        break;
      }
      const ancestor = this.#getTurnUnsafe(current.parentTurnId);
      if (!ancestor) {
        throw new GroupXError("STORE_UNAVAILABLE", "The stored parent Turn chain is incomplete");
      }
      if (current.hopCount !== ancestor.hopCount + 1) {
        throw new GroupXError("STORE_UNAVAILABLE", "The stored parent Turn chain has invalid hops");
      }
      current = ancestor;
      firstAncestor = false;
    }

    const repeatedActor = input.targets.find((target) => ancestorActorIds.has(target.actorId));
    if (
      repeatedActor !== undefined &&
      WAITS_FOR_CHILDREN_COMMAND_TYPES.has(input.commandType)
    ) {
      throw new GroupXError(
        "CAUSAL_CYCLE",
        "A Turn target cannot repeat an actor from its ancestor chain",
        { actorId: repeatedActor.actorId, parentTurnId }
      );
    }
  }

  #enforceAcceptMessageLimitsUnsafe(
    targets: readonly TurnTargetInput[],
    rootCorrelationId: string,
    limits: AcceptMessageLimits
  ): void {
    const overHop = targets.find((target) => (target.hopCount ?? 0) > limits.hopCount);
    if (overHop !== undefined) {
      throw new GroupXError(
        "HOP_LIMIT_REACHED",
        `Turn hop count exceeds the configured limit ${limits.hopCount}`,
        {
          limitKind: "hopCount",
          limit: limits.hopCount,
          actorId: overHop.actorId,
          actual: overHop.hopCount ?? 0
        }
      );
    }

    const rootRow = this.#database
      .prepare("SELECT COUNT(*) AS count FROM turns WHERE root_correlation_id = ?")
      .get(rootCorrelationId) as Row;
    const rootCount = requiredNumber(rootRow.count, "count");
    if (rootCount + targets.length > limits.rootTurns) {
      throw new GroupXError(
        "ROOT_TURN_LIMIT_REACHED",
        `Root Turn count exceeds the configured limit ${limits.rootTurns}`,
        {
          limitKind: "rootTurns",
          limit: limits.rootTurns,
          existing: rootCount,
          requested: targets.length
        }
      );
    }

    const actorRootCount = this.#database.prepare(`
      SELECT COUNT(*) AS count FROM turns
      WHERE root_correlation_id = ? AND target_actor_id = ?
    `);
    const activeQueueCount = this.#database.prepare(`
      SELECT COUNT(*) AS count FROM turns
      WHERE target_actor_id = ?
        AND status IN ('queued', 'dispatching', 'running', 'cancelling')
    `);
    for (const target of targets) {
      const actorCount = requiredNumber(
        (actorRootCount.get(rootCorrelationId, target.actorId) as Row).count,
        "count"
      );
      if (actorCount + 1 > limits.actorCallsPerRoot) {
        throw new GroupXError(
          "ROOT_TURN_LIMIT_REACHED",
          `Actor call count exceeds the per-root limit ${limits.actorCallsPerRoot}`,
          {
            limitKind: "actorCallsPerRoot",
            limit: limits.actorCallsPerRoot,
            actorId: target.actorId,
            existing: actorCount,
            requested: 1
          }
        );
      }
      const queueCount = requiredNumber(
        (activeQueueCount.get(target.actorId) as Row).count,
        "count"
      );
      if (queueCount + 1 > limits.queuePerActor) {
        throw new GroupXError(
          "QUEUE_CAPACITY_REACHED",
          `Actor queue exceeds the configured limit ${limits.queuePerActor}`,
          {
            limitKind: "queuePerActor",
            limit: limits.queuePerActor,
            actorId: target.actorId,
            existing: queueCount,
            requested: 1
          }
        );
      }
    }
  }

  #requireOpenBinding(bindingId: string): SessionBindingRecord {
    const binding = this.getSessionBinding(bindingId);
    if (!binding || binding.closedAt !== undefined || binding.status !== "ready") {
      throw new GroupXError("MCP_BINDING_MISMATCH", "The binding is not ready");
    }
    const instance = this.getAgentInstance(binding.instanceId);
    if (
      !instance ||
      instance.status !== "ready" ||
      instance.processEndedAt !== undefined ||
      instance.actorId !== binding.actorId
    ) {
      throw new GroupXError("MCP_BINDING_MISMATCH", "The binding process instance is not ready");
    }
    return binding;
  }

  #eventSelect(where: string): string {
    return `
      SELECT
        events.*,
        events.actor_kind,
        events.actor_display_name
      FROM events
      ${where}
    `;
  }

  #insertEventUnsafe(input: DurableEventInput): StoredEventRecord {
    const eventId = input.eventId ?? createId("evt");
    const actor = this.#database.prepare("SELECT * FROM actors WHERE actor_id = ?").get(input.actorId) as
      | Row
      | undefined;
    if (!actor) {
      throw new GroupXError("UNKNOWN_ACTOR", "Durable event actor does not exist");
    }
    this.#database
      .prepare(`
        INSERT INTO events(
          event_id, schema_version, room_id, event_type, actor_id, actor_kind,
          actor_display_name, instance_id,
          targets_json, reply_to_event_id, causation_id, correlation_id,
          idempotency_key, occurred_at, body_json, provenance_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        eventId,
        input.schemaVersion ?? GROUPX_SCHEMA,
        input.roomId,
        input.eventType,
        input.actorId,
        actor.kind,
        actor.display_name,
        input.instanceId ?? null,
        jsonText(input.targets ?? []),
        input.replyToEventId ?? null,
        input.causationId ?? null,
        input.correlationId,
        input.idempotencyKey ?? null,
        input.occurredAt ?? nowIso(),
        jsonText(input.body),
        input.provenance === undefined ? null : jsonText(input.provenance)
      );
    const row = this.#database
      .prepare(this.#eventSelect("WHERE events.event_id = ?"))
      .get(eventId) as Row;
    return mapEvent(row);
  }

  appendDurableEvent(input: DurableEventInput): StoredEventRecord {
    this.#assertOpen();
    if (TRANSIENT_EVENT_TYPES.has(input.eventType)) {
      throw new GroupXError(
        "INVALID_ENVELOPE",
        "Transient adapter deltas cannot be written to the durable event store"
      );
    }
    try {
      return this.#withImmediateTransaction(() => this.#insertEventUnsafe(input));
    } catch (error) {
      this.#mapConstraint(error);
    }
  }

  getEvent(eventId: string): StoredEventRecord | undefined {
    this.#assertOpen();
    const row = this.#database
      .prepare(this.#eventSelect("WHERE events.event_id = ?"))
      .get(eventId) as Row | undefined;
    return row ? mapEvent(row) : undefined;
  }

  listEvents(input: { roomId: string; afterSeq?: number; limit?: number }): EventPage {
    this.#assertOpen();
    const afterSeq = input.afterSeq ?? 0;
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw new GroupXError("INVALID_ENVELOPE", "afterSeq must be a non-negative integer");
    }
    const limit = boundedLimit(input.limit);
    const rows = this.#database
      .prepare(
        this.#eventSelect(
          "WHERE events.room_id = ? AND events.seq > ? ORDER BY events.seq LIMIT ?"
        )
      )
      .all(input.roomId, afterSeq, limit + 1) as Row[];
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map(mapEvent);
    const nextAfterSeq = events.at(-1)?.seq ?? afterSeq;
    return { events, afterSeq, nextAfterSeq, hasMore };
  }

  getRoomHighWaterSeq(roomId: string): number {
    this.#assertOpen();
    const row = this.#database
      .prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events WHERE room_id = ?")
      .get(roomId) as Row;
    return requiredNumber(row.max_seq, "max_seq");
  }

  listEventsThrough(input: {
    roomId: string;
    afterSeq?: number;
    throughSeq: number;
    limit?: number;
  }): EventPage {
    this.#assertOpen();
    const afterSeq = input.afterSeq ?? 0;
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw new GroupXError("INVALID_ENVELOPE", "afterSeq must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(input.throughSeq) || input.throughSeq < 0) {
      throw new GroupXError(
        "INVALID_ENVELOPE",
        "throughSeq must be a non-negative safe integer"
      );
    }
    const highWaterSeq = this.getRoomHighWaterSeq(input.roomId);
    if (input.throughSeq > highWaterSeq) {
      throw new GroupXError(
        "INVALID_ENVELOPE",
        `throughSeq exceeds room high-water ${highWaterSeq}`
      );
    }
    const limit = boundedLimit(input.limit);
    const rows = this.#database
      .prepare(
        this.#eventSelect(`
          WHERE events.room_id = ? AND events.seq > ? AND events.seq <= ?
          ORDER BY events.seq LIMIT ?
        `)
      )
      .all(input.roomId, afterSeq, input.throughSeq, limit + 1) as Row[];
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map(mapEvent);
    return {
      events,
      afterSeq,
      nextAfterSeq: events.at(-1)?.seq ?? afterSeq,
      hasMore
    };
  }

  readRoomBootstrapSnapshot(input: {
    roomId: string;
    recentLimit?: number;
  }): RoomBootstrapSnapshot {
    this.#assertOpen();
    const recentLimit = boundedLimit(input.recentLimit);
    return this.#withReadTransaction(() => {
      const highWaterRow = this.#database
        .prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events WHERE room_id = ?")
        .get(input.roomId) as Row;
      const throughSeq = requiredNumber(highWaterRow.max_seq, "max_seq");
      const recentEvents = (
        this.#database
          .prepare(
            this.#eventSelect(`
              WHERE events.room_id = ? AND events.seq <= ?
              ORDER BY events.seq DESC LIMIT ?
            `)
          )
          .all(input.roomId, throughSeq, recentLimit) as Row[]
      )
        .map(mapEvent)
        .reverse();
      const activeTurns = (
        this.#database
          .prepare(`
            SELECT turns.*
            FROM turns
            INNER JOIN events AS source_events
              ON source_events.event_id = turns.source_event_id
            WHERE source_events.room_id = ?
              AND turns.status IN ('queued', 'dispatching', 'running', 'cancelling')
            ORDER BY turns.enqueue_seq, turns.turn_id
          `)
          .all(input.roomId) as Row[]
      ).map(mapTurn);
      return {
        roomId: input.roomId,
        throughSeq,
        recentEvents,
        activeTurns
      };
    });
  }

  countEvents(roomId?: string): number {
    this.#assertOpen();
    const row = (
      roomId === undefined
        ? this.#database.prepare("SELECT COUNT(*) AS count FROM events").get()
        : this.#database.prepare("SELECT COUNT(*) AS count FROM events WHERE room_id = ?").get(roomId)
    ) as Row;
    return requiredNumber(row.count, "count");
  }

  #insertTurnUnsafe(input: EnqueueTurnInput): TurnRecord {
    const source = this.#database
      .prepare("SELECT seq, room_id, body_json FROM events WHERE event_id = ?")
      .get(input.sourceEventId) as Row | undefined;
    if (!source) {
      throw new GroupXError("STORE_CONFLICT", "Turn source event does not exist");
    }
    const turnId = input.turnId ?? createId("turn");
    const queuedAt = input.queuedAt ?? nowIso();
    const queuedEvent = this.#insertEventUnsafe({
      roomId: requiredString(source.room_id, "room_id"),
      eventType: "turn.queued",
      actorId: BUILTIN_ACTORS.system.actorId,
      targets: [input.targetActorId],
      causationId: input.sourceEventId,
      correlationId: input.rootCorrelationId,
      occurredAt: queuedAt,
      body: {
        turnId,
        sourceEventId: input.sourceEventId,
        targetActorId: input.targetActorId,
        adapterId: input.adapterId,
        transport: input.transport,
        hopCount: input.hopCount ?? 0
      }
    });
    this.#database
      .prepare(`
        INSERT INTO turns(
          turn_id, source_event_id, target_actor_id, adapter_id, transport, binding_id,
          parent_turn_id, root_correlation_id, hop_count, queued_event_id,
          enqueue_seq, status, queued_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)
      `)
      .run(
        turnId,
        input.sourceEventId,
        input.targetActorId,
        input.adapterId,
        input.transport,
        input.bindingId ?? null,
        input.parentTurnId ?? null,
        input.rootCorrelationId,
        input.hopCount ?? 0,
        queuedEvent.eventId,
        queuedEvent.seq,
        queuedAt
      );
    return this.#getTurnUnsafe(turnId)!;
  }

  enqueueTurn(input: EnqueueTurnInput): TurnRecord {
    this.#assertOpen();
    try {
      return this.#withImmediateTransaction(() => this.#insertTurnUnsafe(input));
    } catch (error) {
      this.#mapConstraint(error, true);
    }
  }

  #getTurnUnsafe(turnId: string): TurnRecord | undefined {
    const row = this.#database.prepare("SELECT * FROM turns WHERE turn_id = ?").get(turnId) as
      | Row
      | undefined;
    return row ? mapTurn(row) : undefined;
  }

  getTurn(turnId: string): TurnRecord | undefined {
    this.#assertOpen();
    return this.#getTurnUnsafe(turnId);
  }

  listTurns(input: {
    status?: TurnStatus;
    targetActorId?: string;
    rootCorrelationId?: string;
    sourceEventId?: string;
  } = {}): TurnRecord[] {
    this.#assertOpen();
    const predicates: string[] = [];
    const parameters: string[] = [];
    if (input.status !== undefined) {
      predicates.push("status = ?");
      parameters.push(input.status);
    }
    if (input.targetActorId !== undefined) {
      predicates.push("target_actor_id = ?");
      parameters.push(input.targetActorId);
    }
    if (input.rootCorrelationId !== undefined) {
      predicates.push("root_correlation_id = ?");
      parameters.push(input.rootCorrelationId);
    }
    if (input.sourceEventId !== undefined) {
      predicates.push("source_event_id = ?");
      parameters.push(input.sourceEventId);
    }
    const where = predicates.length === 0 ? "" : `WHERE ${predicates.join(" AND ")}`;
    return (
      this.#database
        .prepare(`SELECT * FROM turns ${where} ORDER BY enqueue_seq, turn_id`)
        .all(...parameters) as Row[]
    ).map(mapTurn);
  }

  countTurns(): number {
    this.#assertOpen();
    const row = this.#database.prepare("SELECT COUNT(*) AS count FROM turns").get() as Row;
    return requiredNumber(row.count, "count");
  }

  claimNextQueuedTurn(input: {
    targetActorId: string;
    bindingId: string;
    instanceId: string;
    contextThroughSeq: number;
    summaryThroughSeq?: number;
    expectedTurnId: string;
    expectedTransport: TurnRecord["transport"];
    claimedAt?: string;
  }): ClaimedTurn | undefined {
    this.#assertOpen();
    if (!Number.isSafeInteger(input.contextThroughSeq) || input.contextThroughSeq < 0) {
      throw new GroupXError(
        "INVALID_ENVELOPE",
        "contextThroughSeq must be a non-negative integer"
      );
    }
    if (
      input.summaryThroughSeq !== undefined &&
      (!Number.isSafeInteger(input.summaryThroughSeq) ||
        input.summaryThroughSeq < 0 ||
        input.summaryThroughSeq > input.contextThroughSeq)
    ) {
      throw new GroupXError(
        "INVALID_ENVELOPE",
        "summaryThroughSeq must be a non-negative integer within the context boundary"
      );
    }
    const binding = this.#requireOpenBinding(input.bindingId);
    const instance = this.getAgentInstance(input.instanceId);
    if (
      binding.actorId !== input.targetActorId ||
      binding.instanceId !== input.instanceId ||
      !instance ||
      instance.actorId !== input.targetActorId ||
      instance.status !== "ready" ||
      instance.processEndedAt !== undefined
    ) {
      throw new GroupXError(
        "MCP_BINDING_MISMATCH",
        "Dispatch claim binding does not match the target actor and instance"
      );
    }
    if (
      binding.transport !== input.expectedTransport ||
      instance.transport !== input.expectedTransport
    ) {
      throw new GroupXError(
        "TRANSPORT_MODE_MISMATCH",
        "Dispatch binding/instance transport does not match the expected Turn transport"
      );
    }

    return this.#withImmediateTransaction(() => {
      const active = this.#database
        .prepare(`
          SELECT 1 FROM turns
          WHERE target_actor_id = ?
            AND status IN ('dispatching', 'running', 'cancelling')
          LIMIT 1
        `)
        .get(input.targetActorId);
      if (active !== undefined) return undefined;

      const head = this.#database
        .prepare(`
          SELECT turn_id, transport FROM turns
          WHERE target_actor_id = ? AND status = 'queued'
          ORDER BY enqueue_seq, turn_id
          LIMIT 1
        `)
        .get(input.targetActorId) as Row | undefined;
      if (!head) return undefined;

      const turnId = requiredString(head.turn_id, "turn_id");
      if (input.expectedTurnId !== turnId) {
        return undefined;
      }
      const turnTransport = requiredString(head.transport, "transport") as TurnRecord["transport"];
      if (turnTransport !== input.expectedTransport) {
        throw new GroupXError(
          "TRANSPORT_MODE_MISMATCH",
          "Queued Turn transport does not match the current runtime transport",
          {
            turnId,
            turnTransport,
            expectedTransport: input.expectedTransport
          }
        );
      }
      this.#validateContextThroughSeqUnsafe(
        turnId,
        input.targetActorId,
        input.contextThroughSeq,
        input.summaryThroughSeq
      );
      const claimedAt = input.claimedAt ?? nowIso();
      const claimed = this.#database
        .prepare(`
          UPDATE turns
          SET status = 'dispatching', binding_id = ?
          WHERE turn_id = ? AND status = 'queued'
        `)
        .run(input.bindingId, turnId);
      if (claimed.changes !== 1) {
        throw new GroupXError("STORE_CONFLICT", "The lane head was claimed concurrently");
      }

      const attemptId = createId("attempt");
      this.#database
        .prepare(`
          INSERT INTO turn_attempts(
            attempt_id, turn_id, binding_id, instance_id, context_through_seq,
            summary_through_seq, dispatch_phase, claimed_at, delivery_certainty
          ) VALUES (?, ?, ?, ?, ?, ?, 'prepared', ?, 'not_delivered')
        `)
        .run(
          attemptId,
          turnId,
          input.bindingId,
          input.instanceId,
          input.contextThroughSeq,
          input.summaryThroughSeq ?? null,
          claimedAt
        );
      return {
        turn: this.#getTurnUnsafe(turnId)!,
        attempt: this.#getTurnAttemptUnsafe(attemptId)!
      };
    });
  }

  #validateContextThroughSeqUnsafe(
    turnId: string,
    actorId: string,
    contextThroughSeq: number,
    summaryThroughSeq: number | undefined
  ): void {
    const bounds = this.#database
      .prepare(`
        SELECT source.room_id AS room_id,
               source.seq AS source_seq,
               COALESCE(MAX(room_event.seq), 0) AS max_room_seq
        FROM turns AS turn
        JOIN events AS source ON source.event_id = turn.source_event_id
        LEFT JOIN events AS room_event ON room_event.room_id = source.room_id
        WHERE turn.turn_id = ?
        GROUP BY source.room_id
      `)
      .get(turnId) as Row | undefined;
    if (!bounds) {
      throw new GroupXError("STORE_UNAVAILABLE", "Dispatch Turn source event is missing");
    }
    const roomId = requiredString(bounds.room_id, "room_id");
    const sourceSeq = requiredNumber(bounds.source_seq, "source_seq");
    const maxRoomSeq = requiredNumber(bounds.max_room_seq, "max_room_seq");
    const cursor = this.#database
      .prepare(`
        SELECT last_delivered_seq FROM delivery_cursors
        WHERE actor_id = ? AND room_id = ?
      `)
      .get(actorId, roomId) as Row | undefined;
    const minimumSeq = Math.max(
      sourceSeq,
      cursor ? requiredNumber(cursor.last_delivered_seq, "last_delivered_seq") : 0
    );
    if (contextThroughSeq < minimumSeq || contextThroughSeq > maxRoomSeq) {
      throw new GroupXError(
        "INVALID_ENVELOPE",
        `contextThroughSeq must be between required context floor ${minimumSeq} and room high-water ${maxRoomSeq}`
      );
    }
    if (summaryThroughSeq !== undefined) {
      const summary = this.#database
        .prepare(`
          SELECT 1 FROM summaries
          WHERE room_id = ? AND status = 'active' AND through_seq = ?
          LIMIT 1
        `)
        .get(roomId, summaryThroughSeq);
      if (summary === undefined) {
        throw new GroupXError(
          "STORE_CONFLICT",
          "Dispatch summary checkpoint is no longer the active persisted room summary",
          { reason: "summary_checkpoint_changed", roomId, summaryThroughSeq }
        );
      }
    }
  }

  #getTurnAttemptUnsafe(attemptId: string): TurnAttemptRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM turn_attempts WHERE attempt_id = ?")
      .get(attemptId) as Row | undefined;
    return row ? mapTurnAttempt(row) : undefined;
  }

  getTurnAttempt(attemptId: string): TurnAttemptRecord | undefined {
    this.#assertOpen();
    return this.#getTurnAttemptUnsafe(attemptId);
  }

  listTurnAttempts(turnId: string): TurnAttemptRecord[] {
    this.#assertOpen();
    return (
      this.#database
        .prepare("SELECT * FROM turn_attempts WHERE turn_id = ? ORDER BY claimed_at, attempt_id")
        .all(turnId) as Row[]
    ).map(mapTurnAttempt);
  }

  markPromptInvoked(attemptId: string, invokedAt = nowIso()): ClaimedTurn {
    this.#assertOpen();
    return this.#withImmediateTransaction(() => {
      const attempt = this.#getTurnAttemptUnsafe(attemptId);
      if (!attempt || attempt.terminalAt !== undefined) {
        throw new GroupXError("STORE_CONFLICT", "Turn attempt is missing or already terminal");
      }
      const turn = this.#getTurnUnsafe(attempt.turnId);
      if (
        !turn ||
        turn.status !== "dispatching" ||
        turn.bindingId !== attempt.bindingId
      ) {
        throw new GroupXError(
          "STORE_CONFLICT",
          "Only a dispatching Turn can invoke its native prompt"
        );
      }
      if (
        attempt.dispatchPhase === "prompt_invoked" &&
        attempt.deliveryCertainty === "unknown"
      ) {
        return { turn, attempt };
      }
      if (
        attempt.dispatchPhase !== "prepared" ||
        attempt.deliveryCertainty !== "not_delivered"
      ) {
        throw new GroupXError(
          "STORE_CONFLICT",
          "Native prompt invocation compare-and-set failed"
        );
      }
      const updated = this.#database
        .prepare(`
          UPDATE turn_attempts
          SET dispatch_phase = 'prompt_invoked',
              delivery_certainty = 'unknown',
              prompt_invoked_at = ?
          WHERE attempt_id = ?
            AND terminal_at IS NULL
            AND dispatch_phase = 'prepared'
            AND delivery_certainty = 'not_delivered'
        `)
        .run(invokedAt, attemptId);
      if (updated.changes !== 1) {
        throw new GroupXError(
          "STORE_CONFLICT",
          "Native prompt invocation compare-and-set failed"
        );
      }
      return {
        turn: this.#getTurnUnsafe(turn.turnId)!,
        attempt: this.#getTurnAttemptUnsafe(attemptId)!
      };
    });
  }

  bindAttemptNativeTurnId(attemptId: string, nativeTurnId: string): ClaimedTurn {
    this.#assertOpen();
    if (nativeTurnId.trim() === "") {
      throw new GroupXError("INVALID_ENVELOPE", "nativeTurnId must not be empty");
    }
    return this.#withImmediateTransaction(() => {
      const attempt = this.#getTurnAttemptUnsafe(attemptId);
      if (!attempt || attempt.terminalAt !== undefined) {
        throw new GroupXError("STORE_CONFLICT", "Turn attempt is missing or already terminal");
      }
      const turn = this.#getTurnUnsafe(attempt.turnId);
      if (
        !turn ||
        !new Set<TurnStatus>(["dispatching", "running", "cancelling"]).has(turn.status) ||
        turn.bindingId !== attempt.bindingId ||
        (attempt.dispatchPhase !== "prompt_invoked" &&
          attempt.dispatchPhase !== "native_started")
      ) {
        throw new GroupXError("STORE_CONFLICT", "Native Turn id requires an active Turn");
      }
      if (
        (attempt.nativeTurnId !== undefined && attempt.nativeTurnId !== nativeTurnId) ||
        (turn.nativeTurnId !== undefined && turn.nativeTurnId !== nativeTurnId)
      ) {
        throw new GroupXError(
          "STORE_CONFLICT",
          "Native Turn id is already bound to a different value"
        );
      }
      const attemptUpdated = this.#database
        .prepare(`
          UPDATE turn_attempts
          SET native_turn_id = ?
          WHERE attempt_id = ?
            AND terminal_at IS NULL
            AND (native_turn_id IS NULL OR native_turn_id = ?)
        `)
        .run(nativeTurnId, attemptId, nativeTurnId);
      const turnUpdated = this.#database
        .prepare(`
          UPDATE turns
          SET native_turn_id = ?
          WHERE turn_id = ?
            AND status IN ('dispatching', 'running', 'cancelling')
            AND (native_turn_id IS NULL OR native_turn_id = ?)
        `)
        .run(nativeTurnId, turn.turnId, nativeTurnId);
      if (attemptUpdated.changes !== 1 || turnUpdated.changes !== 1) {
        throw new GroupXError("STORE_CONFLICT", "Native Turn id compare-and-set failed");
      }
      return {
        turn: this.#getTurnUnsafe(turn.turnId)!,
        attempt: this.#getTurnAttemptUnsafe(attemptId)!
      };
    });
  }

  markAttemptRunning(
    attemptId: string,
    nativeTurnId?: string,
    startedAt = nowIso()
  ): ClaimedTurn {
    this.#assertOpen();
    return this.#withImmediateTransaction(() => {
      const attempt = this.#getTurnAttemptUnsafe(attemptId);
      if (!attempt || attempt.terminalAt !== undefined) {
        throw new GroupXError("STORE_CONFLICT", "Turn attempt is missing or already terminal");
      }
      const turn = this.#getTurnUnsafe(attempt.turnId);
      if (
        !turn ||
        !new Set<TurnStatus>(["dispatching", "running", "cancelling"]).has(turn.status) ||
        turn.bindingId !== attempt.bindingId
      ) {
        throw new GroupXError("STORE_CONFLICT", "Only an active Turn can confirm native start");
      }

      const boundNativeTurnId = nativeTurnId ?? attempt.nativeTurnId ?? turn.nativeTurnId;
      if (
        (nativeTurnId !== undefined &&
          attempt.nativeTurnId !== undefined &&
          nativeTurnId !== attempt.nativeTurnId) ||
        (nativeTurnId !== undefined &&
          turn.nativeTurnId !== undefined &&
          nativeTurnId !== turn.nativeTurnId) ||
        (attempt.nativeTurnId !== undefined &&
          turn.nativeTurnId !== undefined &&
          attempt.nativeTurnId !== turn.nativeTurnId)
      ) {
        throw new GroupXError(
          "STORE_CONFLICT",
          "Native Turn id is already bound to a different value"
        );
      }

      if (
        attempt.dispatchPhase === "native_started" &&
        attempt.deliveryCertainty === "delivered"
      ) {
        return { turn, attempt };
      }
      if (
        attempt.dispatchPhase !== "prompt_invoked"
      ) {
        throw new GroupXError("STORE_CONFLICT", "Native start compare-and-set failed");
      }

      const turnResult = this.#database
        .prepare(`
          UPDATE turns
          SET status = CASE WHEN status = 'dispatching' THEN 'running' ELSE status END,
              native_turn_id = ?,
              started_at = COALESCE(started_at, ?)
          WHERE turn_id = ?
            AND status IN ('dispatching', 'running', 'cancelling')
            AND (native_turn_id IS NULL OR native_turn_id = ?)
        `)
        .run(boundNativeTurnId ?? null, startedAt, turn.turnId, boundNativeTurnId ?? null);
      const attemptResult = this.#database
        .prepare(`
          UPDATE turn_attempts
          SET native_turn_id = ?, started_at = COALESCE(started_at, ?),
              dispatch_phase = 'native_started', delivery_certainty = 'delivered'
          WHERE attempt_id = ?
            AND terminal_at IS NULL
            AND dispatch_phase = 'prompt_invoked'
            AND (native_turn_id IS NULL OR native_turn_id = ?)
        `)
        .run(boundNativeTurnId ?? null, startedAt, attemptId, boundNativeTurnId ?? null);
      if (turnResult.changes !== 1 || attemptResult.changes !== 1) {
        throw new GroupXError("STORE_CONFLICT", "Turn start compare-and-set failed");
      }

      const source = this.#database
        .prepare("SELECT room_id FROM events WHERE event_id = ?")
        .get(turn.sourceEventId) as Row | undefined;
      if (!source) {
        throw new GroupXError("STORE_UNAVAILABLE", "Turn source event is missing");
      }
      this.#advanceDeliveryCursorUnsafe(
        turn.targetActorId,
        requiredString(source.room_id, "room_id"),
        attempt.contextThroughSeq,
        attempt.summaryThroughSeq,
        startedAt
      );
      return {
        turn: this.#getTurnUnsafe(turn.turnId)!,
        attempt: this.#getTurnAttemptUnsafe(attemptId)!
      };
    });
  }

  requestTurnCancellation(turnId: string): TurnRecord {
    this.#assertOpen();
    const result = this.#database
      .prepare(`
        UPDATE turns
        SET status = 'cancelling'
        WHERE turn_id = ? AND status IN ('dispatching', 'running')
      `)
      .run(turnId);
    if (result.changes !== 1) {
      throw new GroupXError(
        "STORE_CONFLICT",
        "Only a dispatching or running Turn can request native cancellation"
      );
    }
    return this.#getTurnUnsafe(turnId)!;
  }

  cancelQueuedTurn(turnId: string, occurredAt = nowIso()): TerminalTurnResult {
    this.#assertOpen();
    return this.#withImmediateTransaction(() => {
      const turn = this.#getTurnUnsafe(turnId);
      if (!turn || turn.status !== "queued") {
        throw new GroupXError("STORE_CONFLICT", "Queued cancellation compare-and-set failed");
      }
      return this.#terminalizeTurnUnsafe(
        { turnId, status: "cancelled", occurredAt },
        new Set<TurnStatus>(["queued"])
      );
    });
  }

  failQueuedTurn(
    turnId: string,
    errorCode: string,
    occurredAt = nowIso(),
    eventBody?: Readonly<Record<string, unknown>>
  ): TerminalTurnResult {
    this.#assertOpen();
    return this.#withImmediateTransaction(() => {
      const turn = this.#getTurnUnsafe(turnId);
      if (!turn || turn.status !== "queued") {
        throw new GroupXError("STORE_CONFLICT", "Queued failure compare-and-set failed");
      }
      return this.#terminalizeTurnUnsafe(
        {
          turnId,
          status: "failed",
          errorCode,
          occurredAt,
          ...(eventBody === undefined ? {} : { eventBody })
        },
        new Set<TurnStatus>(["queued"])
      );
    });
  }

  saveTurnPartialText(turnId: string, partialText: string): TurnRecord {
    this.#assertOpen();
    const result = this.#database
      .prepare(`
        UPDATE turns SET partial_text = ?
        WHERE turn_id = ? AND status IN ('dispatching', 'running', 'cancelling')
      `)
      .run(partialText, turnId);
    if (result.changes !== 1) {
      throw new GroupXError("STORE_CONFLICT", "Partial text can only checkpoint an active Turn");
    }
    return this.#getTurnUnsafe(turnId)!;
  }

  terminalizeTurn(input: TerminalTurnInput): TerminalTurnResult {
    this.#assertOpen();
    return this.#withImmediateTransaction(() =>
      this.#terminalizeTurnUnsafe(
        input,
        new Set<TurnStatus>(["dispatching", "running", "cancelling"])
      )
    );
  }

  #terminalizeTurnUnsafe(
    input: TerminalTurnInput,
    allowedStatuses: ReadonlySet<TurnStatus>
  ): TerminalTurnResult {
    const turn = this.#getTurnUnsafe(input.turnId);
    if (!turn || !allowedStatuses.has(turn.status) || TERMINAL_STATUSES.has(turn.status)) {
      throw new GroupXError("STORE_CONFLICT", "Turn terminal compare-and-set failed");
    }

    let attempt: TurnAttemptRecord | undefined;
    if (input.attemptId !== undefined) {
      attempt = this.#getTurnAttemptUnsafe(input.attemptId);
      if (
        !attempt ||
        attempt.turnId !== turn.turnId ||
        attempt.terminalAt !== undefined ||
        turn.bindingId !== attempt.bindingId ||
        (attempt.nativeTurnId !== undefined &&
          turn.nativeTurnId !== undefined &&
          attempt.nativeTurnId !== turn.nativeTurnId)
      ) {
        throw new GroupXError("STORE_CONFLICT", "Terminal attempt does not match the active Turn");
      }
    } else if (turn.status !== "queued") {
      throw new GroupXError("STORE_CONFLICT", "An active Turn terminal write requires its attempt id");
    }
    if (
      input.status === "completed" &&
      attempt?.deliveryCertainty !== "delivered"
    ) {
      throw new GroupXError(
        "STORE_CONFLICT",
        "A completed Turn requires a confirmed native start"
      );
    }

    const source = this.#database
      .prepare("SELECT seq, room_id, body_json FROM events WHERE event_id = ?")
      .get(turn.sourceEventId) as Row | undefined;
    if (!source) {
      throw new GroupXError("STORE_UNAVAILABLE", "Turn source event is missing");
    }
    const occurredAt = input.occurredAt ?? nowIso();

    let reasoningEvent: StoredEventRecord | undefined;
    if (input.reasoning !== undefined && input.reasoning.trim().length > 0) {
      if (attempt === undefined) {
        throw new GroupXError(
          "STORE_CONFLICT",
          "A durable reasoning record requires an active Turn attempt"
        );
      }
      reasoningEvent = this.#insertEventUnsafe({
        roomId: requiredString(source.room_id, "room_id"),
        eventType: "turn.reasoning.recorded",
        actorId: turn.targetActorId,
        instanceId: attempt.instanceId,
        targets: [],
        replyToEventId: turn.sourceEventId,
        causationId: turn.turnId,
        correlationId: turn.rootCorrelationId,
        occurredAt,
        body: {
          turnId: turn.turnId,
          content: input.reasoning,
          terminalStatus: input.status
        },
        provenance: {
          sourceKind: "adapter",
          authorActorId: turn.targetActorId,
          sourceEventId: turn.sourceEventId
        }
      });
    }

    const toolProgressEvents: StoredEventRecord[] = [];
    if ((input.toolProgress?.length ?? 0) > 0) {
      if (attempt === undefined) {
        throw new GroupXError(
          "STORE_CONFLICT",
          "A durable tool progress record requires an active Turn attempt"
        );
      }
      for (const progress of input.toolProgress ?? []) {
        if (
          progress.nativeType !== "tool.started" &&
          progress.nativeType !== "tool.completed"
        ) {
          throw new GroupXError(
            "INVALID_ENVELOPE",
            "A durable tool progress record has an invalid native type"
          );
        }
        toolProgressEvents.push(
          this.#insertEventUnsafe({
            roomId: requiredString(source.room_id, "room_id"),
            eventType: "tool.progress.recorded",
            actorId: turn.targetActorId,
            instanceId: attempt.instanceId,
            targets: [],
            replyToEventId: turn.sourceEventId,
            causationId: turn.turnId,
            correlationId: turn.rootCorrelationId,
            occurredAt: progress.occurredAt,
            body: {
              turnId: turn.turnId,
              nativeType: progress.nativeType,
              ...(progress.toolCallId === undefined
                ? {}
                : { toolCallId: progress.toolCallId }),
              details: progress.details ?? null
            },
            provenance: {
              sourceKind: "adapter",
              authorActorId: turn.targetActorId,
              sourceEventId: turn.sourceEventId
            }
          })
        );
      }
    }

    let responseEvent: StoredEventRecord | undefined;
    if (input.status === "completed") {
      responseEvent = this.#insertEventUnsafe({
        roomId: requiredString(source.room_id, "room_id"),
        eventType: "message.created",
        actorId: turn.targetActorId,
        targets: [],
        replyToEventId: turn.sourceEventId,
        causationId: turn.turnId,
        correlationId: turn.rootCorrelationId,
        occurredAt,
        body: {
          ...(input.eventBody ?? {}),
          turnId: turn.turnId,
          content: input.content ?? ""
        },
        provenance: {
          sourceKind: "adapter",
          authorActorId: turn.targetActorId,
          sourceEventId: turn.sourceEventId
        }
      });
    }

    const terminalEventType =
      input.eventType ??
      ({
        completed: "turn.completed",
        failed: "turn.failed",
        cancelled: "turn.cancelled",
        interrupted: "turn.interrupted"
      } satisfies Record<string, string>)[input.status];
    const terminalActorId = attempt === undefined ? BUILTIN_ACTORS.system.actorId : turn.targetActorId;
    const terminalSourceKind =
      attempt === undefined || input.status === "interrupted" ? "system" : "adapter";
    const terminalEvent = this.#insertEventUnsafe({
      roomId: requiredString(source.room_id, "room_id"),
      eventType: terminalEventType,
      actorId: terminalActorId,
      targets: [],
      replyToEventId: turn.sourceEventId,
      causationId:
        responseEvent?.eventId ??
        toolProgressEvents.at(-1)?.eventId ??
        reasoningEvent?.eventId ??
        turn.turnId,
      correlationId: turn.rootCorrelationId,
      occurredAt,
      body: {
        ...(input.eventBody ?? {}),
        turnId: turn.turnId,
        status: input.status,
        ...(reasoningEvent === undefined
          ? {}
          : { reasoningEventId: reasoningEvent.eventId }),
        ...(toolProgressEvents.length === 0
          ? {}
          : { toolProgressEventIds: toolProgressEvents.map((event) => event.eventId) }),
        ...(responseEvent === undefined ? {} : { responseEventId: responseEvent.eventId }),
        ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode })
      },
      provenance: {
        sourceKind: terminalSourceKind,
        authorActorId: terminalActorId,
        sourceEventId: turn.sourceEventId
      }
    });

    let datedMemoryRollup: AgentDatedMemoryRollupRecord | undefined;
    if (
      input.status === "completed" &&
      responseEvent !== undefined &&
      attempt !== undefined &&
      this.#getSupervisionTurnRoleUnsafe(turn.turnId) !== "observer"
    ) {
      const sourceBody = parseJson<Record<string, unknown>>(source.body_json, {});
      if (typeof sourceBody.content !== "string") {
        throw new GroupXError(
          "STORE_UNAVAILABLE",
          "Completed Turn source message has no string content"
        );
      }
      const roomId = requiredString(source.room_id, "room_id");
      const localDate = localDateKey(occurredAt);
      const sourceSeq = requiredNumber(source.seq, "seq");
      const sourceChars = sourceBody.content.length + (input.content ?? "").length;
      this.#database
        .prepare(`
          INSERT INTO agent_dated_memory_rollups(
            room_id, actor_id, local_date, memory_id, summarized_through_seq,
            pending_through_seq, pending_turns, pending_chars, first_pending_at,
            last_pending_at, failure_count, last_attempt_at, next_attempt_at,
            last_error_code, updated_at
          ) VALUES (?, ?, ?, NULL, 0, ?, 1, ?, ?, ?, 0, NULL, NULL, NULL, ?)
          ON CONFLICT(room_id, actor_id, local_date) DO UPDATE SET
            pending_through_seq = MAX(
              COALESCE(agent_dated_memory_rollups.pending_through_seq, 0),
              excluded.pending_through_seq
            ),
            pending_turns = agent_dated_memory_rollups.pending_turns + 1,
            pending_chars = agent_dated_memory_rollups.pending_chars + excluded.pending_chars,
            first_pending_at = COALESCE(
              agent_dated_memory_rollups.first_pending_at,
              excluded.first_pending_at
            ),
            last_pending_at = excluded.last_pending_at,
            failure_count = 0,
            last_attempt_at = NULL,
            next_attempt_at = NULL,
            last_error_code = NULL,
            updated_at = excluded.updated_at
        `)
        .run(
          roomId,
          turn.targetActorId,
          localDate,
          responseEvent.seq,
          sourceChars,
          occurredAt,
          occurredAt,
          occurredAt
        );
      this.#database
        .prepare(`
          INSERT INTO agent_dated_memory_sources(
            turn_id, room_id, actor_id, local_date, source_event_id, source_seq,
            response_event_id, response_seq, source_chars, terminal_at,
            processed_at, memory_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
        `)
        .run(
          turn.turnId,
          roomId,
          turn.targetActorId,
          localDate,
          turn.sourceEventId,
          sourceSeq,
          responseEvent.eventId,
          responseEvent.seq,
          sourceChars,
          occurredAt
        );
      datedMemoryRollup = this.#getAgentDatedMemoryRollupUnsafe({
        roomId,
        actorId: turn.targetActorId,
        localDate
      });
    }

    const updated = this.#database
      .prepare(`
        UPDATE turns
        SET status = ?, response_event_id = ?, terminal_event_id = ?,
            error_code = ?, terminal_at = ?
        WHERE turn_id = ? AND status = ?
      `)
      .run(
        input.status,
        responseEvent?.eventId ?? null,
        terminalEvent.eventId,
        input.errorCode ?? null,
        occurredAt,
        turn.turnId,
        turn.status
      );
    if (updated.changes !== 1) {
      throw new GroupXError("STORE_CONFLICT", "Turn terminal compare-and-set failed");
    }

    if (attempt !== undefined) {
      const attemptUpdated = this.#database
        .prepare(`
          UPDATE turn_attempts
          SET terminal_at = ?, dispatch_phase = 'terminal'
          WHERE attempt_id = ? AND terminal_at IS NULL
        `)
        .run(occurredAt, attempt.attemptId);
      if (attemptUpdated.changes !== 1) {
        throw new GroupXError("STORE_CONFLICT", "Attempt terminal compare-and-set failed");
      }
    }

    const result: TerminalTurnResult = {
      turn: this.#getTurnUnsafe(turn.turnId)!,
      terminalEvent
    };
    if (reasoningEvent !== undefined) result.reasoningEvent = reasoningEvent;
    if (toolProgressEvents.length > 0) result.toolProgressEvents = toolProgressEvents;
    if (responseEvent !== undefined) result.responseEvent = responseEvent;
    if (datedMemoryRollup !== undefined) result.datedMemoryRollup = datedMemoryRollup;
    return result;
  }

  #getAgentDatedMemoryRollupUnsafe(input: {
    roomId: string;
    actorId: string;
    localDate: string;
  }): AgentDatedMemoryRollupRecord | undefined {
    const row = this.#database
      .prepare(`
        SELECT * FROM agent_dated_memory_rollups
        WHERE room_id = ? AND actor_id = ? AND local_date = ?
      `)
      .get(input.roomId, input.actorId, input.localDate) as Row | undefined;
    return row ? mapAgentDatedMemoryRollup(row) : undefined;
  }

  getAgentDatedMemoryRollup(input: {
    roomId: string;
    actorId: string;
    localDate: string;
  }): AgentDatedMemoryRollupRecord | undefined {
    this.#assertOpen();
    return this.#getAgentDatedMemoryRollupUnsafe(input);
  }

  listAgentDatedMemoryRollups(
    input: { roomId?: string; actorId?: string; pendingOnly?: boolean } = {}
  ): AgentDatedMemoryRollupRecord[] {
    this.#assertOpen();
    const clauses: string[] = [];
    const parameters: unknown[] = [];
    if (input.roomId !== undefined) {
      clauses.push("room_id = ?");
      parameters.push(input.roomId);
    }
    if (input.actorId !== undefined) {
      clauses.push("actor_id = ?");
      parameters.push(input.actorId);
    }
    if (input.pendingOnly === true) clauses.push("pending_turns > 0");
    const rows = this.#database
      .prepare(`
        SELECT * FROM agent_dated_memory_rollups
        ${clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`}
        ORDER BY local_date, actor_id, room_id
      `)
      .all(...parameters) as Row[];
    return rows.map(mapAgentDatedMemoryRollup);
  }

  listAgentDatedMemorySources(input: {
    roomId: string;
    actorId: string;
    localDate: string;
    pendingOnly?: boolean;
    limit?: number;
  }): AgentDatedMemorySourceRecord[] {
    this.#assertOpen();
    const limit = boundedLimit(input.limit, 100);
    const rows = this.#database
      .prepare(`
        SELECT source.*, source_event.body_json AS source_body_json,
               response_event.body_json AS response_body_json
        FROM agent_dated_memory_sources AS source
        JOIN events AS source_event ON source_event.event_id = source.source_event_id
        JOIN events AS response_event ON response_event.event_id = source.response_event_id
        WHERE source.room_id = ? AND source.actor_id = ? AND source.local_date = ?
          ${input.pendingOnly === false ? "" : "AND source.processed_at IS NULL"}
        ORDER BY source.response_seq, source.turn_id
        LIMIT ?
      `)
      .all(input.roomId, input.actorId, input.localDate, limit) as Row[];
    return rows.map(mapAgentDatedMemorySource);
  }

  commitAgentDatedMemoryRollup(
    input: CommitAgentDatedMemoryRollupInput
  ): CommitAgentDatedMemoryRollupResult {
    this.#assertOpen();
    const selectedTurnIds = [...new Set(input.selectedTurnIds)];
    if (
      selectedTurnIds.length === 0 ||
      selectedTurnIds.length !== input.selectedTurnIds.length ||
      selectedTurnIds.some((turnId) => turnId.trim().length === 0)
    ) {
      throw new GroupXError(
        "INVALID_ENVELOPE",
        "A dated-memory rollup requires unique non-blank selected Turn ids"
      );
    }
    const content = input.content.trim();
    if (content.length > MAX_AGENT_DATED_MEMORY_CHARS) {
      throw new GroupXError(
        "INVALID_ENVELOPE",
        `A dated-memory rollup exceeds ${MAX_AGENT_DATED_MEMORY_CHARS} characters`
      );
    }
    const generatedAt = input.generatedAt ?? nowIso();
    try {
      return this.#withImmediateTransaction(() => {
        const current = this.#getAgentDatedMemoryRollupUnsafe(input);
        if (!current || current.pendingTurns === 0) {
          throw new GroupXError("STORE_CONFLICT", "Dated-memory rollup has no pending Turns");
        }
        if (current.memoryId !== input.expectedMemoryId) {
          throw new GroupXError(
            "STORE_CONFLICT",
            "Dated-memory rollup memory compare-and-set failed"
          );
        }

        const placeholders = selectedTurnIds.map(() => "?").join(", ");
        const rows = this.#database
          .prepare(`
            SELECT source.*, source_event.body_json AS source_body_json,
                   response_event.body_json AS response_body_json
            FROM agent_dated_memory_sources AS source
            JOIN events AS source_event ON source_event.event_id = source.source_event_id
            JOIN events AS response_event ON response_event.event_id = source.response_event_id
            WHERE source.turn_id IN (${placeholders})
              AND source.room_id = ? AND source.actor_id = ? AND source.local_date = ?
              AND source.processed_at IS NULL
            ORDER BY source.response_seq, source.turn_id
          `)
          .all(...selectedTurnIds, input.roomId, input.actorId, input.localDate) as Row[];
        if (rows.length !== selectedTurnIds.length) {
          throw new GroupXError(
            "STORE_CONFLICT",
            "Dated-memory rollup sources changed before commit"
          );
        }
        const sources = rows.map(mapAgentDatedMemorySource);
        const lastSource = sources.at(-1)!;

        let memory: MemoryRecord | undefined;
        let event: StoredEventRecord | undefined;
        if (content.length > 0) {
          const replacement: CreateMemoryInput = {
            scopeType: "agent",
            scopeId: input.actorId,
            agentMemoryType: "dated",
            kind: "summary",
            authorActorId: input.actorId,
            subjectActorId: input.actorId,
            content,
            sourceEventId: lastSource.responseEventId,
            sourceKind: "automatic_rollup",
            createdAt: lastSource.terminalAt
          };
          if (current.memoryId === undefined) {
            memory = this.#insertMemoryUnsafe(replacement);
          } else {
            const previous = this.#getMemoryUnsafe(current.memoryId);
            if (
              previous?.status !== "active" ||
              previous.scopeType !== "agent" ||
              previous.scopeId !== input.actorId ||
              previous.agentMemoryType !== "dated"
            ) {
              throw new GroupXError(
                "STORE_CONFLICT",
                "The active dated-memory rollup record changed before commit"
              );
            }
            memory = this.#supersedeMemoryUnsafe(current.memoryId, replacement);
          }
          event = this.#insertEventUnsafe({
            roomId: input.roomId,
            eventType: current.memoryId === undefined ? "memory.remembered" : "memory.superseded",
            actorId: input.actorId,
            targets: [input.actorId],
            replyToEventId: lastSource.responseEventId,
            causationId: lastSource.responseEventId,
            correlationId: createCorrelationId(),
            occurredAt: generatedAt,
            body: { record: memory },
            provenance: {
              sourceKind: "generated_summary",
              authorActorId: input.actorId,
              subjectActorId: input.actorId,
              sourceEventId: lastSource.responseEventId,
              labels: ["agent-dated-memory", input.localDate]
            }
          });
        }

        const processed = this.#database
          .prepare(`
            UPDATE agent_dated_memory_sources
            SET processed_at = ?, memory_id = ?
            WHERE turn_id IN (${placeholders}) AND processed_at IS NULL
          `)
          .run(generatedAt, memory?.memoryId ?? null, ...selectedTurnIds);
        if (processed.changes !== selectedTurnIds.length) {
          throw new GroupXError(
            "STORE_CONFLICT",
            "Dated-memory source checkpoint compare-and-set failed"
          );
        }

        const pending = this.#database
          .prepare(`
            SELECT COUNT(*) AS pending_turns,
                   COALESCE(SUM(source_chars), 0) AS pending_chars,
                   MAX(response_seq) AS pending_through_seq,
                   MIN(terminal_at) AS first_pending_at,
                   MAX(terminal_at) AS last_pending_at
            FROM agent_dated_memory_sources
            WHERE room_id = ? AND actor_id = ? AND local_date = ?
              AND processed_at IS NULL
          `)
          .get(input.roomId, input.actorId, input.localDate) as Row;
        const pendingTurns = requiredNumber(pending.pending_turns, "pending_turns");
        const pendingChars = requiredNumber(pending.pending_chars, "pending_chars");
        const updated = this.#database
          .prepare(`
            UPDATE agent_dated_memory_rollups
            SET memory_id = ?, summarized_through_seq = ?,
                pending_through_seq = ?, pending_turns = ?, pending_chars = ?,
                first_pending_at = ?, last_pending_at = ?, failure_count = 0,
                last_attempt_at = ?, next_attempt_at = NULL, last_error_code = NULL,
                updated_at = ?
            WHERE room_id = ? AND actor_id = ? AND local_date = ?
          `)
          .run(
            memory?.memoryId ?? current.memoryId ?? null,
            Math.max(current.summarizedThroughSeq, lastSource.responseSeq),
            pendingTurns === 0 ? null : pending.pending_through_seq,
            pendingTurns,
            pendingChars,
            pendingTurns === 0 ? null : pending.first_pending_at,
            pendingTurns === 0 ? null : pending.last_pending_at,
            generatedAt,
            generatedAt,
            input.roomId,
            input.actorId,
            input.localDate
          );
        if (updated.changes !== 1) {
          throw new GroupXError("STORE_CONFLICT", "Dated-memory rollup update failed");
        }
        const result: CommitAgentDatedMemoryRollupResult = {
          rollup: this.#getAgentDatedMemoryRollupUnsafe(input)!
        };
        if (memory !== undefined) result.memory = memory;
        if (event !== undefined) result.event = event;
        return result;
      });
    } catch (error) {
      this.#mapConstraint(error);
    }
  }

  recordAgentDatedMemoryRollupFailure(
    input: RecordAgentDatedMemoryRollupFailureInput
  ): AgentDatedMemoryRollupRecord {
    this.#assertOpen();
    const attemptedAt = input.attemptedAt ?? nowIso();
    try {
      return this.#withImmediateTransaction(() => {
        const current = this.#getAgentDatedMemoryRollupUnsafe(input);
        if (!current || current.pendingTurns === 0) {
          throw new GroupXError("STORE_CONFLICT", "Dated-memory rollup has no pending Turns");
        }
        if (current.memoryId !== input.expectedMemoryId) {
          throw new GroupXError(
            "STORE_CONFLICT",
            "Dated-memory rollup failure checkpoint compare-and-set failed"
          );
        }
        const updated = this.#database
          .prepare(`
            UPDATE agent_dated_memory_rollups
            SET failure_count = failure_count + 1, last_attempt_at = ?,
                next_attempt_at = ?, last_error_code = ?, updated_at = ?
            WHERE room_id = ? AND actor_id = ? AND local_date = ?
          `)
          .run(
            attemptedAt,
            input.nextAttemptAt,
            input.errorCode.slice(0, 128),
            attemptedAt,
            input.roomId,
            input.actorId,
            input.localDate
          );
        if (updated.changes !== 1) {
          throw new GroupXError("STORE_CONFLICT", "Dated-memory failure checkpoint update failed");
        }
        return this.#getAgentDatedMemoryRollupUnsafe(input)!;
      });
    } catch (error) {
      this.#mapConstraint(error);
    }
  }

  getDeliveryCursor(actorId: string, roomId: string): DeliveryCursorRecord | undefined {
    this.#assertOpen();
    const row = this.#database
      .prepare("SELECT * FROM delivery_cursors WHERE actor_id = ? AND room_id = ?")
      .get(actorId, roomId) as Row | undefined;
    return row ? mapCursor(row) : undefined;
  }

  getActiveSummary(roomId: string, throughSeq?: number): SummaryRecord | undefined {
    this.#assertOpen();
    if (roomId.trim().length === 0) {
      throw new GroupXError("INVALID_ENVELOPE", "roomId must not be blank");
    }
    if (
      throughSeq !== undefined &&
      (!Number.isSafeInteger(throughSeq) || throughSeq < 0)
    ) {
      throw new GroupXError("INVALID_ENVELOPE", "throughSeq must be non-negative");
    }
    const rows = this.#database
      .prepare(`
        SELECT * FROM summaries
        WHERE room_id = ? AND status = 'active'
          AND (? IS NULL OR through_seq <= ?)
        ORDER BY through_seq DESC, summary_id DESC
        LIMIT 2
      `)
      .all(roomId, throughSeq ?? null, throughSeq ?? null) as Row[];
    if (rows.length > 1) {
      throw new GroupXError("STORE_UNAVAILABLE", "Room has multiple active summaries");
    }
    return rows[0] ? mapSummary(rows[0]) : undefined;
  }

  listSummaries(input: {
    roomId: string;
    includeHistory?: boolean;
    limit?: number;
  }): SummaryRecord[] {
    this.#assertOpen();
    if (input.roomId.trim().length === 0) {
      throw new GroupXError("INVALID_ENVELOPE", "roomId must not be blank");
    }
    const limit = boundedLimit(input.limit);
    return (
      this.#database
        .prepare(`
          SELECT * FROM summaries
          WHERE room_id = ?
            AND (? = 1 OR status = 'active')
          ORDER BY through_seq DESC, summary_id DESC
          LIMIT ?
        `)
        .all(input.roomId, input.includeHistory === true ? 1 : 0, limit) as Row[]
    ).map(mapSummary);
  }

  replaceActiveSummary(input: ReplaceRoomSummaryInput): SummaryRecord {
    this.#assertOpen();
    const content = input.content.trim();
    if (
      input.roomId.trim().length === 0 ||
      input.generatorActorId.trim().length === 0 ||
      content.length === 0
    ) {
      throw new GroupXError(
        "INVALID_ENVELOPE",
        "Summary room, generator, and content must not be blank"
      );
    }
    if (
      !Number.isSafeInteger(input.fromSeq) ||
      !Number.isSafeInteger(input.throughSeq) ||
      input.fromSeq < 1 ||
      input.throughSeq < input.fromSeq
    ) {
      throw new GroupXError("INVALID_ENVELOPE", "Summary sequence range is invalid");
    }
    if (content.length > 32_768) {
      throw new GroupXError("MESSAGE_TOO_LARGE", "Summary exceeds 32768 characters");
    }

    return this.#withImmediateTransaction(() => {
      const actor = this.getActor(input.generatorActorId);
      if (!actor || actor.kind !== "agent" || !actor.enabled) {
        throw new GroupXError("UNKNOWN_ACTOR", "Summary generator must be an enabled Agent");
      }
      const bounds = this.#database
        .prepare(`
          SELECT COUNT(*) AS count, MIN(seq) AS min_seq, MAX(seq) AS max_seq
          FROM events
          WHERE room_id = ? AND seq BETWEEN ? AND ?
        `)
        .get(input.roomId, input.fromSeq, input.throughSeq) as Row;
      if (
        requiredNumber(bounds.count, "count") < 1 ||
        requiredNumber(bounds.min_seq, "min_seq") !== input.fromSeq ||
        requiredNumber(bounds.max_seq, "max_seq") !== input.throughSeq
      ) {
        throw new GroupXError(
          "INVALID_ENVELOPE",
          "Summary range must start and end on durable events in the same room"
        );
      }

      const activeRows = this.#database
        .prepare("SELECT * FROM summaries WHERE room_id = ? AND status = 'active' LIMIT 2")
        .all(input.roomId) as Row[];
      if (activeRows.length > 1) {
        throw new GroupXError("STORE_UNAVAILABLE", "Room has multiple active summaries");
      }
      const activeRow = activeRows[0];
      const active = activeRow ? mapSummary(activeRow) : undefined;
      if (active?.summaryId !== input.expectedPreviousSummaryId) {
        throw new GroupXError("STORE_CONFLICT", "Active room summary changed during compaction");
      }
      if (active) {
        if (input.fromSeq !== active.fromSeq || input.throughSeq <= active.throughSeq) {
          throw new GroupXError(
            "INVALID_ENVELOPE",
            "A rolling room summary must preserve its start and advance its boundary"
          );
        }
        const superseded = this.#database
          .prepare(`
            UPDATE summaries SET status = 'superseded'
            WHERE summary_id = ? AND status = 'active'
          `)
          .run(active.summaryId);
        if (superseded.changes !== 1) {
          throw new GroupXError("STORE_CONFLICT", "Summary compare-and-set failed");
        }
      }

      const summaryId = input.summaryId ?? createId("summary");
      this.#database
        .prepare(`
          INSERT INTO summaries(
            summary_id, room_id, from_seq, through_seq, content,
            generator_actor_id, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?)
        `)
        .run(
          summaryId,
          input.roomId,
          input.fromSeq,
          input.throughSeq,
          content,
          input.generatorActorId,
          input.createdAt ?? nowIso()
        );
      return mapSummary(
        this.#database
          .prepare("SELECT * FROM summaries WHERE summary_id = ?")
          .get(summaryId) as Row
      );
    });
  }

  #advanceDeliveryCursorUnsafe(
    actorId: string,
    roomId: string,
    lastDeliveredSeq: number,
    lastSummarySeq: number | undefined,
    updatedAt: string
  ): DeliveryCursorRecord {
    if (!Number.isSafeInteger(lastDeliveredSeq) || lastDeliveredSeq < 0) {
      throw new GroupXError(
        "INVALID_ENVELOPE",
        "lastDeliveredSeq must be a non-negative integer"
      );
    }
    if (
      lastSummarySeq !== undefined &&
      (!Number.isSafeInteger(lastSummarySeq) || lastSummarySeq < 0)
    ) {
      throw new GroupXError("INVALID_ENVELOPE", "lastSummarySeq must be non-negative");
    }
    const highWaterRow = this.#database
      .prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM events WHERE room_id = ?")
      .get(roomId) as Row;
    const maxRoomSeq = requiredNumber(highWaterRow.max_seq, "max_seq");
    if (lastDeliveredSeq > maxRoomSeq) {
      throw new GroupXError(
        "INVALID_ENVELOPE",
        `lastDeliveredSeq exceeds room high-water ${maxRoomSeq}`
      );
    }
    const current = this.#database
      .prepare(`
        SELECT last_delivered_seq, last_summary_seq
        FROM delivery_cursors WHERE actor_id = ? AND room_id = ?
      `)
      .get(actorId, roomId) as Row | undefined;
    const effectiveDeliveredSeq = Math.max(
      current ? requiredNumber(current.last_delivered_seq, "last_delivered_seq") : 0,
      lastDeliveredSeq
    );
    if (lastSummarySeq !== undefined && lastSummarySeq > effectiveDeliveredSeq) {
      throw new GroupXError(
        "INVALID_ENVELOPE",
        "lastSummarySeq cannot exceed the effective delivered cursor"
      );
    }
    this.#database
      .prepare(`
        INSERT INTO delivery_cursors(
          actor_id, room_id, last_delivered_seq, last_summary_seq, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(actor_id, room_id) DO UPDATE SET
          last_delivered_seq = MAX(
            delivery_cursors.last_delivered_seq,
            excluded.last_delivered_seq
          ),
          last_summary_seq = CASE
            WHEN excluded.last_summary_seq IS NULL THEN delivery_cursors.last_summary_seq
            WHEN delivery_cursors.last_summary_seq IS NULL THEN excluded.last_summary_seq
            ELSE MAX(delivery_cursors.last_summary_seq, excluded.last_summary_seq)
          END,
          updated_at = excluded.updated_at
      `)
      .run(actorId, roomId, lastDeliveredSeq, lastSummarySeq ?? null, updatedAt);
    return this.getDeliveryCursor(actorId, roomId)!;
  }

  /** @internal Fixture/recovery escape hatch; runtime delivery advances via markAttemptRunning. */
  advanceDeliveryCursor(
    actorId: string,
    roomId: string,
    lastDeliveredSeq: number,
    input: { lastSummarySeq?: number; updatedAt?: string } = {}
  ): DeliveryCursorRecord {
    this.#assertOpen();
    return this.#withImmediateTransaction(() =>
      this.#advanceDeliveryCursorUnsafe(
        actorId,
        roomId,
        lastDeliveredSeq,
        input.lastSummarySeq,
        input.updatedAt ?? nowIso()
      )
    );
  }

  recoverAfterRestart(now = nowIso()): RecoveryResult {
    this.#assertOpen();
    return this.#withImmediateTransaction(() => {
      const activeRows = this.#database
        .prepare(`
          SELECT * FROM turns
          WHERE status IN ('dispatching', 'running', 'cancelling')
          ORDER BY enqueue_seq, turn_id
        `)
        .all() as Row[];
      const interruptedTurns: TurnRecord[] = [];

      for (const row of activeRows) {
        const turn = mapTurn(row);
        const attemptRow = this.#database
          .prepare(`
            SELECT * FROM turn_attempts
            WHERE turn_id = ? AND terminal_at IS NULL
          `)
          .get(turn.turnId) as Row | undefined;
        const attempt = attemptRow ? mapTurnAttempt(attemptRow) : undefined;

        if (
          turn.status === "dispatching" &&
          attempt?.dispatchPhase === "prepared" &&
          attempt.deliveryCertainty === "not_delivered"
        ) {
          const attemptUpdated = this.#database
            .prepare(`
              UPDATE turn_attempts
              SET dispatch_phase = 'terminal', terminal_at = ?
              WHERE attempt_id = ?
                AND terminal_at IS NULL
                AND dispatch_phase = 'prepared'
                AND delivery_certainty = 'not_delivered'
            `)
            .run(now, attempt.attemptId);
          const turnUpdated = this.#database
            .prepare(`
              UPDATE turns
              SET status = 'queued', binding_id = NULL, native_turn_id = NULL,
                  started_at = NULL
              WHERE turn_id = ? AND status = 'dispatching'
            `)
            .run(turn.turnId);
          if (attemptUpdated.changes !== 1 || turnUpdated.changes !== 1) {
            throw new GroupXError("STORE_CONFLICT", "Safe recovery requeue compare-and-set failed");
          }
          continue;
        }

        const source = this.#database
          .prepare("SELECT room_id FROM events WHERE event_id = ?")
          .get(turn.sourceEventId) as Row | undefined;
        if (!source) {
          throw new GroupXError("STORE_UNAVAILABLE", "Recovery found a Turn without its source event");
        }
        if (attempt?.deliveryCertainty === "delivered") {
          this.#advanceDeliveryCursorUnsafe(
            turn.targetActorId,
            requiredString(source.room_id, "room_id"),
            attempt.contextThroughSeq,
            attempt.summaryThroughSeq,
            now
          );
        }
        const terminalEvent = this.#insertEventUnsafe({
          roomId: requiredString(source.room_id, "room_id"),
          eventType: "turn.interrupted",
          actorId: BUILTIN_ACTORS.system.actorId,
          targets: [],
          replyToEventId: turn.sourceEventId,
          causationId: turn.turnId,
          correlationId: turn.rootCorrelationId,
          occurredAt: now,
          body: {
            turnId: turn.turnId,
            previousStatus: turn.status,
            ...(attempt === undefined ? {} : { dispatchPhase: attempt.dispatchPhase }),
            deliveryCertainty: "unknown"
          },
          provenance: {
            sourceKind: "system",
            sourceEventId: turn.sourceEventId
          }
        });
        const updated = this.#database
          .prepare(`
            UPDATE turns
            SET status = 'interrupted', terminal_event_id = ?,
                error_code = 'TURN_INTERRUPTED', terminal_at = ?
            WHERE turn_id = ? AND status = ?
          `)
          .run(terminalEvent.eventId, now, turn.turnId, turn.status);
        if (updated.changes !== 1) {
          throw new GroupXError("STORE_CONFLICT", "Recovery Turn compare-and-set failed");
        }
        if (attempt !== undefined) {
          const attemptUpdated = this.#database
            .prepare(`
              UPDATE turn_attempts
              SET terminal_at = ?, dispatch_phase = 'terminal',
                  delivery_certainty = 'unknown'
              WHERE attempt_id = ? AND terminal_at IS NULL
            `)
            .run(now, attempt.attemptId);
          if (attemptUpdated.changes !== 1) {
            throw new GroupXError(
              "STORE_CONFLICT",
              "Recovery attempt compare-and-set failed"
            );
          }
        }
        interruptedTurns.push(this.#getTurnUnsafe(turn.turnId)!);
      }

      const queuedTurns = (
        this.#database
          .prepare(`
            SELECT * FROM turns
            WHERE status = 'queued'
            ORDER BY target_actor_id, enqueue_seq, turn_id
          `)
          .all() as Row[]
      ).map(mapTurn);
      return { queuedTurns, interruptedTurns };
    });
  }

  #insertMemoryUnsafe(input: CreateMemoryInput, supersedesMemoryId?: string): MemoryRecord {
    if (input.scopeType === "agent" && input.agentMemoryType === undefined) {
      throw new GroupXError("INVALID_ENVELOPE", "Agent memory requires agentMemoryType");
    }
    if (input.scopeType !== "agent" && input.agentMemoryType !== undefined) {
      throw new GroupXError(
        "INVALID_ENVELOPE",
        "agentMemoryType is only valid for Agent memory"
      );
    }
    const memoryId = input.memoryId ?? createId("mem");
    this.#database
      .prepare(`
        INSERT INTO memory_records(
          memory_id, scope_type, scope_id, agent_memory_type, kind, author_actor_id, subject_actor_id,
          content, source_event_id, source_kind, status, supersedes_memory_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `)
      .run(
        memoryId,
        input.scopeType,
        input.scopeId,
        input.agentMemoryType ?? null,
        input.kind,
        input.authorActorId,
        input.subjectActorId ?? null,
        input.content,
        input.sourceEventId ?? null,
        input.sourceKind,
        supersedesMemoryId ?? null,
        input.createdAt ?? nowIso()
      );
    return this.#getMemoryUnsafe(memoryId)!;
  }

  #getMemoryUnsafe(memoryId: string): MemoryRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM memory_records WHERE memory_id = ?")
      .get(memoryId) as Row | undefined;
    return row ? mapMemory(row) : undefined;
  }

  getMemory(memoryId: string): MemoryRecord | undefined {
    this.#assertOpen();
    return this.#getMemoryUnsafe(memoryId);
  }

  rememberMemory(input: CreateMemoryInput): MemoryRecord {
    this.#assertOpen();
    try {
      return this.#withImmediateTransaction(() => this.#insertMemoryUnsafe(input));
    } catch (error) {
      this.#mapConstraint(error);
    }
  }

  mutateMemoryWithDisposition(input: MutateMemoryInput): MemoryMutationOutcome {
    this.#assertOpen();
    const commandType = `memory.${input.mutation.kind}`;
    const hash = canonicalHash({
      commandType,
      roomId: input.roomId,
      correlationId: input.correlationId ?? null,
      mutation: input.mutation
    });
    const existing = this.getClientCommand<MemoryMutationOutcome["result"]>(
      input.sourceBindingId,
      input.clientCommandId
    );
    if (existing !== undefined) {
      if (existing.commandType !== commandType || existing.canonicalHash !== hash) {
        throw new GroupXError(
          "CLIENT_COMMAND_CONFLICT",
          "The client command id was already used with a different memory mutation"
        );
      }
      if (existing.result === null) {
        throw new GroupXError("STORE_UNAVAILABLE", "Committed memory command has no result");
      }
      return { result: existing.result, disposition: "replayed" };
    }

    const occurredAt = input.occurredAt ?? nowIso();
    const correlationId = input.correlationId ?? createCorrelationId();
    try {
      return this.#withImmediateTransaction(() => {
        const raced = this.getClientCommand<MemoryMutationOutcome["result"]>(
          input.sourceBindingId,
          input.clientCommandId
        );
        if (raced !== undefined) {
          if (raced.commandType !== commandType || raced.canonicalHash !== hash) {
            throw new GroupXError(
              "CLIENT_COMMAND_CONFLICT",
              "The client command id was already used with a different memory mutation"
            );
          }
          if (raced.result === null) {
            throw new GroupXError("STORE_UNAVAILABLE", "Committed memory command has no result");
          }
          return { result: raced.result, disposition: "replayed" };
        }

        const binding = this.#requireOpenBinding(input.sourceBindingId);
        this.#database
          .prepare(`
            INSERT INTO client_commands(
              command_id, source_binding_id, client_command_id, command_type,
              canonical_hash, result_json, accepted_at
            ) VALUES (?, ?, ?, ?, ?, NULL, ?)
          `)
          .run(
            createId("cmd"),
            input.sourceBindingId,
            input.clientCommandId,
            commandType,
            hash,
            occurredAt
          );

        let record: MemoryRecord;
        let eventType: "memory.remembered" | "memory.superseded" | "memory.retracted";
        switch (input.mutation.kind) {
          case "remember": {
            this.#assertBoundAuthor(binding, input.mutation.record.authorActorId);
            record = this.#insertMemoryUnsafe({
              ...input.mutation.record,
              createdAt: input.mutation.record.createdAt ?? occurredAt
            });
            eventType = "memory.remembered";
            break;
          }
          case "supersede": {
            this.#assertBoundAuthor(binding, input.mutation.replacement.authorActorId);
            record = this.#supersedeMemoryUnsafe(input.mutation.memoryId, {
              ...input.mutation.replacement,
              createdAt: input.mutation.replacement.createdAt ?? occurredAt
            });
            eventType = "memory.superseded";
            break;
          }
          case "retract": {
            record = this.#retractMemoryUnsafe(input.mutation.memoryId, occurredAt);
            eventType = "memory.retracted";
            break;
          }
        }

        const event = this.#insertEventUnsafe({
          roomId: input.roomId,
          eventType,
          actorId: binding.actorId,
          instanceId: binding.instanceId,
          targets: record.subjectActorId === undefined ? [] : [record.subjectActorId],
          ...(record.sourceEventId === undefined
            ? {}
            : {
                replyToEventId: record.sourceEventId,
                causationId: record.sourceEventId
              }),
          correlationId,
          occurredAt,
          body: { record },
          provenance: {
            sourceKind:
              binding.protocol === "local-rest"
                ? "web"
                : binding.protocol === "local-operator"
                  ? "operator"
                  : "mcp",
            authorActorId: binding.actorId,
            ...(record.subjectActorId === undefined
              ? {}
              : { subjectActorId: record.subjectActorId }),
            ...(record.sourceEventId === undefined
              ? {}
              : { sourceEventId: record.sourceEventId })
          }
        });
        const result = { record, event };
        const completed = this.#database
          .prepare(`
            UPDATE client_commands SET result_json = ?
            WHERE source_binding_id = ? AND client_command_id = ?
              AND result_json IS NULL
          `)
          .run(jsonText(result), input.sourceBindingId, input.clientCommandId);
        if (completed.changes !== 1) {
          throw new GroupXError("STORE_CONFLICT", "Memory command result compare-and-set failed");
        }
        return { result, disposition: "accepted" };
      });
    } catch (error) {
      this.#mapConstraint(error);
    }
  }

  #assertBoundAuthor(binding: SessionBindingRecord, authorActorId: string): void {
    if (binding.actorId !== authorActorId) {
      throw new GroupXError(
        "SENDER_FIELD_FORBIDDEN",
        "Mutation author is assigned from the source binding"
      );
    }
  }

  #supersedeMemoryUnsafe(memoryId: string, replacement: CreateMemoryInput): MemoryRecord {
    const previous = this.#getMemoryUnsafe(memoryId);
    if (!previous || previous.status !== "active") {
      throw new GroupXError("STORE_CONFLICT", "Only an active memory can be superseded");
    }
    if (
      previous.scopeType !== replacement.scopeType ||
      previous.scopeId !== replacement.scopeId ||
      previous.agentMemoryType !== replacement.agentMemoryType
    ) {
      throw new GroupXError(
        "STORE_CONFLICT",
        "A memory replacement must remain in its scope and memory type"
      );
    }
    const next = this.#insertMemoryUnsafe(replacement, memoryId);
    const updated = this.#database
      .prepare(`
        UPDATE memory_records SET status = 'superseded'
        WHERE memory_id = ? AND status = 'active'
      `)
      .run(memoryId);
    if (updated.changes !== 1) {
      throw new GroupXError("STORE_CONFLICT", "Memory supersede compare-and-set failed");
    }
    this.#database
      .prepare(`
        UPDATE agent_dated_memory_rollups
        SET memory_id = ?, updated_at = ?
        WHERE memory_id = ?
      `)
      .run(next.memoryId, next.createdAt, memoryId);
    return next;
  }

  supersedeMemory(memoryId: string, replacement: CreateMemoryInput): MemoryRecord {
    this.#assertOpen();
    try {
      return this.#withImmediateTransaction(() =>
        this.#supersedeMemoryUnsafe(memoryId, replacement)
      );
    } catch (error) {
      this.#mapConstraint(error);
    }
  }

  #retractMemoryUnsafe(memoryId: string, retractedAt: string): MemoryRecord {
    const result = this.#database
      .prepare(`
        UPDATE memory_records
        SET status = 'retracted', retracted_at = ?
        WHERE memory_id = ? AND status = 'active'
      `)
      .run(retractedAt, memoryId);
    if (result.changes !== 1) {
      throw new GroupXError("STORE_CONFLICT", "Memory retract compare-and-set failed");
    }
    this.#database
      .prepare(`
        UPDATE agent_dated_memory_rollups
        SET memory_id = NULL, updated_at = ?
        WHERE memory_id = ?
      `)
      .run(retractedAt, memoryId);
    return this.#getMemoryUnsafe(memoryId)!;
  }

  retractMemory(memoryId: string, retractedAt = nowIso()): MemoryRecord {
    this.#assertOpen();
    return this.#withImmediateTransaction(() =>
      this.#retractMemoryUnsafe(memoryId, retractedAt)
    );
  }

  searchMemory(input: MemoryQuery = {}): MemoryRecord[] {
    this.#assertOpen();
    const predicates: string[] = [];
    const parameters: Array<string | number> = [];
    let from = "memory_records";
    if (input.text !== undefined && input.text.trim() !== "") {
      from = `memory_records
        JOIN memory_records_fts ON memory_records_fts.rowid = memory_records.rowid`;
      predicates.push("memory_records_fts MATCH ?");
      parameters.push(`"${input.text.trim().replaceAll('"', '""')}"`);
    }
    if (input.includeHistory !== true) predicates.push("memory_records.status = 'active'");
    if (input.scopeType !== undefined) {
      predicates.push("memory_records.scope_type = ?");
      parameters.push(input.scopeType);
    }
    if (input.scopeId !== undefined) {
      predicates.push("memory_records.scope_id = ?");
      parameters.push(input.scopeId);
    }
    if (input.agentMemoryType !== undefined) {
      predicates.push("memory_records.agent_memory_type = ?");
      parameters.push(input.agentMemoryType);
    }
    if (input.kind !== undefined) {
      predicates.push("memory_records.kind = ?");
      parameters.push(input.kind);
    }
    if (input.authorActorId !== undefined) {
      predicates.push("memory_records.author_actor_id = ?");
      parameters.push(input.authorActorId);
    }
    if (input.subjectActorId !== undefined) {
      predicates.push("memory_records.subject_actor_id = ?");
      parameters.push(input.subjectActorId);
    }
    const where = predicates.length === 0 ? "" : `WHERE ${predicates.join(" AND ")}`;
    parameters.push(boundedLimit(input.limit), boundedQueryCursor(input.cursor));
    return (
      this.#database
        .prepare(`
          SELECT memory_records.* FROM ${from}
          ${where}
          ORDER BY memory_records.created_at DESC, memory_records.memory_id DESC
          LIMIT ? OFFSET ?
        `)
        .all(...parameters) as Row[]
    ).map(mapMemory);
  }

  #insertIdentityUnsafe(
    input: CreateIdentityInput,
    supersedesIdentityId?: string
  ): IdentityRecord {
    const identityId = input.identityId ?? createId("identity");
    this.#database
      .prepare(`
        INSERT INTO identity_records(
          identity_id, subject_actor_id, author_actor_id, kind, content,
          source_event_id, source_kind, status, supersedes_identity_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `)
      .run(
        identityId,
        input.subjectActorId,
        input.authorActorId,
        input.kind,
        input.content,
        input.sourceEventId ?? null,
        input.sourceKind,
        supersedesIdentityId ?? null,
        input.createdAt ?? nowIso()
      );
    return this.#getIdentityUnsafe(identityId)!;
  }

  #getIdentityUnsafe(identityId: string): IdentityRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM identity_records WHERE identity_id = ?")
      .get(identityId) as Row | undefined;
    return row ? mapIdentity(row) : undefined;
  }

  getIdentity(identityId: string): IdentityRecord | undefined {
    this.#assertOpen();
    return this.#getIdentityUnsafe(identityId);
  }

  rememberIdentity(input: CreateIdentityInput): IdentityRecord {
    this.#assertOpen();
    try {
      return this.#withImmediateTransaction(() => this.#insertIdentityUnsafe(input));
    } catch (error) {
      this.#mapConstraint(error);
    }
  }

  mutateIdentityWithDisposition(input: MutateIdentityInput): IdentityMutationOutcome {
    this.#assertOpen();
    const commandType = `identity.${input.mutation.kind}`;
    const hash = canonicalHash({
      commandType,
      roomId: input.roomId,
      correlationId: input.correlationId ?? null,
      mutation: input.mutation
    });
    const existing = this.getClientCommand<IdentityMutationOutcome["result"]>(
      input.sourceBindingId,
      input.clientCommandId
    );
    if (existing !== undefined) {
      if (existing.commandType !== commandType || existing.canonicalHash !== hash) {
        throw new GroupXError(
          "CLIENT_COMMAND_CONFLICT",
          "The client command id was already used with a different identity mutation"
        );
      }
      if (existing.result === null) {
        throw new GroupXError("STORE_UNAVAILABLE", "Committed identity command has no result");
      }
      return { result: existing.result, disposition: "replayed" };
    }

    const occurredAt = input.occurredAt ?? nowIso();
    const correlationId = input.correlationId ?? createCorrelationId();
    try {
      return this.#withImmediateTransaction(() => {
        const raced = this.getClientCommand<IdentityMutationOutcome["result"]>(
          input.sourceBindingId,
          input.clientCommandId
        );
        if (raced !== undefined) {
          if (raced.commandType !== commandType || raced.canonicalHash !== hash) {
            throw new GroupXError(
              "CLIENT_COMMAND_CONFLICT",
              "The client command id was already used with a different identity mutation"
            );
          }
          if (raced.result === null) {
            throw new GroupXError("STORE_UNAVAILABLE", "Committed identity command has no result");
          }
          return { result: raced.result, disposition: "replayed" };
        }

        const binding = this.#requireOpenBinding(input.sourceBindingId);
        this.#database
          .prepare(`
            INSERT INTO client_commands(
              command_id, source_binding_id, client_command_id, command_type,
              canonical_hash, result_json, accepted_at
            ) VALUES (?, ?, ?, ?, ?, NULL, ?)
          `)
          .run(
            createId("cmd"),
            input.sourceBindingId,
            input.clientCommandId,
            commandType,
            hash,
            occurredAt
          );

        let record: IdentityRecord;
        let eventType: "identity.remembered" | "identity.superseded" | "identity.retracted";
        switch (input.mutation.kind) {
          case "remember": {
            this.#assertBoundAuthor(binding, input.mutation.record.authorActorId);
            record = this.#insertIdentityUnsafe({
              ...input.mutation.record,
              createdAt: input.mutation.record.createdAt ?? occurredAt
            });
            eventType = "identity.remembered";
            break;
          }
          case "supersede": {
            this.#assertBoundAuthor(binding, input.mutation.replacement.authorActorId);
            record = this.#supersedeIdentityUnsafe(input.mutation.identityId, {
              ...input.mutation.replacement,
              createdAt: input.mutation.replacement.createdAt ?? occurredAt
            });
            eventType = "identity.superseded";
            break;
          }
          case "retract": {
            record = this.#retractIdentityUnsafe(input.mutation.identityId, occurredAt);
            eventType = "identity.retracted";
            break;
          }
        }

        const event = this.#insertEventUnsafe({
          roomId: input.roomId,
          eventType,
          actorId: binding.actorId,
          instanceId: binding.instanceId,
          targets: [record.subjectActorId],
          ...(record.sourceEventId === undefined
            ? {}
            : {
                replyToEventId: record.sourceEventId,
                causationId: record.sourceEventId
              }),
          correlationId,
          occurredAt,
          body: { record },
          provenance: {
            sourceKind:
              binding.protocol === "local-rest"
                ? "web"
                : binding.protocol === "local-operator"
                  ? "operator"
                  : "mcp",
            authorActorId: binding.actorId,
            subjectActorId: record.subjectActorId,
            ...(record.sourceEventId === undefined
              ? {}
              : { sourceEventId: record.sourceEventId })
          }
        });
        const result = { record, event };
        const completed = this.#database
          .prepare(`
            UPDATE client_commands SET result_json = ?
            WHERE source_binding_id = ? AND client_command_id = ?
              AND result_json IS NULL
          `)
          .run(jsonText(result), input.sourceBindingId, input.clientCommandId);
        if (completed.changes !== 1) {
          throw new GroupXError(
            "STORE_CONFLICT",
            "Identity command result compare-and-set failed"
          );
        }
        return { result, disposition: "accepted" };
      });
    } catch (error) {
      this.#mapConstraint(error);
    }
  }

  #supersedeIdentityUnsafe(
    identityId: string,
    replacement: CreateIdentityInput
  ): IdentityRecord {
    const previous = this.#getIdentityUnsafe(identityId);
    if (!previous || previous.status !== "active") {
      throw new GroupXError("STORE_CONFLICT", "Only an active identity can be superseded");
    }
    if (previous.subjectActorId !== replacement.subjectActorId) {
      throw new GroupXError(
        "STORE_CONFLICT",
        "An identity replacement cannot change its subject"
      );
    }
    const next = this.#insertIdentityUnsafe(replacement, identityId);
    const updated = this.#database
      .prepare(`
        UPDATE identity_records SET status = 'superseded'
        WHERE identity_id = ? AND status = 'active'
      `)
      .run(identityId);
    if (updated.changes !== 1) {
      throw new GroupXError("STORE_CONFLICT", "Identity supersede compare-and-set failed");
    }
    return next;
  }

  supersedeIdentity(identityId: string, replacement: CreateIdentityInput): IdentityRecord {
    this.#assertOpen();
    try {
      return this.#withImmediateTransaction(() =>
        this.#supersedeIdentityUnsafe(identityId, replacement)
      );
    } catch (error) {
      this.#mapConstraint(error);
    }
  }

  #retractIdentityUnsafe(identityId: string, retractedAt: string): IdentityRecord {
    const result = this.#database
      .prepare(`
        UPDATE identity_records
        SET status = 'retracted', retracted_at = ?
        WHERE identity_id = ? AND status = 'active'
      `)
      .run(retractedAt, identityId);
    if (result.changes !== 1) {
      throw new GroupXError("STORE_CONFLICT", "Identity retract compare-and-set failed");
    }
    return this.#getIdentityUnsafe(identityId)!;
  }

  retractIdentity(identityId: string, retractedAt = nowIso()): IdentityRecord {
    this.#assertOpen();
    return this.#withImmediateTransaction(() =>
      this.#retractIdentityUnsafe(identityId, retractedAt)
    );
  }

  readIdentity(input: IdentityQuery = {}): IdentityRecord[] {
    this.#assertOpen();
    const predicates: string[] = [];
    const parameters: Array<string | number> = [];
    let from = "identity_records";
    if (input.text !== undefined && input.text.trim() !== "") {
      from = `identity_records
        JOIN identity_records_fts ON identity_records_fts.rowid = identity_records.rowid`;
      predicates.push("identity_records_fts MATCH ?");
      parameters.push(`"${input.text.trim().replaceAll('"', '""')}"`);
    }
    if (input.includeHistory !== true) predicates.push("identity_records.status = 'active'");
    if (input.subjectActorId !== undefined) {
      predicates.push("identity_records.subject_actor_id = ?");
      parameters.push(input.subjectActorId);
    }
    if (input.authorActorId !== undefined) {
      predicates.push("identity_records.author_actor_id = ?");
      parameters.push(input.authorActorId);
    }
    if (input.kind !== undefined) {
      predicates.push("identity_records.kind = ?");
      parameters.push(input.kind);
    }
    const where = predicates.length === 0 ? "" : `WHERE ${predicates.join(" AND ")}`;
    parameters.push(boundedLimit(input.limit), boundedQueryCursor(input.cursor));
    return (
      this.#database
        .prepare(`
          SELECT identity_records.* FROM ${from}
          ${where}
          ORDER BY identity_records.created_at DESC, identity_records.identity_id DESC
          LIMIT ? OFFSET ?
        `)
        .all(...parameters) as Row[]
    ).map(mapIdentity);
  }

  integrityCheck(): IntegrityCheckResult {
    this.#assertOpen();
    const integrityRows = this.#database.pragma("integrity_check") as Row[];
    const messages = integrityRows.map((row) =>
      requiredString(row.integrity_check, "integrity_check")
    );
    const foreignKeyRows = this.#database.pragma("foreign_key_check") as Row[];
    for (const row of foreignKeyRows) {
      messages.push(
        `foreign_key_violation:${String(row.table)}:${String(row.rowid)}:${String(row.parent)}`
      );
    }
    return {
      ok: messages.length === 1 && messages[0] === "ok" && foreignKeyRows.length === 0,
      messages
    };
  }

  #normalizeTurnTargets(targets: readonly TurnTargetInput[]): TurnTargetInput[] {
    const byActor = new Map<string, TurnTargetInput>();
    for (const target of targets) {
      const existingTarget = byActor.get(target.actorId);
      if (
        existingTarget &&
        (existingTarget.adapterId !== target.adapterId ||
          existingTarget.transport !== target.transport ||
          existingTarget.bindingId !== target.bindingId ||
          existingTarget.parentTurnId !== target.parentTurnId ||
          (existingTarget.hopCount ?? 0) !== (target.hopCount ?? 0))
      ) {
        throw new GroupXError(
          "INVALID_ENVELOPE",
          "One target actor cannot carry conflicting Turn metadata"
        );
      }
      byActor.set(target.actorId, target);
    }
    return [...byActor.values()].sort((left, right) => left.actorId.localeCompare(right.actorId));
  }

  #getSupervisionPairUnsafe(pairId: string): SupervisionPairRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM supervision_pairs WHERE pair_id = ?")
      .get(pairId) as Row | undefined;
    return row ? mapSupervisionPair(row) : undefined;
  }

  #getSupervisionPairByTurnUnsafe(turnId: string): SupervisionPairRecord | undefined {
    const row = this.#database
      .prepare(`
        SELECT supervision_pairs.*
        FROM supervision_pair_turns
        INNER JOIN supervision_pairs
          ON supervision_pairs.pair_id = supervision_pair_turns.pair_id
        WHERE supervision_pair_turns.turn_id = ?
      `)
      .get(turnId) as Row | undefined;
    return row ? mapSupervisionPair(row) : undefined;
  }

  #getSupervisionTurnRoleUnsafe(turnId: string): SupervisionTurnRole | undefined {
    const row = this.#database
      .prepare("SELECT role FROM supervision_pair_turns WHERE turn_id = ?")
      .get(turnId) as Row | undefined;
    return row ? (requiredString(row.role, "role") as SupervisionTurnRole) : undefined;
  }

  #listSupervisionPairTurnsUnsafe(pairId: string): SupervisionPairTurnRecord[] {
    return (
      this.#database
        .prepare(`
          SELECT * FROM supervision_pair_turns
          WHERE pair_id = ?
          ORDER BY role, actor_id, turn_id
        `)
        .all(pairId) as Row[]
    ).map(mapSupervisionPairTurn);
  }

  getSupervisionPair(pairId: string): SupervisionPairRecord | undefined {
    this.#assertOpen();
    return this.#getSupervisionPairUnsafe(pairId);
  }

  getSupervisionPairByTurn(turnId: string): SupervisionPairRecord | undefined {
    this.#assertOpen();
    return this.#getSupervisionPairByTurnUnsafe(turnId);
  }

  getSupervisionPairByCorrelation(correlationId: string): SupervisionPairRecord | undefined {
    this.#assertOpen();
    const row = this.#database
      .prepare(
        "SELECT * FROM supervision_pairs WHERE correlation_id = ? ORDER BY created_at DESC, pair_id DESC LIMIT 1"
      )
      .get(correlationId) as Row | undefined;
    return row ? mapSupervisionPair(row) : undefined;
  }

  listSupervisionPairs(input: { roomId?: string; correlationId?: string } = {}): SupervisionPairRecord[] {
    this.#assertOpen();
    const predicates: string[] = [];
    const parameters: string[] = [];
    if (input.roomId !== undefined) {
      predicates.push("room_id = ?");
      parameters.push(input.roomId);
    }
    if (input.correlationId !== undefined) {
      predicates.push("correlation_id = ?");
      parameters.push(input.correlationId);
    }
    const where = predicates.length === 0 ? "" : `WHERE ${predicates.join(" AND ")}`;
    return (
      this.#database
        .prepare(`SELECT * FROM supervision_pairs ${where} ORDER BY created_at DESC, pair_id DESC`)
        .all(...parameters) as Row[]
    ).map(mapSupervisionPair);
  }

  appendAssistantMessage(input: AppendAssistantMessageInput): AssistantConversationMessageRecord {
    this.#assertOpen();
    const content = input.content.trim();
    if (content.length === 0) {
      throw new GroupXError("INVALID_ENVELOPE", "Assistant conversation content must not be blank");
    }
    const createdAt = input.createdAt ?? nowIso();
    const messageId = input.messageId ?? createId("asst");
    if (input.clientCommandId !== undefined) {
      const existing = this.getAssistantMessageByClientCommandId(input.clientCommandId);
      if (existing) return existing;
    }
    this.#database
      .prepare(`
        INSERT INTO assistant_conversation_messages(
          message_id, role, content, created_at, client_command_id
        ) VALUES (?, ?, ?, ?, ?)
      `)
      .run(messageId, input.role, content, createdAt, input.clientCommandId ?? null);
    return this.#requireAssistantMessage(messageId);
  }

  listAssistantMessages(limit = 200): AssistantConversationMessageRecord[] {
    this.#assertOpen();
    const bounded = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 200) : 200;
    return (
      this.#database
        .prepare(`
          SELECT * FROM assistant_conversation_messages
          ORDER BY created_at DESC, message_id DESC
          LIMIT ?
        `)
        .all(bounded) as Row[]
    )
      .reverse()
      .map(mapAssistantMessage);
  }

  getAssistantMessageByClientCommandId(
    clientCommandId: string
  ): AssistantConversationMessageRecord | undefined {
    this.#assertOpen();
    const row = this.#database
      .prepare("SELECT * FROM assistant_conversation_messages WHERE client_command_id = ?")
      .get(clientCommandId) as Row | undefined;
    return row ? mapAssistantMessage(row) : undefined;
  }

  getAssistantReplyAfter(messageId: string): AssistantConversationMessageRecord | undefined {
    this.#assertOpen();
    const current = this.#requireAssistantMessage(messageId);
    const row = this.#database
      .prepare(
        `
          SELECT * FROM assistant_conversation_messages
          WHERE created_at > ?
             OR (created_at = ? AND message_id > ?)
          ORDER BY created_at ASC, message_id ASC
          LIMIT 1
        `
      )
      .get(current.createdAt, current.createdAt, current.messageId) as Row | undefined;
    if (!row) return undefined;
    const next = mapAssistantMessage(row);
    return next.role === "assistant" ? next : undefined;
  }

  #requireAssistantMessage(messageId: string): AssistantConversationMessageRecord {
    const row = this.#database
      .prepare("SELECT * FROM assistant_conversation_messages WHERE message_id = ?")
      .get(messageId) as Row | undefined;
    if (!row) {
      throw new GroupXError("STORE_UNAVAILABLE", "Assistant conversation message is missing");
    }
    return mapAssistantMessage(row);
  }

  recordContextReset(input: {
    roomId: string;
    throughSeq: number;
    resetNativeSessions?: boolean;
    createdAt?: string;
  }): ContextResetRecord {
    this.#assertOpen();
    if (input.roomId.trim().length === 0) {
      throw new GroupXError("INVALID_ENVELOPE", "roomId must not be blank");
    }
    if (!Number.isSafeInteger(input.throughSeq) || input.throughSeq < 0) {
      throw new GroupXError("INVALID_ENVELOPE", "throughSeq must be a non-negative integer");
    }
    const createdAt = input.createdAt ?? nowIso();
    const resetId = createId("reset");
    return this.#withImmediateTransaction(() => {
      this.#database
        .prepare(`
          UPDATE summaries SET status = 'superseded'
          WHERE room_id = ? AND status = 'active' AND through_seq <= ?
        `)
        .run(input.roomId, input.throughSeq);
      this.#database
        .prepare(`
          INSERT INTO context_resets(
            reset_id, room_id, through_seq, reset_native_sessions, created_at
          ) VALUES (?, ?, ?, ?, ?)
        `)
        .run(
          resetId,
          input.roomId,
          input.throughSeq,
          input.resetNativeSessions === true ? 1 : 0,
          createdAt
        );
      return {
        resetId,
        roomId: input.roomId,
        throughSeq: input.throughSeq,
        createdAt,
        resetNativeSessions: input.resetNativeSessions === true
      };
    });
  }

  getLatestContextResetThroughSeq(roomId: string): number {
    this.#assertOpen();
    const row = this.#database
      .prepare(`
        SELECT through_seq FROM context_resets
        WHERE room_id = ?
        ORDER BY through_seq DESC, created_at DESC
        LIMIT 1
      `)
      .get(roomId) as Row | undefined;
    return row ? requiredNumber(row.through_seq, "through_seq") : 0;
  }

  getSupervisionTurnRole(turnId: string): SupervisionTurnRole | undefined {
    this.#assertOpen();
    return this.#getSupervisionTurnRoleUnsafe(turnId);
  }

  listSupervisionPairTurns(pairId: string): SupervisionPairTurnRecord[] {
    this.#assertOpen();
    return this.#listSupervisionPairTurnsUnsafe(pairId);
  }

  attachSupervisionWorkerTurn(input: {
    pairId: string;
    turnId: string;
    actorId: string;
    createdAt?: string;
  }): SupervisionPairTurnRecord {
    this.#assertOpen();
    return this.#withImmediateTransaction(() => {
      const pair = this.#getSupervisionPairUnsafe(input.pairId);
      if (!pair) {
        throw new GroupXError("SUPERVISION_PAIR_INVALID", "The supervision pair does not exist");
      }
      const turn = this.#getTurnUnsafe(input.turnId);
      if (!turn) {
        throw new GroupXError("UNKNOWN_TARGET", "The steered Turn does not exist");
      }
      if (turn.rootCorrelationId !== pair.correlationId) {
        throw new GroupXError(
          "SUPERVISION_PAIR_INVALID",
          "A steered Turn must stay in the pair correlation"
        );
      }
      const createdAt = input.createdAt ?? nowIso();
      this.#database
        .prepare(`
          INSERT INTO supervision_pair_turns(turn_id, pair_id, role, actor_id, created_at)
          VALUES (?, ?, 'worker', ?, ?)
        `)
        .run(input.turnId, input.pairId, input.actorId, createdAt);
      return this.#listSupervisionPairTurnsUnsafe(input.pairId).find(
        (member) => member.turnId === input.turnId
      )!;
    });
  }

  getSteerCount(subjectTurnId: string): number {
    this.#assertOpen();
    const row = this.#database
      .prepare("SELECT steer_count FROM supervision_steer_counts WHERE subject_turn_id = ?")
      .get(subjectTurnId) as Row | undefined;
    return row ? requiredNumber(row.steer_count, "steer_count") : 0;
  }

  incrementSteerCount(subjectTurnId: string, limit: number): number {
    this.#assertOpen();
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new GroupXError("INVALID_ENVELOPE", "Steer limit must be a positive integer");
    }
    return this.#withImmediateTransaction(() => {
      const turn = this.#getTurnUnsafe(subjectTurnId);
      if (!turn) {
        throw new GroupXError("UNKNOWN_TARGET", "The watched Turn does not exist");
      }
      this.#database
        .prepare(`
          INSERT INTO supervision_steer_counts(subject_turn_id, steer_count)
          VALUES (?, 0)
          ON CONFLICT(subject_turn_id) DO NOTHING
        `)
        .run(subjectTurnId);
      const updated = this.#database
        .prepare(`
          UPDATE supervision_steer_counts
          SET steer_count = steer_count + 1
          WHERE subject_turn_id = ? AND steer_count < ?
        `)
        .run(subjectTurnId, limit);
      if (updated.changes !== 1) {
        throw new GroupXError(
          "STEER_LIMIT_REACHED",
          `Steer count exceeds the configured limit ${limit}`,
          {
            limitKind: "steersPerSubjectTurn",
            limit,
            subjectTurnId
          }
        );
      }
      return this.getSteerCount(subjectTurnId);
    });
  }

  close(): void {
    if (this.#closed) return;
    try {
      if (!this.#database.inTransaction && this.databasePath !== ":memory:") {
        this.#database.pragma("wal_checkpoint(TRUNCATE)");
      }
    } finally {
      this.#database.close();
      this.#closed = true;
      if (this.#registryKey !== undefined) {
        OPEN_FILE_DATABASES.delete(this.#registryKey);
      }
    }
  }
}
