import { describe, expect, it, vi } from "vitest";

import type { GroupXToolBrokerApiOptions } from "../../src/app/tool-broker-api.js";
import { GroupXToolBrokerApi } from "../../src/app/tool-broker-api.js";
import type { ActiveBrokerTurnContext } from "../../src/broker/types.js";
import type { GroupXEnvelope } from "../../src/core/envelope.js";
import { GroupXError } from "../../src/core/errors.js";
import type { ToolCallerContext } from "../../src/mcp/server/broker-api.js";
import type { IdentityRecord, MemoryRecord } from "../../src/storage/types.js";

const activeTurn: ActiveBrokerTurnContext = {
  bindingId: "binding:codex",
  turnId: "turn:parent",
  rootCorrelationId: "corr:root",
  hopCount: 2
};

function caller(overrides: Partial<ToolCallerContext> = {}): ToolCallerContext {
  return {
    bindingId: "binding:codex",
    actorId: "agent:codex",
    instanceId: "instance:codex",
    activeGroupxTurnId: "turn:parent",
    mcpRequestId: "request:1",
    signal: new AbortController().signal,
    ...overrides
  };
}

function envelope(): GroupXEnvelope<{ content: string }> {
  return {
    schema: "groupx.event/0.1",
    eventId: "event:answer",
    seq: 7,
    roomId: "room:main",
    type: "message.created",
    actor: {
      actorId: "agent:grok",
      kind: "agent",
      displayName: "Grok"
    },
    to: ["agent:codex"],
    correlationId: "corr:root",
    rootCorrelationId: "corr:root",
    occurredAt: "2026-08-11T00:00:00.000Z",
    durability: "durable",
    body: { content: "answer" }
  };
}

function brokerFixture() {
  const acceptMessage: GroupXToolBrokerApiOptions["broker"]["acceptMessage"] = vi.fn(
    async () => ({
      messageEventId: "event:question",
      correlationId: "corr:root",
      turns: [{ target: "agent:grok", turnId: "turn:child", status: "queued" as const }]
    })
  );
  const readCorrelation: GroupXToolBrokerApiOptions["broker"]["readCorrelation"] = vi.fn(
    () => ({ correlationId: "corr:root", events: [envelope()], turns: [] })
  );
  const memory: MemoryRecord = {
      memoryId: "memory:1",
      scopeType: "room",
      scopeId: "room:main",
      kind: "fact",
      authorActorId: "user:web",
      content: "shared fact",
      sourceKind: "web",
      status: "active",
      createdAt: "2026-08-11T00:00:00.000Z"
  };
  const queryMemory: GroupXToolBrokerApiOptions["broker"]["queryMemory"] = vi.fn(() => [
    memory
  ]);
  const rememberMemory: GroupXToolBrokerApiOptions["broker"]["rememberMemory"] = vi.fn(
    async (input): Promise<MemoryRecord> => ({
      memoryId: "memory:core",
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      agentMemoryType: input.agentMemoryType,
      kind: input.kind,
      authorActorId: "agent:codex",
      ...(input.subjectActorId === undefined
        ? {}
        : { subjectActorId: input.subjectActorId }),
      content: input.content,
      sourceKind: "mcp",
      status: "active",
      createdAt: "2026-08-11T00:00:00.000Z"
    })
  );
  const rememberIdentity: GroupXToolBrokerApiOptions["broker"]["rememberIdentity"] = vi.fn(
    async (input): Promise<IdentityRecord> => ({
        identityId: "identity:1",
        subjectActorId: input.subjectActorId,
        authorActorId: "agent:codex",
        kind: input.kind,
        content: input.content,
        sourceKind: "mcp",
        status: "active",
        createdAt: "2026-08-11T00:00:00.000Z"
      })
  );
  const unsupported = async (): Promise<never> => {
    throw new Error("not used by this fixture");
  };
  const broker: GroupXToolBrokerApiOptions["broker"] = {
    acceptMessage,
    assertObserverRouting: vi.fn(),
    watchSubject: vi.fn(async () => ({
      until: "next_milestone" as const,
      timedOut: false,
      snapshot: {
        turnId: "turn:child",
        status: "running",
        lastSeq: 3,
        watchCursor: 1,
        terminal: false,
        subjectCancelled: false,
        task: { eventId: "event:question", excerpt: "question" },
        messages: [],
        tools: [],
        steerCount: 0
      }
    })),
    steerSubject: vi.fn(async () => ({
      action: "nudge" as const,
      reason: "adjust",
      subjectTurnId: "turn:child",
      messageEventId: "event:steer",
      correlationId: "corr:root",
      nextTurnId: "turn:next"
    })),
    readCorrelation,
    queryMemory,
    rememberIdentity,
    waitForCorrelation: unsupported,
    cancelTurn: unsupported,
    rememberMemory,
    queryIdentity: () => []
  };
  const requireForCaller = vi.fn(() => ({ ...activeTurn }));
  const api = new GroupXToolBrokerApi({
    broker,
    turns: { requireForCaller },
    roomId: "room:main"
  });
  return {
    api,
    broker,
    acceptMessage,
    readCorrelation,
    queryMemory,
    rememberMemory,
    rememberIdentity,
    requireForCaller
  };
}

