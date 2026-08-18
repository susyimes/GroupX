import { z } from "zod";

import {
  GROUPX_ERROR_CODES,
  GroupXError,
  type GroupXErrorCode
} from "../core/errors.js";
import {
  CursorParameterSchema,
  DEFAULT_KNOWN_TARGETS,
  FORBIDDEN_WRITE_FIELDS,
  NonNegativeIntegerSchema
} from "./common.js";

export const INTERNAL_ERROR_CODE = "INTERNAL_ERROR" as const;

export const SafeValidationIssueSchema = z.strictObject({
  path: z.string().max(512),
  code: z.string().max(64)
});

export const SafeErrorDetailsSchema = z.strictObject({
  forbiddenFields: z.array(z.string().max(64)).max(FORBIDDEN_WRITE_FIELDS.length).optional(),
  unknownTargets: z.array(z.string().max(256)).max(32).optional(),
  issues: z.array(SafeValidationIssueSchema).max(20).optional()
});

export const SafeErrorCodeSchema = z.enum([...GROUPX_ERROR_CODES, INTERNAL_ERROR_CODE]);

export const SafeErrorBodySchema = z.strictObject({
  error: z.strictObject({
    code: SafeErrorCodeSchema,
    message: z.string().min(1).max(256),
    correlationId: z.string().min(1).max(256).optional(),
    details: SafeErrorDetailsSchema.optional()
  })
});

export type SafeErrorDetails = z.infer<typeof SafeErrorDetailsSchema>;
export type SafeErrorBody = z.infer<typeof SafeErrorBodySchema>;

const PUBLIC_ERROR_MESSAGES: Readonly<Partial<Record<GroupXErrorCode, string>>> = {
  INVALID_ENVELOPE: "The request does not match the GroupX contract.",
  UNKNOWN_ACTOR: "The requested actor is not registered.",
  UNKNOWN_TARGET: "One or more message targets are not registered.",
  MCP_UNAVAILABLE: "GroupX MCP is not available for the selected agent transport or capability.",
  SENDER_FIELD_FORBIDDEN: "Sender and provenance fields are assigned by GroupX.",
  CLIENT_COMMAND_CONFLICT: "The client command id was already used with a different payload.",
  TRANSPORT_MODE_MISMATCH:
    "The Turn was created for a different agent transport mode.",
  MESSAGE_TOO_LARGE: "The message content exceeds the allowed size.",
  UNEXPECTED_NATIVE_INTERACTION:
    "The native agent requested an interactive response despite GroupX unrestricted mode.",
  NATIVE_POLICY_BLOCKED: "A native policy blocked unrestricted agent execution.",
  MCP_BINDING_MISMATCH: "The MCP caller binding is not valid for this request.",
  STORE_UNAVAILABLE: "GroupX storage is temporarily unavailable.",
  STEER_LIMIT_REACHED: "This watched turn has reached its steer limit.",
  SUPERVISION_WATCH_REQUIRED: "watch and steer are only available on a supervision watch turn.",
  SUPERVISION_STEER_REQUIRED: "Redirect a watched worker with steer, not send or ask.",
  SUPERVISION_PAIR_INVALID: "The supervision pair is missing or not valid for this caller."
};

function publicMessage(code: GroupXErrorCode | typeof INTERNAL_ERROR_CODE): string {
  if (code === INTERNAL_ERROR_CODE) {
    return "An internal GroupX error occurred.";
  }
  return PUBLIC_ERROR_MESSAGES[code] ?? "The GroupX operation could not be completed.";
}

export class ContractValidationError extends GroupXError {
  readonly safeDetails: SafeErrorDetails | undefined;

  constructor(code: GroupXErrorCode, safeDetails?: SafeErrorDetails, options?: ErrorOptions) {
    super(code, publicMessage(code), safeDetails, options);
    this.name = "ContractValidationError";
    this.safeDetails = safeDetails;
  }
}

function summarizeZodError(error: z.ZodError): SafeErrorDetails {
  return {
    issues: error.issues.slice(0, 20).map((issue) => ({
      path: issue.path.map(String).join("."),
      code: issue.code
    }))
  };
}

function isMessageTooLarge(error: z.ZodError): boolean {
  return error.issues.some(
    (issue) => issue.code === "too_big" && issue.path.at(-1) === "content"
  );
}

