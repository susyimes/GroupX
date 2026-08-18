import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  AgentActorIdSchema,
  CompactContextResultSchema,
  GroupXEnvelopeSchema,
  MAX_TARGETS_PER_MESSAGE,
  McpAskResultSchema,
  McpIdentityRememberResultSchema,
  McpMemoryRememberInputSchema,
  McpMemoryRememberResultSchema,
  McpMemorySearchInputSchema,
  McpMemorySearchResultSchema,
  McpReadInputSchema,
  McpReadResultSchema,
  McpSendResultSchema,
  OperatorAgentCoreRememberInputSchema,
  OperatorAgentRestartInputSchema,
  OperatorContextCompactInputSchema,
  OperatorContextResetInputSchema,
  OperatorContextResetResultSchema,
  OperatorDispatchEventInputSchema,
  OperatorIdentityRememberForInputSchema,
  OperatorIdentityRetractInputSchema,
  OperatorIdentitySearchInputSchema,
  OperatorIdentitySearchResultSchema,
  OperatorIdentitySupersedeInputSchema,
  OperatorMemoryRetractInputSchema,
  OperatorMemorySupersedeInputSchema,
  OperatorRosterResultSchema,
  OperatorSendInputSchema,
  OperatorSetupSaveInputSchema,
  OperatorSupervisionStatusInputSchema,
  OperatorSupervisionStatusResultSchema,
  OperatorTurnCancelInputSchema,
  OperatorTurnsCancelInputSchema,
  OperatorTurnsCancelResultSchema,
  OperatorWorkerAskInputSchema,
  OperatorWorkerDispatchInputSchema,
  RestartAgentAcceptedSchema,
  RoomContextUsageSchema,
  SetupSaveResponseSchema,
  SetupSnapshotSchema,
  parseMcpMemoryRememberInput,
  parseMcpMemoryRememberResult,
  parseMcpMemorySearchResult,
  parseMcpReadResult,
  parseMcpSendResult,
  parseOperatorAgentCoreRememberInput,
  parseOperatorAgentRestartInput,
  parseOperatorContextCompactInput,
  parseOperatorContextResetInput,
  parseOperatorDispatchEventInput,
  parseOperatorIdentityRememberForInput,
  parseOperatorIdentityRetractInput,
  parseOperatorIdentitySearchInput,
  parseOperatorIdentitySupersedeInput,
  parseOperatorMemoryRetractInput,
  parseOperatorMemorySupersedeInput,
  parseOperatorReadInput,
  parseOperatorSendInput,
  parseOperatorSetupSaveInput,
  parseOperatorSupervisionStatusInput,
  parseOperatorTurnCancelInput,
  parseOperatorTurnsCancelInput,
  parseOperatorWorkerAskInput,
  parseOperatorWorkerDispatchInput,
  toSafeErrorBody,
  type KnownTargetOptions
} from "../../contracts/index.js";
import type { McpBindingContext } from "../binding-registry.js";
import { toToolCallerContext } from "./broker-api.js";
import type { OperatorBrokerApi } from "../../app/operator-broker-api.js";
import { GROUPX_MCP_SERVER_NAME, GROUPX_MCP_SERVER_VERSION } from "./tools.js";

export const GROUPX_OPERATOR_MCP_SERVER_NAME = "groupx-operator" as const;

const McpWireTargetsSchema = z
  .array(AgentActorIdSchema)
  .min(1)
  .max(MAX_TARGETS_PER_MESSAGE)
  .meta({ uniqueItems: true });

const OperatorSendWireInputSchema = OperatorSendInputSchema.safeExtend({
  to: McpWireTargetsSchema
});
const OperatorDispatchWireInputSchema = OperatorWorkerDispatchInputSchema.safeExtend({
  to: McpWireTargetsSchema
});
const OperatorAskWireInputSchema = OperatorWorkerAskInputSchema.safeExtend({
  to: McpWireTargetsSchema
});
const OperatorDispatchEventWireInputSchema = OperatorDispatchEventInputSchema.safeExtend({
  to: McpWireTargetsSchema
});
const McpWireEnvelopeSchema = GroupXEnvelopeSchema.safeExtend({ body: z.json() });
const McpReadWireResultSchema = McpReadResultSchema.safeExtend({
  events: z.array(McpWireEnvelopeSchema)
});

function successResult(value: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>
  };
}

function errorResult(error: unknown): CallToolResult {
  const body = toSafeErrorBody(error);
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(body.error) }]
  };
}

async function invoke<T extends object>(
  binding: McpBindingContext,
  request: { readonly requestId: string | number; readonly signal: AbortSignal },
  operation: (caller: ReturnType<typeof toToolCallerContext>) => Promise<T>
): Promise<CallToolResult> {
  try {
    return successResult(await operation(toToolCallerContext(binding, request)));
  } catch (error) {
    return errorResult(error);
  }
}

