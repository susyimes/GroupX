import { z } from "zod";

import {
  AgentActorIdSchema,
  ClientCommandIdSchema,
  CorrelationIdSchema,
  CursorParameterSchema,
  MessageContentSchema,
  MessageTargetsSchema,
  PositiveLimitSchema,
  ReferenceIdSchema
} from "./common.js";
import {
  McpAskResultSchema,
  McpIdentityRememberResultSchema,
  McpMemoryRememberResultSchema,
  McpMemorySearchInputSchema,
  McpMemorySearchResultSchema,
  McpReadInputSchema,
  McpReadResultSchema,
  McpSendResultSchema,
  McpSupervisionSnapshotSchema
} from "./mcp.js";
import {
  CompactContextResultSchema,
  IdentityKindSchema,
  IdentityRecordSchema,
  MemoryKindSchema,
  RestartAgentAcceptedSchema,
  RoomContextUsageSchema,
  SupervisionPairSchema,
  TurnStatusSchema,
  WritableMemoryKindSchema
} from "./rest.js";
import {
  SetupSaveRequestSchema,
  SetupSaveResponseSchema,
  SetupSnapshotSchema
} from "./setup.js";
import {
  assertKnownTargets,
  parseContractOutput,
  parseWriteRequest,
  type KnownTargetOptions
} from "./validation.js";

export const OperatorSupervisionInputSchema = SupervisionPairSchema;

export const OperatorSendInputSchema = z.strictObject({
  to: MessageTargetsSchema,
  content: MessageContentSchema,
  replyToEventId: ReferenceIdSchema.optional(),
  clientCommandId: ClientCommandIdSchema,
  supervision: OperatorSupervisionInputSchema.optional()
});

export const OperatorWorkerDispatchInputSchema = z.strictObject({
  to: MessageTargetsSchema,
  content: MessageContentSchema,
  clientCommandId: ClientCommandIdSchema,
  supervision: OperatorSupervisionInputSchema.optional()
});

export const OperatorWorkerAskInputSchema = OperatorWorkerDispatchInputSchema.extend({
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
  cancelOnTimeout: z.boolean().optional()
});

export const OperatorDispatchEventInputSchema = z.strictObject({
  sourceEventId: ReferenceIdSchema,
  to: MessageTargetsSchema,
  clientCommandId: ClientCommandIdSchema,
  supervision: OperatorSupervisionInputSchema.optional()
});

export const OperatorTurnCancelInputSchema = z.strictObject({
  turnId: ReferenceIdSchema,
  clientCommandId: ClientCommandIdSchema
});

export const OperatorTurnsCancelInputSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema,
  to: z.array(AgentActorIdSchema).min(1).max(32).optional()
});

export const OperatorAgentRestartInputSchema = z.strictObject({
  actorId: AgentActorIdSchema,
  clientCommandId: ClientCommandIdSchema
});

export const OperatorContextCompactInputSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema
});

export const OperatorContextResetInputSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema,
  resetNativeSessions: z.boolean().optional()
});

export const OperatorMemorySupersedeInputSchema = z.strictObject({
  memoryId: ReferenceIdSchema,
  clientCommandId: ClientCommandIdSchema,
  content: MessageContentSchema,
  kind: WritableMemoryKindSchema.optional()
});

export const OperatorMemoryRetractInputSchema = z.strictObject({
  memoryId: ReferenceIdSchema,
  clientCommandId: ClientCommandIdSchema
});

export const OperatorAgentCoreRememberInputSchema = z.strictObject({
  subjectActorId: AgentActorIdSchema,
  clientCommandId: ClientCommandIdSchema,
  kind: WritableMemoryKindSchema,
  content: MessageContentSchema
});

export const OperatorIdentitySearchInputSchema = z.strictObject({
  subjectActorId: AgentActorIdSchema.optional(),
  cursor: CursorParameterSchema.optional(),
  limit: PositiveLimitSchema.optional(),
  includeHistory: z.boolean().optional()
});

