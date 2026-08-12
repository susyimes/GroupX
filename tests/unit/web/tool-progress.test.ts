import { describe, expect, it } from "vitest";

import {
  describeToolProgress,
  mergeToolProgressSnapshot
} from "../../../web/tool-progress.js";

describe("tool progress presentation", () => {
  it("uses a stable call id and a compact tool label", () => {
    expect(
      describeToolProgress({
        nativeType: "tool.started",
        toolCallId: "call-1",
        details: { server: "groupx", tool: "memory_search", status: "in_progress" }
      })
    ).toEqual({
      keyPart: "call-1",
      label: "groupx.memory_search",
      status: "运行中",
      tone: "running"
    });
  });

  it("maps completed and failed terminal updates", () => {
    expect(describeToolProgress({ nativeType: "tool.completed", details: { title: "Shell" } })).toMatchObject({
      label: "Shell",
      status: "已完成",
      tone: "success"
    });
    expect(describeToolProgress({ details: { title: "Shell", status: "failed" } })).toMatchObject({
      status: "失败",
      tone: "danger"
    });
  });

  it("uses a localized fallback for a generic MCP item type", () => {
    expect(describeToolProgress({ nativeType: "tool.completed", details: { itemType: "mcpToolCall" } })).toMatchObject({
      label: "工具调用",
      status: "已完成"
    });
  });

  it("keeps start metadata when completion only supplies status", () => {
    const merged = mergeToolProgressSnapshot(
      { toolCallId: "call-2", details: { name: "run_terminal", kind: "execute" } },
      { nativeType: "tool.completed", details: { status: "completed" } }
    );
    expect(merged).toEqual({
      toolCallId: "call-2",
      nativeType: "tool.completed",
      details: { name: "run_terminal", kind: "execute", status: "completed" }
    });
    expect(describeToolProgress(merged)).toMatchObject({
      keyPart: "call-2",
      label: "run_terminal",
      status: "已完成"
    });
  });
});
