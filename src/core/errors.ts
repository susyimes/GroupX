export const GROUPX_ERROR_CODES = [
  "ADAPTER_NOT_FOUND",
  "ADAPTER_START_FAILED",
  "PROTOCOL_HANDSHAKE_TIMEOUT",
  "PROTOCOL_INVALID_MESSAGE",
  "SESSION_NOT_AVAILABLE",
  "NATIVE_RESUME_UNSUPPORTED",
  "MCP_UNAVAILABLE",
  "TURN_FIRST_EVENT_TIMEOUT",
  "TURN_IDLE_TIMEOUT",
  "TURN_CANCEL_TIMEOUT",
  "TURN_INTERRUPTED",
  "UNEXPECTED_NATIVE_INTERACTION",
  "NATIVE_POLICY_BLOCKED",
  "MCP_BINDING_MISMATCH",
  "STORE_UNAVAILABLE",
  "STORE_CONFLICT",
  "CLIENT_COMMAND_CONFLICT",
  "TRANSPORT_MODE_MISMATCH",
  "CONTEXT_BUDGET_EXCEEDED",
  "INVALID_ENVELOPE",
  "UNKNOWN_ACTOR",
  "UNKNOWN_TARGET",
  "SENDER_FIELD_FORBIDDEN",
  "DUPLICATE_DISPATCH",
  "CAUSAL_CYCLE",
  "ROOT_TURN_LIMIT_REACHED",
  "HOP_LIMIT_REACHED",
  "QUEUE_CAPACITY_REACHED",
  "MESSAGE_TOO_LARGE",
  "ASK_TIMEOUT"
] as const;

export type GroupXErrorCode = (typeof GROUPX_ERROR_CODES)[number];

export class GroupXError extends Error {
  readonly code: GroupXErrorCode;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: GroupXErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "GroupXError";
    this.code = code;
    this.details = details;
  }
}

export function toGroupXError(error: unknown, fallback: GroupXErrorCode = "STORE_UNAVAILABLE"): GroupXError {
  if (error instanceof GroupXError) {
    return error;
  }
  if (error instanceof Error) {
    return new GroupXError(fallback, error.message, undefined, { cause: error });
  }
  return new GroupXError(fallback, String(error));
}
