import { z } from "zod";

import {
  AgentActorIdSchema,
  ClientCommandIdSchema,
  CorrelationIdSchema,
  CursorParameterSchema,
  MAX_MESSAGE_CONTENT_LENGTH,
  MessageContentSchema,
  MessageTargetsSchema,
  PositiveLimitSchema,
  ReferenceIdSchema
} from "./common.js";
import { GroupXEnvelopeSchema } from "./events.js";
import {
  AgentMemoryTypeSchema,
  IdentityKindSchema,
  MemoryKindSchema,
  MemoryRecordSchema,
  MemoryScopeSchema,
  WritableMemoryKindSchema,
  IdentityRecordSchema,
  QueuedTurnResultsSchema,
  SupervisionPairSchema
} from "./rest.js";
import {
  assertKnownTargets,
  parseContractOutput,
  parseWriteRequest,
  type KnownTargetOptions
} from "./validation.js";

function addSupervisionOverlapIssues(
  workers: readonly string[],
  observers: readonly string[] | undefined,
  context: z.RefinementCtx
): void {
  if (observers === undefined) return;
  const workerSet = new Set(workers);
  for (const [index, observer] of observers.entries()) {
    if (workerSet.has(observer)) {
      context.addIssue({
        code: "custom",
        message: "a supervision observer cannot also be a worker in the same command",
        path: ["supervision", "observers", index]
      });
    }
  }
}

export const McpSendInputSchema = z
  .strictObject({
    to: MessageTargetsSchema,
    content: MessageContentSchema,
    replyToEventId: ReferenceIdSchema.optional(),
    clientCommandId: ClientCommandIdSchema,
    supervision: SupervisionPairSchema.optional()
  })
  .superRefine((request, context) => {
    addSupervisionOverlapIssues(request.to, request.supervision?.observers, context);
  });

export const McpSendResultSchema = z.object({
  messageEventId: ReferenceIdSchema,
  correlationId: CorrelationIdSchema,
  turns: QueuedTurnResultsSchema
}).passthrough();

export const McpPublishInputSchema = z.strictObject({
  content: MessageContentSchema,
  replyToEventId: ReferenceIdSchema.optional(),
  clientCommandId: ClientCommandIdSchema
});

export const McpPublishResultSchema = z.object({
  messageEventId: ReferenceIdSchema,
  correlationId: CorrelationIdSchema
}).passthrough();

export const McpAskInputSchema = z
  .strictObject({
    to: MessageTargetsSchema,
    content: MessageContentSchema,
    replyToEventId: ReferenceIdSchema.optional(),
    clientCommandId: ClientCommandIdSchema,
    timeoutMs: z.number().int().positive().max(60_000).optional(),
    cancelOnTimeout: z.boolean().optional(),
    supervision: SupervisionPairSchema.optional()
  })
  .superRefine((request, context) => {
    addSupervisionOverlapIssues(request.to, request.supervision?.observers, context);
  });

export const McpAskTargetResultSchema = z
  .object({
    target: AgentActorIdSchema,
    turnId: ReferenceIdSchema,
    status: z.enum(["completed", "failed", "cancelled", "pending"]),
    queuePosition: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    activeTurnId: ReferenceIdSchema.optional(),
    responseEventId: ReferenceIdSchema.optional(),
    content: z.string().max(MAX_MESSAGE_CONTENT_LENGTH).optional(),
    errorCode: z.string().min(1).max(128).optional(),
    note: z.string().min(1).max(500).optional()
  })
  .passthrough()
  .superRefine((result, context) => {
    if (result.status === "completed" && result.responseEventId === undefined) {
      context.addIssue({
        code: "custom",
        message: "completed ask results require responseEventId",
        path: ["responseEventId"]
      });
    }
  });

