import { z } from "zod";
import { describe, expect, it } from "vitest";

import * as contracts from "../../../src/contracts/index.js";
import {
  BootstrapResponseSchema,
  CancelTurnResultSchema,
  CancelTurnRequestSchema,
  CompactContextRequestSchema,
  CreateMessageRequestSchema,
  EventsQuerySchema,
  GroupXEnvelopeSchema,
  IdentityQuerySchema,
  McpAskInputSchema,
  McpCoreMemoryRememberInputSchema,
  McpIdentityReadInputSchema,
  McpIdentityRememberInputSchema,
  McpMemorySearchInputSchema,
  McpMemoryRememberInputSchema,
  McpReadInputSchema,
  McpSendInputSchema,
  MemoryQuerySchema,
  MemoryRecordSchema,
  RememberIdentityRequestSchema,
  RememberMemoryRequestSchema,
  RestartAgentRequestSchema,
  RetractIdentityRequestSchema,
  RetractMemoryRequestSchema,
  SafeErrorBodySchema,
  SupersedeIdentityRequestSchema,
  SupersedeMemoryRequestSchema,
  parseCreateMessageAccepted,
  parseGroupXEnvelope
} from "../../../src/contracts/index.js";

describe("Web/MCP JSON schema safety", () => {
  it("emits additionalProperties=false for every write request schema", () => {
    const schemas = [
      CreateMessageRequestSchema,
      CancelTurnRequestSchema,
      CompactContextRequestSchema,
      RestartAgentRequestSchema,
      RememberMemoryRequestSchema,
      SupersedeMemoryRequestSchema,
      RetractMemoryRequestSchema,
      RememberIdentityRequestSchema,
      SupersedeIdentityRequestSchema,
      RetractIdentityRequestSchema,
      McpSendInputSchema,
      McpAskInputSchema,
      McpCoreMemoryRememberInputSchema,
      McpReadInputSchema,
      McpMemorySearchInputSchema,
      McpMemoryRememberInputSchema,
      McpIdentityReadInputSchema,
      McpIdentityRememberInputSchema
    ];

    for (const schema of schemas) {
      const jsonSchema = z.toJSONSchema(schema, { io: "input" });
      expect(jsonSchema.additionalProperties).toBe(false);
    }

    const messageJsonSchema = z.toJSONSchema(CreateMessageRequestSchema, { io: "input" });
    expect(messageJsonSchema.properties?.to).toMatchObject({
      minItems: 1,
      uniqueItems: true
    });

    const memoryJsonSchema = z.toJSONSchema(RememberMemoryRequestSchema, { io: "input" });
    expect(memoryJsonSchema.properties?.scope).toMatchObject({ additionalProperties: false });

    const cancelResultJsonSchema = z.toJSONSchema(CancelTurnResultSchema, { io: "output" });
    expect(cancelResultJsonSchema.additionalProperties).toBe(false);
  });

  it("keeps read/query schemas strict as a protocol hygiene boundary", () => {
    for (const schema of [EventsQuerySchema, MemoryQuerySchema, IdentityQuerySchema]) {
      expect(z.toJSONSchema(schema, { io: "input" }).additionalProperties).toBe(false);
    }
  });

  it("requires core or dated classification only for Agent-scoped memory", () => {
    const base = {
      memoryId: "memory-1",
      kind: "note",
      authorActorId: "agent:codex",
      content: "remember this",
      sourceKind: "mcp",
      status: "active",
      createdAt: "2026-08-13T00:00:00.000Z"
    };
    expect(
      MemoryRecordSchema.safeParse({
        ...base,
        scope: { type: "agent", id: "agent:codex" },
        agentMemoryType: "core"
      }).success
    ).toBe(true);
    expect(
      MemoryRecordSchema.safeParse({
        ...base,
        scope: { type: "agent", id: "agent:codex" }
      }).success
    ).toBe(false);
    expect(
      MemoryRecordSchema.safeParse({
        ...base,
        scope: { type: "room", id: "room:main" },
        agentMemoryType: "dated"
      }).success
    ).toBe(false);
  });

  it("makes the unified error body strict at both levels", () => {
    const jsonSchema = z.toJSONSchema(SafeErrorBodySchema, { io: "output" });
    expect(jsonSchema.additionalProperties).toBe(false);
    expect(jsonSchema.properties?.error).toMatchObject({ additionalProperties: false });
  });

  it("does not expose approval REST contracts or bootstrap approval state", () => {
    expect(contracts).not.toHaveProperty("ResolveApprovalRequestSchema");
    expect(contracts).not.toHaveProperty("ResolveApprovalAcceptedSchema");
    expect(contracts).not.toHaveProperty("parseResolveApprovalRequest");
    expect(contracts).not.toHaveProperty("parseResolveApprovalAccepted");

    expect(BootstrapResponseSchema.shape).not.toHaveProperty("pendingApprovals");
  });

  it("rejects internal Turn fields from the bootstrap projection", () => {
    expect(
      BootstrapResponseSchema.safeParse({
        schema: "groupx.bootstrap/0.1",
        room: { roomId: "room:main", throughSeq: 0 },
        agents: [],
        recentEvents: [],
        activeTurns: [
          {
            turnId: "turn_1",
            targetActorId: "agent:codex",
            status: "running",
            sourceEventId: "evt_1",
            bindingId: "binding:codex"
          }
        ]
      }).success
    ).toBe(false);
  });
});

