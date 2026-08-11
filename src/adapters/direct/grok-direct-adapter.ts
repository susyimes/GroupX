import { boundDiagnosticText } from "../../observability/diagnostics.js";
import type { CapabilityFinding, LaunchProfile } from "../types.js";
import {
  DirectCliAdapter,
  type DirectCliAdapterOptions,
  type DirectTurnLaunch
} from "./direct-cli-adapter.js";
import { isRecord, stringField, type DirectProjection } from "./protocol.js";

const GROK_UNRESTRICTED_PREFIX = [
  "--no-auto-update",
  "--permission-mode",
  "bypassPermissions",
  "--sandbox",
  "off",
  "--no-plan"
] as const;

export interface GrokDirectAdapterOptions extends DirectCliAdapterOptions {}

/** @deprecated Direct has no runtime entry or active Gate; use GrokAcpAdapter. */
export class GrokDirectAdapter extends DirectCliAdapter {
  constructor(options: GrokDirectAdapterOptions = {}) {
    super("grok", "agent:grok", { version: "1.0.0", ...options });
  }

  protected override launchArgvShape(resume: boolean): string[] {
    return [
      "<command>",
      "<prefixArgs...>",
      ...GROK_UNRESTRICTED_PREFIX,
      ...(resume ? ["--resume", "<nativeSessionId>"] : []),
      "--output-format",
      "streaming-json",
      "--single",
      "<prompt>"
    ];
  }

  protected override capabilityFindings(): CapabilityFinding[] {
    return [
      finding("transport.lifecycle", "deprecated", "Direct is retained for compatibility only; Structured is the active release transport"),
      finding("access.unrestricted", "documented", "bypassPermissions + sandbox off + no-plan are fixed per process"),
      finding("output.jsonl", "advertised", "--output-format streaming-json emits typed JSONL"),
      finding("session.resume", "advertised", "--resume accepts an explicit session id"),
      finding("mcp.current_turn", "unsupported", "Direct one-shot mode does not attach GroupX MCP"),
      finding("live compatibility", "not_observed", "Adapter fixtures do not claim a real model turn")
    ];
  }

  protected override buildTurnLaunch(input: {
    profile: Pick<LaunchProfile, "command" | "prefixArgs" | "cwd" | "instanceId" | "bindingId">;
    promptText: string;
    nativeSessionId?: string;
  }): DirectTurnLaunch {
    return buildGrokDirectLaunch(input.profile, input.promptText, input.nativeSessionId);
  }

  protected override projectMessage(value: unknown): DirectProjection[] {
    return projectGrokDirectMessage(value);
  }
}

export function buildGrokDirectLaunch(
  profile: Pick<LaunchProfile, "command" | "prefixArgs">,
  promptText: string,
  nativeSessionId?: string
): DirectTurnLaunch {
  return {
    argv: [
      profile.command,
      ...(profile.prefixArgs ?? []),
      ...GROK_UNRESTRICTED_PREFIX,
      ...(nativeSessionId === undefined ? [] : ["--resume", nativeSessionId]),
      "--output-format",
      "streaming-json",
      "--single",
      promptText
    ]
  };
}

export function projectGrokDirectMessage(value: unknown): DirectProjection[] {
  if (!isRecord(value)) return [];
  const type = stringField(value, "type");
  if (type === undefined) return [];
  const nativeEventId = stringField(value, "id", "requestId", "toolCallId");
  switch (type) {
    case "text": {
      const text = extractText(value);
      return text === undefined ? [] : [event("content.delta", { text }, nativeEventId)];
    }
    case "thought": {
      const text = extractText(value);
      return text === undefined ? [] : [event("reasoning.delta", { text }, nativeEventId)];
    }
    case "tool_call":
      return [event("tool.started", grokToolProjection(value), nativeEventId)];
    case "tool_call_update": {
      const status = stringField(value, "status");
      return [
        event(
          status !== undefined && ["completed", "failed", "cancelled"].includes(status)
            ? "tool.completed"
            : "tool.started",
          grokToolProjection(value),
          nativeEventId
        )
      ];
    }
    case "end": {
      const projections: DirectProjection[] = [];
      const nativeSessionId = stringField(value, "sessionId", "session_id");
      if (nativeSessionId !== undefined) projections.push({ kind: "session", nativeSessionId });
      const stopReason = stringField(value, "stopReason", "stop_reason") ?? "end";
      const status = /cancel/i.test(stopReason) ? "cancelled" : /fail|error/i.test(stopReason) ? "failed" : "completed";
      projections.push({
        kind: "terminal",
        status,
        payload: {
          stopReason,
          ...(stringField(value, "requestId", "request_id") === undefined
            ? {}
            : { requestId: stringField(value, "requestId", "request_id") })
        }
      });
      return projections;
    }
    case "error":
      return [{ kind: "terminal", status: "failed", payload: errorProjection(value) }];
    case "permission_request":
    case "approval_request":
    case "question_request":
      return [{ kind: "native_interaction", detail: `Unexpected Grok Direct interaction: ${type}` }];
    default:
      return [];
  }
}

function extractText(value: Record<string, unknown>): string | undefined {
  const direct = stringField(value, "data", "text", "content", "delta");
  if (direct !== undefined) return direct;
  if (isRecord(value.data)) {
    const nestedData = stringField(value.data, "text", "content", "delta");
    if (nestedData !== undefined) return nestedData;
  }
  const message = value.message;
  return isRecord(message) ? stringField(message, "text", "content") : undefined;
}

function event(
  type: "content.delta" | "reasoning.delta" | "tool.started" | "tool.completed",
  payload: unknown,
  nativeEventId?: string
): DirectProjection {
  return { kind: "event", type, payload, ...(nativeEventId === undefined ? {} : { nativeEventId }) };
}

function grokToolProjection(value: Record<string, unknown>): Record<string, unknown> {
  const projected: Record<string, unknown> = {};
  for (const key of ["id", "toolCallId", "name", "title", "kind", "status"] as const) {
    if (Object.hasOwn(value, key)) projected[key] = structuredClone(value[key]);
  }
  return projected;
}

function errorProjection(value: Record<string, unknown>): Record<string, unknown> {
  return {
    type: "error",
    ...(stringField(value, "code") === undefined ? {} : { code: stringField(value, "code") }),
    ...(stringField(value, "message", "error", "detail") === undefined
      ? {}
      : { message: boundDiagnosticText(stringField(value, "message", "error", "detail")!, 512) })
  };
}

function finding(
  capability: string,
  level: CapabilityFinding["level"],
  detail: string
): CapabilityFinding {
  return { capability, level, detail };
}
