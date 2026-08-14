import { describe, expect, it } from "vitest";

import { GroupXError } from "../../../src/core/errors.js";
import {
  AGENT_DATED_MEMORY_NO_CONTENT,
  AgentDatedMemoryEngine,
  type AgentDatedMemorySummarizer,
  type AgentDatedMemorySummaryRequest
} from "../../../src/memory/dated-memory-engine.js";
import { SqliteGroupXStore } from "../../../src/storage/sqlite-store.js";
import type { AgentDatedMemoryRollupRecord } from "../../../src/storage/types.js";

class RecordingSummarizer implements AgentDatedMemorySummarizer {
  readonly requests: AgentDatedMemorySummaryRequest[] = [];
  outputs: string[] = ["- kept one durable result"];
  failures = 0;
  onSummarize?: (input: AgentDatedMemorySummaryRequest) => void | Promise<void>;

  async summarize(input: AgentDatedMemorySummaryRequest) {
    this.requests.push(input);
    await this.onSummarize?.(input);
    if (this.failures > 0) {
      this.failures -= 1;
      throw new GroupXError("SESSION_NOT_AVAILABLE", "temporary owner unavailable");
    }
    return {
      content: this.outputs.shift() ?? "- updated durable result",
      generatorActorId: input.actorId
    };
  }
}

function seed(store: SqliteGroupXStore): void {
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
    status: "ready"
  });
  store.createAgentInstance({
    instanceId: "instance:codex",
    actorId: "agent:codex",
    adapterId: "codex",
    transport: "structured",
    status: "ready"
  });
  store.createSessionBinding({
    bindingId: "binding:codex",
    instanceId: "instance:codex",
    actorId: "agent:codex",
    protocol: "fixture",
    transport: "structured",
    status: "ready"
  });
}

function completeTurn(
  store: SqliteGroupXStore,
  index: number,
  occurredAt: string,
  content = `message ${index}`,
  response = `response ${index}`
): AgentDatedMemoryRollupRecord {
  const accepted = store.acceptMessage({
    sourceBindingId: "binding:web",
    clientCommandId: `dated-${index}`,
    roomId: "room:main",
    targets: [{ actorId: "agent:codex", adapterId: "codex", transport: "structured" }],
    content,
    occurredAt
  });
  const turnId = accepted.turns[0]!.turnId;
  const source = store.getEvent(accepted.messageEventId)!;
  const claim = store.claimNextQueuedTurn({
    targetActorId: "agent:codex",
    bindingId: "binding:codex",
    instanceId: "instance:codex",
    contextThroughSeq: source.seq,
    expectedTurnId: turnId,
    expectedTransport: "structured",
    claimedAt: occurredAt
  })!;
  store.markPromptInvoked(claim.attempt.attemptId, occurredAt);
  store.markAttemptRunning(claim.attempt.attemptId, `native-${index}`, occurredAt);
  return store.terminalizeTurn({
    turnId,
    attemptId: claim.attempt.attemptId,
    status: "completed",
    content: response,
    reasoning: `private reasoning ${index}`,
    toolProgress: [
      { occurredAt, nativeType: "tool.completed", details: { secretTool: index } }
    ],
    occurredAt
  }).datedMemoryRollup!;
}