describe("GroupXToolBrokerApi", () => {
  it("forwards watch and steer through the active Watch Turn without a caller from field", async () => {
    const fixture = brokerFixture();

    await expect(
      fixture.api.watch(caller(), { until: "next_milestone" })
    ).resolves.toMatchObject({
      until: "next_milestone",
      snapshot: { turnId: "turn:child", tools: [] }
    });
    await expect(
      fixture.api.steer(caller(), {
        action: "nudge",
        reason: "adjust",
        content: "try another path",
        clientCommandId: "command:steer"
      })
    ).resolves.toMatchObject({
      action: "nudge",
      subjectTurnId: "turn:child",
      nextTurnId: "turn:next"
    });
    expect(fixture.broker.watchSubject).toHaveBeenCalledWith(
      expect.objectContaining({ watchTurnId: "turn:parent", until: "next_milestone" })
    );
    expect(fixture.broker.steerSubject).toHaveBeenCalledWith(
      expect.objectContaining({
        bindingId: "binding:codex",
        watchTurnId: "turn:parent",
        action: "nudge"
      })
    );
  });

  it("binds child sends to the active root Turn and returns contract-safe output", async () => {
    const fixture = brokerFixture();

    await expect(
      fixture.api.send(caller(), {
        clientCommandId: "command:send",
        to: ["agent:grok"],
        content: "question"
      })
    ).resolves.toEqual({
      messageEventId: "event:question",
      correlationId: "corr:root",
      turns: [{ target: "agent:grok", turnId: "turn:child", status: "queued" }]
    });
    expect(fixture.acceptMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        bindingId: "binding:codex",
        causationId: "turn:parent",
        correlationId: "corr:root",
        parentTurnId: "turn:parent",
        hopCount: 3,
        commandType: "mcp.send"
      })
    );
  });

  it("forwards supervision on send and rejects the caller as an observer", async () => {
    const fixture = brokerFixture();
    const supervision = { observers: ["agent:grok"], mode: "live_steer" as const };

    await fixture.api.send(caller(), {
      clientCommandId: "command:supervise",
      to: ["agent:kimi"],
      content: "review this",
      supervision
    });
    expect(fixture.acceptMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          to: ["agent:kimi"],
          supervision
        })
      })
    );

    await expect(
      fixture.api.send(caller(), {
        clientCommandId: "command:self-observe",
        to: ["agent:kimi"],
        content: "review this",
        supervision: { observers: ["agent:codex"], mode: "live_steer" }
      })
    ).rejects.toMatchObject({ code: "SUPERVISION_PAIR_INVALID" } satisfies Partial<GroupXError>);
    expect(fixture.acceptMessage).toHaveBeenCalledTimes(1);
  });

  it("defaults reads to the active root correlation and validates envelopes", async () => {
    const fixture = brokerFixture();

    const result = await fixture.api.read(caller(), {});

    expect(result.events[0]?.eventId).toBe("event:answer");
    expect(fixture.readCorrelation).toHaveBeenCalledWith({
      correlationId: "corr:root",
      roomId: "room:main"
    });
  });

  it("builds ask output from exact child responses instead of a truncated correlation page", async () => {
    const fixture = brokerFixture();
    fixture.broker.waitForCorrelation = vi.fn(async () => ({
      state: "terminal" as const,
      correlationId: "corr:root",
      turns: [
        {
          turnId: "turn:child",
          sourceEventId: "event:question",
          targetActorId: "agent:grok",
          adapterId: "grok",
          transport: "structured" as const,
          rootCorrelationId: "corr:root",
          hopCount: 3,
          enqueueSeq: 5,
          queuedEventId: "event:queued",
          status: "completed" as const,
          responseEventId: "event:answer",
          queuedAt: "2026-08-11T00:00:00.000Z",
          terminalAt: "2026-08-11T00:00:01.000Z"
        }
      ],
      read: { correlationId: "corr:root", events: [], turns: [] },
      responseEvents: [envelope()]
    }));

    await expect(
      fixture.api.ask(caller(), {
        clientCommandId: "command:ask",
        to: ["agent:grok"],
        content: "question"
      })
    ).resolves.toEqual({
      messageEventId: "event:question",
      correlationId: "corr:root",
      results: [
        {
          target: "agent:grok",
          status: "completed",
          responseEventId: "event:answer",
          content: "answer"
        }
      ]
    });
  });

  it("marks non-terminal ask targets as timeout with a bounded follow-up note", async () => {
    const fixture = brokerFixture();
    fixture.broker.waitForCorrelation = vi.fn(async () => ({
      state: "timeout" as const,
      correlationId: "corr:root",
      turns: [
        {
          turnId: "turn:child",
          sourceEventId: "event:question",
          targetActorId: "agent:grok",
          adapterId: "grok",
          transport: "structured" as const,
          rootCorrelationId: "corr:root",
          hopCount: 3,
          enqueueSeq: 5,
          queuedEventId: "event:queued",
          status: "running" as const,
          queuedAt: "2026-08-11T00:00:00.000Z"
        }
      ],
      read: { correlationId: "corr:root", events: [], turns: [] },
      responseEvents: []
    }));

    const result = await fixture.api.ask(caller(), {
      clientCommandId: "command:ask-timeout",
      to: ["agent:grok"],
      content: "question"
    });

    expect(result.results).toEqual([
      expect.objectContaining({ target: "agent:grok", status: "timeout" })
    ]);
    const note = result.results[0]?.note;
    expect(note).toContain("still running");
    expect(note).toContain('correlationId "corr:root"');
    expect(note?.length ?? 0).toBeLessThanOrEqual(500);
  });

  it("passes offset cursors to memory queries and advances only full pages", async () => {
    const fixture = brokerFixture();

    const result = await fixture.api.memorySearch(caller(), { cursor: 4, limit: 1 });

    expect(result.nextCursor).toBe(5);
    expect(fixture.queryMemory).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: 4, limit: 1 })
    );
  });

  it("records self identity from binding provenance, never from tool arguments", async () => {
    const fixture = brokerFixture();

    const result = await fixture.api.identityRemember(caller(), {
      clientCommandId: "command:identity",
      kind: "preference",
      content: "I prefer concise answers"
    });

    expect(result.identity.subjectActorId).toBe("agent:codex");
    expect(fixture.rememberIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        bindingId: "binding:codex",
        subjectActorId: "agent:codex",
        correlationId: "corr:root"
      })
    );
  });

  it("binds core memory to the current Agent without a caller-supplied scope", async () => {
    const fixture = brokerFixture();

    const result = await fixture.api.coreMemoryRemember(caller(), {
      clientCommandId: "command:core-memory",
      kind: "instruction",
      content: "Keep protocol evidence concise"
    });

    expect(result.memory).toMatchObject({
      scope: { type: "agent", id: "agent:codex" },
      agentMemoryType: "core",
      authorActorId: "agent:codex",
      subjectActorId: "agent:codex"
    });
    expect(fixture.rememberMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        bindingId: "binding:codex",
        scopeType: "agent",
        scopeId: "agent:codex",
        agentMemoryType: "core",
        subjectActorId: "agent:codex",
        correlationId: "corr:root"
      })
    );
  });
});
