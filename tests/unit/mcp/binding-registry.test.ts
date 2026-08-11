import { describe, expect, it } from "vitest";
import { McpBindingRegistry } from "../../../src/mcp/binding-registry.js";

describe("McpBindingRegistry", () => {
  it("resolves actor provenance from a Broker session handle", () => {
    const registry = new McpBindingRegistry();
    const context = registry.register({
      bindingId: "binding-codex",
      actorId: "agent:codex",
      instanceId: "instance-codex"
    });

    expect(context).toMatchObject({
      bindingId: "binding-codex",
      actorId: "agent:codex",
      instanceId: "instance-codex",
      status: "reserved"
    });
    expect(registry.require("binding-codex").actorId).toBe("agent:codex");
    expect(context).not.toHaveProperty("token");
  });

  it("tracks ready and closed lifecycle without authentication semantics", () => {
    const registry = new McpBindingRegistry();
    registry.register({
      bindingId: "binding-kimi",
      actorId: "agent:kimi",
      instanceId: "instance-kimi"
    });

    expect(registry.markReady("binding-kimi", "native-session")).toMatchObject({
      nativeSessionId: "native-session",
      status: "ready"
    });
    expect(() =>
      registry.register({
        bindingId: "binding-kimi",
        actorId: "agent:grok",
        instanceId: "instance-grok"
      })
    ).toThrowError(/already exists/);

    expect(registry.close("binding-kimi").status).toBe("closed");
    expect(() => registry.require("binding-kimi")).toThrowError(/Unknown or closed/);
    expect(() => registry.require("missing")).toThrowError(/Unknown or closed/);
  });

  it("binds at most one active GroupX turn to a session channel", () => {
    const registry = new McpBindingRegistry();
    registry.register({
      bindingId: "binding-grok",
      actorId: "agent:grok",
      instanceId: "instance-grok"
    });

    expect(registry.setActiveTurn("binding-grok", "turn-1").activeGroupxTurnId).toBe("turn-1");
    expect(() => registry.setActiveTurn("binding-grok", "turn-2")).toThrowError(/different active/);
    expect(() => registry.clearActiveTurn("binding-grok", "turn-2")).toThrowError(/does not match/);
    expect(registry.clearActiveTurn("binding-grok", "turn-1").activeGroupxTurnId).toBeUndefined();
  });

  it("returns defensive context copies", () => {
    const registry = new McpBindingRegistry();
    const context = registry.register({
      bindingId: "binding-copy",
      actorId: "agent:codex",
      instanceId: "instance-copy"
    });
    context.actorId = "agent:changed-by-caller";

    expect(registry.require("binding-copy").actorId).toBe("agent:codex");
  });
});
