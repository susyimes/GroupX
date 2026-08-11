import { boundDiagnosticText } from "../../observability/diagnostics.js";
import type { CapabilityFinding, LaunchProfile } from "../types.js";
import {
  DirectCliAdapter,
  type DirectCliAdapterOptions,
  type DirectTurnLaunch
} from "./direct-cli-adapter.js";
import {
  isRecord,
  stringField,
  type DirectProjection
} from "./protocol.js";

const CODEX_UNRESTRICTED_PREFIX = ["--yolo", "--dangerously-bypass-hook-trust"] as const;

export interface CodexDirectAdapterOptions extends DirectCliAdapterOptions {}

/** @deprecated Direct has no runtime entry or active Gate; use CodexAppServerAdapter. */
export class CodexDirectAdapter extends DirectCliAdapter {
  constructor(options: CodexDirectAdapterOptions = {}) {
    super("codex", "agent:codex", { version: "0.147.0", ...options });
  }

  protected override launchArgvShape(resume: boolean): string[] {
    return [
      "<command>",
      "<prefixArgs...>",
      ...CODEX_UNRESTRICTED_PREFIX,
      "exec",
      ...(resume ? ["resume", "--json", "<nativeSessionId>", "-"] : ["--json", "-"])
    ];
  }

  protected override capabilityFindings(): CapabilityFinding[] {
    return [
      finding("transport.lifecycle", "deprecated", "Direct is retained for compatibility only; Structured is the active release transport"),
      finding("access.unrestricted", "documented", "--yolo disables approvals and the Codex sandbox; hook trust bypass is explicit"),
      finding("output.jsonl", "documented", "codex exec --json emits newline-delimited structured events"),
      finding("session.resume", "advertised", "codex exec resume accepts an explicit thread/session id"),
      finding("mcp.current_turn", "unsupported", "Direct one-shot mode does not attach GroupX MCP"),
      finding("live compatibility", "not_observed", "Adapter fixtures do not claim a real model turn")
    ];
  }

  protected override buildTurnLaunch(input: {
    profile: Pick<LaunchProfile, "command" | "prefixArgs" | "cwd" | "instanceId" | "bindingId">;
    promptText: string;
    nativeSessionId?: string;
  }): DirectTurnLaunch {
    return buildCodexDirectLaunch(input.profile, input.promptText, input.nativeSessionId);
  }

  protected override projectMessage(value: unknown): DirectProjection[] {
    return projectCodexDirectMessage(value);
  }
}

export function buildCodexDirectLaunch(
  profile: Pick<LaunchProfile, "command" | "prefixArgs">,
  promptText: string,
  nativeSessionId?: string
): DirectTurnLaunch {
  const fixed = [
    profile.command,
    ...(profile.prefixArgs ?? []),
    ...CODEX_UNRESTRICTED_PREFIX,
    "exec",
    ...(nativeSessionId === undefined ? ["--json", "-"] : ["resume", "--json", nativeSessionId, "-"])
  ] as [string, ...string[]];
  return { argv: fixed, stdinText: promptText };
}

export function projectCodexDirectMessage(value: unknown): DirectProjection[] {
  if (!isRecord(value)) return [];
  const type = stringField(value, "type");
  if (type === undefined) return [];

  switch (type) {
    case "thread.started": {
      const nativeSessionId = stringField(value, "thread_id", "threadId", "session_id", "sessionId");
      return nativeSessionId === undefined ? [] : [{ kind: "session", nativeSessionId }];
    }
    case "turn.started":
      return [];
    case "turn.completed":
      return [{ kind: "terminal", status: "completed", payload: terminalProjection(value) }];
    case "turn.failed":
      return [{ kind: "terminal", status: "failed", payload: terminalProjection(value) }];
    case "error":
      // Codex may emit a recoverable/reconnect diagnostic and later complete
      // the same turn. Exit status or an explicit turn.failed remains terminal.
      return [];
    case "item.started":
    case "item.updated":
    case "item.completed":
      return projectCodexItem(type, value.item);
    default:
      return [];
  }
}

function projectCodexItem(containerType: string, raw: unknown): DirectProjection[] {
  if (!isRecord(raw)) return [];
  const itemType = stringField(raw, "type") ?? "unknown";
  const nativeEventId = stringField(raw, "id", "item_id", "itemId");
  if (
    /(?:approval|permission|elicitation|user_input|question)/i.test(itemType) &&
    /(?:request|pending|prompt)/i.test(itemType)
  ) {
    return [{
      kind: "native_interaction",
      detail: `Unexpected Codex Direct interaction item: ${boundDiagnosticText(itemType, 256)}`
    }];
  }

  if (itemType === "agent_message" && containerType === "item.completed") {
    const text = stringField(raw, "text", "content");
    return text === undefined
      ? []
      : [{ kind: "event", type: "content.delta", payload: { text }, ...(nativeEventId === undefined ? {} : { nativeEventId }) }];
  }
  if (itemType === "reasoning" && containerType === "item.completed") {
    const text = stringField(raw, "text", "content");
    return text === undefined
      ? []
      : [{ kind: "event", type: "reasoning.delta", payload: { text }, ...(nativeEventId === undefined ? {} : { nativeEventId }) }];
  }
  if (isToolItem(itemType)) {
    const eventType = containerType === "item.completed" ? "tool.completed" : "tool.started";
    return [{
      kind: "event",
      type: eventType,
      payload: toolProjection(raw),
      ...(nativeEventId === undefined ? {} : { nativeEventId })
    }];
  }
  return [];
}

function isToolItem(type: string): boolean {
  return [
    "command_execution",
    "file_change",
    "mcp_tool_call",
    "web_search",
    "image_view",
    "todo_list"
  ].includes(type);
}

function toolProjection(item: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const key of ["id", "type", "status", "server", "tool", "exit_code"] as const) {
    if (Object.hasOwn(item, key)) projected[key] = structuredClone(item[key]);
  }
  return projected;
}

function terminalProjection(value: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const key of ["type", "usage", "error", "message"] as const) {
    if (Object.hasOwn(value, key)) projected[key] = structuredClone(value[key]);
  }
  return projected;
}

function finding(
  capability: string,
  level: CapabilityFinding["level"],
  detail: string
): CapabilityFinding {
  return { capability, level, detail };
}
