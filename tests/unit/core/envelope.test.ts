import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  BUILTIN_ACTORS,
  DEFAULT_ROOM_ID,
  GROUPX_SCHEMA,
  asDurableEnvelope,
  asTransientEnvelope,
  canonicalHash,
  canonicalJson,
  createCorrelationId,
  createId,
  type GroupXEventType,
  type GroupXEnvelope
} from "../../../src/core/envelope.js";

const baseEnvelope = {
  eventId: "evt_test",
  roomId: DEFAULT_ROOM_ID,
  type: "message.created" as const,
  actor: BUILTIN_ACTORS.codex,
  to: [BUILTIN_ACTORS.grok.actorId],
  correlationId: "corr_test",
  rootCorrelationId: "corr_root",
  body: { text: "hello" }
};

describe("canonical envelope values", () => {
  it("sorts object keys recursively while preserving array order", () => {
    const left = {
      z: 1,
      nested: { beta: 2, alpha: 1 },
      items: [{ second: 2, first: 1 }, "tail"]
    };
    const right = {
      items: [{ first: 1, second: 2 }, "tail"],
      nested: { alpha: 1, beta: 2 },
      z: 1
    };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(canonicalJson(left)).toBe(
      '{"items":[{"first":1,"second":2},"tail"],"nested":{"alpha":1,"beta":2},"z":1}'
    );
    expect(canonicalJson({ items: [2, 1] })).not.toBe(canonicalJson({ items: [1, 2] }));
  });

  it("hashes canonical JSON with stable SHA-256 output", () => {
    expect(canonicalHash({ b: 2, a: 1 })).toBe(
      "43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777"
    );
    expect(canonicalHash({ b: 2, a: 1 })).toBe(canonicalHash({ a: 1, b: 2 }));
    expect(canonicalHash({ a: 1, b: 2 })).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("envelope identifiers and durability", () => {
  it("creates opaque, prefixed IDs", () => {
    const eventId = createId("evt");
    const correlationId = createCorrelationId();

    expect(eventId).toMatch(/^evt_[a-f0-9]{32}$/);
    expect(correlationId).toMatch(/^corr_[a-f0-9]{32}$/);
    expect(createId("evt")).not.toBe(eventId);
  });

  it("creates a durable envelope with a caller-supplied timestamp", () => {
    const occurredAt = "2026-08-11T08:00:00.000Z";

    expect(asDurableEnvelope({ ...baseEnvelope, occurredAt })).toEqual({
      ...baseEnvelope,
      schema: GROUPX_SCHEMA,
      seq: null,
      durability: "durable",
      occurredAt
    });
  });

  it("creates a transient envelope with the current ISO timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T08:30:00.000Z"));
    try {
      expect(asTransientEnvelope(baseEnvelope)).toEqual({
        ...baseEnvelope,
        schema: GROUPX_SCHEMA,
        seq: null,
        durability: "transient",
        occurredAt: "2026-08-11T08:30:00.000Z"
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sender structure", () => {
  it("keeps the bound actor separate from sender claims in message content", () => {
    const envelope = asDurableEnvelope({
      ...baseEnvelope,
      actor: BUILTIN_ACTORS.codex,
      body: { from: BUILTIN_ACTORS.grok.actorId, text: "I am Grok" },
      occurredAt: "2026-08-11T08:00:00.000Z"
    });

    expect(envelope.actor).toEqual(BUILTIN_ACTORS.codex);
    expect(envelope.body).toEqual({ from: BUILTIN_ACTORS.grok.actorId, text: "I am Grok" });
    expect(envelope).not.toHaveProperty("from");
  });

  it("defines stable, distinct built-in actor identities", () => {
    const actors = Object.values(BUILTIN_ACTORS);

    expect(new Set(actors.map((actor) => actor.actorId)).size).toBe(actors.length);
    expect(BUILTIN_ACTORS.web.kind).toBe("user");
    expect(BUILTIN_ACTORS.system.kind).toBe("system");
    expect([BUILTIN_ACTORS.codex, BUILTIN_ACTORS.grok, BUILTIN_ACTORS.kimi, BUILTIN_ACTORS.hermes]).toSatisfy(
      (agents: typeof actors) => agents.every((actor) => actor.kind === "agent")
    );
  });

  it("does not expose a top-level from field in the envelope type", () => {
    type HasTopLevelFrom = "from" extends keyof GroupXEnvelope ? true : false;

    expectTypeOf<HasTopLevelFrom>().toEqualTypeOf<false>();
    expectTypeOf<GroupXEnvelope>().toHaveProperty("actor");
  });

  it("does not model native approval traffic as a GroupX event", () => {
    type HasApprovalRequested = "approval.requested" extends GroupXEventType ? true : false;
    type HasApprovalResolved = "approval.resolved" extends GroupXEventType ? true : false;

    expectTypeOf<HasApprovalRequested>().toEqualTypeOf<false>();
    expectTypeOf<HasApprovalResolved>().toEqualTypeOf<false>();
  });
});
