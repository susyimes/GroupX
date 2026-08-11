import { describe, expect, it } from "vitest";

import { GroupXError } from "../../../src/core/errors.js";
import {
  MAX_MESSAGE_CONTENT_LENGTH,
  ContractValidationError,
  canonicalContractHash,
  parseCreateMessageRequest,
  parseCreateMessageAccepted,
  parseCancelTurnResult,
  parseLastEventId,
  parseMcpSendInput,
  httpStatusForErrorCode,
  resolveEventCursor,
  toSafeErrorBody
} from "../../../src/contracts/index.js";

function expectContractCode(run: () => unknown, code: string): ContractValidationError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ContractValidationError);
    expect((error as ContractValidationError).code).toBe(code);
    return error as ContractValidationError;
  }
  throw new Error(`Expected contract error ${code}`);
}

const WEB_MESSAGE = {
  clientCommandId: "web-command-1",
  to: ["agent:codex", "agent:grok"],
  content: "review this"
} as const;

describe("message sender and routing contracts", () => {
  it("P-003 rejects a Web sender field instead of trusting it", () => {
    expectContractCode(
      () => parseCreateMessageRequest({ ...WEB_MESSAGE, from: "agent:grok" }),
      "SENDER_FIELD_FORBIDDEN"
    );
  });

  it.each(["from", "actor", "eventId", "provenance"])(
    "explicitly rejects forbidden write field %s",
    (field) => {
      expectContractCode(
        () => parseCreateMessageRequest({ ...WEB_MESSAGE, [field]: "untrusted" }),
        "SENDER_FIELD_FORBIDDEN"
      );
    }
  );

  it("P-002 rejects an MCP caller attempting to claim another sender", () => {
    expectContractCode(
      () =>
        parseMcpSendInput({
          clientCommandId: "mcp-command-1",
          to: ["agent:kimi"],
          content: "hello",
          from: "agent:grok"
        }),
      "SENDER_FIELD_FORBIDDEN"
    );
  });

  it("P-008 rejects unknown targets before the Broker handles the request", () => {
    const error = expectContractCode(
      () =>
        parseCreateMessageRequest({
          ...WEB_MESSAGE,
          to: ["agent:codex", "agent:not-registered"]
        }),
      "UNKNOWN_TARGET"
    );
    expect(error.safeDetails).toEqual({ unknownTargets: ["agent:not-registered"] });
  });

  it("rejects duplicate per-target acceptance results", () => {
    expectContractCode(
      () =>
        parseCreateMessageAccepted({
          messageEventId: "evt_1",
          correlationId: "corr_1",
          turns: [
            { target: "agent:grok", turnId: "turn_1", status: "queued" },
            { target: "agent:grok", turnId: "turn_2", status: "queued" }
          ]
        }),
      "INVALID_ENVELOPE"
    );
  });

  it("supports an injected registry for later adapters without weakening validation", () => {
    const parsed = parseCreateMessageRequest(
      { ...WEB_MESSAGE, to: ["agent:reviewer"] },
      { knownTargets: new Set(["agent:reviewer"]) }
    );
    expect(parsed.to).toEqual(["agent:reviewer"]);
  });

  it("requires a non-empty unique target set", () => {
    expectContractCode(
      () => parseCreateMessageRequest({ ...WEB_MESSAGE, to: [] }),
      "INVALID_ENVELOPE"
    );
    expectContractCode(
      () => parseCreateMessageRequest({ ...WEB_MESSAGE, to: ["agent:grok", "agent:grok"] }),
      "INVALID_ENVELOPE"
    );
  });

  it("applies the shared 32768 character content boundary", () => {
    const accepted = parseCreateMessageRequest({
      ...WEB_MESSAGE,
      content: "x".repeat(MAX_MESSAGE_CONTENT_LENGTH)
    });
    expect(accepted.content).toHaveLength(MAX_MESSAGE_CONTENT_LENGTH);

    expectContractCode(
      () =>
        parseCreateMessageRequest({
          ...WEB_MESSAGE,
          content: "x".repeat(MAX_MESSAGE_CONTENT_LENGTH + 1)
        }),
      "MESSAGE_TOO_LARGE"
    );
  });
});

