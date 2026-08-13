import { describe, expect, it } from "vitest";

import { parseReasoningRecord } from "../../../web/reasoning-record.js";

describe("durable reasoning record presentation", () => {
  it("preserves reasoning content while projecting only its public turn linkage", () => {
    expect(
      parseReasoningRecord({
        turnId: " turn_1 ",
        content: "first thought\nsecond thought",
        terminalStatus: "completed",
        ignored: { native: "detail" }
      })
    ).toEqual({
      turnId: "turn_1",
      content: "first thought\nsecond thought"
    });
  });

  it("rejects malformed or empty durable records", () => {
    expect(parseReasoningRecord(null)).toBeNull();
    expect(parseReasoningRecord({ turnId: "turn_1", content: "   " })).toBeNull();
    expect(parseReasoningRecord({ turnId: "", content: "reasoning" })).toBeNull();
  });
});
