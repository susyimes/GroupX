import { z } from "zod";

import {
  ActorIdSchema,
  AgentActorIdSchema,
  ClientCommandIdSchema,
  CursorParameterSchema,
  MAX_MESSAGE_CONTENT_LENGTH,
  MessageContentSchema,
  MessageTargetsSchema,
  NonNegativeIntegerSchema,
  OptionalReplyToEventIdSchema,
  PositiveLimitSchema,
  ReferenceIdSchema
} from "./common.js";
import { GroupXEnvelopeSchema } from "./events.js";
import {
  assertKnownTargets,
  parseContractOutput,
  parseWriteRequest,
  type KnownTargetOptions
} from "./validation.js";

export const CreateMessageRequestSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema,
  to: MessageTargetsSchema,
  content: MessageContentSchema,
  replyToEventId: OptionalReplyToEventIdSchema
});

export const QueuedTurnResultSchema = z.object({
  target: AgentActorIdSchema,
  turnId: ReferenceIdSchema,
  status: z.literal("queued")
}).passthrough();

export const QueuedTurnResultsSchema = z
  .array(QueuedTurnResultSchema)
  .min(1)
  .max(32)
  .superRefine((turns, context) => {
    const targets = turns.map((turn) => turn.target);
    if (new Set(targets).size !== targets.length) {
      context.addIssue({
        code: "custom",
        message: "accepted turn targets must be unique",
        path: []
      });
    }
  });

export const CreateMessageAcceptedSchema = z.object({
  messageEventId: ReferenceIdSchema,
  correlationId: ReferenceIdSchema,
  turns: QueuedTurnResultsSchema
}).passthrough();

export const CancelTurnRequestSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema
});

export const TurnStatusSchema = z.enum([
  "queued",
  "dispatching",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
  "interrupted"
]);

const TERMINAL_TURN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted"
]);

export const CancelTurnResultSchema = z
  .strictObject({
    turnId: ReferenceIdSchema,
    accepted: z.boolean(),
    status: TurnStatusSchema
  })
  .superRefine((result, context) => {
    if (!result.accepted && !TERMINAL_TURN_STATUSES.has(result.status)) {
      context.addIssue({
        code: "custom",
        message: "a rejected cancel result must describe an already-terminal Turn",
        path: ["status"]
      });
    }
  });

export const RestartAgentRequestSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema
});

export const RestartAgentAcceptedSchema = z.object({
  actorId: AgentActorIdSchema,
  accepted: z.literal(true),
  previousInstanceId: ReferenceIdSchema.optional()
}).passthrough();

export const CompactContextRequestSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema
});

export const RoomContextUsageSchema = z
  .object({
    roomId: ReferenceIdSchema,
    throughSeq: NonNegativeIntegerSchema,
    estimatedCharacters: NonNegativeIntegerSchema,
    maxCharacters: z.number().int().positive(),
    compactionTriggerCharacters: z.number().int().positive(),
    utilizationPercent: z.number().int().min(0).max(100),
    uncompactedMessageCount: NonNegativeIntegerSchema,
    summaryThroughSeq: NonNegativeIntegerSchema.optional(),
    compactable: z.boolean()
  })
  .passthrough()
  .superRefine((usage, context) => {
    if (usage.compactionTriggerCharacters > usage.maxCharacters) {
      context.addIssue({
        code: "custom",
        message: "compaction trigger must not exceed the hard context limit",
        path: ["compactionTriggerCharacters"]
      });
    }
    if (usage.summaryThroughSeq !== undefined && usage.summaryThroughSeq > usage.throughSeq) {
      context.addIssue({
        code: "custom",
        message: "summaryThroughSeq must not exceed throughSeq",
        path: ["summaryThroughSeq"]
      });
    }
  });

export const CompactContextResultSchema = z.object({
  compacted: z.boolean(),
  usage: RoomContextUsageSchema
}).passthrough();

export const MemoryScopeTypeSchema = z.enum(["room", "agent", "correlation"]);
export const AgentMemoryTypeSchema = z.enum(["core", "dated"]);
export const MemoryKindSchema = z.enum([
  "fact",
  "decision",
  "preference",
  "instruction",
  "constraint",
  "summary",
  "note"
]);
export const WritableMemoryKindSchema = z.enum([
  "fact",
  "decision",
  "preference",
  "instruction",
  "constraint",
  "note"
]);
export const IdentityKindSchema = z.enum(["preference", "instruction", "constraint", "note"]);