export const OperatorIdentityRememberForInputSchema = z.strictObject({
  subjectActorId: AgentActorIdSchema,
  clientCommandId: ClientCommandIdSchema,
  kind: IdentityKindSchema,
  content: MessageContentSchema
});

export const OperatorIdentitySupersedeInputSchema = z.strictObject({
  identityId: ReferenceIdSchema,
  clientCommandId: ClientCommandIdSchema,
  content: MessageContentSchema,
  kind: IdentityKindSchema.optional()
});

export const OperatorIdentityRetractInputSchema = z.strictObject({
  identityId: ReferenceIdSchema,
  clientCommandId: ClientCommandIdSchema
});

export const OperatorSetupSaveInputSchema = SetupSaveRequestSchema.extend({
  clientCommandId: ClientCommandIdSchema
});

export const OperatorSupervisionStatusInputSchema = z
  .strictObject({
    pairId: ReferenceIdSchema.optional(),
    correlationId: CorrelationIdSchema.optional()
  })
  .superRefine((input, context) => {
    if (input.pairId === undefined && input.correlationId === undefined) {
      context.addIssue({
        code: "custom",
        message: "pairId or correlationId is required"
      });
    }
  });

export const OperatorRosterTurnSchema = z
  .object({
    turnId: ReferenceIdSchema,
    targetActorId: AgentActorIdSchema,
    status: TurnStatusSchema,
    sourceEventId: ReferenceIdSchema
  })
  .passthrough();

export const OperatorRosterPairSchema = z
  .object({
    pairId: ReferenceIdSchema,
    workers: z.array(AgentActorIdSchema).min(1).max(32),
    observers: z.array(AgentActorIdSchema).min(1).max(4),
    steerCount: z.number().int().nonnegative()
  })
  .passthrough();

export const OperatorRosterResultSchema = z
  .object({
    agents: z.array(
      z
        .object({
          actorId: AgentActorIdSchema,
          displayName: z.string().min(1).max(128),
          enabled: z.boolean(),
          cwd: z.string().min(1).optional(),
          status: z.string().min(1).max(64),
          pendingRestart: z.boolean().optional()
        })
        .passthrough()
    ),
    activeTurns: z.array(OperatorRosterTurnSchema),
    pairs: z.array(OperatorRosterPairSchema),
    health: z.string().min(1).max(64)
  })
  .passthrough();

export const OperatorTurnsCancelResultSchema = z
  .object({
    cancelled: z.array(
      z
        .object({
          turnId: ReferenceIdSchema,
          accepted: z.boolean(),
          status: TurnStatusSchema
        })
        .passthrough()
    )
  })
  .passthrough();

export const OperatorContextResetResultSchema = z
  .object({
    reset: z.boolean(),
    throughSeq: z.number().int().nonnegative(),
    resetNativeSessions: z.boolean(),
    usage: RoomContextUsageSchema
  })
  .passthrough();

export const OperatorIdentitySearchResultSchema = z
  .object({
    items: z.array(IdentityRecordSchema),
    nextCursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional()
  })
  .passthrough();

export const OperatorSupervisionStatusResultSchema = z
  .object({
    pairId: ReferenceIdSchema,
    correlationId: CorrelationIdSchema,
    mode: z.literal("live_steer"),
    workers: z.array(McpSupervisionSnapshotSchema).min(1).max(32),
    observers: z.array(
      z
        .object({
          actorId: AgentActorIdSchema,
          turnId: ReferenceIdSchema,
          status: z.string().min(1).max(64)
        })
        .passthrough()
    )
  })
  .passthrough();

export const OPERATOR_MCP_TOOL_NAMES = [
  "send",
  "read",
  "roster",
  "context_usage",
  "context_compact",
  "context_reset",
  "turn_cancel",
  "turns_cancel",
  "agent_restart",
  "memory_search",
  "memory_remember",
  "memory_supersede",
  "memory_retract",
  "agent_core_remember",
  "identity_search",
  "identity_remember_for",
  "identity_supersede",
  "identity_retract",
  "setup_read",
  "setup_save",
  "worker_dispatch",
  "worker_ask",
  "dispatch_event",
  "supervision_status"
] as const;

