import { z } from "zod";

import { ClientCommandIdSchema, MessageContentSchema, ReferenceIdSchema } from "./common.js";
import { parseContractOutput, parseWriteRequest } from "./validation.js";

export const AssistantStatusSchema = z.enum([
  "disabled",
  "starting",
  "ready",
  "busy",
  "failed",
  "restart_required"
]);

export const AssistantSnapshotSchema = z
  .strictObject({
    enabled: z.boolean(),
    name: z.string().min(1).max(64),
    status: AssistantStatusSchema,
    detail: z.string().max(500).optional()
  })
  .passthrough();

export const AssistantConversationMessageSchema = z
  .strictObject({
    messageId: ReferenceIdSchema,
    role: z.enum(["user", "assistant"]),
    content: MessageContentSchema,
    createdAt: z.string().datetime({ offset: true }),
    clientCommandId: ClientCommandIdSchema.optional()
  })
  .passthrough();

export const AssistantConversationPageSchema = z
  .strictObject({
    messages: z.array(AssistantConversationMessageSchema).max(200)
  })
  .passthrough();

export const AssistantMessageRequestSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema,
  content: MessageContentSchema
});

export const AssistantMessageAcceptedSchema = z
  .strictObject({
    userMessage: AssistantConversationMessageSchema,
    assistantMessage: AssistantConversationMessageSchema.optional(),
    status: AssistantStatusSchema,
    detail: z.string().max(500).optional()
  })
  .passthrough();

export const AssistantCancelRequestSchema = z.strictObject({
  clientCommandId: ClientCommandIdSchema
});

export const AssistantCancelResultSchema = z
  .strictObject({
    accepted: z.boolean()
  })
  .passthrough();

export type AssistantStatus = z.infer<typeof AssistantStatusSchema>;
export type AssistantSnapshot = z.infer<typeof AssistantSnapshotSchema>;
export type AssistantConversationMessage = z.infer<typeof AssistantConversationMessageSchema>;
export type AssistantConversationPage = z.infer<typeof AssistantConversationPageSchema>;
export type AssistantMessageRequest = z.infer<typeof AssistantMessageRequestSchema>;
export type AssistantMessageAccepted = z.infer<typeof AssistantMessageAcceptedSchema>;
export type AssistantCancelRequest = z.infer<typeof AssistantCancelRequestSchema>;
export type AssistantCancelResult = z.infer<typeof AssistantCancelResultSchema>;

export function parseAssistantMessageRequest(input: unknown): AssistantMessageRequest {
  return parseWriteRequest(AssistantMessageRequestSchema, input);
}

export function parseAssistantCancelRequest(input: unknown): AssistantCancelRequest {
  return parseWriteRequest(AssistantCancelRequestSchema, input);
}

export function parseAssistantSnapshot(input: unknown): AssistantSnapshot {
  return parseContractOutput(AssistantSnapshotSchema, input);
}

export function parseAssistantConversationPage(input: unknown): AssistantConversationPage {
  return parseContractOutput(AssistantConversationPageSchema, input);
}

export function parseAssistantMessageAccepted(input: unknown): AssistantMessageAccepted {
  return parseContractOutput(AssistantMessageAcceptedSchema, input);
}

export function parseAssistantCancelResult(input: unknown): AssistantCancelResult {
  return parseContractOutput(AssistantCancelResultSchema, input);
}
