import { isAbsolute } from "node:path";

import { GroupXError } from "../../core/errors.js";
import type { LaunchProfile, McpBindingLaunchSpec, NativeEvent } from "../types.js";

/** Claude Code's first-party structured stdio surface (`--print` + stream-json). */
export const CLAUDE_PROTOCOL = "claude-cli-stream-json-v1";
export const GROUPX_MCP_SERVER_NAME = "groupx";

/**
 * The single unrestricted permission mode GroupX requires. It is applied through
 * process argv only; Claude Code's own settings files are never written.
 */
export const CLAUDE_UNRESTRICTED_PERMISSION_MODE = "bypassPermissions";

/** Fixed product argv appended after the resolved command and launcher prefix. */
export const CLAUDE_BASE_ARGV = [
  "--print",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--permission-mode",
  CLAUDE_UNRESTRICTED_PERMISSION_MODE
] as const;

export interface ClaudeMcpServerConfig {
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
}

export interface ClaudeMcpConfig {
  mcpServers: Record<typeof GROUPX_MCP_SERVER_NAME, ClaudeMcpServerConfig>;
}

/**
 * Projection of the deferred `system`/`init` frame. The native frame also lists
 * the user's tools, MCP servers, skills, plugins, and memory paths; GroupX
 * keeps only the fields its session-identity and access checks need.
 */
export interface ClaudeInit {
  sessionId: string;
  permissionMode: string;
  cwd: string;
  version: string | undefined;
}

/**
 * Projection of the `initialize` control response.
 *
 * The native payload also carries account, organization, model, plugin, and
 * command inventories. GroupX collects only the fields its access contract
 * needs; everything else stays outside GroupX records and diagnostics.
 */
export interface ClaudeHandshake {
  permissionMode: string;
  pid: number | undefined;
}

export interface ClaudeControlResponse {
  requestId: string;
  ok: boolean;
  payload: Record<string, unknown> | undefined;
  error: string | undefined;
}

export type ClaudeTerminalKind = "completed" | "cancelled" | "failed";

export interface ClaudeResult {
  kind: ClaudeTerminalKind;
  subtype: string;
  terminalReason: string | undefined;
  isError: boolean;
  stopReason: string | undefined;
  /** Native HTTP status for an API failure. The CLI emits it as an integer. */
  apiErrorStatus: number | undefined;
  numTurns: number | undefined;
  usage: unknown;
}

export interface ClaudeControlRequest {
  requestId: string;
  subtype: string;
  /** True when the request asks the client to make an interactive decision. */
  interactive: boolean;
}

export interface ClaudeLaunchOptions {
  /** Preassigned id for a new session. Mutually exclusive with `resumeSessionId`. */
  sessionId?: string;
  /** Existing native session id to resume. Mutually exclusive with `sessionId`. */
  resumeSessionId?: string;
  mcp?: McpBindingLaunchSpec | undefined;
  bindingId?: string | undefined;
}

/**
 * Stable process argv for Claude Code 2.1 stream-json stdio. No model, sandbox,
 * or other native policy argument is accepted from configuration; the adapter
 * owns every argument after the launcher prefix.
 */
export function buildClaudeLaunchArgv(
  command: string,
  prefixArgs: readonly string[] = [],
  options: ClaudeLaunchOptions = {}
): readonly [string, ...string[]] {
  requireNonEmpty(command, "command");
  const prefix = prefixArgs.map((argument, index) => requireNonEmpty(argument, `prefixArgs[${index}]`));

  if (options.sessionId !== undefined && options.resumeSessionId !== undefined) {
    throw new TypeError("Claude launch accepts either sessionId or resumeSessionId, not both");
  }

  const argv: string[] = [...prefix, ...CLAUDE_BASE_ARGV];

  const mcpConfig = buildClaudeMcpConfig(options.mcp, options.bindingId);
  if (mcpConfig !== undefined) {
    argv.push("--mcp-config", JSON.stringify(mcpConfig));
  }

  if (options.resumeSessionId !== undefined) {
    argv.push("--resume", requireSessionId(options.resumeSessionId, "resumeSessionId"));
  } else if (options.sessionId !== undefined) {
    argv.push("--session-id", requireSessionId(options.sessionId, "sessionId"));
  }

  return [command, ...argv];
}

