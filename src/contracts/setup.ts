import { z } from "zod";

import { parseContractOutput, parseWriteRequest } from "./validation.js";

export const SetupAgentDriverSchema = z.enum(["codex", "grok", "kimi"]);

export const SetupAgentIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/u, "invalid agent id");

export const SetupCommandDraftSchema = z.strictObject({
  executable: z.string().trim().min(1).max(4_096),
  prefixArgs: z.array(z.string().trim().min(1).max(4_096)).max(1).default([])
});

export const SetupAgentDraftSchema = z.strictObject({
  id: SetupAgentIdSchema,
  driver: SetupAgentDriverSchema,
  name: z.string().trim().max(64).default(""),
  identity: z.string().trim().max(32_768).optional(),
  command: SetupCommandDraftSchema,
  cwd: z.string().trim().min(1).max(4_096),
  enabled: z.boolean().default(true)
});

export const SetupConfigDraftSchema = z
  .strictObject({
    serverPort: z.number().int().min(1).max(65_535).default(4_310),
    storagePath: z.string().trim().min(1).max(4_096).default(".groupx/groupx.db"),
    agents: z.array(SetupAgentDraftSchema).min(1).max(64)
  })
  .superRefine((draft, context) => {
    const seen = new Set<string>();
    for (const [index, agent] of draft.agents.entries()) {
      if (seen.has(agent.id)) {
        context.addIssue({
          code: "custom",
          message: "agent ids must be unique",
          path: ["agents", index, "id"]
        });
      }
      seen.add(agent.id);
    }
  });

export const SetupSaveRequestSchema = z
  .strictObject({
    config: SetupConfigDraftSchema
  })
  .superRefine((request, context) => {
    if (!request.config.agents.some((agent) => agent.enabled)) {
      context.addIssue({
        code: "custom",
        message: "at least one agent must be enabled",
        path: ["config", "agents"]
      });
    }
  });

export const SetupDriverProbeSchema = z.strictObject({
  driver: SetupAgentDriverSchema,
  found: z.boolean()
});

export const SetupSnapshotSchema = z
  .strictObject({
    configPath: z.string().min(1),
    existing: z.boolean(),
    runtimeActive: z.boolean(),
    drivers: z.array(SetupDriverProbeSchema).length(3),
    config: SetupConfigDraftSchema,
    existingConfigError: z.string().min(1).optional()
  })
  .superRefine((snapshot, context) => {
    const drivers = new Set(snapshot.drivers.map(({ driver }) => driver));
    if (drivers.size !== SetupAgentDriverSchema.options.length) {
      context.addIssue({
        code: "custom",
        message: "driver probes must contain codex, grok, and kimi exactly once",
        path: ["drivers"]
      });
    }
  });

export const SetupSaveResponseSchema = z
  .strictObject({
    saved: z.literal(true),
    configPath: z.string().min(1),
    agentCount: z.number().int().min(1).max(64),
    enabledAgentCount: z.number().int().min(1).max(64),
    restartRequired: z.boolean()
  })
  .superRefine((response, context) => {
    if (response.enabledAgentCount > response.agentCount) {
      context.addIssue({
        code: "custom",
        message: "enabled agent count cannot exceed total agent count",
        path: ["enabledAgentCount"]
      });
    }
  });

export type SetupAgentDriver = z.infer<typeof SetupAgentDriverSchema>;
export type SetupAgentDraft = z.infer<typeof SetupAgentDraftSchema>;
export type SetupConfigDraft = z.infer<typeof SetupConfigDraftSchema>;
export type SetupSaveRequest = z.infer<typeof SetupSaveRequestSchema>;
export type SetupSnapshot = z.infer<typeof SetupSnapshotSchema>;
export type SetupSaveResponse = z.infer<typeof SetupSaveResponseSchema>;

export function parseSetupSaveRequest(input: unknown): SetupSaveRequest {
  return parseWriteRequest(SetupSaveRequestSchema, input);
}

export function parseSetupConfigDraft(input: unknown): SetupConfigDraft {
  return parseContractOutput(SetupConfigDraftSchema, input);
}

export function parseSetupSnapshot(input: unknown): SetupSnapshot {
  return parseContractOutput(SetupSnapshotSchema, input);
}

export function parseSetupSaveResponse(input: unknown): SetupSaveResponse {
  return parseContractOutput(SetupSaveResponseSchema, input);
}
