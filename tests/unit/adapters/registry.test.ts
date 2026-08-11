import { describe, expect, it, vi } from "vitest";
import { AdapterRegistry } from "../../../src/adapters/registry.js";
import type {
  AdapterHealth,
  CancelResult,
  CapabilityReport,
  CliAdapter,
  LaunchProfile,
  NativeEvent,
  NativeSession,
  PromptInput
} from "../../../src/adapters/types.js";

function fakeAdapter(adapterId: string, actorId: string): CliAdapter {
  const health = vi.fn<() => AdapterHealth>(() => ({
    adapterId,
    status: "ready",
    nativeSessionAvailable: true,
    updatedAt: "2026-08-11T00:00:00.000Z"
  }));

  return {
    adapterId,
    actorId,
    async probe(): Promise<CapabilityReport> {
      return {
        adapterId,
        launchArgvShape: [],
        findings: [],
        generatedAt: "2026-08-11T00:00:00.000Z"
      };
    },
    async start(_input: LaunchProfile): Promise<NativeSession> {
      return {
        adapterId,
        instanceId: `${adapterId}-instance`,
        bindingId: `${adapterId}-binding`,
        actorId,
        protocol: "fixture",
        startedAt: "2026-08-11T00:00:00.000Z"
      };
    },
    async resume(input: LaunchProfile & { nativeSessionId: string }): Promise<NativeSession> {
      return {
        adapterId,
        instanceId: `${adapterId}-instance`,
        bindingId: `${adapterId}-binding`,
        actorId,
        nativeSessionId: input.nativeSessionId,
        protocol: "fixture",
        startedAt: "2026-08-11T00:00:00.000Z"
      };
    },
    async *prompt(_session: NativeSession, _input: PromptInput): AsyncIterable<NativeEvent> {
      return;
    },
    async cancel(_session: NativeSession, _nativeTurnId: string): Promise<CancelResult> {
      return { requested: true, supported: true, terminalObserved: true };
    },
    async close(_session: NativeSession): Promise<void> {
      return;
    },
    health
  };
}

describe("AdapterRegistry", () => {
  it("indexes one adapter by both its unique adapter and actor identities", () => {
    const registry = new AdapterRegistry();
    const codex = fakeAdapter("codex", "agent:codex");
    const grok = fakeAdapter("grok", "agent:grok");

    registry.register(codex);
    registry.register(grok);

    expect(registry.get("codex")).toBe(codex);
    expect(registry.getByActor("agent:grok")).toBe(grok);
    expect(registry.hasActor("agent:codex")).toBe(true);
    expect(registry.list()).toEqual([codex, grok]);
    expect(registry.health()).toEqual([codex.health(), grok.health()]);
  });

  it("rejects a duplicate adapterId without replacing the original adapter", () => {
    const registry = new AdapterRegistry();
    const original = fakeAdapter("codex", "agent:codex");
    registry.register(original);

    expect(() => registry.register(fakeAdapter("codex", "agent:reviewer"))).toThrowError(
      expect.objectContaining({ code: "STORE_CONFLICT" })
    );
    expect(registry.get("codex")).toBe(original);
    expect(registry.hasActor("agent:reviewer")).toBe(false);
  });

  it("rejects a duplicate actorId without registering the second adapter", () => {
    const registry = new AdapterRegistry();
    const original = fakeAdapter("codex", "agent:codex");
    registry.register(original);

    expect(() => registry.register(fakeAdapter("codex-reviewer", "agent:codex"))).toThrowError(
      expect.objectContaining({ code: "STORE_CONFLICT" })
    );
    expect(registry.getByActor("agent:codex")).toBe(original);
    expect(() => registry.get("codex-reviewer")).toThrowError(
      expect.objectContaining({ code: "ADAPTER_NOT_FOUND" })
    );
  });

  it("reports explicit errors for unknown adapter and actor lookups", () => {
    const registry = new AdapterRegistry();

    expect(() => registry.get("missing")).toThrowError(
      expect.objectContaining({ code: "ADAPTER_NOT_FOUND" })
    );
    expect(() => registry.getByActor("agent:missing")).toThrowError(
      expect.objectContaining({ code: "UNKNOWN_TARGET" })
    );
  });
});