export const MemoryScopeSchema = z
  .strictObject({
    type: MemoryScopeTypeSchema,
    id: ReferenceIdSchema
  })
  .superRefine((scope, context) => {
    if (scope.type === "agent" && !AgentActorIdSchema.safeParse(scope.id).success) {
      context.addIssue({
        code: "custom",
        message: "agent memory scopes require an agent actor id",
        path: ["id"]
      });
    }
  });

export const MemoryScopeOutputSchema = z
  .object({
    type: MemoryScopeTypeSchema,
    id: ReferenceIdSchema
  })
  .passthrough();

export const RememberMemoryRequestSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema,
  scope: MemoryScopeSchema,
  kind: WritableMemoryKindSchema,
  content: MessageContentSchema,
  subjectActorId: AgentActorIdSchema.optional(),
  sourceEventId: ReferenceIdSchema.optional()
});

export const SupersedeMemoryRequestSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema,
  kind: WritableMemoryKindSchema.optional(),
  content: MessageContentSchema,
  sourceEventId: ReferenceIdSchema.optional()
});

export const RetractMemoryRequestSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema
});

export const RememberIdentityRequestSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema,
  subjectActorId: AgentActorIdSchema,
  kind: IdentityKindSchema,
  content: MessageContentSchema,
  sourceEventId: ReferenceIdSchema.optional()
});

export const SupersedeIdentityRequestSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema,
  kind: IdentityKindSchema.optional(),
  content: MessageContentSchema,
  sourceEventId: ReferenceIdSchema.optional()
});

export const RetractIdentityRequestSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema
});

export const EventsQuerySchema = z.strictObject({
  afterSeq: CursorParameterSchema.optional()
});

export const MemoryQuerySchema = z.strictObject({
  scopeType: MemoryScopeTypeSchema.optional(),
  scopeId: ReferenceIdSchema.optional(),
  agentMemoryType: AgentMemoryTypeSchema.optional(),
  kind: MemoryKindSchema.optional(),
  authorActorId: ActorIdSchema.optional(),
  subjectActorId: AgentActorIdSchema.optional(),
  cursor: CursorParameterSchema.optional(),
  limit: PositiveLimitSchema.optional(),
  includeHistory: z.boolean().optional()
});

export const IdentityQuerySchema = z.strictObject({
  subjectActorId: AgentActorIdSchema.optional(),
  authorActorId: ActorIdSchema.optional(),
  kind: IdentityKindSchema.optional(),
  cursor: CursorParameterSchema.optional(),
  limit: PositiveLimitSchema.optional(),
  includeHistory: z.boolean().optional()
});

export const MemoryRecordSchema = z
  .object({
    memoryId: ReferenceIdSchema,
    scope: MemoryScopeOutputSchema,
    agentMemoryType: AgentMemoryTypeSchema.optional(),
    kind: MemoryKindSchema,
    authorActorId: ActorIdSchema,
    subjectActorId: AgentActorIdSchema.optional(),
    content: z.string().max(MAX_MESSAGE_CONTENT_LENGTH),
    sourceEventId: ReferenceIdSchema.optional(),
    sourceKind: z.enum([
      "web",
      "mcp",
      "generated_summary",
      "automatic_turn",
      "automatic_rollup"
    ]),
    status: z.enum(["active", "superseded", "retracted"]),
    supersedesMemoryId: ReferenceIdSchema.optional(),
    createdAt: z.string().min(1).max(64),
    retractedAt: z.string().min(1).max(64).optional()
  })
  .passthrough()
  .superRefine((record, context) => {
    if (record.scope.type === "agent" && record.agentMemoryType === undefined) {
      context.addIssue({
        code: "custom",
        message: "Agent memory records require agentMemoryType",
        path: ["agentMemoryType"]
      });
    }
    if (record.scope.type !== "agent" && record.agentMemoryType !== undefined) {
      context.addIssue({
        code: "custom",
        message: "agentMemoryType is only valid for Agent memory",
        path: ["agentMemoryType"]
      });
    }
  });

