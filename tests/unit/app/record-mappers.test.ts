import { describe, expect, it } from "vitest";

import {
  toIdentityRecordContract,
  toMemoryRecordContract
} from "../../../src/app/record-mappers.js";
import { GroupXError } from "../../../src/core/errors.js";

describe("record mappers", () => {
  it("projects operator-authored memory and identity records", () => {
    expect(
      toMemoryRecordContract({
        memoryId: "mem_op",
        scopeType: "room",
        scopeId: "room:main",
        kind: "note",
        authorActorId: "user:assistant",
        content: "remember this",
        sourceKind: "operator",
        status: "active",
        createdAt: "2026-08-18T00:00:00.000Z"
      })
    ).toMatchObject({ sourceKind: "operator", authorActorId: "user:assistant" });

    expect(
      toIdentityRecordContract({
        identityId: "id_op",
        subjectActorId: "agent:codex",
        authorActorId: "user:assistant",
        kind: "note",
        content: "prefers evidence",
        sourceKind: "operator",
        status: "active",
        createdAt: "2026-08-18T00:00:00.000Z"
      })
    ).toMatchObject({ sourceKind: "operator", authorActorId: "user:assistant" });
  });

  it("still rejects unknown memory source kinds", () => {
    expect(() =>
      toMemoryRecordContract({
        memoryId: "mem_bad",
        scopeType: "room",
        scopeId: "room:main",
        kind: "note",
        authorActorId: "user:assistant",
        content: "no",
        sourceKind: "supervision",
        status: "active",
        createdAt: "2026-08-18T00:00:00.000Z"
      })
    ).toThrow(GroupXError);
  });
});
