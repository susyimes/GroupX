import { describe, expect, it, vi } from "vitest";

import { ActiveTurnCoordinator } from "../../src/app/turn-lifecycle.js";
import type { ActiveBrokerTurnContext } from "../../src/broker/types.js";
import type { ToolCallerContext } from "../../src/mcp/server/broker-api.js";

const context: ActiveBrokerTurnContext = {
  bindingId: "binding:codex",
  turnId: "turn:1",
  rootCorrelationId: "corr:root",
  hopCount: 4
};

function caller(): ToolCallerContext {
  return {
    bindingId: "binding:codex",
    actorId: "agent:codex",
    instanceId: "instance:codex",
    activeGroupxTurnId: "turn:1",
    mcpRequestId: "request:1",
    signal: new AbortController().signal
  };
}

function fixture(transport: "direct" | "structured") {
  const setActiveTurn = vi.fn();
  const clearActiveTurn = vi.fn();
  const syncNativeSession = vi.fn();
  const coordinator = new ActiveTurnCoordinator({
    transport,
    bindings: { setActiveTurn, clearActiveTurn },
    sessions: { syncNativeSession }
  });
  return { coordinator, setActiveTurn, clearActiveTurn, syncNativeSession };
}

describe("ActiveTurnCoordinator", () => {
  it("keeps complete structured causality and releases it after native session sync", () => {
    const f = fixture("structured");

    f.coordinator.activate(context);
    expect(f.coordinator.requireForCaller(caller())).toEqual(context);
    expect(f.setActiveTurn).toHaveBeenCalledWith("binding:codex", "turn:1");

    f.coordinator.deactivate(context);
    expect(f.syncNativeSession).toHaveBeenCalledWith("binding:codex");
    expect(f.clearActiveTurn).toHaveBeenCalledWith("binding:codex", "turn:1");
    expect(f.coordinator.get("binding:codex")).toBeUndefined();
  });

  it("keeps Direct lifecycle continuity but rejects current-turn tools as unavailable", () => {
    const f = fixture("direct");

    f.coordinator.activate(context);
    expect(() => f.coordinator.requireForCaller(caller())).toThrowError(
      expect.objectContaining({ code: "MCP_UNAVAILABLE" })
    );
    f.coordinator.deactivate(context);

    expect(f.setActiveTurn).not.toHaveBeenCalled();
    expect(f.clearActiveTurn).not.toHaveBeenCalled();
    expect(f.syncNativeSession).toHaveBeenCalledWith("binding:codex");
  });
});
