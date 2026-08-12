import { GroupXError } from "../../core/errors.js";
import { isAbsolute } from "node:path";
import type { LaunchProfile, McpBindingLaunchSpec, NativeEvent } from "../types.js";

export const ACP_PROTOCOL_VERSION = 1;
export const GROUPX_MCP_SERVER_NAME = "groupx";

export interface AcpAgentCapabilities {
  loadSession?: boolean;
  mcpCapabilities?: {
    http?: boolean;
    sse?: boolean;
    [key: string]: unknown;
  };
  sessionCapabilities?: {
    resume?: unknown;
    close?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface AcpImplementationInfo {
  name: string;
  title?: string;
  version?: string;
  [key: string]: unknown;
}

export interface AcpInitializeResult {
  protocolVersion: 1;
  agentCapabilities: AcpAgentCapabilities;
  agentInfo?: AcpImplementationInfo;
  authMethods?: unknown[];
}

export type AcpMcpServerDescriptor =
  | {
      name: typeof GROUPX_MCP_SERVER_NAME;
      command: string;
      args: string[];
      env: [];
    }
  | {
      type: "http";
      name: typeof GROUPX_MCP_SERVER_NAME;
      url: string;
      headers: [{ name: "X-GroupX-Binding"; value: string }];
    };

export interface AcpSessionUpdate {
  sessionId: string;
  update: Record<string, unknown> & { sessionUpdate: string };
}

export interface AcpPromptResult {
  stopReason: string;
  userMessageId?: string;
  usage?: unknown;
}

export function parseInitializeResult(value: unknown): AcpInitializeResult {
  const result = requireRecord(value, "initialize result");
  if (result.protocolVersion !== ACP_PROTOCOL_VERSION) {
    throw new GroupXError(
      "PROTOCOL_INVALID_MESSAGE",
      `ACP protocol version mismatch: expected ${ACP_PROTOCOL_VERSION}, received ${String(result.protocolVersion)}`
    );
  }

  const capabilities = result.agentCapabilities;
  if (!isRecord(capabilities)) {
    throw new GroupXError("PROTOCOL_INVALID_MESSAGE", "ACP initialize result is missing agentCapabilities");
  }

  const parsed: AcpInitializeResult = {
    protocolVersion: ACP_PROTOCOL_VERSION,
    agentCapabilities: cloneJsonRecord(capabilities)
  };
  if (isRecord(result.agentInfo) && typeof result.agentInfo.name === "string") {
    parsed.agentInfo = cloneJsonRecord(result.agentInfo) as AcpImplementationInfo;
  }
  if (Array.isArray(result.authMethods)) {
    parsed.authMethods = structuredClone(result.authMethods);
  }
  return parsed;
}

export function parseNewSessionResult(value: unknown): string {
  const result = requireRecord(value, "session/new result");
  if (typeof result.sessionId !== "string" || result.sessionId.length === 0) {
    throw new GroupXError("PROTOCOL_INVALID_MESSAGE", "ACP session/new result is missing sessionId");
  }
  return result.sessionId;
}

export function parsePromptResult(value: unknown): AcpPromptResult {
  const result = requireRecord(value, "session/prompt result");
  if (typeof result.stopReason !== "string" || result.stopReason.length === 0) {
    throw new GroupXError("PROTOCOL_INVALID_MESSAGE", "ACP session/prompt result is missing stopReason");
  }
  return {
    stopReason: result.stopReason,
    ...(typeof result.userMessageId === "string" ? { userMessageId: result.userMessageId } : {}),
    ...(Object.hasOwn(result, "usage") ? { usage: structuredClone(result.usage) } : {})
  };
}

export function parseSessionUpdate(params: unknown): AcpSessionUpdate | undefined {
  if (!isRecord(params) || typeof params.sessionId !== "string" || !isRecord(params.update)) {
    return undefined;
  }
  if (typeof params.update.sessionUpdate !== "string" || params.update.sessionUpdate.length === 0) {
    return undefined;
  }
  return {
    sessionId: params.sessionId,
    update: cloneJsonRecord(params.update) as Record<string, unknown> & { sessionUpdate: string }
  };
}

export function buildMcpServers(
  mcp: McpBindingLaunchSpec | undefined,
  capabilities: AcpAgentCapabilities,
  bindingId: string
): AcpMcpServerDescriptor[] {
  if (mcp === undefined) {
    return [];
  }

  if (mcp.transport === "stdio") {
    if (!isAbsolute(mcp.command) || mcp.args.some((argument) => typeof argument !== "string")) {
      throw new TypeError("Invalid GroupX MCP stdio launch specification");
    }
    if (mcp.args.some((argument) => argument === "--binding" || argument.startsWith("--binding="))) {
      throw new GroupXError(
        "MCP_BINDING_MISMATCH",
        "GroupX MCP stdio binding is assigned by the Adapter and must not be supplied in mcp.args"
      );
    }
    return [
      {
        name: GROUPX_MCP_SERVER_NAME,
        command: mcp.command,
        args: [...mcp.args, "--binding", bindingId],
        env: []
      }
    ];
  }

  if (capabilities.mcpCapabilities?.http !== true) {
    throw new GroupXError(
      "ADAPTER_START_FAILED",
      "The ACP agent did not advertise mcpCapabilities.http for the requested GroupX MCP transport"
    );
  }
  if (mcp.url.length === 0) {
    throw new TypeError("Invalid GroupX MCP HTTP URL");
  }
  return [
    {
      type: "http",
      name: GROUPX_MCP_SERVER_NAME,
      url: mcp.url,
      headers: [{ name: "X-GroupX-Binding", value: bindingId }]
    }
  ];
}

export function buildPromptBlocks(input: {
  content: string;
  contextPacket?: string;
}): Array<{ type: "text"; text: string }> {
  const text =
    input.contextPacket === undefined || input.contextPacket.length === 0
      ? input.content
      : `${input.contextPacket}\n\n[current_message]\n${input.content}`;
  return [{ type: "text", text }];
}

export function normalizeSessionUpdate(
  adapterId: string,
  instanceId: string,
  nativeSessionId: string,
  nativeTurnId: string,
  occurredAt: string,
  update: AcpSessionUpdate["update"]
): NativeEvent | undefined {
  const common = {
    adapterId,
    instanceId,
    nativeSessionId,
    nativeTurnId,
    occurredAt
  } as const;

  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const text = textContent(update.content);
      if (text === undefined) {
        return undefined;
      }
      return {
        ...common,
        ...(typeof update.messageId === "string" ? { nativeEventId: update.messageId } : {}),
        type: "content.delta",
        payload: {
          text,
          ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {})
        }
      };
    }
    case "agent_thought_chunk": {
      const text = textContent(update.content);
      if (text === undefined) {
        return undefined;
      }
      return {
        ...common,
        ...(typeof update.messageId === "string" ? { nativeEventId: update.messageId } : {}),
        type: "reasoning.delta",
        payload: {
          text,
          ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {})
        }
      };
    }
    case "tool_call":
      return {
        ...common,
        ...(typeof update.toolCallId === "string" ? { nativeEventId: update.toolCallId } : {}),
        type: "tool.started",
        payload: toolProjection(update)
      };
    case "tool_call_update": {
      const status = typeof update.status === "string" ? update.status : undefined;
      return {
        ...common,
        ...(typeof update.toolCallId === "string" ? { nativeEventId: update.toolCallId } : {}),
        type: status === "completed" || status === "failed" || status === "cancelled" ? "tool.completed" : "tool.started",
        payload: toolProjection(update)
      };
    }
    default:
      return undefined;
  }
}

export function launchProfileFields(
  profile: LaunchProfile
): Pick<LaunchProfile, "command" | "prefixArgs" | "cwd" | "instanceId" | "bindingId" | "mcp"> {
  return {
    command: profile.command,
    ...(profile.prefixArgs === undefined ? {} : { prefixArgs: [...profile.prefixArgs] }),
    cwd: profile.cwd,
    ...(profile.instanceId === undefined ? {} : { instanceId: profile.instanceId }),
    ...(profile.bindingId === undefined ? {} : { bindingId: profile.bindingId }),
    ...(profile.mcp === undefined ? {} : { mcp: structuredClone(profile.mcp) })
  };
}

function toolProjection(update: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ["toolCallId", "title", "kind", "status", "content", "locations"] as const) {
    if (Object.hasOwn(update, key)) {
      result[key] = structuredClone(update[key]);
    }
  }
  return result;
}

function textContent(value: unknown): string | undefined {
  return isRecord(value) && value.type === "text" && typeof value.text === "string" ? value.text : undefined;
}

function requireRecord(value: unknown, description: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new GroupXError("PROTOCOL_INVALID_MESSAGE", `ACP ${description} must be an object`);
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  return structuredClone(value);
}
