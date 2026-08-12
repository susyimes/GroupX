import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import { AdapterRegistry } from "../../src/adapters/registry.js";
import type {
  AdapterHealth,
  CancelResult,
  CapabilityReport,
  CliAdapter,
  LaunchProfile,
  NativeEvent,
  NativeSession,
  PromptInput
} from "../../src/adapters/types.js";
import { createAdapterRegistry } from "../../src/app/adapter-factory.js";
import { GroupXRuntime } from "../../src/app/runtime.js";
import type { GroupXConfig } from "../../src/config.js";
import { GroupXError } from "../../src/core/errors.js";
import { SqliteGroupXStore } from "../../src/storage/sqlite-store.js";

class RuntimeAdapter implements CliAdapter {
  readonly adapterId = "codex" as const;
  readonly actorId = "agent:codex";
  readonly starts: LaunchProfile[] = [];
  readonly closes: NativeSession[] = [];
  readonly prompts: PromptInput[] = [];
  mcpReachableStatus: number | undefined;
  failStart = false;

  async probe(): Promise<CapabilityReport> {
    return {
      adapterId: this.adapterId,
      launchArgvShape: [],
      findings: [],
      generatedAt: "2026-08-11T00:00:00.000Z"
    };
  }

  async start(input: LaunchProfile): Promise<NativeSession> {
    this.starts.push(input);
    if (this.failStart) throw new GroupXError("ADAPTER_START_FAILED", "fixture failed");
    if (input.mcp?.transport === "streamable-http") {
      const response = await fetch(input.mcp.url, {
        headers: { "X-GroupX-Binding": input.bindingId! }
      });
      this.mcpReachableStatus = response.status;
    }
    return this.session(input);
  }

  async resume(input: LaunchProfile & { nativeSessionId: string }): Promise<NativeSession> {
    return { ...this.session(input), nativeSessionId: input.nativeSessionId };
  }

  async *prompt(_session: NativeSession, input: PromptInput): AsyncIterable<NativeEvent> {
    this.prompts.push(input);
    yield {
      adapterId: this.adapterId,
      type: "turn.completed",
      instanceId: _session.instanceId,
      nativeTurnId: input.turnId,
      payload: {},
      occurredAt: "2026-08-11T00:00:01.000Z"
    };
  }

  async cancel(_session: NativeSession, _nativeTurnId: string): Promise<CancelResult> {
    return { requested: true, supported: true, terminalObserved: false };
  }

  async close(session: NativeSession): Promise<void> {
    this.closes.push(session);
  }

  health(): AdapterHealth {
    return {
      adapterId: this.adapterId,
      status: "ready",
      nativeSessionAvailable: true,
      updatedAt: "2026-08-11T00:00:00.000Z"
    };
  }

  private session(input: LaunchProfile): NativeSession {
    return {
      adapterId: this.adapterId,
      actorId: this.actorId,
      instanceId: input.instanceId!,
      bindingId: input.bindingId!,
      ...(input.mcp === undefined ? {} : { nativeSessionId: "native:codex" }),
      protocol:
        input.mcp === undefined
          ? "direct-jsonl"
          : "codex-app-server-stdio-jsonrpc-v2",
      startedAt: "2026-08-11T00:00:00.000Z"
    };
  }
}

function config(transport: "direct" | "structured"): GroupXConfig {
  const agent = (name: string, enabled: boolean) => ({
    driver: name as "codex" | "grok" | "kimi",
    command: {
      executable: process.execPath,
      prefixArgs: [path.resolve(`fixture-${name}.mjs`)]
    },
    cwd: path.resolve(`workspace-${name}`),
    enabled
  });
  return {
    transport,
    server: { host: "127.0.0.1", port: 4_310 },
    storage: { path: path.resolve("unused-runtime-test.db") },
    agents: {
      codex: { ...agent("codex", true), identity: "Stable Codex identity from settings" },
      grok: agent("grok", false),
      kimi: agent("kimi", false)
    },
    limits: {
      messageCharacters: 32_768,
      queuePerAgent: 64,
      rootTurns: 24,
      hopCount: 12,
      actorCallsPerRoot: 8,
      contextCharacters: 256_000,
      sseEvents: 64,
      sseBytes: 65_536
    },
    timeouts: {
      handshakeMs: 100,
      requestMs: 100,
      firstEventMs: 100,
      idleMs: 100,
      cancelMs: 100,
      closeMs: 500,
      askMs: 100
    }
  };
}