/**
 * Build the one GroupX-owned Claude MCP fragment. It is passed as argv and
 * merges with the user's own servers; a binding id is a source correlation
 * handle, not an authentication token or permission grant.
 */
export function buildClaudeMcpConfig(
  mcp: McpBindingLaunchSpec | undefined,
  bindingId: string | undefined
): ClaudeMcpConfig | undefined {
  if (mcp === undefined) {
    return undefined;
  }
  if (bindingId === undefined || bindingId.length === 0) {
    throw new GroupXError(
      "MCP_BINDING_MISMATCH",
      "MCP-enabled Claude sessions require a Broker-preassigned bindingId"
    );
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
    return {
      mcpServers: {
        [GROUPX_MCP_SERVER_NAME]: {
          type: "stdio",
          command: mcp.command,
          args: [...mcp.args, "--binding", bindingId]
        }
      }
    };
  }

  if (mcp.url.length === 0) {
    throw new TypeError("Invalid GroupX MCP HTTP URL");
  }
  return {
    mcpServers: {
      [GROUPX_MCP_SERVER_NAME]: {
        type: "http",
        url: mcp.url,
        headers: { "X-GroupX-Binding": bindingId }
      }
    }
  };
}

export function buildClaudeUserMessage(input: {
  content: string;
  contextPacket?: string | undefined;
}): Record<string, unknown> {
  const text =
    input.contextPacket === undefined || input.contextPacket.length === 0
      ? input.content
      : `${input.contextPacket}\n\n[current_message]\n${input.content}`;
  return {
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] }
  };
}

export function buildClaudeInterruptRequest(requestId: string): Record<string, unknown> {
  requireNonEmpty(requestId, "requestId");
  return { type: "control_request", request_id: requestId, request: { subtype: "interrupt" } };
}

/**
 * The SDK control handshake. Claude Code emits its `system`/`init` frame only
 * after the first user message, so this is the one exchange that proves the
 * native process is alive without consuming a model turn. The reported
 * current_permission_mode is observational; unrestricted is established by
 * set_permission_mode.
 */
export function buildClaudeInitializeRequest(requestId: string): Record<string, unknown> {
  requireNonEmpty(requestId, "requestId");
  return { type: "control_request", request_id: requestId, request: { subtype: "initialize" } };
}

export function buildClaudeSetPermissionModeRequest(requestId: string): Record<string, unknown> {
  requireNonEmpty(requestId, "requestId");
  return {
    type: "control_request",
    request_id: requestId,
    request: { subtype: "set_permission_mode", mode: CLAUDE_UNRESTRICTED_PERMISSION_MODE }
  };
}

export function parseClaudeHandshake(payload: Record<string, unknown> | undefined): ClaudeHandshake {
  const permissionMode = payload === undefined ? undefined : optionalString(payload.current_permission_mode);
  if (permissionMode === undefined) {
    throw new GroupXError(
      "PROTOCOL_INVALID_MESSAGE",
      "Claude initialize control response is missing current_permission_mode"
    );
  }
  return {
    permissionMode,
    pid: payload !== undefined && typeof payload.pid === "number" ? payload.pid : undefined
  };
}

export function parseClaudeSetPermissionModeResult(payload: Record<string, unknown> | undefined): string {
  const mode = payload === undefined ? undefined : optionalString(payload.mode);
  if (mode === undefined) {
    throw new GroupXError(
      "PROTOCOL_INVALID_MESSAGE",
      "Claude set_permission_mode control response is missing mode"
    );
  }
  return mode;
}

/**
 * GroupX has no approval subsystem. Any interactive request is answered with a
 * protocol-level denial so the native process cannot stay blocked, and the Turn
 * fails separately with `UNEXPECTED_NATIVE_INTERACTION`.
 */
export function buildClaudeDenyPermissionResponse(requestId: string): Record<string, unknown> {
  requireNonEmpty(requestId, "requestId");
  return {
    type: "control_response",
    response: {
      subtype: "success",
      request_id: requestId,
      response: {
        behavior: "deny",
        message: "GroupX runs Claude Code unrestricted and never answers a permission request"
      }
    }
  };
}

