import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  AgentActorIdSchema,
  GroupXEnvelopeSchema,
  MAX_TARGETS_PER_MESSAGE,
  McpAskInputSchema,
  McpAskResultSchema,
  McpCoreMemoryRememberInputSchema,
  McpCoreMemoryRememberResultSchema,
  McpIdentityReadInputSchema,
  McpIdentityReadResultSchema,
  McpIdentityRememberInputSchema,
  McpIdentityRememberResultSchema,
  McpMemoryRememberInputSchema,
  McpMemoryRememberResultSchema,
  McpMemorySearchInputSchema,
  McpMemorySearchResultSchema,
  McpReadInputSchema,
  McpReadResultSchema,
  McpSendInputSchema,
  McpSendResultSchema,
  McpSteerInputSchema,
  McpSteerResultSchema,
  McpWatchInputSchema,
  McpWatchResultSchema,
  parseMcpAskInput,
  parseMcpAskResult,
  parseMcpCoreMemoryRememberInput,
  parseMcpCoreMemoryRememberResult,
  parseMcpIdentityReadInput,
  parseMcpIdentityReadResult,
  parseMcpIdentityRememberInput,
  parseMcpIdentityRememberResult,
  parseMcpMemoryRememberInput,
  parseMcpMemoryRememberResult,
  parseMcpMemorySearchInput,
  parseMcpMemorySearchResult,
  parseMcpReadInput,
  parseMcpReadResult,
  parseMcpSendInput,
  parseMcpSendResult,
  parseMcpSteerInput,
  parseMcpSteerResult,
  parseMcpWatchInput,
  parseMcpWatchResult,
  toSafeErrorBody,
  type KnownTargetOptions
} from "../../contracts/index.js";
import type { McpBindingContext } from "../binding-registry.js";
import {
  toToolCallerContext,
  type ToolBrokerApi,
  type ToolCallerContext
} from "./broker-api.js";

export const GROUPX_MCP_SERVER_NAME = "groupx" as const;
export const GROUPX_MCP_SERVER_VERSION = "0.1.0" as const;

export const GROUPX_MCP_TOOL_NAMES = [
  "send",
  "ask",
  "watch",
  "steer",
  "read",
  "memory_search",
  "memory_remember",
  "core_memory_remember",
  "identity_read",
  "identity_remember"
] as const;

export type GroupXMcpToolName = (typeof GROUPX_MCP_TOOL_NAMES)[number];

export interface CreateGroupXMcpServerOptions extends KnownTargetOptions {
  readonly broker: ToolBrokerApi;
  readonly binding: McpBindingContext;
}

/*
 * The authoritative contract schemas contain runtime transforms/custom JSON
 * checks that the MCP SDK cannot encode in tool discovery JSON Schema. These
 * wire schemas are derived from the same contracts, replacing only those two
 * non-representable nodes. Handlers still run the authoritative parseMcp*
 * functions before calling Broker.
 */
const McpWireTargetsSchema = z
  .array(AgentActorIdSchema)
  .min(1)
  .max(MAX_TARGETS_PER_MESSAGE)
  .meta({ uniqueItems: true });

const McpSendWireInputSchema = McpSendInputSchema.safeExtend({
  to: McpWireTargetsSchema
});