export type OperatorMcpToolName = (typeof OPERATOR_MCP_TOOL_NAMES)[number];

export type OperatorSendInput = z.infer<typeof OperatorSendInputSchema>;
export type OperatorWorkerDispatchInput = z.infer<typeof OperatorWorkerDispatchInputSchema>;
export type OperatorWorkerAskInput = z.infer<typeof OperatorWorkerAskInputSchema>;
export type OperatorDispatchEventInput = z.infer<typeof OperatorDispatchEventInputSchema>;
export type OperatorTurnCancelInput = z.infer<typeof OperatorTurnCancelInputSchema>;
export type OperatorTurnsCancelInput = z.infer<typeof OperatorTurnsCancelInputSchema>;
export type OperatorAgentRestartInput = z.infer<typeof OperatorAgentRestartInputSchema>;
export type OperatorContextCompactInput = z.infer<typeof OperatorContextCompactInputSchema>;
export type OperatorContextResetInput = z.infer<typeof OperatorContextResetInputSchema>;
export type OperatorMemorySupersedeInput = z.infer<typeof OperatorMemorySupersedeInputSchema>;
export type OperatorMemoryRetractInput = z.infer<typeof OperatorMemoryRetractInputSchema>;
export type OperatorAgentCoreRememberInput = z.infer<typeof OperatorAgentCoreRememberInputSchema>;
export type OperatorIdentitySearchInput = z.infer<typeof OperatorIdentitySearchInputSchema>;
export type OperatorIdentityRememberForInput = z.infer<typeof OperatorIdentityRememberForInputSchema>;
export type OperatorIdentitySupersedeInput = z.infer<typeof OperatorIdentitySupersedeInputSchema>;
export type OperatorIdentityRetractInput = z.infer<typeof OperatorIdentityRetractInputSchema>;
export type OperatorSetupSaveInput = z.infer<typeof OperatorSetupSaveInputSchema>;
export type OperatorSupervisionStatusInput = z.infer<typeof OperatorSupervisionStatusInputSchema>;
export type OperatorRosterResult = z.infer<typeof OperatorRosterResultSchema>;
export type OperatorTurnsCancelResult = z.infer<typeof OperatorTurnsCancelResultSchema>;
export type OperatorContextResetResult = z.infer<typeof OperatorContextResetResultSchema>;
export type OperatorIdentitySearchResult = z.infer<typeof OperatorIdentitySearchResultSchema>;
export type OperatorSupervisionStatusResult = z.infer<typeof OperatorSupervisionStatusResultSchema>;

function parseTargets<T extends { to: readonly string[] }>(
  parsed: T,
  options?: KnownTargetOptions
): T {
  const observers = (parsed as { supervision?: { observers?: readonly string[] } }).supervision
    ?.observers;
  assertKnownTargets([...parsed.to, ...(observers ?? [])], options);
  return parsed;
}

export function parseOperatorSendInput(input: unknown, options?: KnownTargetOptions): OperatorSendInput {
  return parseTargets(parseWriteRequest(OperatorSendInputSchema, input), options);
}

export function parseOperatorWorkerDispatchInput(
  input: unknown,
  options?: KnownTargetOptions
): OperatorWorkerDispatchInput {
  return parseTargets(parseWriteRequest(OperatorWorkerDispatchInputSchema, input), options);
}

export function parseOperatorWorkerAskInput(
  input: unknown,
  options?: KnownTargetOptions
): OperatorWorkerAskInput {
  return parseTargets(parseWriteRequest(OperatorWorkerAskInputSchema, input), options);
}

export function parseOperatorDispatchEventInput(
  input: unknown,
  options?: KnownTargetOptions
): OperatorDispatchEventInput {
  return parseTargets(parseWriteRequest(OperatorDispatchEventInputSchema, input), options);
}

