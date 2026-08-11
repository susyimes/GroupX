import { afterEach, describe, expect, it } from "vitest";

import { GroupXError } from "../../../src/core/errors.js";
import {
  GroupXMemoryService,
  classifyIdentityPerspective
} from "../../../src/memory/service.js";
import type { MemoryClock } from "../../../src/memory/types.js";
import {
  appendMessage,
  cleanupMemoryTestFixtures,
  createMemoryTestFixture
} from "./test-fixture.js";

class SequenceClock implements MemoryClock {
  readonly #values: string[];

  constructor(...values: string[]) {
    this.#values = [...values];
  }

  now(): string {
    const next = this.#values.shift();
    if (next === undefined) throw new Error("Test clock exhausted");
    return next;
  }
}

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(GroupXError);
    expect((error as GroupXError).code).toBe(code);
    return;
  }
  throw new Error(`Expected GroupXError(${code})`);
}

afterEach(cleanupMemoryTestFixtures);

describe("GroupXMemoryService explicit public memory", () => {
  it("remember/search/supersede/retract use the injected clock and preserve ordinary text", () => {
    const fixture = createMemoryTestFixture();
    const service = new GroupXMemoryService(
      fixture.store,
      new SequenceClock(
        "2026-08-11T01:00:00.000Z",
        "2026-08-11T02:00:00.000Z",
        "2026-08-11T03:00:00.000Z"
      )
    );
    const source = appendMessage(fixture, {
      eventId: "evt_memory_source",
      actorId: "user:web",
      content: "pin this",
      targets: ["agent:codex"]
    });
    const originalText = "Keep <literal>tag</literal> and token-like-text unchanged";

    const first = service.remember({
      scopeType: "room",
      scopeId: "room:main",
      kind: "decision",
      authorActorId: "user:web",
      content: originalText,
      sourceEventId: source.eventId,
      sourceKind: "web"
    });
    expect(first.content).toBe(originalText);
    expect(first.createdAt).toBe("2026-08-11T01:00:00.000Z");
    expect(service.search({ scopeId: "room:main" })).toEqual([first]);

    const replacement = service.supersede(first.memoryId, {
      scopeType: "room",
      scopeId: "room:main",
      kind: "decision",
      authorActorId: "user:web",
      content: "Use the replacement decision",
      sourceEventId: source.eventId,
      sourceKind: "web"
    });
    expect(replacement.createdAt).toBe("2026-08-11T02:00:00.000Z");
    expect(replacement.supersedesMemoryId).toBe(first.memoryId);
    expect(service.search({ scopeId: "room:main" })).toEqual([replacement]);

    const retracted = service.retract(replacement.memoryId);
    expect(retracted.status).toBe("retracted");
    expect(retracted.retractedAt).toBe("2026-08-11T03:00:00.000Z");
    expect(service.search({ scopeId: "room:main" })).toEqual([]);
    expect(service.search({ scopeId: "room:main", includeHistory: true })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ memoryId: first.memoryId, status: "superseded" }),
        expect.objectContaining({ memoryId: replacement.memoryId, status: "retracted" })
      ])
    );
  });

  it("has no ordinary-chat ingestion path and does not turn a durable message into memory", () => {
    const fixture = createMemoryTestFixture();
    const service = new GroupXMemoryService(
      fixture.store,
      new SequenceClock("2026-08-11T01:00:00.000Z")
    );
    appendMessage(fixture, {
      eventId: "evt_plain_chat",
      actorId: "user:web",
      content: "This is only chat",
      targets: ["agent:grok"]
    });

    expect(service.search({ scopeId: "room:main", includeHistory: true })).toEqual([]);
  });
});