export function buildClaudeControlErrorResponse(requestId: string, error: string): Record<string, unknown> {
  requireNonEmpty(requestId, "requestId");
  return {
    type: "control_response",
    response: { subtype: "error", request_id: requestId, error }
  };
}

export function parseClaudeInit(value: unknown): ClaudeInit {
  const message = requireRecord(value, "system init message");
  const sessionId = optionalString(message.session_id);
  if (sessionId === undefined) {
    throw new GroupXError("PROTOCOL_INVALID_MESSAGE", "Claude init message is missing session_id");
  }
  const cwd = optionalString(message.cwd);
  if (cwd === undefined) {
    throw new GroupXError("PROTOCOL_INVALID_MESSAGE", "Claude init message is missing cwd");
  }
  const permissionMode = optionalString(message.permissionMode);
  if (permissionMode === undefined) {
    throw new GroupXError("PROTOCOL_INVALID_MESSAGE", "Claude init message is missing permissionMode");
  }

  return { sessionId, permissionMode, cwd, version: optionalString(message.claude_code_version) };
}

export function parseClaudeResult(value: unknown): ClaudeResult {
  const message = requireRecord(value, "result message");
  const subtype = optionalString(message.subtype) ?? "unknown";
  const terminalReason = optionalString(message.terminal_reason);
  const isError = message.is_error === true;

  return {
    kind: classifyClaudeResult(subtype, terminalReason, isError),
    subtype,
    terminalReason,
    isError,
    stopReason: optionalString(message.stop_reason),
    apiErrorStatus: typeof message.api_error_status === "number" ? message.api_error_status : undefined,
    numTurns: typeof message.num_turns === "number" ? message.num_turns : undefined,
    usage: message.usage
  };
}

function classifyClaudeResult(
  subtype: string,
  terminalReason: string | undefined,
  isError: boolean
): ClaudeTerminalKind {
  // Claude Code reports an accepted interrupt with one of two abort reasons
  // depending on where the turn was stopped: mid-token (`aborted_streaming`) or
  // during tool execution (`aborted_tools`). Both are cancellation settlements,
  // not turn failures.
  if (terminalReason === "aborted_streaming" || terminalReason === "aborted_tools") {
    return "cancelled";
  }
  return subtype === "success" && !isError ? "completed" : "failed";
}

/**
 * Classify a control request the native process sent to GroupX. `can_use_tool`
 * is the permission decision path and is always fatal for the current Turn.
 */
export function parseClaudeControlRequest(value: unknown): ClaudeControlRequest | undefined {
  if (!isRecord(value) || value.type !== "control_request") {
    return undefined;
  }
  const requestId = optionalString(value.request_id);
  if (requestId === undefined) {
    return undefined;
  }
  const subtype = (isRecord(value.request) ? optionalString(value.request.subtype) : undefined) ?? "unknown";
  return { requestId, subtype, interactive: INTERACTIVE_CONTROL_SUBTYPES.has(subtype) };
}

/**
 * Every CLI-to-client control request that asks GroupX to make an interactive
 * decision. The remaining native subtypes (`hook_callback`, `mcp_message`,
 * `host_auth_token_refresh`, `oauth_token_refresh`) are not decisions and are
 * answered with a protocol error instead of failing the Turn.
 */
const INTERACTIVE_CONTROL_SUBTYPES = new Set(["can_use_tool", "elicitation", "request_user_dialog"]);

export function parseClaudeControlResponse(value: unknown): ClaudeControlResponse | undefined {
  if (!isRecord(value) || value.type !== "control_response" || !isRecord(value.response)) {
    return undefined;
  }
  const response = value.response;
  const requestId = optionalString(response.request_id);
  if (requestId === undefined) {
    return undefined;
  }
  return {
    requestId,
    ok: response.subtype === "success",
    payload: isRecord(response.response) ? response.response : undefined,
    error: optionalString(response.error)
  };
}

