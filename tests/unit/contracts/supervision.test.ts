import { describe, expect, it } from "vitest";

import {
  ContractValidationError,
  parseCreateMessageRequest,
  parseMcpSendInput,
  parseMcpSteerInput,
  parseMcpWatchInput
} from "../../../src/contracts/index.js";

function expectContractCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ContractValidationError);
    expect((error as ContractValidationError).code).toBe(code);
    return;
  }
  throw new Error(`Expected contract error ${code}`);
}

describe("supervision request contracts", () => {
  it("accepts a live_steer pair when observers do not overlap workers", () => {
    expect(
      parseCreateMessageRequest({
        clientCommandId: "web-supervise-1",
        to: ["agent:codex"],
        content: "review this",
        supervision: { observers: ["agent:grok", "agent:kimi"], mode: "live_steer" }
      })
    ).toMatchObject({
      to: ["agent:codex"],
      supervision: { observers: ["agent:grok", "agent:kimi"], mode: "live_steer" }
    });
  });

  it("rejects an observer that is also a worker and rejects a self-reported from field", () => {
    expectContractCode(
      () =>
        parseCreateMessageRequest({
          clientCommandId: "web-supervise-overlap",
          to: ["agent:codex"],
          content: "review this",
          supervision: { observers: ["agent:codex"], mode: "live_steer" }
        }),
      "INVALID_ENVELOPE"
    );
    expectContractCode(
      () =>
        parseCreateMessageRequest({
          clientCommandId: "web-supervise-from",
          to: ["agent:codex"],
          content: "review this",
          from: "agent:grok",
          supervision: { observers: ["agent:grok"], mode: "live_steer" }
        }),
      "SENDER_FIELD_FORBIDDEN"
    );
  });

  it("rejects unknown observers and caller-supplied steer provenance", () => {
    expectContractCode(
      () =>
        parseCreateMessageRequest({
          clientCommandId: "web-supervise-unknown",
          to: ["agent:codex"],
          content: "review this",
          supervision: { observers: ["agent:not-registered"], mode: "live_steer" }
        }),
      "UNKNOWN_TARGET"
    );
    expectContractCode(
      () =>
        parseMcpSteerInput({
          action: "interrupt",
          reason: "stop",
          content: "change course",
          clientCommandId: "steer-1",
          from: "agent:grok"
        }),
      "SENDER_FIELD_FORBIDDEN"
    );
    expect(parseMcpWatchInput({ until: "terminal" })).toEqual({ until: "terminal" });
  });

  it("accepts supervision on member send and rejects overlapping observers", () => {
    expect(
      parseMcpSendInput({
        clientCommandId: "mcp-supervise-1",
        to: ["agent:codex"],
        content: "review this",
        supervision: { observers: ["agent:grok"], mode: "live_steer" }
      })
    ).toMatchObject({
      to: ["agent:codex"],
      supervision: { observers: ["agent:grok"], mode: "live_steer" }
    });
    expectContractCode(
      () =>
        parseMcpSendInput({
          clientCommandId: "mcp-supervise-overlap",
          to: ["agent:codex"],
          content: "review this",
          supervision: { observers: ["agent:codex"], mode: "live_steer" }
        }),
      "INVALID_ENVELOPE"
    );
  });
});
