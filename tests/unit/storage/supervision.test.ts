import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SUPERVISION_WATCH_KIND } from "../../../src/core/supervision.js";
import { GroupXError } from "../../../src/core/errors.js";
import { SqliteGroupXStore } from "../../../src/storage/sqlite-store.js";
import type { AcceptMessageInput, TurnTargetInput } from "../../../src/storage/types.js";

interface Fixture {
  directory: string;
  store: SqliteGroupXStore;
}

const fixtures = new Set<Fixture>();

function seedBindings(store: SqliteGroupXStore): void {
  const seeds = [
    ["user:web", "web", "instance:web", "binding:web"],
    ["agent:codex", "codex", "instance:codex", "binding:codex"],
    ["agent:grok", "grok", "instance:grok", "binding:grok"]
  ] as const;
  for (const [actorId, adapterId, instanceId, bindingId] of seeds) {
    store.createAgentInstance({
      instanceId,
      actorId,
      adapterId,
      ...(actorId.startsWith("agent:") ? { transport: "structured" as const } : {}),
      processStartedAt: "2026-08-11T00:00:00.000Z",
      status: "ready"
    });
    store.createSessionBinding({
      bindingId,
      instanceId,
      actorId,
      protocol: adapterId === "web" ? "local-rest" : "test-protocol",
      ...(actorId.startsWith("agent:") ? { transport: "structured" as const } : {}),
      protocolVersion: "test/1",
      status: "ready",
      capabilities: { prompt: true },
      createdAt: "2026-08-11T00:00:00.000Z",
      lastReadyAt: "2026-08-11T00:00:00.000Z"
    });
  }
}

function createFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "groupx-supervision-store-"));
  const fixture: Fixture = {
    directory,
    store: undefined as unknown as SqliteGroupXStore
  };
  fixture.store = new SqliteGroupXStore(join(directory, "groupx.db"));
  seedBindings(fixture.store);
  fixtures.add(fixture);
  return fixture;
}

function target(actorId: "agent:codex" | "agent:grok"): TurnTargetInput {
  return { actorId, adapterId: actorId.slice("agent:".length), transport: "structured" };
}

function pairInput(clientCommandId: string): AcceptMessageInput {
  return {
    sourceBindingId: "binding:web",
    clientCommandId,
    roomId: "room:main",
    targets: [target("agent:codex")],
    content: "implement the feature",
    supervision: {
      mode: "live_steer",
      observers: [target("agent:grok")]
    }
  };
}

function expectGroupXCode(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(GroupXError);
    expect((error as GroupXError).code).toBe(code);
    return;
  }
  throw new Error(`Expected GroupXError(${code})`);
}

afterEach(() => {
  for (const fixture of fixtures) {
    fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
  fixtures.clear();
});

describe("supervision pairing persistence", () => {
  it("creates worker and watch turns on one correlation without reusing the task as the observer prompt", () => {
    const fixture = createFixture();
    const accepted = fixture.store.acceptMessage(pairInput("pair-1"));

    expect(accepted.turns).toEqual([
      expect.objectContaining({ target: "agent:codex", status: "queued" })
    ]);
    expect(accepted.watchTurns).toEqual([
      expect.objectContaining({ target: "agent:grok", status: "queued" })
    ]);
    const worker = fixture.store.getTurn(accepted.turns[0]!.turnId)!;
    const observer = fixture.store.getTurn(accepted.watchTurns![0]!.turnId)!;
    expect(worker.rootCorrelationId).toBe(accepted.correlationId);
    expect(observer.rootCorrelationId).toBe(accepted.correlationId);
    expect(fixture.store.getSupervisionTurnRole(worker.turnId)).toBe("worker");
    expect(fixture.store.getSupervisionTurnRole(observer.turnId)).toBe("observer");

    const task = fixture.store.getEvent(accepted.messageEventId)!;
    const watch = fixture.store.getEvent(accepted.watchEventId!)!;
    const pair = fixture.store.getEvent(accepted.pairEventId!)!;
    expect(task.body).toEqual({ content: "implement the feature" });
    expect(watch.body).toMatchObject({ kind: SUPERVISION_WATCH_KIND });
    expect((watch.body as { content: string }).content).toContain("not a second executor");
    expect((watch.body as { content: string }).content).not.toBe("implement the feature");
    expect(pair.eventType).toBe("supervision.paired");
    expect(pair.provenance?.sourceKind).toBe("supervision");
    expect(fixture.store.getSchemaVersion()).toBe(8);
  });

  it("rejects an overlapping pair and keeps steer counts visible", () => {
    const fixture = createFixture();
    expectGroupXCode(
      () =>
        fixture.store.acceptMessage({
          ...pairInput("overlap"),
          targets: [target("agent:codex"), target("agent:grok")]
        }),
      "SUPERVISION_PAIR_INVALID"
    );

    const accepted = fixture.store.acceptMessage(pairInput("steer-limit"));
    const subject = accepted.turns[0]!.turnId;
    expect(fixture.store.incrementSteerCount(subject, 2)).toBe(1);
    expect(fixture.store.incrementSteerCount(subject, 2)).toBe(2);
    expectGroupXCode(() => fixture.store.incrementSteerCount(subject, 2), "STEER_LIMIT_REACHED");
    expect(fixture.store.getSteerCount(subject)).toBe(2);
  });

  it("does not register dated-memory sources for observer turns", () => {
    const fixture = createFixture();
    const accepted = fixture.store.acceptMessage(pairInput("dated-skip"));
    const workerTurn = fixture.store.getTurn(accepted.turns[0]!.turnId)!;
    const observerTurn = fixture.store.getTurn(accepted.watchTurns![0]!.turnId)!;

    const complete = (turnId: string, actorId: string, bindingId: string, instanceId: string) => {
      const turn = fixture.store.getTurn(turnId)!;
      const source = fixture.store.getEvent(turn.sourceEventId)!;
      const claim = fixture.store.claimNextQueuedTurn({
        targetActorId: actorId,
        bindingId,
        instanceId,
        contextThroughSeq: source.seq,
        expectedTurnId: turnId,
        expectedTransport: "structured"
      })!;
      fixture.store.markPromptInvoked(claim.attempt.attemptId);
      fixture.store.markAttemptRunning(claim.attempt.attemptId, `native-${turnId}`);
      return fixture.store.terminalizeTurn({
        turnId,
        attemptId: claim.attempt.attemptId,
        status: "completed",
        content: `${actorId} done`,
        occurredAt: "2026-08-11T00:00:03.000Z"
      });
    };

    const workerTerminal = complete(
      workerTurn.turnId,
      "agent:codex",
      "binding:codex",
      "instance:codex"
    );
    const observerTerminal = complete(
      observerTurn.turnId,
      "agent:grok",
      "binding:grok",
      "instance:grok"
    );

    expect(workerTerminal.datedMemoryRollup?.pendingTurns).toBe(1);
    expect(observerTerminal.datedMemoryRollup).toBeUndefined();
    expect(
      fixture.store.listAgentDatedMemorySources({
        roomId: "room:main",
        actorId: "agent:grok",
        localDate: "2026-08-11"
      })
    ).toEqual([]);
    expect(
      fixture.store.listEvents({ roomId: "room:main", afterSeq: 0, limit: 200 }).events.some(
        (event) => event.eventType.startsWith("approval.")
      )
    ).toBe(false);
  });
});
