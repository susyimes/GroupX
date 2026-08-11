export type DiagnosticValue =
  | null
  | boolean
  | number
  | { type: "string"; length: number }
  | { type: "array"; length: number }
  | { type: "object"; keys: string[]; omittedKeyCount: number }
  | { type: "other"; valueType: string };

/**
 * Bounds diagnostic text without classifying or rewriting its content.
 * GroupX is not a secret scanner; token-like text remains ordinary text.
 */
export function boundDiagnosticText(input: string, maxLength = 4_096): string {
  if (!Number.isSafeInteger(maxLength) || maxLength < 0) {
    throw new RangeError("maxLength must be a non-negative safe integer");
  }
  if (input.length <= maxLength) {
    return input;
  }
  return `${input.slice(0, maxLength)}…[TRUNCATED]`;
}

/**
 * Describes an unknown native value without copying arbitrary string payloads
 * into GroupX diagnostics.
 */
export function projectDiagnosticValue(value: unknown, maxKeys = 20): DiagnosticValue {
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 0) {
    throw new RangeError("maxKeys must be a non-negative safe integer");
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    return { type: "string", length: value.length };
  }
  if (Array.isArray(value)) {
    return { type: "array", length: value.length };
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    return {
      type: "object",
      keys: keys.slice(0, maxKeys),
      omittedKeyCount: Math.max(0, keys.length - maxKeys)
    };
  }
  return { type: "other", valueType: typeof value };
}
