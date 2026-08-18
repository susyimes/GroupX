import { z } from "zod";

import {
  ActorIdSchema,
  AgentActorIdSchema,
  NonNegativeIntegerSchema,
  ReferenceIdSchema
} from "./common.js";
import { parseContractOutput } from "./validation.js";

export const GROUPX_EVENT_SCHEMA = "groupx.event/0.1" as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function isJsonValue(value: unknown, ancestors: WeakSet<object>, depth: number): value is JsonValue {
  if (depth > 64) {
    return false;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  if (ancestors.has(value)) {
    return false;
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (value.length > 100_000) {
        return false;
      }
      const keys = Reflect.ownKeys(value);
      if (
        keys.some(
          (key) =>
            typeof key !== "string" ||
            (key !== "length" &&
              (!/^\d+$/.test(key) ||
                String(Number(key)) !== key ||
                Number(key) >= value.length))
        )
      ) {
        return false;
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (
          descriptor === undefined ||
          !("value" in descriptor) ||
          !isJsonValue(descriptor.value, ancestors, depth + 1)
        ) {
          return false;
        }
      }
      return true;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        return false;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        !isJsonValue(descriptor.value, ancestors, depth + 1)
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    ancestors.delete(value);
  }
}

export const JsonValueSchema = z.custom<JsonValue>(
  (value) => isJsonValue(value, new WeakSet<object>(), 0),
  "value must be losslessly JSON serializable"
);

export const ActorRefSchema = z
  .object({
    actorId: ActorIdSchema,
    kind: z.enum(["user", "agent", "system"]),
    instanceId: ReferenceIdSchema.optional(),
    displayName: z.string().min(1).max(128)
  })
  .passthrough()
  .superRefine((actor, context) => {
    if (!actor.actorId.startsWith(`${actor.kind}:`)) {
      context.addIssue({
        code: "custom",
        message: "actor kind must match the actorId namespace",
        path: ["actorId"]
      });
    }
  });

export const PublicProvenanceSchema = z
  .object({
    sourceKind: z.enum(["web", "adapter", "mcp", "system", "generated_summary", "supervision", "operator"]),
    authorActorId: ActorIdSchema.optional(),
    subjectActorId: ActorIdSchema.optional(),
    sourceEventId: ReferenceIdSchema.optional(),
    labels: z.array(z.string().min(1).max(64)).max(32).optional()
  })
  .passthrough();

export const GroupXEnvelopeSchema = z
  .object({
    schema: z.literal(GROUPX_EVENT_SCHEMA),
    eventId: ReferenceIdSchema,
    seq: NonNegativeIntegerSchema.nullable(),
    roomId: ReferenceIdSchema,
    type: z.string().min(1).max(128),
    actor: ActorRefSchema,
    to: z.array(AgentActorIdSchema).max(32),
    replyToEventId: ReferenceIdSchema.optional(),
    causationId: ReferenceIdSchema.optional(),
    correlationId: ReferenceIdSchema,
    rootCorrelationId: ReferenceIdSchema.optional(),
    parentTurnId: ReferenceIdSchema.optional(),
    hopCount: NonNegativeIntegerSchema.optional(),
    actorCallCountWithinRoot: NonNegativeIntegerSchema.optional(),
    forwardedEventId: ReferenceIdSchema.optional(),
    idempotencyKey: ReferenceIdSchema.optional(),
    occurredAt: z.string().datetime({ offset: true }),
    durability: z.enum(["durable", "transient"]),
    body: JsonValueSchema,
    provenance: PublicProvenanceSchema.optional()
  })
  .passthrough()
  .superRefine((envelope, context) => {
    if (envelope.durability === "durable" && envelope.seq === null) {
      context.addIssue({
        code: "custom",
        message: "durable envelopes require a non-negative seq",
        path: ["seq"]
      });
    }
    if (envelope.durability === "transient" && envelope.seq !== null) {
      context.addIssue({
        code: "custom",
        message: "transient envelopes must have seq=null",
        path: ["seq"]
      });
    }
    if (new Set(envelope.to).size !== envelope.to.length) {
      context.addIssue({
        code: "custom",
        message: "envelope targets must be unique",
        path: ["to"]
      });
    }
  });

export type ActorRefContract = z.infer<typeof ActorRefSchema>;
export type PublicProvenanceContract = z.infer<typeof PublicProvenanceSchema>;
export type GroupXEnvelopeContract = z.infer<typeof GroupXEnvelopeSchema>;

export function parseGroupXEnvelope(input: unknown): GroupXEnvelopeContract {
  return parseContractOutput(GroupXEnvelopeSchema, input);
}
