import { describe, expect, it } from "vitest";

import { pendingConfiguredAgents } from "../../../web/agent-roster.js";

describe("pendingConfiguredAgents", () => {
  it("projects a newly saved enabled agent without replacing the active runtime roster", () => {
    const pending = pendingConfiguredAgents(
      {
        config: {
          agents: [
            { id: "codex", name: "Codex", cwd: "D:/GroupX", enabled: true },
            { id: "reviewer", name: "Review Agent", cwd: "D:/Review", enabled: true }
          ]
        }
      },
      new Set(["agent:codex"])
    );

    expect(pending).toEqual([
      {
        actorId: "agent:reviewer",
        displayName: "Review Agent",
        status: "pending_restart",
        cwd: "D:/Review",
        enabled: true,
        capabilities: []
      }
    ]);
  });

  it("ignores disabled, malformed, duplicate and already active entries", () => {
    const pending = pendingConfiguredAgents(
      {
        config: {
          agents: [
            { id: "codex", enabled: true },
            { id: "disabled", enabled: false },
            { id: "bad id", enabled: true },
            { id: "new-agent", name: "", cwd: ".", enabled: true },
            { id: "new-agent", name: "Latest", cwd: "D:/Latest", enabled: true }
          ]
        }
      },
      new Set(["agent:codex"])
    );

    expect(pending).toEqual([
      expect.objectContaining({
        actorId: "agent:new-agent",
        displayName: "Latest",
        cwd: "D:/Latest"
      })
    ]);
  });

  it("fails closed to an empty projection for an invalid setup response", () => {
    expect(pendingConfiguredAgents({ config: { agents: "invalid" } }, new Set())).toEqual([]);
  });
});
