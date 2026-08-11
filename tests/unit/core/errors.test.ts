import { describe, expect, it } from "vitest";

import {
  GROUPX_ERROR_CODES,
  GroupXError,
  toGroupXError
} from "../../../src/core/errors.js";

describe("GroupXError", () => {
  it("preserves its code, details, message, and cause", () => {
    const cause = new Error("native failure");
    const details = { adapter: "fake", retryable: false } as const;
    const error = new GroupXError(
      "ADAPTER_START_FAILED",
      "adapter did not start",
      details,
      { cause }
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("GroupXError");
    expect(error.code).toBe("ADAPTER_START_FAILED");
    expect(error.message).toBe("adapter did not start");
    expect(error.details).toBe(details);
    expect(error.cause).toBe(cause);
  });

  it("returns an existing GroupXError unchanged", () => {
    const original = new GroupXError("UNKNOWN_TARGET", "missing target");

    expect(toGroupXError(original, "STORE_CONFLICT")).toBe(original);
  });

  it("wraps a native Error with the requested fallback and original cause", () => {
    const original = new TypeError("malformed frame");
    const wrapped = toGroupXError(original, "PROTOCOL_INVALID_MESSAGE");

    expect(wrapped).toBeInstanceOf(GroupXError);
    expect(wrapped.code).toBe("PROTOCOL_INVALID_MESSAGE");
    expect(wrapped.message).toBe("malformed frame");
    expect(wrapped.details).toBeUndefined();
    expect(wrapped.cause).toBe(original);
  });

  it("stringifies non-Error failures and uses STORE_UNAVAILABLE by default", () => {
    const wrapped = toGroupXError(503);

    expect(wrapped.code).toBe("STORE_UNAVAILABLE");
    expect(wrapped.message).toBe("503");
    expect(wrapped.cause).toBeUndefined();
  });

  it("exports unique error codes", () => {
    expect(new Set(GROUPX_ERROR_CODES).size).toBe(GROUPX_ERROR_CODES.length);
    expect(GROUPX_ERROR_CODES).toContain("SENDER_FIELD_FORBIDDEN");
    expect(GROUPX_ERROR_CODES).toContain("INVALID_ENVELOPE");
    expect(GROUPX_ERROR_CODES).toContain("UNEXPECTED_NATIVE_INTERACTION");
    expect(GROUPX_ERROR_CODES).toContain("NATIVE_POLICY_BLOCKED");
    expect(GROUPX_ERROR_CODES).toContain("TRANSPORT_MODE_MISMATCH");
    expect(GROUPX_ERROR_CODES).toContain("MCP_UNAVAILABLE");
    expect(GROUPX_ERROR_CODES.some((code) => code.startsWith("APPROVAL_"))).toBe(false);
  });
});