export const McpAskResultSchema = z.object({
  messageEventId: ReferenceIdSchema,
  correlationId: CorrelationIdSchema,
  state: z.enum(["terminal", "pending"]),
  results: z.array(McpAskTargetResultSchema).min(1).max(32)
}).passthrough().superRefine((result, context) => {
  const targets = result.results.map((targetResult) => targetResult.target);
  if (new Set(targets).size !== targets.length) {
    context.addIssue({
      code: "custom",
      message: "ask result targets must be unique",
      path: ["results"]
    });
  }
  const hasPending = result.results.some((targetResult) => targetResult.status === "pending");
  if ((result.state === "pending") !== hasPending) {
    context.addIssue({
      code: "custom",
      message: "ask state must match whether any target result is pending",
      path: ["state"]
    });
  }
});

export const McpCollectInputSchema = z.strictObject({
  messageEventId: ReferenceIdSchema,
  timeoutMs: z.number().int().positive().max(60_000).optional()
});

export const McpCollectResultSchema = McpAskResultSchema;

export const McpWatchInputSchema = z.strictObject({
  subjectTurnId: ReferenceIdSchema.optional(),
  afterSeq: CursorParameterSchema.optional(),
  until: z.enum(["next_milestone", "terminal"]).default("next_milestone"),
  timeoutMs: z.number().int().positive().max(3_600_000).optional()
});

export const McpSupervisionSnapshotSchema = z
  .object({
    turnId: ReferenceIdSchema,
    status: z.string().min(1).max(64),
    deliveryCertainty: z.string().min(1).max(64).optional(),
    lastSeq: z.number().int().nonnegative(),
    watchCursor: z.number().int().nonnegative(),
    terminal: z.boolean(),
    subjectCancelled: z.boolean(),
    task: z.object({
      eventId: ReferenceIdSchema,
      excerpt: z.string().max(MAX_MESSAGE_CONTENT_LENGTH)
    }).passthrough(),
    messages: z.array(
      z.object({
        eventId: ReferenceIdSchema,
        excerpt: z.string().max(MAX_MESSAGE_CONTENT_LENGTH)
      }).passthrough()
    ).max(32),
    tools: z.array(
      z.object({
        name: z.string().min(1).max(64),
        status: z.enum(["started", "completed"]),
        toolCallId: ReferenceIdSchema.optional()
      }).passthrough()
    ).max(64),
    steerCount: z.number().int().nonnegative(),
    lastSteerReason: z.string().max(500).optional()
  })
  .passthrough();

export const McpWatchResultSchema = z.object({
  snapshot: McpSupervisionSnapshotSchema,
  until: z.enum(["next_milestone", "terminal"]),
  timedOut: z.boolean()
}).passthrough();

export const McpSteerInputSchema = z.strictObject({
  subjectTurnId: ReferenceIdSchema.optional(),
  action: z.enum(["nudge", "interrupt"]),
  reason: z.string().min(1).max(500),
  content: MessageContentSchema,
  clientCommandId: ClientCommandIdSchema
});

export const McpSteerResultSchema = z.object({
  action: z.enum(["nudge", "interrupt"]),
  reason: z.string().min(1).max(500),
  subjectTurnId: ReferenceIdSchema,
  messageEventId: ReferenceIdSchema,
  correlationId: CorrelationIdSchema,
  nextTurnId: ReferenceIdSchema.optional(),
  steeredEventId: ReferenceIdSchema.optional()
}).passthrough();

export const McpReadInputSchema = z.strictObject({
  correlationId: CorrelationIdSchema.optional(),
  afterSeq: CursorParameterSchema.optional(),
  limit: PositiveLimitSchema.optional()
});

export const McpReadTurnSchema = z
  .object({
    target: AgentActorIdSchema,
    turnId: ReferenceIdSchema,
    status: z.string().min(1).max(64),
    responseEventId: ReferenceIdSchema.optional(),
    errorCode: z.string().min(1).max(128).optional()
  })
  .passthrough();

export const McpReadResultSchema = z.object({
  correlationId: CorrelationIdSchema.optional(),
  events: z.array(GroupXEnvelopeSchema),
  turns: z.array(McpReadTurnSchema),
  nextAfterSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()
}).passthrough();