export interface CreateGroupXOperatorMcpServerOptions extends KnownTargetOptions {
  readonly broker: OperatorBrokerApi;
  readonly binding: McpBindingContext;
}

export function createGroupXOperatorMcpServer(
  options: CreateGroupXOperatorMcpServerOptions
): McpServer {
  const knownTargetOptions: KnownTargetOptions | undefined =
    options.knownTargets === undefined ? undefined : { knownTargets: options.knownTargets };
  const server = new McpServer(
    { name: GROUPX_OPERATOR_MCP_SERVER_NAME, version: GROUPX_MCP_SERVER_VERSION },
    {
      instructions:
        "You are the GroupX room assistant operator surface. These tools do not require an Agent Turn. " +
        "Do not call watch or steer. Do not put yourself in observers. Default to worker_dispatch, not send."
    }
  );

  server.registerTool(
    "send",
    {
      description:
        "Speak publicly in the room as user:assistant. Only when the user explicitly wants the group to see it.",
      inputSchema: OperatorSendWireInputSchema,
      outputSchema: McpSendResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        parseMcpSendResult(
          await options.broker.send(caller, parseOperatorSendInput(input, knownTargetOptions))
        )
      )
  );

  server.registerTool(
    "read",
    {
      description: "Read durable room events and turn state by correlation or sequence cursor.",
      inputSchema: McpReadInputSchema,
      outputSchema: McpReadWireResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        parseMcpReadResult(await options.broker.read(caller, parseOperatorReadInput(input)))
      )
  );

  server.registerTool(
    "roster",
    {
      description: "List enabled room agents, health, non-terminal turns, and supervision pair summaries.",
      inputSchema: z.strictObject({}),
      outputSchema: OperatorRosterResultSchema
    },
    async (_input, extra) => invoke(options.binding, extra, async (caller) => options.broker.roster(caller))
  );

  server.registerTool(
    "context_usage",
    {
      description: "Inspect the current room context character budget.",
      inputSchema: z.strictObject({}),
      outputSchema: RoomContextUsageSchema
    },
    async (_input, extra) =>
      invoke(options.binding, extra, async (caller) => options.broker.contextUsage(caller))
  );

  server.registerTool(
    "context_compact",
    {
      description: "Compact older room context into the same durable summary. Does not delete transcript.",
      inputSchema: OperatorContextCompactInputSchema,
      outputSchema: CompactContextResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        options.broker.contextCompact(caller, parseOperatorContextCompactInput(input))
      )
  );

  server.registerTool(
    "context_reset",
    {
      description: "Start a new context epoch. Transcript is kept. Optionally restart native sessions.",
      inputSchema: OperatorContextResetInputSchema,
      outputSchema: OperatorContextResetResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        options.broker.contextReset(caller, parseOperatorContextResetInput(input))
      )
  );

  server.registerTool(
    "turn_cancel",
    {
      description: "Request cancellation of one non-terminal Turn.",
      inputSchema: OperatorTurnCancelInputSchema,
      outputSchema: z.object({
        turnId: z.string(),
        accepted: z.boolean(),
        status: z.string()
      })
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        options.broker.turnCancel(caller, parseOperatorTurnCancelInput(input))
      )
  );

  server.registerTool(
    "turns_cancel",
    {
      description: "Cancel all non-terminal Turns, optionally filtered by worker.",
      inputSchema: OperatorTurnsCancelInputSchema,
      outputSchema: OperatorTurnsCancelResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        options.broker.turnsCancel(caller, parseOperatorTurnsCancelInput(input, knownTargetOptions))
      )
  );

  server.registerTool(
    "agent_restart",
    {
      description: "Restart one room Agent session. Do not replay a prompt that may already have been delivered.",
      inputSchema: OperatorAgentRestartInputSchema,
      outputSchema: RestartAgentAcceptedSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        options.broker.agentRestart(caller, parseOperatorAgentRestartInput(input, knownTargetOptions))
      )
  );

  server.registerTool(
    "memory_search",
    {
      description: "Search public memory or an Agent's core/dated memory.",
      inputSchema: McpMemorySearchInputSchema,
      outputSchema: McpMemorySearchResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        parseMcpMemorySearchResult(await options.broker.memorySearch(caller, input))
      )
  );

  server.registerTool(
    "memory_remember",
    {
      description: "Write a public room memory. Do not use this for Agent core or dated memory.",
      inputSchema: McpMemoryRememberInputSchema,
      outputSchema: McpMemoryRememberResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        parseMcpMemoryRememberResult(
          await options.broker.memoryRemember(
            caller,
            parseMcpMemoryRememberInput(input, knownTargetOptions)
          )
        )
      )
  );

  server.registerTool(
    "memory_supersede",
    {
      description: "Replace public or Agent core memory. Dated memory cannot be rewritten.",
      inputSchema: OperatorMemorySupersedeInputSchema,
      outputSchema: McpMemoryRememberResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        options.broker.memorySupersede(caller, parseOperatorMemorySupersedeInput(input))
      )
  );

  server.registerTool(
    "memory_retract",
    {
      description: "Retract public, core, or dated memory.",
      inputSchema: OperatorMemoryRetractInputSchema,
      outputSchema: McpMemoryRememberResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        options.broker.memoryRetract(caller, parseOperatorMemoryRetractInput(input))
      )
  );

  server.registerTool(
    "agent_core_remember",
    {
      description: "Write curated core memory for any Agent. Cannot write dated memory.",
      inputSchema: OperatorAgentCoreRememberInputSchema,
      outputSchema: McpMemoryRememberResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        options.broker.agentCoreRemember(
          caller,
          parseOperatorAgentCoreRememberInput(input, knownTargetOptions)
        )
      )
  );

  server.registerTool(
    "identity_search",
    {
      description: "Read compatibility identity records, optionally for one Agent.",
      inputSchema: OperatorIdentitySearchInputSchema,
      outputSchema: OperatorIdentitySearchResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        options.broker.identitySearch(caller, parseOperatorIdentitySearchInput(input))
      )
  );

  server.registerTool(
    "identity_remember_for",
    {
      description: "Write a compatibility identity record for any Agent. Author is user:assistant.",
      inputSchema: OperatorIdentityRememberForInputSchema,
      outputSchema: McpIdentityRememberResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        options.broker.identityRememberFor(
          caller,
          parseOperatorIdentityRememberForInput(input, knownTargetOptions)
        )
      )
  );

  server.registerTool(
    "identity_supersede",
    {
      description: "Replace a compatibility identity record.",
      inputSchema: OperatorIdentitySupersedeInputSchema,
      outputSchema: McpIdentityRememberResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        options.broker.identitySupersede(caller, parseOperatorIdentitySupersedeInput(input))
      )
  );

  server.registerTool(
    "identity_retract",
    {
      description: "Retract a compatibility identity record.",
      inputSchema: OperatorIdentityRetractInputSchema,
      outputSchema: McpIdentityRememberResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        options.broker.identityRetract(caller, parseOperatorIdentityRetractInput(input))
      )
  );

  server.registerTool(
    "setup_read",
    {
      description: "Read the current setup draft, including the assistant card.",
      inputSchema: z.strictObject({}),
      outputSchema: SetupSnapshotSchema
    },
    async (_input, extra) => invoke(options.binding, extra, async (caller) => options.broker.setupRead(caller))
  );

  server.registerTool(
    "setup_save",
    {
      description: "Save the setup draft. Success requires a GroupX restart; sessions are not hot-swapped.",
      inputSchema: OperatorSetupSaveInputSchema,
      outputSchema: SetupSaveResponseSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        options.broker.setupSave(caller, parseOperatorSetupSaveInput(input))
      )
  );

  server.registerTool(
    "worker_dispatch",
    {
      description:
        "Wake one or more workers without a chat bubble. Writes operator.dispatch as the current task.",
      inputSchema: OperatorDispatchWireInputSchema,
      outputSchema: McpSendResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        options.broker.workerDispatch(
          caller,
          parseOperatorWorkerDispatchInput(input, knownTargetOptions)
        )
      )
  );

  server.registerTool(
    "worker_ask",
    {
      description:
        "Dispatch workers without a chat bubble and wait for their terminal results to return here.",
      inputSchema: OperatorAskWireInputSchema,
      outputSchema: McpAskResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        options.broker.workerAsk(caller, parseOperatorWorkerAskInput(input, knownTargetOptions))
      )
  );

  server.registerTool(
    "dispatch_event",
    {
      description: "Re-route an existing public room message to more workers. The original author stays.",
      inputSchema: OperatorDispatchEventWireInputSchema,
      outputSchema: McpSendResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        options.broker.dispatchEvent(
          caller,
          parseOperatorDispatchEventInput(input, knownTargetOptions)
        )
      )
  );

  server.registerTool(
    "supervision_status",
    {
      description: "Read a bounded supervision pair snapshot. No reasoning or raw tool arguments.",
      inputSchema: OperatorSupervisionStatusInputSchema,
      outputSchema: OperatorSupervisionStatusResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        options.broker.supervisionStatus(caller, parseOperatorSupervisionStatusInput(input))
      )
  );

  void GROUPX_MCP_SERVER_NAME;
  return server;
}
