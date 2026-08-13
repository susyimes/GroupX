import type { StoredEventRecord } from "../storage/types.js";
import type { GroupXStore } from "../storage/types.js";

export interface MemoryClock {
  now(): string;
}

export type MemoryApplicationStore = Pick<
  GroupXStore,
  | "rememberMemory"
  | "supersedeMemory"
  | "retractMemory"
  | "searchMemory"
  | "rememberIdentity"
  | "supersedeIdentity"
  | "retractIdentity"
  | "readIdentity"
>;

export type ContextPacketStore = Pick<
  GroupXStore,
  | "getDeliveryCursor"
  | "getActiveSummary"
  | "getEvent"
  | "getRoomHighWaterSeq"
  | "listEvents"
  | "listEventsThrough"
  | "searchMemory"
  | "readIdentity"
>;

export interface RoomContextUsage {
  roomId: string;
  throughSeq: number;
  estimatedCharacters: number;
  maxCharacters: number;
  compactionTriggerCharacters: number;
  utilizationPercent: number;
  uncompactedMessageCount: number;
  summaryThroughSeq?: number;
  compactable: boolean;
}

export interface RoomContextCompactionResult {
  compacted: boolean;
  usage: RoomContextUsage;
}

export type IdentityPerspective = "configured" | "self" | "user-authored" | "observed";

export interface CurrentContextMessage {
  authorActorId: string;
  authorDisplayName?: string;
  content: string;
  sourceEventId?: string;
  sourceKind?: string;
  replyToEventId?: string;
  occurredAt?: string;
}

interface BuildContextPacketBase {
  roomId: string;
  targetActorId: string;
  /** Stable Agent identity read from groupx.json, never from chat or memory. */
  configuredIdentity?: string;
  throughSeq: number;
  maxChars: number;
}

export type BuildContextPacketInput = BuildContextPacketBase &
  (
    | { currentEvent: StoredEventRecord; currentMessage?: never }
    | { currentEvent?: never; currentMessage: CurrentContextMessage }
  );

export interface ContextSourceLabel {
  kind: string;
  eventId?: string;
  recordId?: string;
}

export interface ContextEntry {
  entryType: "message" | "memory" | "identity" | "summary";
  id: string;
  authorActorId: string;
  authorDisplayName?: string;
  subject: string;
  source: ContextSourceLabel;
  content: string;
  seq?: number;
  occurredAt?: string;
}

export interface IdentityContextEntry extends ContextEntry {
  entryType: "identity";
  subject: string;
  perspective: IdentityPerspective;
}

export interface ContextPacketSections {
  /** At most one mandatory identity configured for the target Agent. */
  configuredIdentity: IdentityContextEntry[];
  selfIdentity: IdentityContextEntry[];
  userAuthoredIdentity: IdentityContextEntry[];
  observedIdentity: IdentityContextEntry[];
  /** Stable memory explicitly curated by the target Agent or user. */
  agentCoreMemory: ContextEntry[];
  /** Automatic successful-Turn journal, isolated to the target Agent. */
  agentDatedMemory: ContextEntry[];
  publicMemory: ContextEntry[];
  /** At most one persisted cumulative room checkpoint. */
  generatedSummary: ContextEntry[];
  unreadTranscript: ContextEntry[];
  replyChain: ContextEntry[];
  currentMessage: ContextEntry;
}

export interface ContextPacketOmissions {
  selfIdentity: number;
  userAuthoredIdentity: number;
  observedIdentity: number;
  agentCoreMemory: number;
  agentDatedMemory: number;
  publicMemory: number;
  generatedSummary: number;
  unreadTranscript: number;
}

export interface ContextPacket {
  schema: "groupx.context/0.4";
  roomId: string;
  targetActorId: string;
  afterSeq: number;
  throughSeq: number;
  maxChars: number;
  charCount: number;
  sections: ContextPacketSections;
  omitted: ContextPacketOmissions;
  text: string;
}
