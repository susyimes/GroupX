import { z } from "zod";

import { canonicalHash, canonicalJson } from "../core/envelope.js";

export const MAX_MESSAGE_CONTENT_LENGTH = 32_768;
export const MAX_CLIENT_COMMAND_ID_LENGTH = 128;
export const MAX_REFERENCE_ID_LENGTH = 256;
export const MAX_TARGETS_PER_MESSAGE = 32;
export const MAX_PAGE_SIZE = 500;

export const FORBIDDEN_WRITE_FIELDS = ["from", "actor", "eventId", "provenance"] as const;

export const ClientCommandIdSchema = z
  .string()
  .min(1)
  .max(MAX_CLIENT_COMMAND_ID_LENGTH)
  .refine((value) => value.trim().length > 0, "clientCommandId must not be blank");

export const ReferenceIdSchema = z
  .string()
  .min(1)
  .max(MAX_REFERENCE_ID_LENGTH)
  .refine((value) => value.trim().length > 0, "identifier must not be blank");

export const CorrelationIdSchema = ReferenceIdSchema;

export const AgentActorIdSchema = z
  .string()
  .min(7)
  .max(MAX_REFERENCE_ID_LENGTH)
  .regex(/^agent:[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/, "invalid agent actor id");

export const ActorIdSchema = z
  .string()
  .min(3)
  .max(MAX_REFERENCE_ID_LENGTH)
  .regex(/^(?:agent|user|system):[A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?$/, "invalid actor id");

export const MessageContentSchema = z
  .string()
  .min(1)
  .max(MAX_MESSAGE_CONTENT_LENGTH)
  .refine((value) => value.trim().length > 0, "content must not be blank");

export const NonNegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const PositiveLimitSchema = z.number().int().positive().max(MAX_PAGE_SIZE);

export const CursorParameterSchema = z
  .union([
    NonNegativeIntegerSchema,
    z
      .string()
      .regex(/^\d+$/, "cursor must be a non-negative decimal integer")
      .transform((value) => Number(value))
  ])
  .pipe(NonNegativeIntegerSchema);

export const MessageTargetsSchema = z
  .array(AgentActorIdSchema)
  .min(1)
  .max(MAX_TARGETS_PER_MESSAGE)
  .superRefine((targets, context) => {
    const seen = new Set<string>();
    for (const [index, target] of targets.entries()) {
      if (seen.has(target)) {
        context.addIssue({
          code: "custom",
          message: "message targets must be unique",
          path: [index]
        });
      }
      seen.add(target);
    }
  })
  .transform((targets) => [...targets].sort((left, right) => left.localeCompare(right)))
  .meta({ uniqueItems: true });

export const OptionalReplyToEventIdSchema = ReferenceIdSchema.nullable().optional().transform(
  (value) => value ?? undefined
);

export const DEFAULT_KNOWN_TARGETS = [
  "agent:codex",
  "agent:grok",
  "agent:kimi",
  "agent:hermes"
] as const;

export type ClientCommandId = z.infer<typeof ClientCommandIdSchema>;
export type AgentActorId = z.infer<typeof AgentActorIdSchema>;
export type ActorId = z.infer<typeof ActorIdSchema>;

export function canonicalContractJson(value: unknown): string {
  return canonicalJson(value);
}

export function canonicalContractHash(value: unknown): string {
  return canonicalHash(value);
}
