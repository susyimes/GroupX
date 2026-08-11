import type {
  McpAskInput,
  McpAskResult,
  McpIdentityReadInput,
  McpIdentityReadResult,
  McpIdentityRememberInput,
  McpIdentityRememberResult,
  McpMemoryRememberInput,
  McpMemoryRememberResult,
  McpMemorySearchInput,
  McpMemorySearchResult,
  McpReadInput,
  McpReadResult,
  McpSendInput,
  McpSendResult
} from "../../contracts/mcp.js";
import type { McpBindingContext } from "../binding-registry.js";

/**
 * Provenance supplied to Broker operations for one MCP tool invocation.
 *
 * The binding fields come from the Adapter/session registry, never from tool
 * arguments. They associate normal GroupX traffic with an actor; they are not
 * authentication or authorization evidence.
 */
export interface ToolCallerContext {
  readonly bindingId: string;
  readonly actorId: string;
  readonly instanceId: string;
  readonly nativeSessionId?: string;
  readonly activeGroupxTurnId?: string;
  readonly mcpRequestId: string | number;
  readonly signal: AbortSignal;
}

export function toToolCallerContext(
  binding: McpBindingContext,
  input: {
    readonly requestId: string | number;
    readonly signal: AbortSignal;
  }
): ToolCallerContext {
  return {
    bindingId: binding.bindingId,
    actorId: binding.actorId,
    instanceId: binding.instanceId,
    ...(binding.nativeSessionId === undefined
      ? {}
      : { nativeSessionId: binding.nativeSessionId }),
    ...(binding.activeGroupxTurnId === undefined
      ? {}
      : { activeGroupxTurnId: binding.activeGroupxTurnId }),
    mcpRequestId: input.requestId,
    signal: input.signal
  };
}

/**
 * Product-facing dependency of the MCP adapter.
 *
 * Implementations own persistence, routing, causal checks and actor/domain
 * validation. This MCP module only validates the public contract, supplies the
 * bound caller context and converts results to MCP CallToolResult values.
 */
export interface ToolBrokerApi {
  send(caller: ToolCallerContext, input: McpSendInput): Promise<McpSendResult>;
  ask(caller: ToolCallerContext, input: McpAskInput): Promise<McpAskResult>;
  read(caller: ToolCallerContext, input: McpReadInput): Promise<McpReadResult>;
  memorySearch(
    caller: ToolCallerContext,
    input: McpMemorySearchInput
  ): Promise<McpMemorySearchResult>;
  memoryRemember(
    caller: ToolCallerContext,
    input: McpMemoryRememberInput
  ): Promise<McpMemoryRememberResult>;
  identityRead(
    caller: ToolCallerContext,
    input: McpIdentityReadInput
  ): Promise<McpIdentityReadResult>;
  identityRemember(
    caller: ToolCallerContext,
    input: McpIdentityRememberInput
  ): Promise<McpIdentityRememberResult>;
}