export const McpMemorySearchInputSchema = z.strictObject({
  query: z.string().min(1).max(1_024).optional(),
  scope: MemoryScopeSchema.optional(),
  agentMemoryType: AgentMemoryTypeSchema.optional(),
  kind: MemoryKindSchema.optional(),
  subjectActorId: AgentActorIdSchema.optional(),
  cursor: CursorParameterSchema.optional(),
  limit: PositiveLimitSchema.optional(),
  includeHistory: z.boolean().optional()
});

export const McpMemorySearchResultSchema = z.object({
  items: z.array(MemoryRecordSchema),
  nextCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()
}).passthrough();

export const McpMemoryRememberInputSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema,
  scope: MemoryScopeSchema,
  kind: WritableMemoryKindSchema,
  content: MessageContentSchema,
  subjectActorId: AgentActorIdSchema.optional(),
  sourceEventId: ReferenceIdSchema.optional()
});

export const McpMemoryRememberResultSchema = z.object({
  memory: MemoryRecordSchema
}).passthrough();

export const McpCoreMemoryRememberInputSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema,
  kind: WritableMemoryKindSchema,
  content: MessageContentSchema,
  sourceEventId: ReferenceIdSchema.optional()
});

export const McpCoreMemoryRememberResultSchema = McpMemoryRememberResultSchema;

export const McpIdentityReadInputSchema = z.strictObject({
  cursor: CursorParameterSchema.optional(),
  limit: PositiveLimitSchema.optional(),
  includeHistory: z.boolean().optional()
});

export const McpIdentityReadResultSchema = z.object({
  items: z.array(IdentityRecordSchema),
  nextCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()
}).passthrough();

export const McpIdentityRememberInputSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema,
  kind: IdentityKindSchema,
  content: MessageContentSchema,
  sourceEventId: ReferenceIdSchema.optional()
});

export const McpIdentityRememberResultSchema = z.object({
  identity: IdentityRecordSchema
}).passthrough();

export type McpWatchInput = z.infer<typeof McpWatchInputSchema>;
export type McpWatchResult = z.infer<typeof McpWatchResultSchema>;
export type McpSteerInput = z.infer<typeof McpSteerInputSchema>;
export type McpSteerResult = z.infer<typeof McpSteerResultSchema>;
export type McpSendInput = z.infer<typeof McpSendInputSchema>;
export type McpSendResult = z.infer<typeof McpSendResultSchema>;
export type McpPublishInput = z.infer<typeof McpPublishInputSchema>;
export type McpPublishResult = z.infer<typeof McpPublishResultSchema>;
export type McpAskInput = z.infer<typeof McpAskInputSchema>;
export type McpAskResult = z.infer<typeof McpAskResultSchema>;
export type McpCollectInput = z.infer<typeof McpCollectInputSchema>;
export type McpCollectResult = z.infer<typeof McpCollectResultSchema>;
export type McpReadInput = z.infer<typeof McpReadInputSchema>;
export type McpReadResult = z.infer<typeof McpReadResultSchema>;
export type McpMemorySearchInput = z.infer<typeof McpMemorySearchInputSchema>;
export type McpMemorySearchResult = z.infer<typeof McpMemorySearchResultSchema>;
export type McpMemoryRememberInput = z.infer<typeof McpMemoryRememberInputSchema>;
export type McpMemoryRememberResult = z.infer<typeof McpMemoryRememberResultSchema>;
export type McpCoreMemoryRememberInput = z.infer<typeof McpCoreMemoryRememberInputSchema>;
export type McpCoreMemoryRememberResult = z.infer<typeof McpCoreMemoryRememberResultSchema>;
export type McpIdentityReadInput = z.infer<typeof McpIdentityReadInputSchema>;
export type McpIdentityReadResult = z.infer<typeof McpIdentityReadResultSchema>;
export type McpIdentityRememberInput = z.infer<typeof McpIdentityRememberInputSchema>;
export type McpIdentityRememberResult = z.infer<typeof McpIdentityRememberResultSchema>;

export function parseMcpSendInput(input: unknown, options?: KnownTargetOptions): McpSendInput {
  const parsed = parseWriteRequest(McpSendInputSchema, input);
  assertKnownTargets([...parsed.to, ...(parsed.supervision?.observers ?? [])], options);
  return parsed;
}

