import { boundDiagnosticText } from "../../observability/diagnostics.js";
import type { NativeEvent } from "../types.js";

export type DirectProjectedEventType = Extract<
  NativeEvent["type"],
  "content.delta" | "reasoning.delta" | "tool.started" | "tool.completed"
>;

export type DirectTerminalStatus = "completed" | "cancelled" | "failed";

export type DirectProjection =
  | {
      kind: "event";
      type: DirectProjectedEventType;
      payload: unknown;
      nativeEventId?: string;
    }
  | { kind: "session"; nativeSessionId: string }
  | { kind: "terminal"; status: DirectTerminalStatus; payload?: unknown }
  | { kind: "native_interaction"; detail: string }
  | { kind: "native_policy_blocked"; detail: string };

const INTERACTION_TYPES = new Set([
  "approval.requested",
  "approval_requested",
  "permission.requested",
  "permission_requested",
  "request_user_input",
  "user_input_requested",
  "elicitation.requested",
  "elicitation_requested",
  "question.requested",
  "question_requested"
]);

const POLICY_PATTERNS = [
  /always-approve[^\r\n]{0,160}(?:disabled|blocked|refused)[^\r\n]{0,80}managed policy/i,
  /(?:disabled|blocked|refused)[^\r\n]{0,80}managed policy[^\r\n]{0,160}always-approve/i,
  /bypassPermissions[^\r\n]{0,160}(?:disabled|blocked|ignored)[^\r\n]{0,80}managed policy/i,
  /managed (?:requirements|policy)[^\r\n]{0,160}(?:approval|sandbox|dangerFullAccess|yolo)[^\r\n]{0,160}(?:not allowed|disabled|blocked|denied)/i,
  /managed policy fail-closed gate:[^\r\n]{0,240}refusing session\b/i,
  /refus(?:e|ed|ing)(?:\s+to)?\s+(?:start|resume|create)?\s*(?:the\s+)?session[^\r\n]{0,160}managed policy[^\r\n]{0,160}(?:bypass|always-approve|permission mode)/i,
  /permission(?: rule)?[^\r\n]{0,120}(?:explicitly )?den(?:y|ied|ies)[^\r\n]{0,120}(?:policy|rule)/i,
  /tool[^\r\n]{0,240}was denied by permission (?:rule|policy)\b/i
] as const;

/**
 * Detects only explicit protocol request shapes. It deliberately does not scan
 * assistant/model text, so a normal answer mentioning approvals is harmless.
 */
export function classifyStructuredInteraction(
  value: unknown
): Extract<DirectProjection, { kind: "native_interaction" }> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const type = stringField(value, "type", "event", "eventType")?.toLowerCase();
  const method = stringField(value, "method")?.toLowerCase();
  if (type !== undefined && INTERACTION_TYPES.has(type)) {
    return {
      kind: "native_interaction",
      detail: boundDiagnosticText(`Unexpected native interaction event: ${type}`, 512)
    };
  }
  if (
    method !== undefined &&
    (method.includes("requestapproval") ||
      method.includes("request_permission") ||
      method.includes("request_user_input") ||
      method.includes("elicitation"))
  ) {
    return {
      kind: "native_interaction",
      detail: boundDiagnosticText(`Unexpected native interaction request: ${method}`, 512)
    };
  }
  return undefined;
}

/** Uses bounded native diagnostics only; ordinary assistant content is excluded. */
export function classifyNativePolicyDiagnostic(
  text: string
): Extract<DirectProjection, { kind: "native_policy_blocked" }> | undefined {
  if (text.length === 0 || !POLICY_PATTERNS.some((pattern) => pattern.test(text))) {
    return undefined;
  }
  return {
    kind: "native_policy_blocked",
    detail: boundDiagnosticText(text, 512)
  };
}

export function diagnosticFields(value: unknown): string {
  if (!isRecord(value)) {
    return "";
  }
  const parts: string[] = [];
  for (const key of ["code", "errorCode", "message", "detail", "error", "reason"] as const) {
    const field = value[key];
    if (typeof field === "string" && field.length > 0) {
      parts.push(field);
    } else if (isRecord(field)) {
      const nested = stringField(field, "code", "message", "detail", "reason");
      if (nested !== undefined) {
        parts.push(nested);
      }
    }
  }
  return boundDiagnosticText(parts.join(" | "), 1_024);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringField(
  value: Record<string, unknown>,
  ...names: readonly string[]
): string | undefined {
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}
