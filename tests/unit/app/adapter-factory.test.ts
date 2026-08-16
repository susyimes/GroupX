import { describe, expect, it } from "vitest";

import { HermesAcpAdapter } from "../../../src/adapters/acp/hermes-acp-adapter.js";
import { ClaudeCliAdapter } from "../../../src/adapters/claude/claude-cli-adapter.js";
import { createStructuredAgentAdapter } from "../../../src/app/adapter-factory.js";

const timeouts = {
  handshakeMs: 1_000,
  requestMs: 1_000,
  firstEventMs: 1_000,
  idleMs: 1_000,
  cancelMs: 1_000,
  closeMs: 1_000,
  askMs: 1_000
};

describe("structured adapter factory", () => {
  it("creates a room-local Hermes ACP adapter", () => {
    const adapter = createStructuredAgentAdapter("researcher", "hermes", timeouts);

    expect(adapter).toBeInstanceOf(HermesAcpAdapter);
    expect(adapter).toMatchObject({
      adapterId: "researcher",
      actorId: "agent:researcher"
    });
  });

  it("creates a room-local Claude stream-json adapter outside the ACP family", () => {
    const adapter = createStructuredAgentAdapter("reviewer", "claude", timeouts);

    expect(adapter).toBeInstanceOf(ClaudeCliAdapter);
    expect(adapter).toMatchObject({
      adapterId: "reviewer",
      actorId: "agent:reviewer"
    });
  });
});
