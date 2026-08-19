import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  AgentActorIdSchema,
  GroupXEnvelopeSchema,
  MAX_TARGETS_PER_MESSAGE,
  McpAskInputSchema,
  McpAskResultSchema,
  McpCollectInputSchema,
  McpCollectResultSchema,
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
  McpPublishInputSchema,
  McpPublishResultSchema,
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
  parseMcpCollectInput,
  parseMcpCollectResult,
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
  parseMcpPublishInput,
  parseMcpPublishResult,
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
  "publish",
  "ask",
  "collect",
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
        "comes from the current Adapter/session binding. Routing rules: (1) Your final turn and " +
        "publish are visible to the room but wake no agent, and @name mentions in plain text " +
        "never route; only send or ask creates target Turns. (2) Choose send, ask, publish, and " +
        "read as needed to organize, delegate, challenge, rebut, or converge. GroupX does not " +
        "appoint a coordinator, forbid agent-to-agent review, or prescribe a number of rounds. " +
        "For a peer already running in this correlation, prefer publish plus read for the " +
        "in-flight discussion: send or ask always queues a distinct later Turn, even when that " +
        "peer can already read your public message. Use send or ask there only when you " +
        "intentionally need that later Turn. (3) ask waits at most 60000 ms and returns " +
        "state=pending immediately when a target is " +
        "already queued. Use collect with that ask's exact messageEventId to continue the same " +
        "request without duplicating it; a materially different follow-up may use send or ask. " +
        "publish is the no-wakeup public-message path. (4) replyTo " +
        "defaults to the current source message, preserving the handoff chain. Your prompt context is frozen at " +
        "dispatch time; call read to catch up on newer room messages before irreversible " +
        "actions such as pushing commits or declaring agreement with another agent. (5) watch " +
        "and steer exist only on a live supervision watch turn: watch waits for a bounded " +
        "worker milestone, and steer nudges or interrupts the whole worker turn. They are " +
        "not an approval layer and cannot allow or deny a native tool. (6) To start a live " +
        "supervision pair, pass supervision.observers on send or ask. Observers cannot overlap " +
        "workers, and you cannot list yourself as an observer."
    }
  );

  server.registerTool(
    "publish",
    {
      description:
        "Publish a durable public message without waking any agent or creating a Turn. Use it " +
        "for checkpoints and for in-flight challenges or replies among peers that already have " +
        "running Turns in this correlation; they catch up with read and can respond from those " +
        "Turns without building a delayed queue. replyToEventId defaults to the current source " +
        "message.",
      inputSchema: McpPublishInputSchema,
      outputSchema: McpPublishResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        parseMcpPublishResult(
          await options.broker.publish(caller, parseMcpPublishInput(input))
        )
      )
  );

  server.registerTool(
    "send",
    {
      description:
        "Send a public GroupX message asynchronously to one or more agents. This always creates " +
        "a distinct target Turn; if a target already has a running Turn in this correlation, the " +
        "new Turn waits behind it. Inspect state with read and use publish for in-flight peer " +
        "discussion unless you intentionally need that later Turn. Plain final responses and " +
        "@name mentions in text wake no one. Optional " +
        "supervision.observers starts a live_steer pair: those agents watch the workers and " +
        "may later watch/steer. Observers cannot overlap to[], and you cannot observe yourself.",
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
        "Ask one or more agents and wait up to 60000 ms for their terminal results. If a target " +
        "is already busy, ask still creates a distinct later Turn and immediately returns " +
        "state=pending with queuePosition. For a peer already running in this correlation, use " +
        "publish plus read for in-flight discussion unless a later Turn is intentional. " +
        "Continue that same request with collect(messageEventId) instead of duplicating it; a " +
        "materially different follow-up may use send or ask. Optional " +
        "supervision.observers starts the same live_steer pair as send.",
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
    "collect",
    {
      description:
        "Collect only the child Turns created by one earlier ask messageEventId. Waits at most " +
        "60000 ms, returns pending with queue metadata when unfinished, and never creates or " +
        "replays a Turn.",
      inputSchema: McpCollectInputSchema,
      outputSchema: McpCollectResultSchema
    },
    async (input, extra) =>
      invoke(options.binding, extra, async (caller) =>
        parseMcpCollectResult(
          await options.broker.collect(caller, parseMcpCollectInput(input))
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
        "messages, sibling answers, and running turn status. Inspect same-correlation peers with " +
        "read before send/ask so an in-flight reply does not become a delayed duplicate Turn, " +
        "and read again before irreversible actions.",
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