function fixture(transport: "direct" | "structured") {
  const store = new SqliteGroupXStore(":memory:");
  const adapter = new RuntimeAdapter();
  const adapters = new AdapterRegistry();
  adapters.register(adapter);
  const runtime = new GroupXRuntime(config(transport), {
    store,
    adapters,
    port: 0,
    staticRoot: path.resolve("missing-static-root")
  });
  return { store, adapter, runtime };
}

describe("GroupXRuntime composition", () => {
  it("listens before structured session startup and mounts MCP only there", async () => {
    const f = fixture("structured");
    try {
      const started = await f.runtime.start();

      expect(f.runtime.readiness.state).toBe("ready");
      expect(f.runtime.mcpMounted).toBe(true);
      expect(f.adapter.mcpReachableStatus).toBeGreaterThanOrEqual(400);
      expect(f.adapter.mcpReachableStatus).toBeLessThan(500);
      expect(f.adapter.starts[0]?.mcp).toEqual({
        transport: "streamable-http",
        url: `${started.address.origin}/mcp`
      });
      const health = await fetch(`${started.address.origin}/api/health`).then(
        async (response) => await response.json()
      );
      expect(health).toMatchObject({
        status: "ok",
        readiness: "ready",
        transport: "structured",
        access: "unrestricted"
      });

      const webBindingId = f.runtime.webBindingId!;
      await f.runtime.close();
      expect(f.store.getSessionBinding(webBindingId)?.status).toBe("ready");
      expect(f.adapter.closes).toHaveLength(1);
    } finally {
      await f.runtime.close().catch(() => undefined);
      f.store.close();
    }
  });

  it("injects the configured Agent identity into the target context packet", async () => {
    const f = fixture("structured");
    try {
      const started = await f.runtime.start();
      const response = await fetch(`${started.address.origin}/api/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientCommandId: "runtime:configured-identity",
          to: ["agent:codex"],
          content: "identity injection check"
        })
      });
      expect(response.status).toBe(202);
      await vi.waitFor(() => expect(f.adapter.prompts).toHaveLength(1));
      expect(f.adapter.prompts[0]?.contextPacket).toContain("[configured_agent_identity]");
      expect(f.adapter.prompts[0]?.contextPacket).toContain("Stable Codex identity from settings");
    } finally {
      await f.runtime.close().catch(() => undefined);
      f.store.close();
    }
  });

  it("rejects deprecated Direct before opening the runtime", () => {
    expect(() => createAdapterRegistry(config("direct"))).toThrowError(
      expect.objectContaining({
        code: "ADAPTER_START_FAILED",
        message: "Direct transport is deprecated and disabled; use structured transport"
      })
    );
    const store = new SqliteGroupXStore(":memory:");
    const adapters = new AdapterRegistry();
    adapters.register(new RuntimeAdapter());
    try {
      expect(
        () =>
          new GroupXRuntime(config("direct"), {
            store,
            adapters,
            port: 0,
            staticRoot: path.resolve("missing-static-root")
          })
      ).toThrowError(
        expect.objectContaining({
          code: "ADAPTER_START_FAILED",
          message: "Direct transport is deprecated and disabled; use structured transport"
        })
      );
    } finally {
      store.close();
    }
  });

  it("closes HTTP and persisted runtime records when an Adapter fails to start", async () => {
    const f = fixture("structured");
    f.adapter.failStart = true;
    try {
      await expect(f.runtime.start()).rejects.toMatchObject({ code: "ADAPTER_START_FAILED" });
      expect(f.runtime.readiness.state).toBe("failed");
      expect(
        f.store
          .listSessionBindings()
          .filter((binding) => binding.actorId.startsWith("agent:"))
          .every((binding) => binding.closedAt !== undefined)
      ).toBe(true);
      expect(f.store.getSessionBinding("binding:web")?.status).toBe("ready");
    } finally {
      await f.runtime.close().catch(() => undefined);
      f.store.close();
    }
  });

  it("does not recover or interrupt live session records when the HTTP port is already occupied", async () => {
    const store = new SqliteGroupXStore(":memory:");
    const adapters = new AdapterRegistry();
    adapters.register(new RuntimeAdapter());
    store.createAgentInstance({
      instanceId: "instance:already-running",
      actorId: "agent:codex",
      adapterId: "codex",
      status: "ready",
      transport: "structured"
    });
    store.createSessionBinding({
      bindingId: "binding:already-running",
      instanceId: "instance:already-running",
      actorId: "agent:codex",
      nativeSessionId: "native:already-running",
      protocol: "codex-app-server-stdio-jsonrpc-v2",
      status: "ready",
      capabilities: { cwd: path.resolve("workspace-codex") },
      transport: "structured"
    });
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const address = occupied.address();
    if (address === null || typeof address === "string") throw new Error("fixture port missing");
    const runtime = new GroupXRuntime(config("structured"), {
      store,
      adapters,
      port: address.port,
      staticRoot: path.resolve("missing-static-root")
    });

    try {
      await expect(runtime.start()).rejects.toMatchObject({ code: "EADDRINUSE" });
      const persistedInstance = store.getAgentInstance("instance:already-running");
      const persistedBinding = store.getSessionBinding("binding:already-running");
      expect(persistedInstance?.status).toBe("ready");
      expect(persistedInstance?.processEndedAt).toBeUndefined();
      expect(persistedBinding?.status).toBe("ready");
      expect(persistedBinding?.closedAt).toBeUndefined();
    } finally {
      await runtime.close().catch(() => undefined);
      await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
      store.close();
    }
  });

  it("reuses the logical Web binding so POST idempotency survives a process restart", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "groupx-runtime-replay-"));
    const databasePath = path.join(directory, "groupx.db");
    let firstRuntime: GroupXRuntime | undefined;
    let secondRuntime: GroupXRuntime | undefined;
    try {
      const createRuntime = (): GroupXRuntime => {
        const adapters = new AdapterRegistry();
        adapters.register(new RuntimeAdapter());
        return new GroupXRuntime(
          { ...config("structured"), storage: { path: databasePath } },
          {
            adapters,
            port: 0,
            staticRoot: path.resolve("missing-static-root")
          }
        );
      };
      const body = {
        clientCommandId: "command:cross-runtime-replay",
        to: ["agent:codex"],
        content: "persist once"
      };

      firstRuntime = createRuntime();
      const firstAddress = (await firstRuntime.start()).address;
      const firstResponse = await fetch(`${firstAddress.origin}/api/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      expect(firstResponse.status).toBe(202);
      const firstResult = await firstResponse.json();
      await firstRuntime.broker.waitForIdle();
      await firstRuntime.close();

      secondRuntime = createRuntime();
      const secondAddress = (await secondRuntime.start()).address;
      expect(secondRuntime.webBindingId).toBe("binding:web");
      const secondResponse = await fetch(`${secondAddress.origin}/api/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      expect(secondResponse.status).toBe(202);
      await expect(secondResponse.json()).resolves.toEqual(firstResult);
    } finally {
      await secondRuntime?.close().catch(() => undefined);
      await firstRuntime?.close().catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