export function parseMcpAskInput(input: unknown, options?: KnownTargetOptions): McpAskInput {
  const parsed = parseWriteRequest(McpAskInputSchema, input);
  assertKnownTargets([...parsed.to, ...(parsed.supervision?.observers ?? [])], options);
  return parsed;
}

export function parseMcpPublishInput(input: unknown): McpPublishInput {
  return parseWriteRequest(McpPublishInputSchema, input);
}

export function parseMcpCollectInput(input: unknown): McpCollectInput {
  return parseWriteRequest(McpCollectInputSchema, input);
}

export function parseMcpWatchInput(input: unknown): McpWatchInput {
  return parseWriteRequest(McpWatchInputSchema, input);
}

export function parseMcpSteerInput(input: unknown): McpSteerInput {
  return parseWriteRequest(McpSteerInputSchema, input);
}

export function parseMcpWatchResult(input: unknown): McpWatchResult {
  return parseContractOutput(McpWatchResultSchema, input);
}

export function parseMcpSteerResult(input: unknown): McpSteerResult {
  return parseContractOutput(McpSteerResultSchema, input);
}

export function parseMcpReadInput(input: unknown): McpReadInput {
  return parseWriteRequest(McpReadInputSchema, input);
}

export function parseMcpMemorySearchInput(input: unknown): McpMemorySearchInput {
  return parseWriteRequest(McpMemorySearchInputSchema, input);
}

export function parseMcpMemoryRememberInput(
  input: unknown,
  options?: KnownTargetOptions
): McpMemoryRememberInput {
  const parsed = parseWriteRequest(McpMemoryRememberInputSchema, input);
  const actors = [
    ...(parsed.subjectActorId === undefined ? [] : [parsed.subjectActorId]),
    ...(parsed.scope.type === "agent" ? [parsed.scope.id] : [])
  ];
  if (actors.length > 0) {
    assertKnownTargets(actors, options);
  }
  return parsed;
}

export function parseMcpIdentityReadInput(input: unknown): McpIdentityReadInput {
  return parseWriteRequest(McpIdentityReadInputSchema, input);
}

export function parseMcpIdentityRememberInput(input: unknown): McpIdentityRememberInput {
  return parseWriteRequest(McpIdentityRememberInputSchema, input);
}

export function parseMcpSendResult(input: unknown): McpSendResult {
  return parseContractOutput(McpSendResultSchema, input);
}

export function parseMcpAskResult(input: unknown): McpAskResult {
  return parseContractOutput(McpAskResultSchema, input);
}

export function parseMcpPublishResult(input: unknown): McpPublishResult {
  return parseContractOutput(McpPublishResultSchema, input);
}

export function parseMcpCollectResult(input: unknown): McpCollectResult {
  return parseContractOutput(McpCollectResultSchema, input);
}

export function parseMcpReadResult(input: unknown): McpReadResult {
  return parseContractOutput(McpReadResultSchema, input);
}

export function parseMcpMemorySearchResult(input: unknown): McpMemorySearchResult {
  return parseContractOutput(McpMemorySearchResultSchema, input);
}

export function parseMcpMemoryRememberResult(input: unknown): McpMemoryRememberResult {
  return parseContractOutput(McpMemoryRememberResultSchema, input);
}

export function parseMcpCoreMemoryRememberInput(input: unknown): McpCoreMemoryRememberInput {
  return parseWriteRequest(McpCoreMemoryRememberInputSchema, input);
}

export function parseMcpCoreMemoryRememberResult(input: unknown): McpCoreMemoryRememberResult {
  return parseContractOutput(McpCoreMemoryRememberResultSchema, input);
}

export function parseMcpIdentityReadResult(input: unknown): McpIdentityReadResult {
  return parseContractOutput(McpIdentityReadResultSchema, input);
}

export function parseMcpIdentityRememberResult(input: unknown): McpIdentityRememberResult {
  return parseContractOutput(McpIdentityRememberResultSchema, input);
}
