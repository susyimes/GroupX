import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { NativeSession } from "../../src/adapters/types.js";
import { RuntimeReadiness } from "../../src/app/readiness.js";
import { RestartAgentCommandCoordinator } from "../../src/app/restart-commands.js";
import {
  GroupXWebBrokerApi,
  type GroupXWebBrokerApiOptions
} from "../../src/app/web-broker-api.js";
import { SqliteGroupXStore } from "../../src/storage/sqlite-store.js";
import type { CancelTurnOutcome } from "../../src/broker/types.js";
import type { MemoryRecord } from "../../src/storage/types.js";

function seedWebBinding(store: SqliteGroupXStore): void {
  store.createAgentInstance({
    instanceId: "instance:web",
    actorId: "user:web",
    adapterId: "web",
    status: "ready"
  });
  store.createSessionBinding({
    bindingId: "binding:web",
    instanceId: "instance:web",
    actorId: "user:web",
    protocol: "local-rest",
    status: "ready",
    capabilities: { transport: "loopback-http" }
  });
}

function nativeSession(instanceId = "instance:codex:new"): NativeSession {
  return {
    adapterId: "codex",
    actorId: "agent:codex",
    instanceId,
    bindingId: "binding:codex:new",
    nativeSessionId: "native:codex",
    protocol: "codex-app-server-stdio-jsonrpc-v2",
    startedAt: "2026-08-11T00:00:00.000Z"
  };
}

function appConfig(): GroupXWebBrokerApiOptions["config"] {
  const agent = (name: string) => ({
    driver: name as "codex" | "grok" | "kimi",
    command: { executable: process.execPath, prefixArgs: [path.resolve(`${name}.mjs`)] },
    cwd: path.resolve(`workspace-${name}`),
    enabled: true
  });
  return {
    transport: "structured",
    agents: {
      codex: agent("codex"),
      grok: agent("grok"),
      kimi: agent("kimi")
    }
  };
}

function brokerFixture(): GroupXWebBrokerApiOptions["broker"] {
  const unsupported = async (): Promise<never> => {
    throw new Error("not used by this fixture");
  };
  return {
    health: () => ({
      store: { available: true, integrityOk: true, schemaVersion: 4, journalMode: "memory" },
      agents: [],
      activeTurns: 0,
      queuedTurns: 0
    }),
    bootstrap: () => ({
      schema: "groupx.bootstrap/0.1",
      room: { roomId: "room:main", throughSeq: 0 },
      agents: [],
      recentEvents: [],
      activeTurns: []
    }),
    contextUsage: () => ({
      roomId: "room:main",
      throughSeq: 0,
      estimatedCharacters: 160,
      maxCharacters: 256_000,
      compactionTriggerCharacters: 192_000,
      utilizationPercent: 0,
      uncompactedMessageCount: 0,
      compactable: false
    }),
    compactContextFromBinding: async () => ({
      compacted: false,
      usage: {
        roomId: "room:main",
        throughSeq: 0,
        estimatedCharacters: 160,
        maxCharacters: 256_000,
        compactionTriggerCharacters: 192_000,
        utilizationPercent: 0,
        uncompactedMessageCount: 0,
        compactable: false
      }
    }),
    acceptMessage: unsupported,
    cancelFromBinding: unsupported,
    queryMemory: () => [],
    queryIdentity: () => [],
    rememberMemory: unsupported,
    rememberIdentity: unsupported,
    supersedeMemory: unsupported,
    retractMemory: unsupported,
    supersedeIdentity: unsupported,
    retractIdentity: unsupported
  };
}

