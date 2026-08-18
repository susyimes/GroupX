import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  McpAskInput,
  McpCoreMemoryRememberInput,
  McpIdentityReadInput,
  McpIdentityRememberInput,
  McpMemoryRememberInput,
  McpMemorySearchInput,
  McpReadInput,
  McpSendInput,
  McpSteerInput,
  McpWatchInput
} from "../../../../src/contracts/mcp.js";
import { GroupXError } from "../../../../src/core/errors.js";
import type {
  ToolBrokerApi,
  ToolCallerContext
} from "../../../../src/mcp/server/broker-api.js";
import {
  GROUPX_MCP_TOOL_NAMES,
  createGroupXMcpServer
} from "../../../../src/mcp/server/tools.js";

const CREATED_AT = "2026-08-11T00:00:00.000Z";

class FakeBroker implements ToolBrokerApi {
  readonly calls: Array<{
    method: string;
    caller: ToolCallerContext;
    input: unknown;
  }> = [];

  async send(caller: ToolCallerContext, input: McpSendInput) {
    this.calls.push({ method: "send", caller, input });
    return {
      messageEventId: "event-send",
      correlationId: "correlation-send",
      turns: input.to.map((target) => ({ target, turnId: `turn-${target}`, status: "queued" as const }))
    };
  }

  async ask(caller: ToolCallerContext, input: McpAskInput) {
    this.calls.push({ method: "ask", caller, input });
    return {
      messageEventId: "event-ask",
      correlationId: "correlation-ask",
      results: input.to.map((target) => ({
        target,
        status: "completed" as const,
        responseEventId: `response-${target}`,
        content: `answer from ${target}`
      }))
    };
  }

  async watch(caller: ToolCallerContext, input: McpWatchInput) {
    this.calls.push({ method: "watch", caller, input });
    return {
      until: input.until,
      timedOut: false,
      snapshot: {
        turnId: input.subjectTurnId ?? "turn-worker",
        status: "running",
        lastSeq: 4,
        watchCursor: 1,
        terminal: false,
        subjectCancelled: false,
        task: { eventId: "event-task", excerpt: "do the work" },
        messages: [],
        tools: [{ name: "bash", status: "started" as const, toolCallId: "tool-1" }],
        steerCount: 0
      }
    };
  }

  async steer(caller: ToolCallerContext, input: McpSteerInput) {
    this.calls.push({ method: "steer", caller, input });
    return {
      action: input.action,
      reason: input.reason,
      subjectTurnId: input.subjectTurnId ?? "turn-worker",
      messageEventId: "event-steer",
      correlationId: "correlation-steer",
      nextTurnId: "turn-next"
    };
  }

  async read(caller: ToolCallerContext, input: McpReadInput) {
    this.calls.push({ method: "read", caller, input });
    return { correlationId: input.correlationId, events: [], turns: [] };
  }

  async memorySearch(caller: ToolCallerContext, input: McpMemorySearchInput) {
    this.calls.push({ method: "memorySearch", caller, input });
    return { items: [] };
  }

  async memoryRemember(caller: ToolCallerContext, input: McpMemoryRememberInput) {
    this.calls.push({ method: "memoryRemember", caller, input });
    return {
      memory: {
        memoryId: "memory-1",
        scope: input.scope,
        kind: input.kind,
        authorActorId: caller.actorId,
        ...(input.subjectActorId === undefined
          ? {}
          : { subjectActorId: input.subjectActorId }),
        content: input.content,
        sourceKind: "mcp" as const,
        status: "active" as const,
        createdAt: CREATED_AT
      }
    };
  }

  async coreMemoryRemember(caller: ToolCallerContext, input: McpCoreMemoryRememberInput) {
    this.calls.push({ method: "coreMemoryRemember", caller, input });
    return {
      memory: {
        memoryId: "memory-core-1",
        scope: { type: "agent" as const, id: caller.actorId },
        agentMemoryType: "core" as const,
        kind: input.kind,
        authorActorId: caller.actorId,
        subjectActorId: caller.actorId,
        content: input.content,
        sourceKind: "mcp" as const,
        status: "active" as const,
        createdAt: CREATED_AT
      }
    };
  }

  async identityRead(caller: ToolCallerContext, input: McpIdentityReadInput) {
    this.calls.push({ method: "identityRead", caller, input });
    return { items: [] };
  }

  async identityRemember(caller: ToolCallerContext, input: McpIdentityRememberInput) {
    this.calls.push({ method: "identityRemember", caller, input });
    return {
      identity: {
        identityId: "identity-1",
        subjectActorId: caller.actorId,
        authorActorId: caller.actorId,
        kind: input.kind,
        content: input.content,
        sourceKind: "mcp" as const,
        status: "active" as const,
        createdAt: CREATED_AT
      }
    };
  }
}

