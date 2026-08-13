import type { GroupXEventType } from "../core/envelope.js";
import { GroupXError } from "../core/errors.js";
import type {
  IdentityRecord,
  MemoryRecord,
  StoredEventRecord
} from "../storage/types.js";
import type {
  IdentityRecordContract,
  MemoryRecordContract
} from "../contracts/rest.js";
import { assertSseEnvelope } from "../web/sse/codec.js";
import type { DurableGroupXEnvelope } from "../web/sse/types.js";

/**
 * Project one committed storage event onto the public durable event envelope.
 *
 * Storage remains authoritative for sender attribution. No body field is ever
 * consulted to derive actor, instance, target, or provenance information.
 */
export function toDurableEnvelope<TBody = unknown>(
  event: StoredEventRecord<TBody>
): DurableGroupXEnvelope<TBody> {
  const envelope: DurableGroupXEnvelope<TBody> = {
    schema: "groupx.event/0.1",
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
    ...(event.replyToEventId === undefined
      ? {}
      : { replyToEventId: event.replyToEventId }),
    ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
    correlationId: event.correlationId,
    rootCorrelationId: event.correlationId,
    ...(event.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: event.idempotencyKey }),
    occurredAt: event.occurredAt,
    durability: "durable",
    body: event.body,
    ...(event.provenance === undefined ? {} : { provenance: event.provenance })
  };

  // Fail closed if corrupted or incompatible persisted data reaches the
  // transport boundary.
  assertSseEnvelope(envelope);
  return envelope;
}

export function toMemoryRecordContract(record: MemoryRecord): MemoryRecordContract {
  if (
    record.sourceKind !== "web" &&
    record.sourceKind !== "mcp" &&
    record.sourceKind !== "generated_summary" &&
    record.sourceKind !== "automatic_turn"
  ) {
    throw new GroupXError("STORE_UNAVAILABLE", "Memory record has an invalid source kind");
  }
  return {
    memoryId: record.memoryId,
    scope: { type: record.scopeType, id: record.scopeId },
    ...(record.agentMemoryType === undefined
      ? {}
      : { agentMemoryType: record.agentMemoryType }),
    kind: record.kind,
    authorActorId: record.authorActorId,
    ...(record.subjectActorId === undefined
      ? {}
      : { subjectActorId: record.subjectActorId }),
    content: record.content,
    ...(record.sourceEventId === undefined ? {} : { sourceEventId: record.sourceEventId }),
    sourceKind: record.sourceKind,
    status: record.status,
    ...(record.supersedesMemoryId === undefined
      ? {}
      : { supersedesMemoryId: record.supersedesMemoryId }),
    createdAt: record.createdAt,
    ...(record.retractedAt === undefined ? {} : { retractedAt: record.retractedAt })
  };
}

export function toIdentityRecordContract(record: IdentityRecord): IdentityRecordContract {
  if (
    record.sourceKind !== "web" &&
    record.sourceKind !== "mcp" &&
    record.sourceKind !== "adapter"
  ) {
    throw new GroupXError("STORE_UNAVAILABLE", "Identity record has an invalid source kind");
  }
  if (
    record.kind !== "preference" &&
    record.kind !== "instruction" &&
    record.kind !== "constraint" &&
    record.kind !== "note"
  ) {
    throw new GroupXError("STORE_UNAVAILABLE", "Identity record has an invalid kind");
  }
  return {
    identityId: record.identityId,
    subjectActorId: record.subjectActorId,
    authorActorId: record.authorActorId,
    kind: record.kind,
    content: record.content,
    ...(record.sourceEventId === undefined ? {} : { sourceEventId: record.sourceEventId }),
    sourceKind: record.sourceKind,
    status: record.status,
    ...(record.supersedesIdentityId === undefined
      ? {}
      : { supersedesIdentityId: record.supersedesIdentityId }),
    createdAt: record.createdAt,
    ...(record.retractedAt === undefined ? {} : { retractedAt: record.retractedAt })
  };
}
