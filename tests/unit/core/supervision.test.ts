import { describe, expect, it } from "vitest";

import { GroupXError } from "../../../src/core/errors.js";
import {
  SUPERVISION_WATCH_KIND,
  buildSupervisionWatchBrief,
  excerptText,
  isSupervisionWatchMessage,
  toolNameFromDetails
} from "../../../src/core/supervision.js";

describe("supervision projection helpers", () => {
  it("builds a watch brief that is not the worker execution prompt", () => {
    const brief = buildSupervisionWatchBrief({
      task: "implement the feature",
      workers: [{ actorId: "agent:codex", turnId: "turn_worker" }],
      observers: ["agent:grok"]
    });

    expect(brief).toContain("not a second executor");
    expect(brief).toContain("implement the feature");
    expect(brief).toContain("agent:codex turn turn_worker");
    expect(brief).toContain("cannot cancel a single native tool");
    expect(brief).not.toBe("implement the feature");
  });

  it("rejects an empty pair and keeps excerpts bounded", () => {
    expect(() =>
      buildSupervisionWatchBrief({ task: "x", workers: [], observers: ["agent:grok"] })
    ).toThrow(GroupXError);
    expect(excerptText("a".repeat(600)).endsWith("…")).toBe(true);
    expect(excerptText("short")).toBe("short");
  });

  it("projects only a tool name and recognizes watch briefs", () => {
    expect(toolNameFromDetails({ name: "bash", arguments: ["rm", "-rf"] })).toBe("bash");
    expect(toolNameFromDetails({ argv: ["secret"] })).toBe("tool");
    expect(isSupervisionWatchMessage({ kind: SUPERVISION_WATCH_KIND, content: "brief" })).toBe(
      true
    );
    expect(isSupervisionWatchMessage({ content: "ordinary" })).toBe(false);
  });
});
