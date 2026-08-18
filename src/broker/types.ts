import type {
  AdapterHealth,
  AdapterId,
  CliAdapter,
  NativeSession
} from "../adapters/types.js";
import type { GroupXEnvelope } from "../core/envelope.js";
import type {
  AcceptMessageLimits,
  AgentDatedMemoryRollupRecord,
  ClaimedTurn,
  CreateIdentityInput,
  CreateMemoryInput,
  IdentityQuery,
  IdentityRecord,
  MemoryQuery,
  MemoryRecord,
  RecoveryResult,
  RuntimeTransport,
  StoredEventRecord,
  TurnRecord,
  TurnStatus
} from "../storage/types.js";

export interface BrokerSupervisionPair {
  observers: readonly string[];
  mode: "live_steer";
}

export interface BrokerMessageRequest {
  clientCommandId: string;
  to: readonly string[];
  content: string;
  replyToEventId?: string;
  supervision?: BrokerSupervisionPair;
}

/**
 * The caller binding is supplied by the HTTP/MCP composition layer. It is a
 * provenance association, not an authentication credential.
 */
export interface AcceptBrokerMessageInput {
  bindingId: string;
  request: BrokerMessageRequest;
  roomId?: string;
  commandType?: string;
  causationId?: string;
  correlationId?: string;
  parentTurnId?: string;
  hopCount?: number;
}

export interface BrokerSessionProvider {
  resolve(input: {
    actorId: string;
    adapterId: AdapterId;
  }): NativeSession | Promise<NativeSession>;
}

export interface BrokerContextPacket {
  contextPacket?: string;
  contextThroughSeq: number;
  /** Persisted summary boundary actually embedded in contextPacket. */
  summaryThroughSeq?: number;
}

export interface BrokerContextProvider {
  prepare(input: {
    turn: TurnRecord;
    sourceEvent: StoredEventRecord;
    lastDeliveredSeq: number;
  }): BrokerContextPacket | Promise<BrokerContextPacket>;
}

export interface BrokerContextController {
  inspectUsage(roomId: string): import("../memory/types.js").RoomContextUsage;
  compactNow(roomId: string): Promise<import("../memory/types.js").RoomContextCompactionResult>;
}

export interface BrokerDatedMemoryController {
  /** Schedules best-effort rollup work after a successful terminal commit. */
  noteCompleted(record: AgentDatedMemoryRollupRecord): void;
}

export interface BrokerEventPublisher {
  publish(envelope: GroupXEnvelope): void | Promise<void>;
}

export interface BrokerAgentController {
  restart(actorId: string): void | Promise<void>;
}

export interface ActiveBrokerTurnContext {
  bindingId: string;
  turnId: string;
  rootCorrelationId: string;
  hopCount: number;
}

/**
 * Synchronous composition hook used to associate native MCP calls with the
 * currently executing GroupX Turn. It is provenance/causality state, not an
 * authorization decision point.
 */
export interface BrokerTurnLifecycle {
  activate(context: ActiveBrokerTurnContext): void;
  deactivate(context: ActiveBrokerTurnContext): void;
}

export interface BrokerClock {
  now(): string;
}

export type BrokerIdFactory = (prefix: string) => string;

export interface BrokerErrorContext {
  operation:
    | "publish"
    | "dispatch"
    | "context"
    | "memory"
    | "restart"
    | "recovery";
  actorId?: string;
  turnId?: string;
}

export interface BrokerDependencies {
  store: import("../storage/types.js").GroupXStore;
  adapters: import("../adapters/registry.js").AdapterRegistry;
  sessions: BrokerSessionProvider;
  publisher: BrokerEventPublisher;
  agentController?: BrokerAgentController;
  contextProvider?: BrokerContextProvider;
  contextController?: BrokerContextController;
  datedMemoryController?: BrokerDatedMemoryController;
  turnLifecycle?: BrokerTurnLifecycle;
  acceptMessageLimits?: AcceptMessageLimits;
  steerLimit?: number;
  watchTimeoutMs?: number;
  selectedTransport: RuntimeTransport;
  clock?: BrokerClock;
  idFactory?: BrokerIdFactory;
  defaultRoomId?: string;
  partialCheckpointChars?: number;
  nativeCancelTimeoutMs?: number;
  closeTimeoutMs?: number;
  onError?: (error: unknown, context: BrokerErrorContext) => void;
}

export interface CancelTurnOutcome {
  turnId: string;
  accepted: boolean;
  status: TurnStatus;
}

export interface CancelTurnFromBindingInput {
  turnId: string;
  bindingId: string;
  clientCommandId: string;
}

export interface CompactContextFromBindingInput {
  bindingId: string;
  clientCommandId: string;
  roomId?: string;
}

export interface CorrelationReadResult {
  correlationId?: string;
  events: GroupXEnvelope[];
  turns: Array<{
    target: string;
    turnId: string;
    status: string;
    responseEventId?: string;
    errorCode?: string;
  }>;
  nextAfterSeq?: number;
}

export interface ReadCorrelationInput {
  correlationId?: string;
  roomId?: string;
  afterSeq?: number;
  limit?: number;
}

