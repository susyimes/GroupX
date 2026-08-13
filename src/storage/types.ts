import type { PublicProvenance } from "../core/envelope.js";

export type JsonObject = Readonly<Record<string, unknown>>;
export type RuntimeTransport = "direct" | "structured";

export interface ActorRecord {
  actorId: string;
  kind: "user" | "agent" | "system";
  displayName: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertActorInput {
  actorId: string;
  kind: ActorRecord["kind"];
  displayName: string;
  enabled?: boolean;
  now?: string;
}

export interface AgentInstanceRecord {
  instanceId: string;
  actorId: string;
  adapterId: string;
  transport?: RuntimeTransport;
  processStartedAt: string;
  processEndedAt?: string;
  status: AgentInstanceStatus;
}

export const AGENT_INSTANCE_STATUSES = [
  "starting",
  "ready",
  "stopping",
  "stopped",
  "failed",
  "interrupted"
] as const;
export type AgentInstanceStatus = (typeof AGENT_INSTANCE_STATUSES)[number];

export interface CreateAgentInstanceInput {
  instanceId: string;
  actorId: string;
  adapterId: string;
  transport?: RuntimeTransport;
  processStartedAt?: string;
  status?: Extract<AgentInstanceStatus, "starting" | "ready">;
}

export interface FinishAgentInstanceInput {
  status: Extract<AgentInstanceStatus, "stopped" | "failed" | "interrupted">;
  processEndedAt?: string;
}

export interface SessionBindingRecord {
  bindingId: string;
  instanceId: string;
  actorId: string;
  nativeSessionId?: string;
  protocol: string;
  transport?: RuntimeTransport;
  protocolVersion?: string;
  status: SessionBindingStatus;
  capabilities: JsonObject;
  createdAt: string;
  lastReadyAt?: string;
  closedAt?: string;
}

export const SESSION_BINDING_STATUSES = [
  "starting",
  "ready",
  "closed",
  "failed",
  "interrupted"
] as const;
export type SessionBindingStatus = (typeof SESSION_BINDING_STATUSES)[number];

export interface CreateSessionBindingInput {
  bindingId: string;
  instanceId: string;
  actorId: string;
  nativeSessionId?: string;
  protocol: string;
  transport?: RuntimeTransport;
  protocolVersion?: string;
  status?: Extract<SessionBindingStatus, "starting" | "ready">;
  capabilities?: JsonObject;
  createdAt?: string;
  lastReadyAt?: string;
}

export interface MarkSessionBindingReadyInput {
  nativeSessionId?: string;
  protocolVersion?: string;
  capabilities?: JsonObject;
  lastReadyAt?: string;
}

export interface MarkSessionBindingFailedInput {
  status?: Extract<SessionBindingStatus, "failed" | "interrupted">;
  closedAt?: string;
}

export interface RuntimeRecoveryResult {
  agentInstances: AgentInstanceRecord[];
  sessionBindings: SessionBindingRecord[];
}

export interface ClientCommandRecord<TResult = unknown> {
  commandId: string;
  sourceBindingId: string;
  clientCommandId: string;
  commandType: string;
  canonicalHash: string;
  completed: boolean;
  result: TResult | null;
  acceptedAt: string;
}

export interface BeginClientCommandInput {
  sourceBindingId: string;
  clientCommandId: string;
  commandType: string;
  canonicalPayload: JsonObject;
  acceptedAt?: string;
}

export type BeginClientCommandOutcome<TResult = unknown> =
  | { disposition: "accepted" }
  | { disposition: "pending" }
  | { disposition: "replayed"; result: TResult };

export interface CompleteClientCommandInput<TResult = unknown> {
  sourceBindingId: string;
  clientCommandId: string;
  result: TResult;
}

export interface DurableEventInput<TBody = unknown> {
  eventId?: string;
  schemaVersion?: string;
  roomId: string;
  eventType: string;
  actorId: string;
  instanceId?: string;
  targets?: readonly string[];
  replyToEventId?: string;
  causationId?: string;
  correlationId: string;
  idempotencyKey?: string;
  occurredAt?: string;
  body: TBody;
  provenance?: PublicProvenance;
}

export interface StoredEventRecord<TBody = unknown> {
  seq: number;
  eventId: string;
  schemaVersion: string;
  roomId: string;
  eventType: string;
  actorId: string;
  actorKind: ActorRecord["kind"];
  actorDisplayName: string;
  instanceId?: string;
  targets: string[];
  replyToEventId?: string;
  causationId?: string;
  correlationId: string;
  idempotencyKey?: string;
  occurredAt: string;
  body: TBody;
  provenance?: PublicProvenance;
}

export interface EventPage {
  events: StoredEventRecord[];
  afterSeq: number;
  nextAfterSeq: number;
  hasMore: boolean;
}

export const TURN_STATUSES = [
  "queued",
  "dispatching",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "interrupted"
] as const;

export type TurnStatus = (typeof TURN_STATUSES)[number];
export type RunningTurnStatus = Extract<
  TurnStatus,
  "queued" | "dispatching" | "running" | "cancelling"
>;
export type TerminalTurnStatus = Exclude<TurnStatus, RunningTurnStatus>;

export interface TurnTargetInput {
  actorId: string;
  adapterId: string;
  transport: RuntimeTransport;
  bindingId?: string;
  parentTurnId?: string;
  hopCount?: number;
}

export interface AcceptMessageLimits {
  /** Defaults mirror the v0.1 config schema; this exported value is the storage fallback source. */
  rootTurns: number;
  hopCount: number;
  actorCallsPerRoot: number;
  queuePerActor: number;
}

export const DEFAULT_ACCEPT_MESSAGE_LIMITS: Readonly<AcceptMessageLimits> = Object.freeze({
  rootTurns: 24,
  hopCount: 12,
  actorCallsPerRoot: 8,
  queuePerActor: 64
});

export interface AcceptMessageInput {
  sourceBindingId: string;
  clientCommandId: string;
  commandType?: string;
  roomId: string;
  targets: readonly TurnTargetInput[];
  content: string;
  replyToEventId?: string;
  causationId?: string;
  correlationId?: string;
  idempotencyKey?: string;
  occurredAt?: string;
  provenance?: PublicProvenance;
  limits?: AcceptMessageLimits;
}

export interface AcceptedTurnResult {
  target: string;
  turnId: string;
  status: "queued";
}

export interface AcceptMessageResult {
  messageEventId: string;
  correlationId: string;
  turns: AcceptedTurnResult[];
}

export interface AcceptMessageOutcome {
  result: AcceptMessageResult;
  disposition: "accepted" | "replayed";
}

export interface TurnRecord {
  turnId: string;
  sourceEventId: string;
  targetActorId: string;
  adapterId: string;
  transport: RuntimeTransport;
  bindingId?: string;
  nativeTurnId?: string;
  parentTurnId?: string;
  rootCorrelationId: string;
  hopCount: number;
  enqueueSeq: number;
  queuedEventId: string;
  status: TurnStatus;
  partialText?: string;
  responseEventId?: string;
  terminalEventId?: string;
  errorCode?: string;
  queuedAt: string;
  startedAt?: string;
  terminalAt?: string;
}

export interface RoomBootstrapSnapshot {
  roomId: string;
  throughSeq: number;
  recentEvents: StoredEventRecord[];
  activeTurns: TurnRecord[];
}

export interface EnqueueTurnInput {
  turnId?: string;
  sourceEventId: string;
  targetActorId: string;
  adapterId: string;
  transport: RuntimeTransport;
  bindingId?: string;
  parentTurnId?: string;
  rootCorrelationId: string;
  hopCount?: number;
  queuedAt?: string;
}

export interface TerminalToolProgressInput {
  occurredAt: string;
  nativeType: "tool.started" | "tool.completed";
  toolCallId?: string;
  details: unknown;
}

export interface TerminalTurnInput {
  turnId: string;
  attemptId?: string;
  status: TerminalTurnStatus;
  content?: string;
  /** Aggregated native reasoning for durable transcript replay; never a Context Packet input. */
  reasoning?: string;
  /** Bounded native tool projections for durable UI replay; never a Context Packet input. */
  toolProgress?: readonly TerminalToolProgressInput[];
  errorCode?: string;
  eventType?: string;
  eventBody?: JsonObject;
  occurredAt?: string;
}

export interface TerminalTurnResult {
  turn: TurnRecord;
  reasoningEvent?: StoredEventRecord;
  toolProgressEvents?: StoredEventRecord[];
  responseEvent?: StoredEventRecord;
  /** Automatic per-Agent dated memory written in the same terminal transaction. */
  datedMemory?: MemoryRecord;
  datedMemoryEvent?: StoredEventRecord;
  terminalEvent: StoredEventRecord;
}

export const DELIVERY_CERTAINTIES = ["not_delivered", "delivered", "unknown", "terminal"] as const;
export type DeliveryCertainty = (typeof DELIVERY_CERTAINTIES)[number];

export const DISPATCH_PHASES = [
  "prepared",
  "prompt_invoked",
  "native_started",
  "terminal"
] as const;
export type DispatchPhase = (typeof DISPATCH_PHASES)[number];

export interface TurnAttemptRecord {
  attemptId: string;
  turnId: string;
  bindingId: string;
  instanceId: string;
  contextThroughSeq: number;
  /** Highest room sequence represented by a persisted summary in this attempt. */
  summaryThroughSeq?: number;
  nativeTurnId?: string;
  dispatchPhase: DispatchPhase;
  claimedAt: string;
  promptInvokedAt?: string;
  startedAt?: string;
  terminalAt?: string;
  deliveryCertainty: DeliveryCertainty;
}

export interface ClaimedTurn {
  turn: TurnRecord;
  attempt: TurnAttemptRecord;
}

export interface DeliveryCursorRecord {
  actorId: string;
  roomId: string;
  lastDeliveredSeq: number;
  lastSummarySeq?: number;
  updatedAt: string;
}

export const SUMMARY_STATUSES = ["active", "superseded"] as const;
export type SummaryStatus = (typeof SUMMARY_STATUSES)[number];

/** A cumulative, derived room checkpoint. The source transcript remains authoritative. */
export interface SummaryRecord {
  summaryId: string;
  roomId: string;
  fromSeq: number;
  throughSeq: number;
  content: string;
  generatorActorId: string;
  status: SummaryStatus;
  createdAt: string;
}

export interface ReplaceRoomSummaryInput {
  summaryId?: string;
  roomId: string;
  fromSeq: number;
  throughSeq: number;
  content: string;
  generatorActorId: string;
  /** Compare-and-set guard. Omit only when the room has no active summary. */
  expectedPreviousSummaryId?: string;
  createdAt?: string;
}

export interface RecoveryResult {
  queuedTurns: TurnRecord[];
  interruptedTurns: TurnRecord[];
}

export const MEMORY_SCOPE_TYPES = ["room", "agent", "correlation"] as const;
export type MemoryScopeType = (typeof MEMORY_SCOPE_TYPES)[number];

export const MEMORY_KINDS = [
  "fact",
  "decision",
  "preference",
  "instruction",
  "constraint",
  "summary",
  "note"
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export const AGENT_MEMORY_TYPES = ["core", "dated"] as const;
export type AgentMemoryType = (typeof AGENT_MEMORY_TYPES)[number];
export type RecordStatus = "active" | "superseded" | "retracted";

export interface MemoryRecord {
  memoryId: string;
  scopeType: MemoryScopeType;
  scopeId: string;
  /** Present only for Agent-scoped records. */
  agentMemoryType?: AgentMemoryType;
  kind: MemoryKind;
  authorActorId: string;
  subjectActorId?: string;
  content: string;
  sourceEventId?: string;
  sourceKind: string;
  status: RecordStatus;
  supersedesMemoryId?: string;
  createdAt: string;
  retractedAt?: string;
}

export interface CreateMemoryInput {
  memoryId?: string;
  scopeType: MemoryScopeType;
  scopeId: string;
  /** Required for Agent scope and forbidden for room/correlation scope. */
  agentMemoryType?: AgentMemoryType;
  kind: MemoryKind;
  authorActorId: string;
  subjectActorId?: string;
  content: string;
  sourceEventId?: string;
  sourceKind: string;
  createdAt?: string;
}

export type MemoryMutationCommand =
  | { kind: "remember"; record: CreateMemoryInput }
  | { kind: "supersede"; memoryId: string; replacement: CreateMemoryInput }
  | { kind: "retract"; memoryId: string };

export interface MutateMemoryInput {
  sourceBindingId: string;
  clientCommandId: string;
  roomId: string;
  correlationId?: string;
  occurredAt?: string;
  mutation: MemoryMutationCommand;
}

export interface MemoryMutationResult {
  record: MemoryRecord;
  event: StoredEventRecord;
}

export interface MemoryMutationOutcome {
  result: MemoryMutationResult;
  disposition: "accepted" | "replayed";
}

export interface MemoryQuery {
  scopeType?: MemoryScopeType;
  scopeId?: string;
  agentMemoryType?: AgentMemoryType;
  kind?: MemoryKind;
  authorActorId?: string;
  subjectActorId?: string;
  text?: string;
  includeHistory?: boolean;
  /** Offset in deterministic result order; use against a mutation-free snapshot. */
  cursor?: number;
  limit?: number;
}

export interface IdentityRecord {
  identityId: string;
  subjectActorId: string;
  authorActorId: string;
  kind: string;
  content: string;
  sourceEventId?: string;
  sourceKind: string;
  status: RecordStatus;
  supersedesIdentityId?: string;
  createdAt: string;
  retractedAt?: string;
}

export interface CreateIdentityInput {
  identityId?: string;
  subjectActorId: string;
  authorActorId: string;
  kind: string;
  content: string;
  sourceEventId?: string;
  sourceKind: string;
  createdAt?: string;
}

export type IdentityMutationCommand =
  | { kind: "remember"; record: CreateIdentityInput }
  | { kind: "supersede"; identityId: string; replacement: CreateIdentityInput }
  | { kind: "retract"; identityId: string };

export interface MutateIdentityInput {
  sourceBindingId: string;
  clientCommandId: string;
  roomId: string;
  correlationId?: string;
  occurredAt?: string;
  mutation: IdentityMutationCommand;
}

export interface IdentityMutationResult {
  record: IdentityRecord;
  event: StoredEventRecord;
}

export interface IdentityMutationOutcome {
  result: IdentityMutationResult;
  disposition: "accepted" | "replayed";
}

export interface IdentityQuery {
  subjectActorId?: string;
  authorActorId?: string;
  kind?: string;
  text?: string;
  includeHistory?: boolean;
  /** Offset in deterministic result order; use against a mutation-free snapshot. */
  cursor?: number;
  limit?: number;
}

export interface IntegrityCheckResult {
  ok: boolean;
  messages: string[];
}

export interface GroupXStore {
  readonly databasePath: string;
  getSchemaVersion(): number;
  getJournalMode(): string;
  upsertActor(input: UpsertActorInput): ActorRecord;
  getActor(actorId: string): ActorRecord | undefined;
  listActors(): ActorRecord[];
  createAgentInstance(input: CreateAgentInstanceInput): AgentInstanceRecord;
  getAgentInstance(instanceId: string): AgentInstanceRecord | undefined;
  finishAgentInstance(
    instanceId: string,
    input: FinishAgentInstanceInput
  ): AgentInstanceRecord;
  createSessionBinding(input: CreateSessionBindingInput): SessionBindingRecord;
  getSessionBinding(bindingId: string): SessionBindingRecord | undefined;
  listSessionBindings(): SessionBindingRecord[];
  markSessionBindingReady(
    bindingId: string,
    input?: MarkSessionBindingReadyInput
  ): SessionBindingRecord;
  markSessionBindingFailed(
    bindingId: string,
    input?: MarkSessionBindingFailedInput
  ): SessionBindingRecord;
  closeSessionBinding(bindingId: string, closedAt?: string): SessionBindingRecord;
  recoverStaleRuntimeRecords(now?: string): RuntimeRecoveryResult;
  getClientCommand<TResult = unknown>(
    sourceBindingId: string,
    clientCommandId: string
  ): ClientCommandRecord<TResult> | undefined;
  beginClientCommand<TResult = unknown>(
    input: BeginClientCommandInput
  ): BeginClientCommandOutcome<TResult>;
  completeClientCommand<TResult = unknown>(
    input: CompleteClientCommandInput<TResult>
  ): TResult;
  acceptMessage(input: AcceptMessageInput): AcceptMessageResult;
  acceptMessageWithDisposition(input: AcceptMessageInput): AcceptMessageOutcome;
  appendDurableEvent(input: DurableEventInput): StoredEventRecord;
  getEvent(eventId: string): StoredEventRecord | undefined;
  listEvents(input: { roomId: string; afterSeq?: number; limit?: number }): EventPage;
  getRoomHighWaterSeq(roomId: string): number;
  listEventsThrough(input: {
    roomId: string;
    afterSeq?: number;
    throughSeq: number;
    limit?: number;
  }): EventPage;
  readRoomBootstrapSnapshot(input: {
    roomId: string;
    recentLimit?: number;
  }): RoomBootstrapSnapshot;
  countEvents(roomId?: string): number;
  enqueueTurn(input: EnqueueTurnInput): TurnRecord;
  getTurn(turnId: string): TurnRecord | undefined;
  listTurns(input?: {
    status?: TurnStatus;
    targetActorId?: string;
    rootCorrelationId?: string;
  }): TurnRecord[];
  countTurns(): number;
  claimNextQueuedTurn(input: {
    targetActorId: string;
    bindingId: string;
    instanceId: string;
    contextThroughSeq: number;
    summaryThroughSeq?: number;
    expectedTurnId: string;
    expectedTransport: RuntimeTransport;
    claimedAt?: string;
  }): ClaimedTurn | undefined;
  getTurnAttempt(attemptId: string): TurnAttemptRecord | undefined;
  listTurnAttempts(turnId: string): TurnAttemptRecord[];
  markPromptInvoked(attemptId: string, invokedAt?: string): ClaimedTurn;
  bindAttemptNativeTurnId(attemptId: string, nativeTurnId: string): ClaimedTurn;
  markAttemptRunning(attemptId: string, nativeTurnId?: string, startedAt?: string): ClaimedTurn;
  requestTurnCancellation(turnId: string): TurnRecord;
  cancelQueuedTurn(turnId: string, occurredAt?: string): TerminalTurnResult;
  failQueuedTurn(
    turnId: string,
    errorCode: string,
    occurredAt?: string,
    eventBody?: JsonObject
  ): TerminalTurnResult;
  saveTurnPartialText(turnId: string, partialText: string): TurnRecord;
  terminalizeTurn(input: TerminalTurnInput): TerminalTurnResult;
  getDeliveryCursor(actorId: string, roomId: string): DeliveryCursorRecord | undefined;
  getActiveSummary(roomId: string, throughSeq?: number): SummaryRecord | undefined;
  listSummaries(input: {
    roomId: string;
    includeHistory?: boolean;
    limit?: number;
  }): SummaryRecord[];
  replaceActiveSummary(input: ReplaceRoomSummaryInput): SummaryRecord;
  recoverAfterRestart(now?: string): RecoveryResult;
  rememberMemory(input: CreateMemoryInput): MemoryRecord;
  mutateMemoryWithDisposition(input: MutateMemoryInput): MemoryMutationOutcome;
  getMemory(memoryId: string): MemoryRecord | undefined;
  supersedeMemory(memoryId: string, replacement: CreateMemoryInput): MemoryRecord;
  retractMemory(memoryId: string, retractedAt?: string): MemoryRecord;
  searchMemory(input?: MemoryQuery): MemoryRecord[];
  rememberIdentity(input: CreateIdentityInput): IdentityRecord;
  mutateIdentityWithDisposition(input: MutateIdentityInput): IdentityMutationOutcome;
  getIdentity(identityId: string): IdentityRecord | undefined;
  supersedeIdentity(identityId: string, replacement: CreateIdentityInput): IdentityRecord;
  retractIdentity(identityId: string, retractedAt?: string): IdentityRecord;
  readIdentity(input?: IdentityQuery): IdentityRecord[];
  integrityCheck(): IntegrityCheckResult;
  close(): void;
}
