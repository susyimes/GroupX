import path from "node:path";

import { describe, expect, it } from "vitest";

import { AdapterRegistry } from "../../src/adapters/registry.js";
import type {
  AdapterHealth,
  AdapterId,
  CancelResult,
  CapabilityReport,
  CliAdapter,
  LaunchProfile,
  NativeEvent,
  NativeSession,
  PromptInput
} from "../../src/adapters/types.js";
import {
  AgentSessionManager,
  type ManagedAgentId,
  type SessionManagerOptions
} from "../../src/app/session-manager.js";
import { GroupXError } from "../../src/core/errors.js";
import { McpBindingRegistry } from "../../src/mcp/binding-registry.js";
import { SqliteGroupXStore } from "../../src/storage/sqlite-store.js";

class FakeAdapter implements CliAdapter {
  readonly starts: LaunchProfile[] = [];
  readonly resumes: Array<LaunchProfile & { nativeSessionId: string }> = [];
  readonly closes: NativeSession[] = [];
  failStart = false;
  failStartsRemaining = 0;
  failResume = false;
  hangClose = false;

  constructor(
    readonly adapterId: ManagedAgentId,
    readonly actorId: string
  ) {}

  async probe(): Promise<CapabilityReport> {
    return {
      adapterId: this.adapterId,
      launchArgvShape: [],
      findings: [],
      generatedAt: new Date(0).toISOString()
    };
  }

  async start(input: LaunchProfile): Promise<NativeSession> {
    this.starts.push(input);
    if (this.failStartsRemaining > 0) {
      this.failStartsRemaining -= 1;
      throw new GroupXError("ADAPTER_START_FAILED", "temporary fixture start failure");
    }
    if (this.failStart) throw new GroupXError("ADAPTER_START_FAILED", "fixture start failed");
    return this.session(input, input.mcp ? `native:${this.adapterId}` : undefined);
  }

  async resume(input: LaunchProfile & { nativeSessionId: string }): Promise<NativeSession> {
    this.resumes.push(input);
    if (this.failStart || this.failResume) {
      throw new GroupXError("ADAPTER_START_FAILED", "fixture resume failed");
    }
    return this.session(input, input.nativeSessionId);
  }

  async *prompt(
    _session: NativeSession,
    _input: PromptInput
  ): AsyncIterable<NativeEvent> {
    return;
  }

  async cancel(_session: NativeSession, _nativeTurnId: string): Promise<CancelResult> {
    return { requested: true, supported: true, terminalObserved: false };
  }

  async close(session: NativeSession): Promise<void> {
    this.closes.push(session);
    if (this.hangClose) await new Promise<void>(() => undefined);
  }

  health(): AdapterHealth {
    return {
      adapterId: this.adapterId,
      status: "ready",
      nativeSessionAvailable: true,
      updatedAt: new Date(0).toISOString()
    };
  }

  private session(input: LaunchProfile, nativeSessionId: string | undefined): NativeSession {
    return {
      adapterId: this.adapterId,
      actorId: this.actorId,
      instanceId: input.instanceId!,
      bindingId: input.bindingId!,
      ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
      protocol: input.mcp ? (this.adapterId === "codex" ? "codex-app-server-stdio-jsonrpc-v2" : "acp") : "direct-jsonl",
      startedAt: new Date(0).toISOString()
    };
  }
}

function fixture(transport: "direct" | "structured") {
  const store = new SqliteGroupXStore(":memory:");
  const registry = new AdapterRegistry();
  const adapters = {
    codex: new FakeAdapter("codex", "agent:codex"),
    grok: new FakeAdapter("grok", "agent:grok"),
    kimi: new FakeAdapter("kimi", "agent:kimi")
  };
  for (const adapter of Object.values(adapters)) registry.register(adapter);
  let sequence = 0;
  const config: SessionManagerOptions["config"] = {
    transport,
    agents: {
      codex: agentConfig("codex"),
      grok: agentConfig("grok"),
      kimi: agentConfig("kimi")
    },
    timeouts: {
      handshakeMs: 100,
      requestMs: 100,
      firstEventMs: 100,
      idleMs: 100,
      cancelMs: 100,
      closeMs: 25,
      askMs: 100
    }
  };
  const bindings = new McpBindingRegistry();
  const manager = new AgentSessionManager({
    config,
    store,
    adapters: registry,
    mcpBindings: bindings,
    idFactory(kind, agentId) {
      sequence += 1;
      return `${kind}:${agentId}:${sequence}`;
    }
  });
  return { store, registry, adapters, config, bindings, manager };
}

