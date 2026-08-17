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
  it("reports the single-room character budget and manually compacts only old messages", async () => {
    const fixture = createMemoryTestFixture();
    for (let index = 0; index < 16; index += 1) {
      appendMessage(fixture, {
        eventId: `evt_manual_context_${index}`,
        actorId: index % 2 === 0 ? "user:web" : "agent:codex",
        content: `manual-context-${index} ${"m".repeat(80)}`
      });
    }
    fixture.store.appendDurableEvent({
      eventId: "evt_manual_context_tool",
      roomId: "room:main",
      eventType: "tool.progress.recorded",
      actorId: "agent:codex",
      correlationId: "corr_manual_context",
      body: { turnId: "turn:manual", details: { output: "not context" } }
    });
    const summarizer = new RecordingSummarizer();
    const beforeCompaction: Array<{ roomId: string; throughSeq: number }> = [];
    const engine = new RoomContextEngine({
      store: fixture.store,
      summarizer,
      maxChars: 10_000,
      maxCompactionInputChars: 20_000,
      maxSummaryChars: 500,
      manualRetainMessages: 4,
      beforeCompaction(input) {
        beforeCompaction.push({ roomId: input.roomId, throughSeq: input.throughSeq });
      }
    });

    const before = engine.inspectUsage("room:main");
    expect(before).toMatchObject({
      roomId: "room:main",
      throughSeq: 17,
      maxCharacters: 10_000,
      compactionTriggerCharacters: 7_500,
      uncompactedMessageCount: 16,
      compactable: true
    });
    expect(before.estimatedCharacters).toBeGreaterThan(1_000);

    const result = await engine.compactNow("room:main");

    expect(result.compacted).toBe(true);
    expect(summarizer.calls).toHaveLength(1);
    expect(summarizer.calls[0]!.messages).toHaveLength(12);
    expect(summarizer.calls[0]!.messages.at(-1)?.eventId).toBe("evt_manual_context_11");
    expect(beforeCompaction).toEqual([
      { roomId: "room:main", throughSeq: summarizer.calls[0]!.throughSeq }
    ]);
    expect(JSON.stringify(summarizer.calls)).not.toContain("not context");
    expect(result.usage).toMatchObject({
      throughSeq: 17,
      uncompactedMessageCount: 4,
      compactable: false
    });
    expect(result.usage.summaryThroughSeq).toBe(
      summarizer.calls[0]!.messages.at(-1)!.seq
    );
    expect(fixture.store.countEvents()).toBe(17);
  });

  it("does not send durable reasoning or tool progress records to the compaction Agent", async () => {
    const fixture = createMemoryTestFixture();
    for (let index = 0; index < 10; index += 1) {
      appendMessage(fixture, {
        eventId: `evt_reasoning_engine_${index}`,
        actorId: index % 2 === 0 ? "user:web" : "agent:grok",
        content: `history-${index} ${"h".repeat(180)}`
      });
    }
    fixture.store.appendDurableEvent({
      eventId: "evt_reasoning_engine_record",
      roomId: "room:main",
      eventType: "turn.reasoning.recorded",
      actorId: "agent:grok",
      correlationId: "corr_reasoning_engine",
      body: {
        turnId: "turn_reasoning_engine",
        content: "PRIVATE_REASONING_MUST_NOT_BE_COMPACTED",
        terminalStatus: "completed"
      }
    });
    fixture.store.appendDurableEvent({
      eventId: "evt_tool_progress_engine_record",
      roomId: "room:main",
      eventType: "tool.progress.recorded",
      actorId: "agent:grok",
      correlationId: "corr_reasoning_engine",
      body: {
        turnId: "turn_reasoning_engine",
        nativeType: "tool.completed",
        toolCallId: "call-engine",
        details: { output: "PRIVATE_TOOL_PROGRESS_MUST_NOT_BE_COMPACTED" }
      }
    });
    const current = appendMessage(fixture, {
      eventId: "evt_reasoning_engine_current",
      actorId: "user:web",
      content: "current after reasoning",
      targets: ["agent:codex"]
    });
    const summarizer = new RecordingSummarizer();
    const engine = new RoomContextEngine({
      store: fixture.store,
      summarizer,
      maxChars: 2_100,
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
    const compactedEventIds = summarizer.calls
      .flatMap((call) => call.messages)
      .map((message) => message.eventId);
    expect(compactedEventIds).not.toContain("evt_reasoning_engine_record");
    expect(compactedEventIds).not.toContain("evt_tool_progress_engine_record");
    expect(JSON.stringify(summarizer.calls)).not.toContain(
      "PRIVATE_REASONING_MUST_NOT_BE_COMPACTED"
    );
    expect(JSON.stringify(summarizer.calls)).not.toContain(
      "PRIVATE_TOOL_PROGRESS_MUST_NOT_BE_COMPACTED"
    );
    expect(packet.text).not.toContain("PRIVATE_REASONING_MUST_NOT_BE_COMPACTED");
    expect(packet.text).not.toContain("PRIVATE_TOOL_PROGRESS_MUST_NOT_BE_COMPACTED");
  });

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
      maxChars: 2_100,
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