export interface WatchSubjectInput {
  watchTurnId: string;
  subjectTurnId?: string;
  afterSeq?: number;
  until: "next_milestone" | "terminal";
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface WatchSubjectResult {
  snapshot: import("../core/supervision.js").SupervisionSnapshot;
  until: "next_milestone" | "terminal";
  timedOut: boolean;
}

export interface SteerSubjectInput {
  bindingId: string;
  watchTurnId: string;
  subjectTurnId?: string;
  action: "nudge" | "interrupt";
  reason: string;
  content: string;
  clientCommandId: string;
}

export interface SteerSubjectResult {
  action: "nudge" | "interrupt";
  reason: string;
  subjectTurnId: string;
  messageEventId: string;
  correlationId: string;
  nextTurnId?: string;
  steeredEventId?: string;
}

export interface WaitForCorrelationInput {
  correlationId: string;
  /**
   * For groupx.ask this is the exact child Turn set returned by acceptMessage.
   * If omitted, the Broker snapshots the correlation's current Turns.
   */
  childTurnIds?: readonly string[];
  roomId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface CorrelationWaitResult {
  state: "terminal" | "timeout" | "aborted";
  correlationId: string;
  turns: TurnRecord[];
  read: CorrelationReadResult;
  /** Exact final response events for the waited child Turns, independent of read pagination. */
  responseEvents: GroupXEnvelope[];
}

export interface BrokerHealth {
  store: {
    available: boolean;
    integrityOk: boolean;
    schemaVersion: number;
    journalMode: string;
  };
  agents: AdapterHealth[];
  activeTurns: number;
  queuedTurns: number;
}

export interface BrokerTurnProjection {
  turnId: string;
  targetActorId: string;
  status: TurnRecord["status"];
  sourceEventId: string;
}

export interface BrokerBootstrap {
  schema: "groupx.bootstrap/0.1";
  room: { roomId: string; throughSeq: number };
  agents: Array<{
    actorId: string;
    displayName: string;
    status: string;
    instanceId?: string;
  }>;
  recentEvents: GroupXEnvelope[];
  activeTurns: BrokerTurnProjection[];
}

export interface RememberMemoryFromBindingInput
  extends Omit<CreateMemoryInput, "authorActorId" | "sourceKind"> {
  bindingId: string;
  clientCommandId: string;
  roomId?: string;
  correlationId?: string;
}

export interface RememberIdentityFromBindingInput
  extends Omit<CreateIdentityInput, "authorActorId" | "sourceKind"> {
  bindingId: string;
  clientCommandId: string;
  roomId?: string;
  correlationId?: string;
}

export interface SupersedeMemoryFromBindingInput {
  bindingId: string;
  clientCommandId: string;
  roomId?: string;
  correlationId?: string;
  kind?: CreateMemoryInput["kind"];
  content: string;
  sourceEventId?: string;
}

export interface SupersedeIdentityFromBindingInput {
  bindingId: string;
  clientCommandId: string;
  roomId?: string;
  correlationId?: string;
  kind?: string;
  content: string;
  sourceEventId?: string;
}

export interface RetractRecordFromBindingInput {
  bindingId: string;
  clientCommandId: string;
  roomId?: string;
  correlationId?: string;
}

export interface BrokerFacade {
  acceptMessage(input: AcceptBrokerMessageInput): Promise<import("../storage/types.js").AcceptMessageResult>;
  assertObserverRouting(watchTurnId: string, targets: readonly string[]): void;
  watchSubject(input: WatchSubjectInput): Promise<WatchSubjectResult>;
  steerSubject(input: SteerSubjectInput): Promise<SteerSubjectResult>;
  cancelTurn(turnId: string): Promise<CancelTurnOutcome>;
  cancelFromBinding(input: CancelTurnFromBindingInput): Promise<CancelTurnOutcome>;
  contextUsage(roomId?: string): import("../memory/types.js").RoomContextUsage;
  compactContextFromBinding(
    input: CompactContextFromBindingInput
  ): Promise<import("../memory/types.js").RoomContextCompactionResult>;
  readCorrelation(input?: ReadCorrelationInput): CorrelationReadResult;
  waitForCorrelation(input: WaitForCorrelationInput): Promise<CorrelationWaitResult>;
  health(): BrokerHealth;
  bootstrap(input?: { roomId?: string; recentLimit?: number }): BrokerBootstrap;
  queryMemory(input?: MemoryQuery): MemoryRecord[];
  queryIdentity(input?: IdentityQuery): IdentityRecord[];
  rememberMemory(input: RememberMemoryFromBindingInput): Promise<MemoryRecord>;
  supersedeMemory(
    memoryId: string,
    input: SupersedeMemoryFromBindingInput
  ): Promise<MemoryRecord>;
  retractMemory(
    memoryId: string,
    input: RetractRecordFromBindingInput
  ): Promise<MemoryRecord>;
  rememberIdentity(input: RememberIdentityFromBindingInput): Promise<IdentityRecord>;
  supersedeIdentity(
    identityId: string,
    input: SupersedeIdentityFromBindingInput
  ): Promise<IdentityRecord>;
  retractIdentity(
    identityId: string,
    input: RetractRecordFromBindingInput
  ): Promise<IdentityRecord>;
  recoverAfterRestart(): Promise<RecoveryResult>;
  notifySessionReady(actorId: string): void;
  restartAgent(actorId: string): Promise<void>;
  waitForIdle(): Promise<void>;
  close(): Promise<void>;
}

export interface DispatchPreparation {
  claim: ClaimedTurn;
  adapter: CliAdapter;
  session: NativeSession;
  sourceEvent: StoredEventRecord;
  promptContent: string;
  contextPacket?: string;
}