describe("AgentDatedMemoryEngine", () => {
  it("waits for the 8-turn threshold and five-minute quiet window", async () => {
    const store = new SqliteGroupXStore(":memory:");
    seed(store);
    const summarizer = new RecordingSummarizer();
    let now = new Date("2026-08-11T12:00:00.000Z");
    const engine = new AgentDatedMemoryEngine({ store, summarizer, now: () => now });
    let rollup: AgentDatedMemoryRollupRecord | undefined;
    for (let index = 1; index <= 8; index += 1) {
      rollup = completeTurn(store, index, now.toISOString());
      engine.noteCompleted(rollup);
      now = new Date(now.getTime() + 1_000);
    }

    now = new Date("2026-08-11T12:04:00.000Z");
    await expect(engine.flushNow(rollup!)).resolves.toBe("skipped");
    expect(summarizer.requests).toHaveLength(0);

    now = new Date("2026-08-11T12:06:00.000Z");
    await expect(engine.flushNow(rollup!)).resolves.toBe("completed");
    expect(summarizer.requests).toHaveLength(1);
    expect(summarizer.requests[0]!.sources).toHaveLength(8);
    expect(JSON.stringify(summarizer.requests[0]!.sources)).not.toContain("private reasoning");
    expect(JSON.stringify(summarizer.requests[0]!.sources)).not.toContain("secretTool");
    expect(store.listAgentDatedMemoryRollups({ pendingOnly: true })).toEqual([]);
    expect(store.searchMemory({
      scopeType: "agent",
      scopeId: "agent:codex",
      agentMemoryType: "dated"
    })).toEqual([
      expect.objectContaining({ sourceKind: "automatic_rollup", kind: "summary" })
    ]);
    await engine.close();
    store.close();
  });

  it("uses the 16k source-character threshold with the same quiet window", async () => {
    const store = new SqliteGroupXStore(":memory:");
    seed(store);
    const summarizer = new RecordingSummarizer();
    let now = new Date("2026-08-11T12:00:00.000Z");
    const engine = new AgentDatedMemoryEngine({ store, summarizer, now: () => now });
    const rollup = completeTurn(
      store,
      1,
      now.toISOString(),
      "m".repeat(8_000),
      "r".repeat(8_000)
    );

    now = new Date("2026-08-11T12:04:59.000Z");
    await expect(engine.flushNow(rollup)).resolves.toBe("skipped");
    now = new Date("2026-08-11T12:05:01.000Z");
    await expect(engine.flushNow(rollup)).resolves.toBe("completed");
    expect(summarizer.requests).toHaveLength(1);
    await engine.close();
    store.close();
  });

  it("supersedes the same day's record and checkpoints a semantically empty batch", async () => {
    const store = new SqliteGroupXStore(":memory:");
    seed(store);
    const summarizer = new RecordingSummarizer();
    summarizer.outputs = ["- first fact", "- first fact\n- second decision", AGENT_DATED_MEMORY_NO_CONTENT];
    let now = new Date("2026-08-11T12:00:00.000Z");
    const engine = new AgentDatedMemoryEngine({
      store,
      summarizer,
      now: () => now,
      turnThreshold: 1,
      debounceMs: 1
    });

    const first = completeTurn(store, 1, now.toISOString());
    await engine.flushNow(first, { force: true });
    const firstMemory = store.searchMemory({ scopeType: "agent", includeHistory: false })[0]!;

    now = new Date("2026-08-11T13:00:00.000Z");
    const second = completeTurn(store, 2, now.toISOString());
    await engine.flushNow(second, { force: true });
    const activeAfterSecond = store.searchMemory({ scopeType: "agent", includeHistory: false });
    expect(activeAfterSecond).toHaveLength(1);
    expect(activeAfterSecond[0]).toMatchObject({
      content: "- first fact\n- second decision",
      supersedesMemoryId: firstMemory.memoryId
    });
    expect(summarizer.requests[1]!.previousMemory?.memoryId).toBe(firstMemory.memoryId);

    now = new Date("2026-08-11T14:00:00.000Z");
    const trivial = completeTurn(store, 3, now.toISOString(), "hello", "acknowledged");
    await engine.flushNow(trivial, { force: true });
    expect(store.searchMemory({ scopeType: "agent", includeHistory: false })).toEqual(
      activeAfterSecond
    );
    expect(store.listAgentDatedMemoryRollups({ pendingOnly: true })).toEqual([]);
    await engine.close();
    store.close();
  });

  it("re-reads a user-edited daily head after a summary compare-and-set conflict", async () => {
    const store = new SqliteGroupXStore(":memory:");
    seed(store);
    const summarizer = new RecordingSummarizer();
    summarizer.outputs = ["- initial", "- stale update", "- corrected update"];
    const now = new Date("2026-08-11T12:00:00.000Z");
    const engine = new AgentDatedMemoryEngine({
      store,
      summarizer,
      now: () => now,
      turnThreshold: 1,
      debounceMs: 1
    });

    const first = completeTurn(store, 1, now.toISOString());
    await expect(engine.flushNow(first, { force: true })).resolves.toBe("completed");
    const original = store.searchMemory({ scopeType: "agent" })[0]!;
    const second = completeTurn(store, 2, "2026-08-11T13:00:00.000Z");
    let editedId: string | undefined;
    summarizer.onSummarize = () => {
      if (editedId !== undefined) return;
      editedId = store.supersedeMemory(original.memoryId, {
        scopeType: "agent",
        scopeId: "agent:codex",
        agentMemoryType: "dated",
        kind: "summary",
        authorActorId: "user:web",
        subjectActorId: "agent:codex",
        content: "- user correction",
        sourceKind: "web",
        createdAt: "2026-08-11T13:01:00.000Z"
      }).memoryId;
    };

    await expect(engine.flushNow(second, { force: true })).resolves.toBe("failed");
    expect(store.listAgentDatedMemoryRollups({ pendingOnly: true })[0]?.memoryId).toBe(editedId);

    await expect(engine.flushNow(second, { force: true })).resolves.toBe("completed");
    expect(summarizer.requests.at(-1)?.previousMemory?.memoryId).toBe(editedId);
    expect(store.listAgentDatedMemoryRollups({ pendingOnly: true })).toEqual([]);
    await engine.close();
    store.close();
  });

  it("keeps failed generation pending, retries transient failures, and never changes the Turn", async () => {
    const store = new SqliteGroupXStore(":memory:");
    seed(store);
    const summarizer = new RecordingSummarizer();
    summarizer.failures = 3;
    let now = new Date("2026-08-11T12:00:00.000Z");
    const engine = new AgentDatedMemoryEngine({
      store,
      summarizer,
      now: () => now,
      attempts: 3,
      retryBaseMs: 1,
      turnThreshold: 1,
      debounceMs: 1
    });
    const rollup = completeTurn(store, 1, now.toISOString());
    const turnId = store.listTurns({ targetActorId: "agent:codex" })[0]!.turnId;

    await expect(engine.flushNow(rollup, { force: true })).resolves.toBe("failed");
    expect(summarizer.requests).toHaveLength(3);
    expect(store.getTurn(turnId)?.status).toBe("completed");
    expect(store.searchMemory({ scopeType: "agent" })).toEqual([]);
    const failed = store.listAgentDatedMemoryRollups({ pendingOnly: true })[0]!;
    expect(failed).toMatchObject({ failureCount: 1, lastErrorCode: "SESSION_NOT_AVAILABLE" });
    expect(failed.nextAttemptAt).toBeDefined();

    now = new Date(failed.nextAttemptAt!);
    await expect(engine.flushNow(failed)).resolves.toBe("completed");
    expect(store.getTurn(turnId)?.status).toBe("completed");
    await engine.close();
    store.close();
  });

  it("flushes a below-threshold prior date and supports a compaction cutoff", async () => {
    const store = new SqliteGroupXStore(":memory:");
    seed(store);
    const summarizer = new RecordingSummarizer();
    summarizer.outputs = ["- prior day", "- current day before checkpoint"];
    let now = new Date("2026-08-12T12:00:00.000Z");
    const engine = new AgentDatedMemoryEngine({
      store,
      summarizer,
      now: () => now,
      turnThreshold: 99,
      charThreshold: 999_999
    });
    const prior = completeTurn(store, 1, "2026-08-11T12:00:00.000Z");
    await expect(engine.flushNow(prior)).resolves.toBe("completed");

    const current = completeTurn(store, 2, now.toISOString());
    const source = store.listAgentDatedMemorySources({
      roomId: current.roomId,
      actorId: current.actorId,
      localDate: current.localDate
    })[0]!;
    await engine.flushBeforeCompaction({ roomId: "room:main", throughSeq: source.sourceSeq });
    expect(summarizer.requests).toHaveLength(2);
    expect(store.listAgentDatedMemoryRollups({ pendingOnly: true })).toEqual([]);
    await engine.close();
    store.close();
  });
});
