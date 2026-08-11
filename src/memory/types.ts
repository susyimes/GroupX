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
  | "getEvent"
  | "listEvents"
  | "searchMemory"
  | "readIdentity"
>;

export type IdentityPerspective = "self" | "user-authored" | "observed";

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
  entryType: "message" | "memory" | "identity";
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
  selfIdentity: IdentityContextEntry[];
  userAuthoredIdentity: IdentityContextEntry[];
  observedIdentity: IdentityContextEntry[];
  publicMemory: ContextEntry[];
  unreadTranscript: ContextEntry[];
  replyChain: ContextEntry[];
  currentMessage: ContextEntry;
}

export interface ContextPacketOmissions {
  selfIdentity: number;
  userAuthoredIdentity: number;
  observedIdentity: number;
  publicMemory: number;
  unreadTranscript: number;
}

export interface ContextPacket {
  schema: "groupx.context/0.1";
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