function agentConfig(agentId: ManagedAgentId) {
  return {
    driver: agentId as "codex" | "grok" | "kimi",
    command: {
      executable: process.execPath,
      prefixArgs: [path.resolve(`fixture-${agentId}.mjs`)]
    },
    cwd: path.resolve(`workspace-${agentId}`),
    enabled: true
  };
}

describe("AgentSessionManager lifecycle", () => {
  it("preallocates structured bindings and forwards the loopback MCP endpoint", async () => {
    const f = fixture("structured");
    try {
      f.manager.setStructuredMcpUrl("http://127.0.0.1:4310/mcp");
      const sessions = await f.manager.startAll();

      expect(sessions).toHaveLength(3);
      expect(f.manager.state).toBe("ready");
      for (const [agentId, adapter] of Object.entries(f.adapters) as Array<
        [ManagedAgentId, FakeAdapter]
      >) {
        expect(adapter.starts).toHaveLength(1);
        expect(adapter.starts[0]).toMatchObject({
          command: process.execPath,
          prefixArgs: [path.resolve(`fixture-${agentId}.mjs`)],
          cwd: path.resolve(`workspace-${agentId}`),
          mcp: {
            transport: "streamable-http",
            url: "http://127.0.0.1:4310/mcp"
          }
        });
        const session = f.manager.resolve({ actorId: adapter.actorId, adapterId: agentId });
        expect(f.store.getAgentInstance(session.instanceId)?.status).toBe("ready");
        expect(f.store.getSessionBinding(session.bindingId)?.status).toBe("ready");
        expect(f.bindings.require(session.bindingId)).toMatchObject({
          actorId: adapter.actorId,
          status: "ready"
        });
      }

      await f.manager.close();
      expect(f.manager.state).toBe("closed");
      for (const session of sessions) {
        expect(f.store.getAgentInstance(session.instanceId)?.status).toBe("stopped");
        expect(f.store.getSessionBinding(session.bindingId)?.status).toBe("closed");
        expect(() => f.bindings.require(session.bindingId)).toThrow(/closed/u);
      }
    } finally {
      await f.manager.close().catch(() => undefined);
      f.store.close();
    }
  });

  it("derives a structured resume plan after stale-record recovery", async () => {
    const first = fixture("structured");
    try {
      first.manager.setStructuredMcpUrl("http://127.0.0.1:4310/mcp");
      await first.manager.startAll();

      // Simulate a process loss: a new manager owns the same still-open records.
      const nextRegistry = new AdapterRegistry();
      const nextAdapters = {
        codex: new FakeAdapter("codex", "agent:codex"),
        grok: new FakeAdapter("grok", "agent:grok"),
        kimi: new FakeAdapter("kimi", "agent:kimi")
      };
      for (const adapter of Object.values(nextAdapters)) nextRegistry.register(adapter);
      let sequence = 100;
      const next = new AgentSessionManager({
        config: first.config,
        store: first.store,
        adapters: nextRegistry,
        mcpBindings: new McpBindingRegistry(),
        idFactory(kind, agentId) {
          sequence += 1;
          return `${kind}:${agentId}:${sequence}`;
        }
      });
      const recovery = next.prepareRecovery();
      expect(recovery.stale.agentInstances).toHaveLength(3);
      expect(recovery.stale.sessionBindings).toHaveLength(3);
      expect(recovery.nativeSessionIds).toEqual({
        codex: "native:codex",
        grok: "native:grok",
        kimi: "native:kimi"
      });
      next.setStructuredMcpUrl("http://127.0.0.1:4310/mcp");
      await next.startAll({ nativeSessionIds: recovery.nativeSessionIds });
      expect(nextAdapters.codex.resumes[0]?.nativeSessionId).toBe("native:codex");
      expect(nextAdapters.grok.resumes[0]?.nativeSessionId).toBe("native:grok");
      expect(nextAdapters.kimi.resumes[0]?.nativeSessionId).toBe("native:kimi");
      await next.close();
    } finally {
      // The first manager represents the lost owner; do not let it rewrite the
      // new records, but release its fake in-memory state before closing SQLite.
      await first.manager.close().catch(() => undefined);
      first.store.close();
    }
  });

  it("keeps direct transport global, resumes hints, and persists a late session id", async () => {
    const f = fixture("direct");
    try {
      expect(() => f.manager.setStructuredMcpUrl("http://127.0.0.1:4310/mcp")).toThrowError(
        expect.objectContaining({ code: "TRANSPORT_MODE_MISMATCH" })
      );
      f.manager.prepareRecovery();
      await f.manager.startAll({
        nativeSessionIds: { codex: "must-not-resume", grok: "must-not-resume" }
      });
      expect(f.adapters.codex.resumes[0]?.nativeSessionId).toBe("must-not-resume");
      expect(f.adapters.grok.resumes[0]?.nativeSessionId).toBe("must-not-resume");
      expect(f.adapters.kimi.starts).toHaveLength(1);
      for (const adapter of Object.values(f.adapters)) {
        expect(adapter.starts[0]?.mcp ?? adapter.resumes[0]?.mcp).toBeUndefined();
      }

      const kimi = f.manager.get("agent:kimi")!;
      expect(kimi.nativeSessionId).toBeUndefined();
      kimi.nativeSessionId = "native:kimi:learned-after-first-turn";
      f.manager.syncNativeSession(kimi.bindingId);
      expect(f.store.getSessionBinding(kimi.bindingId)?.nativeSessionId).toBe(
        "native:kimi:learned-after-first-turn"
      );
    } finally {
      await f.manager.close().catch(() => undefined);
      f.store.close();
    }
  });

  it("starts a fresh same-transport session when a persisted native resume hint is stale", async () => {
    const f = fixture("structured");
    try {
      f.adapters.codex.failResume = true;
      f.manager.setStructuredMcpUrl("http://127.0.0.1:4310/mcp");
      const sessions = await f.manager.startAll({
        nativeSessionIds: { codex: "native:stale-empty-thread" }
      });

      expect(f.adapters.codex.resumes).toHaveLength(3);
      expect(f.adapters.codex.starts).toHaveLength(1);
      expect(sessions.find((session) => session.actorId === "agent:codex")?.nativeSessionId).toBe(
        "native:codex"
      );
      const codexBinding = f.store
        .listSessionBindings()
        .find((binding) => binding.actorId === "agent:codex" && binding.status === "ready");
      expect(codexBinding?.capabilities).toMatchObject({
        transport: "structured",
        continuity: "new_session_after_resume_failure"
      });
    } finally {
      await f.manager.close().catch(() => undefined);
      f.store.close();
    }
  });

  it("rolls back previously started sessions when one Agent fails", async () => {
    const f = fixture("structured");
    try {
      f.adapters.grok.failStart = true;
      f.manager.setStructuredMcpUrl("http://127.0.0.1:4310/mcp");
      await expect(f.manager.startAll()).rejects.toMatchObject({ code: "ADAPTER_START_FAILED" });
      expect(f.manager.state).toBe("idle");
      expect(f.adapters.codex.closes).toHaveLength(1);
      expect(f.adapters.kimi.starts).toHaveLength(0);
      expect(f.store.listSessionBindings().every((binding) => binding.closedAt !== undefined)).toBe(
        true
      );
      expect(
        f.store.listSessionBindings().some((binding) => binding.status === "failed")
      ).toBe(true);
    } finally {
      await f.manager.close().catch(() => undefined);
      f.store.close();
    }
  });

  it("retries a transient session start failure with bounded backoff", async () => {
    const store = new SqliteGroupXStore(":memory:");
    const registry = new AdapterRegistry();
    const adapters = {
      codex: new FakeAdapter("codex", "agent:codex"),
      grok: new FakeAdapter("grok", "agent:grok"),
      kimi: new FakeAdapter("kimi", "agent:kimi")
    };
    for (const adapter of Object.values(adapters)) registry.register(adapter);
    const bindings = new McpBindingRegistry();
    const config: SessionManagerOptions["config"] = {
      transport: "structured",
      agents: {
        codex: agentConfig("codex"),
        grok: agentConfig("grok"),
        kimi: agentConfig("kimi")
      },
      timeouts: {
        handshakeMs: 100, requestMs: 100, firstEventMs: 100, idleMs: 100,
        cancelMs: 100, closeMs: 25, askMs: 100
      }
    };
    const progress: Array<{ phase: string; agentId: string; attempt: number }> = [];
    const manager = new AgentSessionManager({
      config,
      store,
      adapters: registry,
      mcpBindings: bindings,
      startAttempts: 2,
      retryBaseMs: 1,
      onProgress(event) {
        progress.push({ phase: event.phase, agentId: event.agentId, attempt: event.attempt });
      },
      idFactory: (() => {
        let sequence = 1_000;
        return (kind, agentId) => `${kind}:${agentId}:${sequence++}`;
      })()
    });
    adapters.codex.failStartsRemaining = 1;
    try {
      manager.setStructuredMcpUrl("http://127.0.0.1:4310/mcp");
      await manager.startAll();
      expect(adapters.codex.starts).toHaveLength(2);
      expect(progress.filter((event) => event.agentId === "codex").slice(0, 3)).toEqual([
        { phase: "starting", agentId: "codex", attempt: 1 },
        { phase: "retrying", agentId: "codex", attempt: 1 },
        { phase: "starting", agentId: "codex", attempt: 2 }
      ]);
    } finally {
      await manager.close().catch(() => undefined);
      store.close();
    }
  });
});