describe("GroupXMemoryService identity provenance helpers", () => {
  it("fixes an MCP self identity to the calling Agent", () => {
    const fixture = createMemoryTestFixture();
    const service = new GroupXMemoryService(
      fixture.store,
      new SequenceClock("2026-08-11T01:00:00.000Z")
    );
    const identity = service.rememberSelfIdentity({
      callingActorId: "agent:grok",
      kind: "preference",
      content: "Prefer protocol evidence"
    });

    expect(identity).toMatchObject({
      subjectActorId: "agent:grok",
      authorActorId: "agent:grok",
      sourceKind: "mcp"
    });
    expect(classifyIdentityPerspective(identity)).toBe("self");
  });

  it("keeps Web user authorship distinct from the Agent subject", () => {
    const fixture = createMemoryTestFixture();
    const service = new GroupXMemoryService(
      fixture.store,
      new SequenceClock("2026-08-11T01:00:00.000Z")
    );
    const identity = service.rememberUserAuthoredIdentity({
      authorActorId: "user:web",
      subjectActorId: "agent:codex",
      kind: "instruction",
      content: "Act as the room reviewer"
    });

    expect(identity).toMatchObject({
      subjectActorId: "agent:codex",
      authorActorId: "user:web",
      sourceKind: "web"
    });
    expect(classifyIdentityPerspective(identity)).toBe("user-authored");
  });

  it("stores another Agent's statement only as a note observation", () => {
    const fixture = createMemoryTestFixture();
    const service = new GroupXMemoryService(
      fixture.store,
      new SequenceClock("2026-08-11T01:00:00.000Z")
    );
    const observation = service.rememberObservedIdentity({
      authorActorId: "agent:codex",
      subjectActorId: "agent:grok",
      content: "Focused on interoperability"
    });

    expect(observation).toMatchObject({
      subjectActorId: "agent:grok",
      authorActorId: "agent:codex",
      kind: "note",
      sourceKind: "adapter"
    });
    expect(classifyIdentityPerspective(observation)).toBe("observed");
    expect(
      service.searchIdentity({
        subjectActorId: "agent:grok",
        authorActorId: "agent:grok"
      })
    ).toEqual([]);
  });

  it("rejects observation semantics that would masquerade as self or a non-note identity", () => {
    const fixture = createMemoryTestFixture();
    const service = new GroupXMemoryService(
      fixture.store,
      new SequenceClock("2026-08-11T01:00:00.000Z")
    );

    expectCode(
      () =>
        service.rememberObservedIdentity({
          authorActorId: "agent:grok",
          subjectActorId: "agent:grok",
          content: "not an observation"
        }),
      "INVALID_ENVELOPE"
    );
    expectCode(
      () =>
        service.rememberIdentity({
          subjectActorId: "agent:grok",
          authorActorId: "agent:codex",
          kind: "preference",
          content: "should remain an observation",
          sourceKind: "adapter"
        }),
      "INVALID_ENVELOPE"
    );
  });

  it("supersedes and retracts identity through explicit helpers without losing authorship", () => {
    const fixture = createMemoryTestFixture();
    const service = new GroupXMemoryService(
      fixture.store,
      new SequenceClock(
        "2026-08-11T01:00:00.000Z",
        "2026-08-11T02:00:00.000Z",
        "2026-08-11T03:00:00.000Z"
      )
    );
    const first = service.rememberUserAuthoredIdentity({
      authorActorId: "user:web",
      subjectActorId: "agent:kimi",
      kind: "preference",
      content: "Prefer short answers"
    });
    const replacement = service.supersedeUserAuthoredIdentity(first.identityId, {
      authorActorId: "user:web",
      subjectActorId: "agent:kimi",
      kind: "preference",
      content: "Prefer concise evidence-backed answers"
    });
    expect(replacement).toMatchObject({
      authorActorId: "user:web",
      subjectActorId: "agent:kimi",
      supersedesIdentityId: first.identityId,
      status: "active"
    });

    const retracted = service.retractIdentity(replacement.identityId);
    expect(retracted).toMatchObject({
      authorActorId: "user:web",
      subjectActorId: "agent:kimi",
      status: "retracted",
      retractedAt: "2026-08-11T03:00:00.000Z"
    });
  });
});
