import { describe, expect, it } from "vitest";

import { GroupXOperatorBrokerApi } from "../../../src/app/operator-broker-api.js";
import { GroupXError } from "../../../src/core/errors.js";
import type { ToolCallerContext } from "../../../src/mcp/server/broker-api.js";

function caller(overrides: Partial<ToolCallerContext> = {}): ToolCallerContext {
  return {
    bindingId: "binding:operator",
    actorId: "user:assistant",
    instanceId: "instance:operator",
    mcpRequestId: "req-1",
    signal: new AbortController().signal,
    ...overrides
  };
}

function createApi() {
  const acceptCalls: unknown[] = [];
  const broker = {
    acceptMessage: async (input: unknown) => {
      acceptCalls.push(input);
      const request = input as {
        request: { to: string[]; content: string };
      };
      return {
        messageEventId: "evt_dispatch",
        correlationId: "corr_dispatch",
        turns: request.request.to.map((target, index) => ({
          target,
          turnId: `turn_${index}`,
          status: "queued" as const
        }))
      };
    },
    rememberMemory: async () => {
      throw new Error("rememberMemory should not run");
    },
    bootstrap: () => ({
      agents: [{ actorId: "agent:codex", displayName: "Codex", status: "ready" }],
      activeTurns: []
    }),
    health: () => ({ store: { available: true, integrityOk: true } })
  };
  const store = {
    getMemory: () => ({
      memoryId: "mem_dated",
      agentMemoryType: "dated"
    }),
    listSupervisionPairs: () => [],
    listSupervisionPairTurns: () => [],
    getSteerCount: () => 0
  };
  const api = new GroupXOperatorBrokerApi({
    broker: broker as never,
    restartCommands: { restart: async () => ({ actorId: "agent:codex", accepted: true }) },
    config: {
      transport: "structured",
      agents: {
        codex: { enabled: true },
        grok: { enabled: true }
      }
    } as never,
    roomId: "room:main",
    bindingId: "binding:operator",
    store: store as never
  });
  return { api, acceptCalls, store };
}

describe("GroupXOperatorBrokerApi", () => {
  it("rejects non-operator callers and does not require an Agent Turn", async () => {
    const { api } = createApi();
    await expect(api.roster(caller({ actorId: "user:web" }))).rejects.toMatchObject({
      code: "MCP_BINDING_MISMATCH"
    });
    await expect(api.roster(caller({ bindingId: "binding:web" }))).rejects.toMatchObject({
      code: "MCP_BINDING_MISMATCH"
    });
    await expect(api.roster(caller())).resolves.toBeDefined();
  });

  it("dispatches workers through operator.dispatch without a chat bubble", async () => {
    const { api, acceptCalls } = createApi();
    const result = await api.workerDispatch(caller(), {
      clientCommandId: "op-dispatch-1",
      to: ["agent:codex"],
      content: "review the plan"
    });
    expect(result.messageEventId).toBe("evt_dispatch");
    expect(acceptCalls[0]).toMatchObject({
      bindingId: "binding:operator",
      commandType: "operator.worker_dispatch",
      sourceEventType: "operator.dispatch",
      operation: "worker_dispatch",
      request: {
        clientCommandId: "op-dispatch-1",
        to: ["agent:codex"],
        content: "review the plan"
      }
    });
  });

  it("sends publicly as the operator binding, not user:web", async () => {
    const { api, acceptCalls } = createApi();
    await api.send(caller(), {
      clientCommandId: "op-send-1",
      to: ["agent:grok"],
      content: "群里说一声"
    });
    expect(acceptCalls[0]).toMatchObject({
      bindingId: "binding:operator",
      request: { content: "群里说一声", to: ["agent:grok"] }
    });
    expect(JSON.stringify(acceptCalls[0])).not.toContain("user:web");
  });

  it("rejects the assistant as a supervision observer and dated writes", async () => {
    const { api } = createApi();
    await expect(
      api.workerDispatch(caller(), {
        clientCommandId: "op-dispatch-2",
        to: ["agent:codex"],
        content: "watch me",
        supervision: { observers: ["user:assistant"], mode: "live_steer" }
      })
    ).rejects.toBeInstanceOf(GroupXError);

    await expect(
      api.memoryRemember(caller(), {
        clientCommandId: "op-mem-1",
        scope: { type: "agent", id: "agent:codex" },
        kind: "note",
        content: "dated attempt"
      })
    ).rejects.toMatchObject({ code: "INVALID_ENVELOPE" });

    await expect(
      api.memorySupersede(caller(), {
        clientCommandId: "op-mem-2",
        memoryId: "mem_dated",
        content: "rewrite dated"
      })
    ).rejects.toMatchObject({ code: "INVALID_ENVELOPE" });
  });
});