describe("RestartAgentCommandCoordinator", () => {
  it("single-flights concurrent calls and replays the persisted result", async () => {
    const store = new SqliteGroupXStore(":memory:");
    seedWebBinding(store);
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const restart = vi.fn(async () => {
      await blocked;
      return {
        actorId: "agent:codex",
        previousInstanceId: "instance:codex:old",
        session: nativeSession()
      };
    });
    const coordinator = new RestartAgentCommandCoordinator({
      store,
      sessions: { restart }
    });
    try {
      const input = {
        actorId: "agent:codex",
        bindingId: "binding:web",
        clientCommandId: "command:restart:one"
      };
      const first = coordinator.restart(input);
      const concurrent = coordinator.restart(input);
      release?.();

      await expect(Promise.all([first, concurrent])).resolves.toEqual([
        {
          actorId: "agent:codex",
          accepted: true,
          previousInstanceId: "instance:codex:old"
        },
        {
          actorId: "agent:codex",
          accepted: true,
          previousInstanceId: "instance:codex:old"
        }
      ]);
      await expect(coordinator.restart(input)).resolves.toMatchObject({ accepted: true });
      expect(restart).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });

  it("fails closed on a persisted pending restart instead of repeating it", async () => {
    const store = new SqliteGroupXStore(":memory:");
    seedWebBinding(store);
    store.beginClientCommand({
      sourceBindingId: "binding:web",
      clientCommandId: "command:restart:uncertain",
      commandType: "agent.restart",
      canonicalPayload: { actorId: "agent:codex" }
    });
    const restart = vi.fn(async () => ({
      actorId: "agent:codex",
      session: nativeSession()
    }));
    const coordinator = new RestartAgentCommandCoordinator({
      store,
      sessions: { restart }
    });
    try {
      await expect(
        coordinator.restart({
          actorId: "agent:codex",
          bindingId: "binding:web",
          clientCommandId: "command:restart:uncertain"
        })
      ).rejects.toMatchObject({ code: "STORE_CONFLICT" });
      expect(restart).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });
});

describe("GroupXWebBrokerApi", () => {
  it("projects room context usage and preserves the manual compaction command id", async () => {
    const readiness = new RuntimeReadiness();
    readiness.markReady();
    const broker = brokerFixture();
    const compactContextFromBinding = vi.fn(broker.compactContextFromBinding);
    broker.compactContextFromBinding = compactContextFromBinding;
    const api = new GroupXWebBrokerApi({
      broker,
      restartCommands: { restart: async () => ({ actorId: "agent:codex", accepted: true }) },
      readiness,
      config: appConfig(),
      roomId: "room:main",
      bindingId: "binding:web"
    });
    const signal = new AbortController().signal;

    expect(api.contextUsage(signal)).toMatchObject({
      roomId: "room:main",
      maxCharacters: 256_000,
      compactable: false
    });
    await api.compactContext({ clientCommandId: "command:compact" }, signal);
    expect(compactContextFromBinding).toHaveBeenCalledWith({
      bindingId: "binding:web",
      clientCommandId: "command:compact",
      roomId: "room:main"
    });
  });

  it("gates writes until startup recovery and sessions are ready", async () => {
    const readiness = new RuntimeReadiness();
    const broker = brokerFixture();
    const acceptMessage: GroupXWebBrokerApiOptions["broker"]["acceptMessage"] = vi.fn(
      async () => ({
        messageEventId: "event:message",
        correlationId: "corr:message",
        turns: [{ target: "agent:codex", turnId: "turn:1", status: "queued" as const }]
      })
    );
    broker.acceptMessage = acceptMessage;
    const api = new GroupXWebBrokerApi({
      broker,
      restartCommands: { restart: async () => ({ actorId: "agent:codex", accepted: true }) },
      readiness,
      config: appConfig(),
      roomId: "room:main",
      bindingId: "binding:web"
    });
    const request = {
      clientCommandId: "command:message",
      to: ["agent:codex"],
      content: "hello",
      replyToEventId: undefined
    };

    await expect(api.createMessage(request, new AbortController().signal)).rejects.toMatchObject({
      code: "SESSION_NOT_AVAILABLE"
    });
    readiness.markReady();
    await expect(api.createMessage(request, new AbortController().signal)).resolves.toMatchObject({
      messageEventId: "event:message",
      turns: [{ status: "queued" }]
    });
  });

  it("preserves cancel command ids and uses offset pagination", async () => {
    const readiness = new RuntimeReadiness();
    readiness.markReady();
    const broker = brokerFixture();
    const cancelFromBinding: GroupXWebBrokerApiOptions["broker"]["cancelFromBinding"] = vi.fn(
      async (): Promise<CancelTurnOutcome> => ({
        turnId: "turn:1",
        accepted: true,
        status: "cancelling"
      })
    );
    const memory: MemoryRecord = {
        memoryId: "memory:1",
        scopeType: "room",
        scopeId: "room:main",
        kind: "fact",
        authorActorId: "user:web",
        content: "fact",
        sourceKind: "web",
        status: "active",
        createdAt: "2026-08-11T00:00:00.000Z"
    };
    const queryMemory: GroupXWebBrokerApiOptions["broker"]["queryMemory"] = vi.fn(() => [
      memory
    ]);
    broker.cancelFromBinding = cancelFromBinding;
    broker.queryMemory = queryMemory;
    const api = new GroupXWebBrokerApi({
      broker,
      restartCommands: { restart: async () => ({ actorId: "agent:codex", accepted: true }) },
      readiness,
      config: appConfig(),
      roomId: "room:main",
      bindingId: "binding:web"
    });

    await api.cancelTurn(
      "turn:1",
      { clientCommandId: "command:cancel" },
      new AbortController().signal
    );
    expect(cancelFromBinding).toHaveBeenCalledWith({
      turnId: "turn:1",
      bindingId: "binding:web",
      clientCommandId: "command:cancel"
    });
    expect(api.queryMemory({ cursor: 3, limit: 1 }, new AbortController().signal)).toMatchObject({
      nextCursor: 4
    });
    expect(queryMemory).toHaveBeenCalledWith(expect.objectContaining({ cursor: 3, limit: 1 }));
  });
});