export const IdentityRecordSchema = z.object({
  identityId: ReferenceIdSchema,
  subjectActorId: AgentActorIdSchema,
  authorActorId: ActorIdSchema,
  kind: IdentityKindSchema,
  content: z.string().max(MAX_MESSAGE_CONTENT_LENGTH),
  sourceEventId: ReferenceIdSchema.optional(),
  sourceKind: z.enum(["web", "mcp", "adapter"]),
  status: z.enum(["active", "superseded", "retracted"]),
  supersedesIdentityId: ReferenceIdSchema.optional(),
  createdAt: z.string().min(1).max(64),
  retractedAt: z.string().min(1).max(64).optional()
}).passthrough();

export const RememberMemoryAcceptedSchema = z.object({
  memory: MemoryRecordSchema
}).passthrough();

export const RememberIdentityAcceptedSchema = z.object({
  identity: IdentityRecordSchema
}).passthrough();

export const MemoryPageSchema = z.object({
  items: z.array(MemoryRecordSchema),
  nextCursor: NonNegativeIntegerSchema.optional()
}).passthrough();

export const IdentityPageSchema = z.object({
  items: z.array(IdentityRecordSchema),
  nextCursor: NonNegativeIntegerSchema.optional()
}).passthrough();

export const AgentProjectionSchema = z
  .object({
    actorId: AgentActorIdSchema,
    displayName: z.string().min(1).max(128),
    status: z.string().min(1).max(64),
    instanceId: ReferenceIdSchema.optional(),
    cwd: z.string().min(1).max(32_768).optional(),
    enabled: z.boolean().optional(),
    capabilities: z.json().optional()
  })
  .passthrough();

export const TurnProjectionSchema = z
  .object({
    turnId: ReferenceIdSchema,
    targetActorId: AgentActorIdSchema,
    status: z.string().min(1).max(64),
    sourceEventId: ReferenceIdSchema
  })
  .strict();

export const BootstrapResponseSchema = z.object({
  schema: z.literal("groupx.bootstrap/0.1"),
  room: z.object({
    roomId: ReferenceIdSchema,
    throughSeq: NonNegativeIntegerSchema
  }).passthrough(),
  agents: z.array(AgentProjectionSchema),
  recentEvents: z.array(GroupXEnvelopeSchema),
  activeTurns: z.array(TurnProjectionSchema),
  previousPage: z
    .object({
      beforeSeq: NonNegativeIntegerSchema
    })
    .passthrough()
    .optional()
}).passthrough();

export type CreateMessageRequest = z.infer<typeof CreateMessageRequestSchema>;
export type CreateMessageAccepted = z.infer<typeof CreateMessageAcceptedSchema>;
export type CancelTurnRequest = z.infer<typeof CancelTurnRequestSchema>;
export type CancelTurnResult = z.infer<typeof CancelTurnResultSchema>;
export type RestartAgentRequest = z.infer<typeof RestartAgentRequestSchema>;
export type RestartAgentAccepted = z.infer<typeof RestartAgentAcceptedSchema>;
export type CompactContextRequest = z.infer<typeof CompactContextRequestSchema>;
export type RoomContextUsage = z.infer<typeof RoomContextUsageSchema>;
export type CompactContextResult = z.infer<typeof CompactContextResultSchema>;
export type RememberMemoryRequest = z.infer<typeof RememberMemoryRequestSchema>;
export type SupersedeMemoryRequest = z.infer<typeof SupersedeMemoryRequestSchema>;
export type RetractMemoryRequest = z.infer<typeof RetractMemoryRequestSchema>;
export type RememberIdentityRequest = z.infer<typeof RememberIdentityRequestSchema>;
export type SupersedeIdentityRequest = z.infer<typeof SupersedeIdentityRequestSchema>;
export type RetractIdentityRequest = z.infer<typeof RetractIdentityRequestSchema>;
export type MemoryQuery = z.infer<typeof MemoryQuerySchema>;
export type IdentityQuery = z.infer<typeof IdentityQuerySchema>;
export type MemoryRecordContract = z.infer<typeof MemoryRecordSchema>;
export type IdentityRecordContract = z.infer<typeof IdentityRecordSchema>;
export type BootstrapResponse = z.infer<typeof BootstrapResponseSchema>;