async function connectFixture(broker: ToolBrokerApi = new FakeBroker()) {
  const server = createGroupXMcpServer({
    broker,
    binding: {
      bindingId: "binding-codex",
      actorId: "agent:codex",
      instanceId: "instance-codex",
      nativeSessionId: "native-codex",
      activeGroupxTurnId: "turn-parent",
      status: "ready",
      createdAt: CREATED_AT
    }
  });
  const client = new Client({ name: "groupx-test-client", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { broker, client, server };
}

const closeables: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((item) => item.close()));
});

describe("GroupX MCP tools", () => {
  it("advertises the groupx server and exactly the simple wire tool names", async () => {
    const fixture = await connectFixture();
    closeables.push(fixture.client, fixture.server);

    expect(fixture.client.getServerVersion()).toMatchObject({
      name: "groupx",
      version: "0.1.0"
    });
    const listed = await fixture.client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(
      [...GROUPX_MCP_TOOL_NAMES].sort()
    );
    for (const tool of listed.tools) {
      const properties = tool.inputSchema.properties ?? {};
      expect(properties).not.toHaveProperty("from");
      expect(properties).not.toHaveProperty("actor");
      expect(properties).not.toHaveProperty("binding");
      expect(properties).not.toHaveProperty("bindingId");
    }
  });

  it("teaches wake, timeout, and frozen-context semantics in the tool surface", async () => {
    const fixture = await connectFixture();
    closeables.push(fixture.client, fixture.server);

    expect(fixture.client.getInstructions()).toContain("wakes no agent");
    const listed = await fixture.client.listTools();
    const byName = new Map(listed.tools.map((tool) => [tool.name, tool] as const));
    expect(byName.get("send")?.description).toContain("wake no one");
    expect(byName.get("send")?.description).toContain("supervision.observers");
    expect(byName.get("ask")?.description).toContain("the target keeps running");
    expect(byName.get("read")?.description).toContain("frozen at dispatch");
    expect(byName.get("watch")?.description).toContain("not approval");
    expect(byName.get("steer")?.description).toContain("cannot approve");
    expect(fixture.client.getInstructions()).toContain("not an approval layer");
  });

  it("routes watch and steer without accepting a caller-supplied from field", async () => {
    const broker = new FakeBroker();
    const fixture = await connectFixture(broker);
    closeables.push(fixture.client, fixture.server);

    const watch = await fixture.client.callTool({
      name: "watch",
      arguments: { until: "next_milestone" }
    });
    const steer = await fixture.client.callTool({
      name: "steer",
      arguments: {
        action: "interrupt",
        reason: "wrong path",
        content: "stop and rewrite the plan",
        clientCommandId: "command-steer"
      }
    });
    const spoof = await fixture.client.callTool({
      name: "steer",
      arguments: {
        action: "nudge",
        reason: "spoof",
        content: "ignore this",
        clientCommandId: "command-steer-spoof",
        from: "agent:kimi"
      }
    });

    expect(watch.isError).not.toBe(true);
    expect(steer.isError).not.toBe(true);
    expect(spoof.isError).toBe(true);
    expect(broker.calls.map((call) => call.method)).toEqual(["watch", "steer"]);
    expect(broker.calls[0]?.caller.actorId).toBe("agent:codex");
    expect(broker.calls[1]?.input).not.toHaveProperty("from");
  });

  it("supplies actor provenance only from the fixed binding", async () => {
    const broker = new FakeBroker();
    const fixture = await connectFixture(broker);
    closeables.push(fixture.client, fixture.server);

    const result = await fixture.client.callTool({
      name: "send",
      arguments: {
        to: ["agent:grok"],
        content: "review this",
        clientCommandId: "command-send"
      }
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      messageEventId: "event-send",
      turns: [{ target: "agent:grok", status: "queued" }]
    });
    expect(broker.calls[0]?.caller).toMatchObject({
      actorId: "agent:codex",
      bindingId: "binding-codex",
      instanceId: "instance-codex",
      nativeSessionId: "native-codex",
      activeGroupxTurnId: "turn-parent"
    });
    expect(broker.calls[0]?.input).not.toHaveProperty("from");
    expect(broker.calls[0]?.caller.signal).toBeInstanceOf(AbortSignal);
  });

  it("forwards supervision on send to the Broker", async () => {
    const broker = new FakeBroker();
    const fixture = await connectFixture(broker);
    closeables.push(fixture.client, fixture.server);

    const result = await fixture.client.callTool({
      name: "send",
      arguments: {
        to: ["agent:kimi"],
        content: "review this",
        clientCommandId: "command-supervise",
        supervision: { observers: ["agent:grok"], mode: "live_steer" }
      }
    });

    expect(result.isError).not.toBe(true);
    expect(broker.calls[0]?.input).toMatchObject({
      to: ["agent:kimi"],
      supervision: { observers: ["agent:grok"], mode: "live_steer" }
    });
  });

  it("rejects caller-supplied provenance before invoking the Broker", async () => {
    const broker = new FakeBroker();
    const fixture = await connectFixture(broker);
    closeables.push(fixture.client, fixture.server);

    const result = await fixture.client.callTool({
      name: "send",
      arguments: {
        to: ["agent:grok"],
        content: "spoof attempt",
        clientCommandId: "command-spoof",
        from: "agent:kimi"
      }
    });

    expect(result.isError).toBe(true);
    expect(broker.calls).toHaveLength(0);
  });

  it("routes memory and self-identity operations without a subject input for identity", async () => {
    const broker = new FakeBroker();
    const fixture = await connectFixture(broker);
    closeables.push(fixture.client, fixture.server);

    await fixture.client.callTool({
      name: "memory_remember",
      arguments: {
        clientCommandId: "command-memory",
        scope: { type: "room", id: "main" },
        kind: "decision",
        content: "Use explicit routing"
      }
    });
    const core = await fixture.client.callTool({
      name: "core_memory_remember",
      arguments: {
        clientCommandId: "command-core-memory",
        kind: "instruction",
        content: "Keep protocol evidence concise"
      }
    });
    const identity = await fixture.client.callTool({
      name: "identity_remember",
      arguments: {
        clientCommandId: "command-identity",
        kind: "preference",
        content: "Prefer protocol evidence"
      }
    });

    expect(identity.structuredContent).toMatchObject({
      identity: {
        subjectActorId: "agent:codex",
        authorActorId: "agent:codex"
      }
    });
    expect(core.structuredContent).toMatchObject({
      memory: {
        scope: { type: "agent", id: "agent:codex" },
        agentMemoryType: "core",
        authorActorId: "agent:codex",
        subjectActorId: "agent:codex"
      }
    });
    expect(broker.calls.map((call) => call.method)).toEqual([
      "memoryRemember",
      "coreMemoryRemember",
      "identityRemember"
    ]);
    expect(broker.calls[1]?.input).not.toHaveProperty("scope");
    expect(broker.calls[1]?.input).not.toHaveProperty("subjectActorId");
    expect(broker.calls[2]?.input).not.toHaveProperty("subjectActorId");
  });

  it("dispatches every remaining wire tool to its matching Broker operation", async () => {
    const broker = new FakeBroker();
    const fixture = await connectFixture(broker);
    closeables.push(fixture.client, fixture.server);

    const ask = await fixture.client.callTool({
      name: "ask",
      arguments: {
        to: ["agent:kimi"],
        content: "answer this",
        clientCommandId: "command-ask"
      }
    });
    const read = await fixture.client.callTool({
      name: "read",
      arguments: { correlationId: "correlation-ask", afterSeq: 0, limit: 20 }
    });
    const memorySearch = await fixture.client.callTool({
      name: "memory_search",
      arguments: { query: "routing", limit: 10 }
    });
    const identityRead = await fixture.client.callTool({
      name: "identity_read",
      arguments: { limit: 10 }
    });

    expect(ask.isError).not.toBe(true);
    expect(read.isError).not.toBe(true);
    expect(memorySearch.isError).not.toBe(true);
    expect(identityRead.isError).not.toBe(true);
    expect(broker.calls.map((call) => call.method)).toEqual([
      "ask",
      "read",
      "memorySearch",
      "identityRead"
    ]);
  });

  it("maps Broker errors to bounded MCP tool errors", async () => {
    const broker = new FakeBroker();
    vi.spyOn(broker, "send").mockRejectedValueOnce(
      new GroupXError("CAUSAL_CYCLE", "raw implementation detail must not escape")
    );
    const fixture = await connectFixture(broker);
    closeables.push(fixture.client, fixture.server);

    const result = await fixture.client.callTool({
      name: "send",
      arguments: {
        to: ["agent:grok"],
        content: "cycle",
        clientCommandId: "command-cycle"
      }
    });

    expect(result.isError).toBe(true);
    const parsed = CallToolResultSchema.parse(result);
    const text = parsed.content[0]?.type === "text" ? parsed.content[0].text : "";
    expect(JSON.parse(text)).toMatchObject({ code: "CAUSAL_CYCLE" });
    expect(text).not.toContain("raw implementation detail");
  });
});