export interface ClaudeStreamProjection {
  type: NativeEvent["type"];
  payload: Record<string, unknown>;
  nativeEventId?: string;
}

/**
 * Project one `stream_event` into a normalized GroupX event. Returns undefined
 * for frames that carry no room-visible semantics.
 */
export function normalizeClaudeStreamEvent(value: unknown): ClaudeStreamProjection | undefined {
  if (!isRecord(value) || !isRecord(value.event)) {
    return undefined;
  }
  const event = value.event;

  if (event.type === "content_block_start" && isRecord(event.content_block)) {
    const block = event.content_block;
    const toolUseId = block.type === "tool_use" ? optionalString(block.id) : undefined;
    if (toolUseId === undefined) {
      // Without an id the call cannot be correlated with its tool_result, and
      // the aggregated assistant frame would re-open it as a second start.
      return undefined;
    }
    const toolName = optionalString(block.name);
    return {
      type: "tool.started",
      payload: { toolUseId, ...(toolName === undefined ? {} : { toolName }) },
      nativeEventId: toolUseId
    };
  }

  if (event.type === "content_block_delta" && isRecord(event.delta)) {
    const delta = event.delta;
    if (delta.type === "text_delta") {
      const text = optionalString(delta.text);
      return text === undefined ? undefined : { type: "content.delta", payload: { text } };
    }
    if (delta.type === "thinking_delta") {
      const text = optionalString(delta.thinking);
      return text === undefined ? undefined : { type: "reasoning.delta", payload: { text } };
    }
    return undefined;
  }

  return undefined;
}

/**
 * Report the assistant message a `message_start` frame opens. `undefined` means
 * the frame is not a message_start; a present result with `messageId: undefined`
 * means a new message opened without an id, which must still clear the previous
 * id so its deltas are never attributed to the wrong message.
 */
export function readClaudeStreamMessageStart(value: unknown): { messageId: string | undefined } | undefined {
  if (!isRecord(value) || !isRecord(value.event) || value.event.type !== "message_start") {
    return undefined;
  }
  return {
    messageId: isRecord(value.event.message) ? optionalString(value.event.message.id) : undefined
  };
}

export interface ClaudeAssistantBlocks {
  messageId: string | undefined;
  text: string[];
  toolUses: Array<{ toolUseId: string; toolName: string | undefined }>;
}

export function readClaudeAssistantBlocks(value: unknown): ClaudeAssistantBlocks | undefined {
  if (!isRecord(value) || value.type !== "assistant" || !isRecord(value.message)) {
    return undefined;
  }
  const content = value.message.content;
  if (!Array.isArray(content)) {
    return undefined;
  }

  const text: string[] = [];
  const toolUses: ClaudeAssistantBlocks["toolUses"] = [];
  for (const block of content) {
    if (!isRecord(block)) {
      continue;
    }
    if (block.type === "text") {
      const value_ = optionalString(block.text);
      if (value_ !== undefined) {
        text.push(value_);
      }
    } else if (block.type === "tool_use") {
      const toolUseId = optionalString(block.id);
      if (toolUseId !== undefined) {
        toolUses.push({ toolUseId, toolName: optionalString(block.name) });
      }
    }
  }
  return { messageId: optionalString(value.message.id), text, toolUses };
}

export interface ClaudeToolResult {
  toolUseId: string;
  isError: boolean;
}

export function readClaudeToolResults(value: unknown): ClaudeToolResult[] {
  if (!isRecord(value) || value.type !== "user" || !isRecord(value.message)) {
    return [];
  }
  const content = value.message.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const results: ClaudeToolResult[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool_result") {
      continue;
    }
    const toolUseId = optionalString(block.tool_use_id);
    if (toolUseId !== undefined) {
      results.push({ toolUseId, isError: block.is_error === true });
    }
  }
  return results;
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

function requireSessionId(value: string, name: string): string {
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u.test(value)) {
    throw new TypeError(`${name} must be a UUID accepted by the Claude Code CLI`);
  }
  return value;
}

function requireNonEmpty(value: string, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireRecord(value: unknown, description: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new GroupXError("PROTOCOL_INVALID_MESSAGE", `Claude ${description} must be an object`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
