import { afterEach, describe, expect, it } from "vitest";

import { GroupXError } from "../../../src/core/errors.js";
import { RoomContextEngine } from "../../../src/memory/context-engine.js";
import type {
  RoomCompactionRequest,
  RoomContextSummarizer
} from "../../../src/memory/context-engine.js";
import {
  appendMessage,
  cleanupMemoryTestFixtures,
  createMemoryTestFixture
} from "./test-fixture.js";

class RecordingSummarizer implements RoomContextSummarizer {
  readonly calls: RoomCompactionRequest[] = [];
  fail = false;
  failWithSessionUnavailable = 0;

  async compact(input: RoomCompactionRequest) {
    this.calls.push(input);
    if (this.failWithSessionUnavailable > 0) {
      this.failWithSessionUnavailable -= 1;
      throw new GroupXError("SESSION_NOT_AVAILABLE", "temporary compactor session failure");
    }
    if (this.fail) throw new Error("summarizer unavailable");
    return {
      generatorActorId: "agent:codex",
      content: input.previousSummary
        ? `Rolled checkpoint through ${input.throughSeq}`
        : `Initial checkpoint through ${input.throughSeq}`
    };
  }
}

afterEach(cleanupMemoryTestFixtures);

describe("RoomContextEngine", () => {
  it("compacts omitted old messages and keeps recent verbatim context", async () => {
    const fixture = createMemoryTestFixture();
    const events = Array.from({ length: 10 }, (_, index) =>
      appendMessage(fixture, {
        eventId: `evt_engine_${index}`,
        actorId: index % 2 === 0 ? "user:web" : "agent:grok",
        content: `message-${index} ${"x".repeat(180)}`,
        occurredAt: `2026-08-11T00:${String(index).padStart(2, "0")}:00.000Z`
      })
    );
    const current = appendMessage(fixture, {
      eventId: "evt_engine_current",
      actorId: "user:web",
      content: "current room request",
      targets: ["agent:codex"]
    });
    const summarizer = new RecordingSummarizer();
    const engine = new RoomContextEngine({
      store: fixture.store,
      summarizer,
      maxChars: 1_800,
      maxCompactionInputChars: 2_000,
      maxSummaryChars: 300
    });

    const packet = await engine.prepare({
      roomId: "room:main",
      targetActorId: "agent:codex",
      throughSeq: current.seq,
      currentEvent: current
    });

    expect(summarizer.calls.length).toBeGreaterThan(0);
    expect(summarizer.calls[0]!.messages[0]!.eventId).toBe(events[0]!.eventId);
    expect(packet.omitted.unreadTranscript).toBe(0);
    expect(packet.sections.generatedSummary).toHaveLength(1);
    expect(packet.sections.currentMessage.content).toBe("current room request");
    expect(fixture.store.getActiveSummary("room:main")?.throughSeq).toBe(
      packet.sections.generatedSummary[0]!.seq
    );
    expect(fixture.store.countEvents()).toBe(11);
  });

  it("compacts at the soft target before reaching the configured hard ceiling", async () => {
    const fixture = createMemoryTestFixture();
    for (let index = 0; index < 5; index += 1) {
      appendMessage(fixture, {
        eventId: `evt_soft_target_${index}`,
        actorId: "user:web",
        content: `soft-target-history-${index} ${"s".repeat(220)}`
      });
    }
    const current = appendMessage(fixture, {
      eventId: "evt_soft_target_current",
      actorId: "user:web",
      content: "current after soft target",
      targets: ["agent:codex"]
    });
    const summarizer = new RecordingSummarizer();
    const engine = new RoomContextEngine({
      store: fixture.store,
      summarizer,
      maxChars: 3_000,
      compactionTriggerChars: 1_400,
      maxCompactionInputChars: 2_500,
      maxSummaryChars: 300
    });

    const packet = await engine.prepare({
      roomId: "room:main",
      targetActorId: "agent:codex",
      throughSeq: current.seq,
      currentEvent: current
    });

    expect(summarizer.calls.length).toBeGreaterThan(0);
    expect(packet.maxChars).toBe(1_400);
    expect(packet.charCount).toBeLessThanOrEqual(1_400);
    expect(packet.omitted.unreadTranscript).toBe(0);
  });

  it("uses the hard ceiling for required context that cannot be compacted", async () => {
    const fixture = createMemoryTestFixture();
    const current = appendMessage(fixture, {
      eventId: "evt_hard_ceiling_current",
      actorId: "user:web",
      content: `large-current ${"c".repeat(1_500)}`,
      targets: ["agent:codex"]
    });
    const summarizer = new RecordingSummarizer();
    const engine = new RoomContextEngine({
      store: fixture.store,
      summarizer,
      maxChars: 3_000,
      compactionTriggerChars: 1_200
    });

    const packet = await engine.prepare({
      roomId: "room:main",
      targetActorId: "agent:codex",
      throughSeq: current.seq,
      currentEvent: current
    });

    expect(summarizer.calls).toHaveLength(0);
    expect(packet.maxChars).toBe(3_000);
    expect(packet.charCount).toBeGreaterThan(1_200);
    expect(packet.charCount).toBeLessThanOrEqual(3_000);
  });

  it("does not advance or replace the durable checkpoint when compaction fails", async () => {
    const fixture = createMemoryTestFixture();
    for (let index = 0; index < 8; index += 1) {
      appendMessage(fixture, {
        eventId: `evt_failure_${index}`,
        actorId: "user:web",
        content: `history-${index} ${"y".repeat(220)}`
      });
    }
    const current = appendMessage(fixture, {
      eventId: "evt_failure_current",
      actorId: "user:web",
      content: "current",
      targets: ["agent:codex"]
    });
    const summarizer = new RecordingSummarizer();
    summarizer.fail = true;
    const engine = new RoomContextEngine({
      store: fixture.store,
      summarizer,
      maxChars: 1_400,
      maxCompactionInputChars: 2_000,
      maxSummaryChars: 300
    });

    await expect(
      engine.prepare({
        roomId: "room:main",
        targetActorId: "agent:codex",
        throughSeq: current.seq,
        currentEvent: current
      })
    ).rejects.toMatchObject({ code: "CONTEXT_BUDGET_EXCEEDED" });
    expect(fixture.store.getActiveSummary("room:main")).toBeUndefined();
    expect(fixture.store.getDeliveryCursor("agent:codex", "room:main")).toBeUndefined();
    expect(fixture.store.countEvents()).toBe(9);
  });

  it("publishes bounded compaction progress and retries only a pre-persist transient failure", async () => {
    const fixture = createMemoryTestFixture();
    for (let index = 0; index < 8; index += 1) {
      appendMessage(fixture, {
        eventId: `evt_retry_progress_${index}`,
        actorId: "user:web",
        content: `retry-history-${index} ${"r".repeat(220)}`
      });
    }
    const current = appendMessage(fixture, {
      eventId: "evt_retry_progress_current",
      actorId: "user:web",
      content: "current",
      targets: ["agent:codex"]
    });
    const summarizer = new RecordingSummarizer();
    summarizer.failWithSessionUnavailable = 1;
    const progress: Array<{ phase: string; attempt: number }> = [];
    const engine = new RoomContextEngine({
      store: fixture.store,
      summarizer,
      maxChars: 1_400,
      maxCompactionInputChars: 2_000,
      maxSummaryChars: 300,
      compactionAttempts: 2,
      compactionRetryBaseMs: 1,
      onProgress(event) {
        progress.push({ phase: event.phase, attempt: event.attempt });
      }
    });

    const packet = await engine.prepare({
      roomId: "room:main",
      targetActorId: "agent:codex",
      throughSeq: current.seq,
      currentEvent: current
    });

    expect(packet.sections.generatedSummary).toHaveLength(1);
    expect(progress.slice(0, 4)).toEqual([
      { phase: "started", attempt: 1 },
      { phase: "retrying", attempt: 1 },
      { phase: "started", attempt: 2 },
      { phase: "completed", attempt: 2 }
    ]);
  });
});
