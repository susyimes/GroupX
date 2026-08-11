import { describe, expect, it } from "vitest";
import { IdentityBindingRegistry } from "../../../src/core/identity-binding.js";

describe("IdentityBindingRegistry", () => {
  it("derives actor identity from the binding and rejects attempted actor forgery", () => {
    const registry = new IdentityBindingRegistry();
    const binding = registry.create({
      bindingId: "binding:codex:1",
      actorId: "agent:codex",
      adapterId: "codex",
      instanceId: "codex/main@1",
      nativeSessionId: "native-session-1"
    });

    expect(registry.resolveActor(binding.bindingId)).toBe("agent:codex");
    expect(() => registry.assertActor(binding.bindingId, "agent:grok")).toThrowError(
      expect.objectContaining({ code: "MCP_BINDING_MISMATCH" })
    );
    expect(registry.resolveActor(binding.bindingId)).toBe("agent:codex");
  });

  it("returns defensive copies so callers cannot mutate a stored identity", () => {
    const registry = new IdentityBindingRegistry();
    const returned = registry.create({
      bindingId: "binding:kimi:1",
      actorId: "agent:kimi",
      adapterId: "kimi",
      instanceId: "kimi/main@1"
    });

    returned.actorId = "agent:grok";
    returned.status = "closed";

    expect(registry.require("binding:kimi:1")).toMatchObject({
      actorId: "agent:kimi",
      status: "active"
    });

    const required = registry.require("binding:kimi:1");
    required.actorId = "agent:codex";
    expect(registry.resolveActor("binding:kimi:1")).toBe("agent:kimi");
  });

  it("makes a closed binding permanently inactive", () => {
    const registry = new IdentityBindingRegistry();
    registry.create({
      bindingId: "binding:grok:1",
      actorId: "agent:grok",
      adapterId: "grok",
      instanceId: "grok/main@1"
    });

    const closed = registry.close("binding:grok:1");

    expect(closed).toMatchObject({ status: "closed", actorId: "agent:grok" });
    expect(closed.closedAt).toEqual(expect.any(String));
    expect(registry.list("agent:grok")).toEqual([closed]);
    expect(() => registry.require("binding:grok:1")).toThrowError(
      expect.objectContaining({ code: "MCP_BINDING_MISMATCH" })
    );
    expect(() => registry.resolveActor("binding:grok:1")).toThrowError(
      expect.objectContaining({ code: "MCP_BINDING_MISMATCH" })
    );
    expect(() => registry.close("binding:grok:1")).toThrowError(
      expect.objectContaining({ code: "MCP_BINDING_MISMATCH" })
    );
  });

  it("rejects duplicate and unknown binding identifiers", () => {
    const registry = new IdentityBindingRegistry();
    registry.create({
      bindingId: "binding:fixed",
      actorId: "agent:codex",
      adapterId: "codex",
      instanceId: "codex/main@1"
    });

    expect(() =>
      registry.create({
        bindingId: "binding:fixed",
        actorId: "agent:grok",
        adapterId: "grok",
        instanceId: "grok/main@1"
      })
    ).toThrowError(expect.objectContaining({ code: "STORE_CONFLICT" }));
    expect(() => registry.require("binding:unknown")).toThrowError(
      expect.objectContaining({ code: "MCP_BINDING_MISMATCH" })
    );
  });
});