function findForbiddenWriteFields(input: unknown): string[] {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return [];
  }

  return FORBIDDEN_WRITE_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(input, field)
  );
}

export function parseWriteRequest<TSchema extends z.ZodType>(
  schema: TSchema,
  input: unknown
): z.output<TSchema> {
  const forbiddenFields = findForbiddenWriteFields(input);
  if (forbiddenFields.length > 0) {
    throw new ContractValidationError("SENDER_FIELD_FORBIDDEN", { forbiddenFields });
  }

  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ContractValidationError(
      isMessageTooLarge(result.error) ? "MESSAGE_TOO_LARGE" : "INVALID_ENVELOPE",
      summarizeZodError(result.error),
      { cause: result.error }
    );
  }
  return result.data;
}

export function parseContractOutput<TSchema extends z.ZodType>(
  schema: TSchema,
  input: unknown
): z.output<TSchema> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new ContractValidationError("INVALID_ENVELOPE", summarizeZodError(result.error), {
      cause: result.error
    });
  }
  return result.data;
}

export interface KnownTargetOptions {
  readonly knownTargets?: ReadonlySet<string> | readonly string[] | ((target: string) => boolean);
}

function targetPredicate(options?: KnownTargetOptions): (target: string) => boolean {
  const configured = options?.knownTargets;
  if (typeof configured === "function") {
    return configured;
  }
  const targets = new Set(configured ?? DEFAULT_KNOWN_TARGETS);
  return (target) => targets.has(target);
}

export function assertKnownTargets(
  targets: readonly string[],
  options?: KnownTargetOptions
): void {
  const isKnown = targetPredicate(options);
  const unknownTargets = targets.filter((target) => !isKnown(target));
  if (unknownTargets.length > 0) {
    throw new ContractValidationError("UNKNOWN_TARGET", { unknownTargets });
  }
}

export function parseCursorParameter(input: unknown): number {
  const result = CursorParameterSchema.safeParse(input);
  if (!result.success) {
    throw new ContractValidationError("INVALID_ENVELOPE", summarizeZodError(result.error), {
      cause: result.error
    });
  }
  return result.data;
}

export function parseLastEventId(input: unknown): number | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (typeof input !== "string") {
    throw new ContractValidationError("INVALID_ENVELOPE", {
      issues: [{ path: "Last-Event-ID", code: "invalid_type" }]
    });
  }
  return parseCursorParameter(input);
}

export function resolveEventCursor(input: {
  readonly afterSeq?: unknown;
  readonly lastEventId?: unknown;
}): number {
  const lastEventId = parseLastEventId(input.lastEventId);
  if (lastEventId !== undefined) {
    return lastEventId;
  }
  if (input.afterSeq === undefined) {
    return 0;
  }
  return parseCursorParameter(input.afterSeq);
}

export function toSafeErrorBody(error: unknown, correlationId?: string): SafeErrorBody {
  const code = error instanceof GroupXError ? error.code : INTERNAL_ERROR_CODE;
  const details = error instanceof ContractValidationError ? error.safeDetails : undefined;

  const body: SafeErrorBody = {
    error: {
      code,
      message: publicMessage(code),
      ...(correlationId === undefined ? {} : { correlationId }),
      ...(details === undefined ? {} : { details })
    }
  };
  return SafeErrorBodySchema.parse(body);
}

export function httpStatusForErrorCode(
  code: GroupXErrorCode | typeof INTERNAL_ERROR_CODE
): number {
  switch (code) {
    case "SENDER_FIELD_FORBIDDEN":
    case "INVALID_ENVELOPE":
    case "SUPERVISION_PAIR_INVALID":
    case "SUPERVISION_WATCH_REQUIRED":
    case "SUPERVISION_STEER_REQUIRED":
    case "STEER_LIMIT_REACHED":
      return 400;
    case "UNKNOWN_ACTOR":
    case "UNKNOWN_TARGET":
      return 404;
    case "CLIENT_COMMAND_CONFLICT":
    case "TRANSPORT_MODE_MISMATCH":
      return 409;
    case "MESSAGE_TOO_LARGE":
      return 413;
    case "STORE_UNAVAILABLE":
    case "NATIVE_POLICY_BLOCKED":
    case "MCP_UNAVAILABLE":
      return 503;
    default:
      return 500;
  }
}

export function assertNonNegativeCursor(value: unknown): number {
  return parseContractOutput(NonNegativeIntegerSchema, value);
}