describe("SSE Envelope output contract", () => {
  const durable = {
    schema: "groupx.event/0.1",
    eventId: "evt_1",
    seq: 12,
    roomId: "room:main",
    type: "future.event.type",
    actor: {
      actorId: "system:groupx",
      kind: "system",
      displayName: "GroupX"
    },
    to: [],
    correlationId: "corr_1",
    occurredAt: "2026-08-11T12:00:00.000Z",
    durability: "durable",
    body: { safe: true }
  } as const;

  it("accepts unknown event types for forward-compatible generic rendering", () => {
    expect(parseGroupXEnvelope(durable).type).toBe("future.event.type");
  });

  it("accepts only losslessly JSON-serializable event bodies", () => {
    const parsed = parseGroupXEnvelope({
      ...durable,
      body: { nested: [null, true, 3, "text"] }
    });
    const serialized = JSON.stringify(parsed);
    expect(serialized).toContain('"body"');

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const lossyArray = ["visible"] as string[] & Record<string, unknown>;
    lossyArray["01"] = "not encoded by JSON.stringify";
    for (const body of [
      undefined,
      1n,
      () => true,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      circular,
      lossyArray
    ]) {
      expect(() => parseGroupXEnvelope({ ...durable, body })).toThrow();
    }
  });

  it("allows only Agent actor ids in Envelope routing targets", () => {
    expect(() => parseGroupXEnvelope({ ...durable, to: ["user:web"] })).toThrow();
    expect(() => parseGroupXEnvelope({ ...durable, to: ["system:groupx"] })).toThrow();
    expect(parseGroupXEnvelope({ ...durable, to: ["agent:grok"] }).to).toEqual(["agent:grok"]);
  });

  it("requires an ISO timestamp with timezone evidence", () => {
    expect(() => parseGroupXEnvelope({ ...durable, occurredAt: "not-a-date" })).toThrow();
  });

  it("requires actor kind to agree with the actorId namespace", () => {
    expect(() =>
      parseGroupXEnvelope({
        ...durable,
        actor: { actorId: "agent:grok", kind: "user", displayName: "spoof" }
      })
    ).toThrow();
  });

  it("requires durable SSE events to carry a cursor", () => {
    expect(() => GroupXEnvelopeSchema.parse({ ...durable, seq: null })).toThrow();
  });

  it("requires transient events to omit a durable cursor", () => {
    expect(
      parseGroupXEnvelope({
        ...durable,
        eventId: "evt_delta",
        seq: null,
        type: "turn.content.delta",
        durability: "transient"
      }).seq
    ).toBeNull();
    expect(() =>
      GroupXEnvelopeSchema.parse({ ...durable, type: "turn.content.delta", durability: "transient" })
    ).toThrow();
  });
});

describe("response forward compatibility", () => {
  it("preserves newly added optional response fields", () => {
    const parsed = parseCreateMessageAccepted({
      messageEventId: "evt_1",
      correlationId: "corr_1",
      turns: [{ target: "agent:grok", turnId: "turn_1", status: "queued", lane: "grok" }],
      futureField: "future"
    });

    expect(parsed.futureField).toBe("future");
    expect(parsed.turns[0]?.lane).toBe("grok");
  });
});