export function parseCreateMessageRequest(
  input: unknown,
  options?: KnownTargetOptions
): CreateMessageRequest {
  const parsed = parseWriteRequest(CreateMessageRequestSchema, input);
  assertKnownTargets(parsed.to, options);
  return parsed;
}

export function parseCancelTurnRequest(input: unknown): CancelTurnRequest {
  return parseWriteRequest(CancelTurnRequestSchema, input);
}

export function parseRestartAgentRequest(input: unknown): RestartAgentRequest {
  return parseWriteRequest(RestartAgentRequestSchema, input);
}

export function parseCompactContextRequest(input: unknown): CompactContextRequest {
  return parseWriteRequest(CompactContextRequestSchema, input);
}

export function parseRememberMemoryRequest(
  input: unknown,
  options?: KnownTargetOptions
): RememberMemoryRequest {
  const parsed = parseWriteRequest(RememberMemoryRequestSchema, input);
  const actors = [
    ...(parsed.subjectActorId === undefined ? [] : [parsed.subjectActorId]),
    ...(parsed.scope.type === "agent" ? [parsed.scope.id] : [])
  ];
  if (actors.length > 0) {
    assertKnownTargets(actors, options);
  }
  return parsed;
}

export function parseSupersedeMemoryRequest(input: unknown): SupersedeMemoryRequest {
  return parseWriteRequest(SupersedeMemoryRequestSchema, input);
}

export function parseRetractMemoryRequest(input: unknown): RetractMemoryRequest {
  return parseWriteRequest(RetractMemoryRequestSchema, input);
}

export function parseRememberIdentityRequest(
  input: unknown,
  options?: KnownTargetOptions
): RememberIdentityRequest {
  const parsed = parseWriteRequest(RememberIdentityRequestSchema, input);
  assertKnownTargets([parsed.subjectActorId], options);
  return parsed;
}

export function parseSupersedeIdentityRequest(input: unknown): SupersedeIdentityRequest {
  return parseWriteRequest(SupersedeIdentityRequestSchema, input);
}

export function parseRetractIdentityRequest(input: unknown): RetractIdentityRequest {
  return parseWriteRequest(RetractIdentityRequestSchema, input);
}

export function parseCreateMessageAccepted(input: unknown): CreateMessageAccepted {
  return parseContractOutput(CreateMessageAcceptedSchema, input);
}

export function parseEventsQuery(input: unknown): z.infer<typeof EventsQuerySchema> {
  return parseContractOutput(EventsQuerySchema, input);
}

export function parseMemoryQuery(input: unknown): MemoryQuery {
  return parseContractOutput(MemoryQuerySchema, input);
}

export function parseIdentityQuery(input: unknown): IdentityQuery {
  return parseContractOutput(IdentityQuerySchema, input);
}

export function parseCancelTurnResult(input: unknown): CancelTurnResult {
  return parseContractOutput(CancelTurnResultSchema, input);
}

export function parseRestartAgentAccepted(input: unknown): RestartAgentAccepted {
  return parseContractOutput(RestartAgentAcceptedSchema, input);
}

export function parseRoomContextUsage(input: unknown): RoomContextUsage {
  return parseContractOutput(RoomContextUsageSchema, input);
}

export function parseCompactContextResult(input: unknown): CompactContextResult {
  return parseContractOutput(CompactContextResultSchema, input);
}

export function parseRememberMemoryAccepted(
  input: unknown
): z.infer<typeof RememberMemoryAcceptedSchema> {
  return parseContractOutput(RememberMemoryAcceptedSchema, input);
}

export function parseRememberIdentityAccepted(
  input: unknown
): z.infer<typeof RememberIdentityAcceptedSchema> {
  return parseContractOutput(RememberIdentityAcceptedSchema, input);
}

export function parseMemoryPage(input: unknown): z.infer<typeof MemoryPageSchema> {
  return parseContractOutput(MemoryPageSchema, input);
}

export function parseIdentityPage(input: unknown): z.infer<typeof IdentityPageSchema> {
  return parseContractOutput(IdentityPageSchema, input);
}

export function parseBootstrapResponse(input: unknown): BootstrapResponse {
  return parseContractOutput(BootstrapResponseSchema, input);
}