const McpAskWireInputSchema = McpAskInputSchema.safeExtend({
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
  operation: (caller: ToolCallerContext) => Promise<T>
): Promise<CallToolResult> {
  try {
    return successResult(await operation(toToolCallerContext(binding, request)));
  } catch (error) {
    return errorResult(error);
  }
}

/**
 * Builds one MCP protocol endpoint for a binding-scoped connection/request.
 *
 * Wire names deliberately contain no dots. MCP clients normally expose these
 * as namespaced tools such as `groupx__send` using the server name.
 */
export function createGroupXMcpServer(options: CreateGroupXMcpServerOptions): McpServer {
  const knownTargetOptions: KnownTargetOptions | undefined =
    options.knownTargets === undefined
      ? undefined
      : { knownTargets: options.knownTargets };
  const server = new McpServer(
    { name: GROUPX_MCP_SERVER_NAME, version: GROUPX_MCP_SERVER_VERSION },
    {
      instructions:
        "GroupX tools route explicit local group messages and memory operations. Caller identity " +
        "comes from the current Adapter/session binding. Routing rules: (1) Your final turn " +
        "response is visible to the room but wakes no agent, and @name mentions in plain text " +
        "never route; to make another agent act or answer, call send or ask. (2) After an ask " +
        "timeout the target keeps running and its answer is never delivered to you " +
        "automatically; keep polling read until the target turn is terminal, or hand off " +
        "explicitly with send before ending your turn. (3) Your prompt context is frozen at " +
        "dispatch time; call read to catch up on newer room messages before irreversible " +
        "actions such as pushing commits or declaring agreement with another agent. (4) watch " +
        "and steer exist only on a live supervision watch turn: watch waits for a bounded " +
        "worker milestone, and steer nudges or interrupts the whole worker turn. They are " +
        "not an approval layer and cannot allow or deny a native tool."
    }
  );

  server.registerTool(
    "send",
    {
      description:
        "Send a public GroupX message asynchronously to one or more agents. Each target is " +
        "woken with a new turn. This (or ask) is the only way to make another agent act: " +
        "plain final responses and @name mentions in text wake no one.",
      inputSchema: McpSendWireInputSchema,
      outputSchema: McpSendResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        parseMcpSendResult(
          await options.broker.send(
            caller,
            parseMcpSendInput(input, knownTargetOptions)
          )
        )
      )
  );

  server.registerTool(
    "ask",
    {
      description:
        "Ask one or more agents and wait for their terminal GroupX results. Waits up to " +
        "timeoutMs (default 120000, max 3600000). On timeout the target keeps running: poll " +
        "read with the returned correlationId until its turn is terminal, or hand off with " +
        "send; the answer is never delivered automatically after your turn ends.",
      inputSchema: McpAskWireInputSchema,
      outputSchema: McpAskResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        parseMcpAskResult(
          await options.broker.ask(
            caller,
            parseMcpAskInput(input, knownTargetOptions)
          )
        )
      )
  );

  server.registerTool(
    "watch",
    {
      description:
        "Wait for the next bounded milestone or terminal state of the worker you are " +
        "watching. Only valid on a supervision watch turn. Returns a bounded snapshot: " +
        "status, public message excerpts, and tool names/status. No reasoning text, raw " +
        "tool arguments, or stderr. This is observation, not approval.",
      inputSchema: McpWatchInputSchema,
      outputSchema: McpWatchResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        parseMcpWatchResult(await options.broker.watch(caller, parseMcpWatchInput(input)))
      )
  );

  server.registerTool(
    "steer",
    {
      description:
        "Redirect the watched worker. nudge queues guidance after the current turn. " +
        "interrupt cancels the whole current worker turn, then starts a new one with your " +
        "guidance. Requires a public reason. You cannot approve, deny, or cancel a single " +
        "native tool. Only valid on a supervision watch turn.",
      inputSchema: McpSteerInputSchema,
      outputSchema: McpSteerResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        parseMcpSteerResult(await options.broker.steer(caller, parseMcpSteerInput(input)))
      )
  );

  server.registerTool(
    "read",
    {
      description:
        "Read durable GroupX events and turn state by correlation or sequence cursor. Your " +
        "prompt context is frozen at dispatch time; use read to catch up on newer room " +
        "messages, sibling answers, and running turn status, especially before irreversible " +
        "actions.",
      inputSchema: McpReadInputSchema,
      outputSchema: McpReadWireResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        parseMcpReadResult(await options.broker.read(caller, parseMcpReadInput(input)))
      )
  );

  server.registerTool(
    "memory_search",
    {
      description: "Search curated GroupX public memory.",
      inputSchema: McpMemorySearchInputSchema,
      outputSchema: McpMemorySearchResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        parseMcpMemorySearchResult(
          await options.broker.memorySearch(caller, parseMcpMemorySearchInput(input))
        )
      )
  );

  server.registerTool(
    "memory_remember",
    {
      description: "Add an explicit, source-attributed record to GroupX public memory.",
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
    "core_memory_remember",
    {
      description:
        "Write a curated core memory for the current Agent only. Caller and target identity come from the active GroupX binding.",
      inputSchema: McpCoreMemoryRememberInputSchema,
      outputSchema: McpCoreMemoryRememberResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        parseMcpCoreMemoryRememberResult(
          await options.broker.coreMemoryRemember(
            caller,
            parseMcpCoreMemoryRememberInput(input)
          )
        )
      )
  );

  server.registerTool(
    "identity_read",
    {
      description: "Read the current caller's GroupX identity memory.",
      inputSchema: McpIdentityReadInputSchema,
      outputSchema: McpIdentityReadResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        parseMcpIdentityReadResult(
          await options.broker.identityRead(caller, parseMcpIdentityReadInput(input))
        )
      )
  );

  server.registerTool(
    "identity_remember",
    {
      description: "Add an explicit identity record for the current bound GroupX actor.",
      inputSchema: McpIdentityRememberInputSchema,
      outputSchema: McpIdentityRememberResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        parseMcpIdentityRememberResult(
          await options.broker.identityRemember(caller, parseMcpIdentityRememberInput(input))
        )
      )
  );

  return server;
}
