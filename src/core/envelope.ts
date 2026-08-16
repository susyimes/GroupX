import { createHash, randomUUID } from "node:crypto";

export const GROUPX_SCHEMA = "groupx.event/0.1" as const;
export const DEFAULT_ROOM_ID = "room:main" as const;

export type ActorKind = "user" | "agent" | "system";
export type Durability = "durable" | "transient";

export type GroupXEventType =
  | "message.created"
  | "turn.queued"
  | "turn.dispatched"
  | "turn.started"
  | "turn.content.delta"
  | "turn.reasoning.delta"
  | "turn.reasoning.recorded"
  | "turn.progress"
  | "turn.completed"
  | "turn.failed"
  | "turn.cancelled"
  | "turn.interrupted"
  | "tool.progress"
  | "tool.progress.recorded"
  | "context.compaction.started"
  | "context.compaction.retrying"
  | "context.compaction.completed"
  | "context.compaction.failed"
  | "session.starting"
  | "session.retrying"
  | "session.ready"
  | "session.resumed"
  | "session.stopped"
  | "session.failed"
  | "memory.remembered"
  | "memory.superseded"
  | "memory.retracted"
  | "identity.remembered"
  | "identity.superseded"
  | "identity.retracted"
  | "routing.loop_stopped"
  | "system.error";

export interface ActorRef {
  actorId: string;
  kind: ActorKind;
  instanceId?: string;
  displayName: string;
}

export interface PublicProvenance {
  sourceKind: "web" | "adapter" | "mcp" | "system" | "generated_summary";
  authorActorId?: string;
  subjectActorId?: string;
  sourceEventId?: string;
  labels?: string[];
}

export interface GroupXEnvelope<TBody = unknown> {
  schema: typeof GROUPX_SCHEMA;
  eventId: string;
  seq: number | null;
  roomId: string;
  type: GroupXEventType;
  actor: ActorRef;
  to: string[];
  replyToEventId?: string;
  forwardedEventId?: string;
  causationId?: string;
  correlationId: string;
  rootCorrelationId: string;
  idempotencyKey?: string;
  occurredAt: string;
  durability: Durability;
  body: TBody;
  provenance?: PublicProvenance;
}

export const BUILTIN_ACTORS = {
  web: { actorId: "user:web", kind: "user", displayName: "You" },
  codex: { actorId: "agent:codex", kind: "agent", displayName: "Codex" },
  grok: { actorId: "agent:grok", kind: "agent", displayName: "Grok" },
  kimi: { actorId: "agent:kimi", kind: "agent", displayName: "Kimi" },
  hermes: { actorId: "agent:hermes", kind: "agent", displayName: "Hermes" },
  claude: { actorId: "agent:claude", kind: "agent", displayName: "Claude" },
  system: { actorId: "system:groupx", kind: "system", displayName: "GroupX" }
} as const satisfies Record<string, ActorRef>;

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function createCorrelationId(): string {
  return createId("corr");
}

function sortForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForCanonicalJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortForCanonicalJson(child)])
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForCanonicalJson(value));
}

export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function asDurableEnvelope<TBody>(
  input: Omit<GroupXEnvelope<TBody>, "schema" | "seq" | "durability" | "occurredAt"> & {
    occurredAt?: string;
  }
): GroupXEnvelope<TBody> {
  return {
    ...input,
    schema: GROUPX_SCHEMA,
    seq: null,
    durability: "durable",
    occurredAt: input.occurredAt ?? new Date().toISOString()
  };
}

export function asTransientEnvelope<TBody>(
  input: Omit<GroupXEnvelope<TBody>, "schema" | "seq" | "durability" | "occurredAt"> & {
    occurredAt?: string;
  }
): GroupXEnvelope<TBody> {
  return {
    ...input,
    schema: GROUPX_SCHEMA,
    seq: null,
    durability: "transient",
    occurredAt: input.occurredAt ?? new Date().toISOString()
  };
}
