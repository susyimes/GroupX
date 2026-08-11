import { describe, expect, it } from "vitest";

import {
  classifyNativePolicyDiagnostic,
  classifyStructuredInteraction,
  diagnosticFields,
  estimateWindowsCommandLineCharacters,
  projectCodexDirectMessage,
  projectGrokDirectMessage,
  projectKimiDirectMessage
} from "../../../../src/adapters/direct/index.js";

describe("Direct JSONL projections", () => {
  it("does not mistake ordinary assistant text about approval for a native interaction", () => {
    expect(
      classifyStructuredInteraction({ type: "text", content: "I discussed approval.requested in prose" })
    ).toBeUndefined();
    expect(
      projectCodexDirectMessage({
        type: "item.completed",
        item: { type: "agent_message", text: "permission requested is just text" }
      })
    ).toEqual([
      { kind: "event", type: "content.delta", payload: { text: "permission requested is just text" } }
    ]);
  });

  it("recognizes only explicit interaction and independent managed-policy diagnostics", () => {
    expect(classifyStructuredInteraction({ type: "permission.requested" })).toEqual(
      expect.objectContaining({ kind: "native_interaction" })
    );
    expect(
      classifyNativePolicyDiagnostic("always-approve enable refused: disabled by managed policy")
    ).toEqual(expect.objectContaining({ kind: "native_policy_blocked" }));
    expect(
      classifyNativePolicyDiagnostic(
        "Refusing to start session because managed policy disables the requested bypass permission mode"
      )
    ).toEqual(expect.objectContaining({ kind: "native_policy_blocked" }));
    expect(
      classifyNativePolicyDiagnostic(
        "managed policy fail-closed gate: refusing session — tamper evidence was detected"
      )
    ).toEqual(expect.objectContaining({ kind: "native_policy_blocked" }));
    expect(classifyNativePolicyDiagnostic("ordinary Windows ACL access denied")).toBeUndefined();
    expect(
      diagnosticFields({
        role: "assistant",
        content: "always-approve enable blocked by managed policy"
      })
    ).toBe("");
    expect(
      diagnosticFields({
        role: "tool",
        content: 'Tool "Shell" was denied by permission rule. Reason: configured deny'
      })
    ).toBe("");
    expect(projectKimiDirectMessage({
      role: "tool",
      tool_call_id: "tool-1",
      content: 'Tool "Shell" was denied by permission rule. Reason: configured deny'
    })).toEqual([{
      kind: "event",
      type: "tool.completed",
      payload: { toolCallId: "tool-1" },
      nativeEventId: "tool-1"
    }]);
  });

  it("projects Grok end/session and Kimi resume_hint separately", () => {
    expect(projectGrokDirectMessage({ type: "text", data: "official grok text" })).toEqual([
      { kind: "event", type: "content.delta", payload: { text: "official grok text" } }
    ]);
    expect(
      projectGrokDirectMessage({
        type: "end",
        stopReason: "end_turn",
        sessionId: "grok-session",
        requestId: "request"
      })
    ).toEqual([
      { kind: "session", nativeSessionId: "grok-session" },
      {
        kind: "terminal",
        status: "completed",
        payload: { stopReason: "end_turn", requestId: "request" }
      }
    ]);
    expect(
      projectKimiDirectMessage({
        role: "meta",
        type: "session.resume_hint",
        session_id: "kimi-session"
      })
    ).toEqual([
      { kind: "session", nativeSessionId: "kimi-session" },
      { kind: "terminal", status: "completed", payload: { sessionId: "kimi-session" } }
    ]);
  });

  it("counts Windows argv in UTF-16 code units, including quoting", () => {
    expect(estimateWindowsCommandLineCharacters(["exe", "🙂 x"])).toBe(10);
  });

  it("does not treat a recoverable Codex top-level error diagnostic as terminal", () => {
    expect(projectCodexDirectMessage({ type: "error", message: "reconnecting" })).toEqual([]);
  });
});