describe("cursor and idempotency input boundaries", () => {
  it("accepts only non-negative safe-integer cursors and Last-Event-ID values", () => {
    expect(parseLastEventId(undefined)).toBeUndefined();
    expect(parseLastEventId("0")).toBe(0);
    expect(parseLastEventId("0012")).toBe(12);
    expect(resolveEventCursor({ afterSeq: "7", lastEventId: "12" })).toBe(12);
    expect(resolveEventCursor({ afterSeq: 7 })).toBe(7);

    for (const invalid of ["-1", "1.5", "", " 1", "9007199254740992", -1, 1.5, ["1"]]) {
      expectContractCode(() => parseLastEventId(invalid), "INVALID_ENVELOPE");
    }
  });

  it("normalizes recipient order and null reply fields for stable command hashing", () => {
    const first = parseCreateMessageRequest({
      ...WEB_MESSAGE,
      to: ["agent:grok", "agent:codex"],
      replyToEventId: null
    });
    const retry = parseCreateMessageRequest({ ...WEB_MESSAGE });

    expect(first.to).toEqual(["agent:codex", "agent:grok"]);
    expect(canonicalContractHash(first)).toBe(canonicalContractHash(retry));
  });

  it("keeps payload changes visible to CLIENT_COMMAND_CONFLICT handling", () => {
    const first = parseCreateMessageRequest(WEB_MESSAGE);
    const conflicting = parseCreateMessageRequest({ ...WEB_MESSAGE, content: "different" });
    expect(first.clientCommandId).toBe(conflicting.clientCommandId);
    expect(canonicalContractHash(first)).not.toBe(canonicalContractHash(conflicting));
  });

  it("does not accept caller supplied canonical or binding fields", () => {
    expectContractCode(
      () => parseCreateMessageRequest({ ...WEB_MESSAGE, canonicalHash: "chosen-by-client" }),
      "INVALID_ENVELOPE"
    );
    expectContractCode(
      () => parseMcpSendInput({ ...WEB_MESSAGE, sourceBindingId: "binding:spoof" }),
      "INVALID_ENVELOPE"
    );
  });

  it("serializes validation failures without echoing request values or raw causes", () => {
    const secret = "sk-secret-value-that-must-not-leak";
    const error = expectContractCode(
      () => parseCreateMessageRequest({ ...WEB_MESSAGE, extra: secret }),
      "INVALID_ENVELOPE"
    );
    const body = toSafeErrorBody(error, "corr_safe");
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("extra");
    expect(body.error.correlationId).toBe("corr_safe");
  });
});

describe("unrestricted native failure contracts", () => {
  it("publishes stable non-approval error codes without exposing native details", () => {
    const interaction = toSafeErrorBody(
      new GroupXError(
        "UNEXPECTED_NATIVE_INTERACTION",
        "native requestUserInput payload contained a secret"
      )
    );
    const blocked = toSafeErrorBody(
      new GroupXError("NATIVE_POLICY_BLOCKED", "enterprise policy details")
    );

    expect(interaction.error).toEqual({
      code: "UNEXPECTED_NATIVE_INTERACTION",
      message: "The native agent requested an interactive response despite GroupX unrestricted mode."
    });
    expect(blocked.error).toEqual({
      code: "NATIVE_POLICY_BLOCKED",
      message: "A native policy blocked unrestricted agent execution."
    });
    expect(httpStatusForErrorCode("UNEXPECTED_NATIVE_INTERACTION")).toBe(500);
    expect(httpStatusForErrorCode("NATIVE_POLICY_BLOCKED")).toBe(503);
  });

  it("reports a persisted Turn transport mismatch as a stable conflict", () => {
    const body = toSafeErrorBody(
      new GroupXError(
        "TRANSPORT_MODE_MISMATCH",
        "queued Turn uses structured while runtime is direct"
      )
    );

    expect(body.error).toEqual({
      code: "TRANSPORT_MODE_MISMATCH",
      message: "The Turn was created for a different agent transport mode."
    });
    expect(httpStatusForErrorCode("TRANSPORT_MODE_MISMATCH")).toBe(409);
  });

  it("distinguishes unavailable GroupX MCP capability from session availability", () => {
    const body = toSafeErrorBody(
      new GroupXError("MCP_UNAVAILABLE", "adapter capability probe was not verified")
    );

    expect(body.error).toEqual({
      code: "MCP_UNAVAILABLE",
      message: "GroupX MCP is not available for the selected agent transport or capability."
    });
    expect(body.error.code).not.toBe("SESSION_NOT_AVAILABLE");
    expect(httpStatusForErrorCode("MCP_UNAVAILABLE")).toBe(503);
  });
});

describe("cancel Turn response contract", () => {
  it.each(["completed", "failed", "cancelled", "interrupted"] as const)(
    "accepts idempotent cancellation of an already-%s Turn",
    (status) => {
      expect(
        parseCancelTurnResult({
          turnId: "turn_1",
          accepted: false,
          status
        })
      ).toEqual({
        turnId: "turn_1",
        accepted: false,
        status
      });
    }
  );

  it.each([
    "queued",
    "dispatching",
    "running",
    "cancelling",
    "completed",
    "failed",
    "cancelled",
    "interrupted"
  ] as const)("preserves the canonical %s status after accepting cancellation", (status) => {
    expect(parseCancelTurnResult({ turnId: "turn_2", accepted: true, status })).toEqual({
      turnId: "turn_2",
      accepted: true,
      status
    });
  });

  it("rejects internally inconsistent or extended cancellation results", () => {
    for (const invalid of [
      { turnId: "turn_3", accepted: false, status: "queued" },
      { turnId: "turn_3", accepted: false, status: "cancelling" },
      { turnId: "turn_3", accepted: true, status: "terminal" },
      { turnId: "turn_3", accepted: true, status: "queued", futureField: true }
    ]) {
      expectContractCode(() => parseCancelTurnResult(invalid), "INVALID_ENVELOPE");
    }
  });
});