export function parseOperatorTurnCancelInput(input: unknown): OperatorTurnCancelInput {
  return parseWriteRequest(OperatorTurnCancelInputSchema, input);
}

export function parseOperatorTurnsCancelInput(
  input: unknown,
  options?: KnownTargetOptions
): OperatorTurnsCancelInput {
  const parsed = parseWriteRequest(OperatorTurnsCancelInputSchema, input);
  if (parsed.to !== undefined) assertKnownTargets(parsed.to, options);
  return parsed;
}

export function parseOperatorAgentRestartInput(
  input: unknown,
  options?: KnownTargetOptions
): OperatorAgentRestartInput {
  const parsed = parseWriteRequest(OperatorAgentRestartInputSchema, input);
  assertKnownTargets([parsed.actorId], options);
  return parsed;
}

export function parseOperatorContextCompactInput(input: unknown): OperatorContextCompactInput {
  return parseWriteRequest(OperatorContextCompactInputSchema, input);
}

export function parseOperatorContextResetInput(input: unknown): OperatorContextResetInput {
  return parseWriteRequest(OperatorContextResetInputSchema, input);
}

export function parseOperatorMemorySearchInput(input: unknown): z.infer<typeof McpMemorySearchInputSchema> {
  return parseWriteRequest(McpMemorySearchInputSchema, input);
}

export function parseOperatorMemorySupersedeInput(input: unknown): OperatorMemorySupersedeInput {
  return parseWriteRequest(OperatorMemorySupersedeInputSchema, input);
}

export function parseOperatorMemoryRetractInput(input: unknown): OperatorMemoryRetractInput {
  return parseWriteRequest(OperatorMemoryRetractInputSchema, input);
}

export function parseOperatorAgentCoreRememberInput(
  input: unknown,
  options?: KnownTargetOptions
): OperatorAgentCoreRememberInput {
  const parsed = parseWriteRequest(OperatorAgentCoreRememberInputSchema, input);
  assertKnownTargets([parsed.subjectActorId], options);
  return parsed;
}

export function parseOperatorIdentitySearchInput(input: unknown): OperatorIdentitySearchInput {
  return parseWriteRequest(OperatorIdentitySearchInputSchema, input);
}

export function parseOperatorIdentityRememberForInput(
  input: unknown,
  options?: KnownTargetOptions
): OperatorIdentityRememberForInput {
  const parsed = parseWriteRequest(OperatorIdentityRememberForInputSchema, input);
  assertKnownTargets([parsed.subjectActorId], options);
  return parsed;
}

export function parseOperatorIdentitySupersedeInput(input: unknown): OperatorIdentitySupersedeInput {
  return parseWriteRequest(OperatorIdentitySupersedeInputSchema, input);
}

export function parseOperatorIdentityRetractInput(input: unknown): OperatorIdentityRetractInput {
  return parseWriteRequest(OperatorIdentityRetractInputSchema, input);
}

export function parseOperatorSetupSaveInput(input: unknown): OperatorSetupSaveInput {
  return parseWriteRequest(OperatorSetupSaveInputSchema, input);
}

export function parseOperatorSupervisionStatusInput(input: unknown): OperatorSupervisionStatusInput {
  return parseWriteRequest(OperatorSupervisionStatusInputSchema, input);
}

export function parseOperatorReadInput(input: unknown): z.infer<typeof McpReadInputSchema> {
  return parseWriteRequest(McpReadInputSchema, input);
}

export {
  CompactContextResultSchema,
  MemoryKindSchema,
  McpAskResultSchema,
  McpIdentityRememberResultSchema,
  McpMemoryRememberResultSchema,
  McpMemorySearchInputSchema,
  McpMemorySearchResultSchema,
  McpReadInputSchema,
  McpReadResultSchema,
  McpSendResultSchema,
  RestartAgentAcceptedSchema,
  RoomContextUsageSchema,
  SetupSaveResponseSchema,
  SetupSnapshotSchema
};
