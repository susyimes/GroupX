import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AdapterRegistry } from "../../../src/adapters/registry.js";
import type {
  AdapterHealth,
  CancelResult,
  CapabilityReport,
  CliAdapter,
  LaunchProfile,
  NativeEvent,
  NativeSession,
  PromptInput
} from "../../../src/adapters/types.js";
import { GroupXBroker } from "../../../src/broker/broker.js";
import type {
  BrokerAgentController,
  BrokerContextProvider,
  BrokerDependencies,
  BrokerTurnLifecycle
} from "../../../src/broker/types.js";
import type { GroupXEnvelope } from "../../../src/core/envelope.js";
import { GroupXError } from "../../../src/core/errors.js";
import { SqliteGroupXStore } from "../../../src/storage/sqlite-store.js";

interface Deferred<T = void> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

type PromptHandler = (
  session: NativeSession,
  input: PromptInput
) => AsyncIterable<NativeEvent>;

class FakeAdapter implements CliAdapter {
  readonly adapterId: string;
  readonly actorId: string;
  readonly prompts: PromptInput[] = [];
  readonly cancellations: string[] = [];
  handler: PromptHandler;
  cancelHandler?: (nativeTurnId: string) => Promise<CancelResult>;
  cancelResult: CancelResult = {
    requested: true,
    supported: true,
    terminalObserved: false
  };

  constructor(adapterId: string, handler: PromptHandler = completedHandler(adapterId)) {
    this.adapterId = adapterId;
    this.actorId = `agent:${adapterId}`;
    this.handler = handler;
  }

  async probe(): Promise<CapabilityReport> {
    return {
      adapterId: this.adapterId,
      launchArgvShape: [],
      findings: [],
      generatedAt: "2026-08-11T00:00:00.000Z"
    };
  }

  async start(_input: LaunchProfile): Promise<NativeSession> {
    return sessionFor(this.adapterId);
  }

  async resume(_input: LaunchProfile & { nativeSessionId: string }): Promise<NativeSession> {
    return sessionFor(this.adapterId);
  }

  prompt(session: NativeSession, input: PromptInput): AsyncIterable<NativeEvent> {
    this.prompts.push(input);
    return this.handler(session, input);
  }

  async cancel(_session: NativeSession, nativeTurnId: string): Promise<CancelResult> {
    this.cancellations.push(nativeTurnId);
    if (this.cancelHandler) return await this.cancelHandler(nativeTurnId);
    return this.cancelResult;
  }

  async close(_session: NativeSession): Promise<void> {}

  health(): AdapterHealth {
    return {
      adapterId: this.adapterId,
      status: "ready",
      instanceId: `instance:${this.adapterId}`,
      nativeSessionAvailable: true,
      updatedAt: "2026-08-11T00:00:00.000Z"
    };
  }
}

function sessionFor(adapterId: string): NativeSession {
  return {
    adapterId,
    instanceId: `instance:${adapterId}`,
    bindingId: `binding:${adapterId}`,
    actorId: `agent:${adapterId}`,
    nativeSessionId: `session:${adapterId}`,
    protocol: "fixture",
    startedAt: "2026-08-11T00:00:00.000Z"
  };
}

function nativeEvent(
  adapterId: string,
  type: NativeEvent["type"],
  payload: unknown = {},
  suffix: string = type
): NativeEvent {
  return {
    adapterId,
    instanceId: `instance:${adapterId}`,
    nativeSessionId: `session:${adapterId}`,
    nativeTurnId: `native:${adapterId}`,
    nativeEventId: `native-event:${adapterId}:${suffix}`,
    type,
    payload,
    occurredAt: "2026-08-11T00:00:01.000Z"
  };
}

function completedHandler(adapterId: string): PromptHandler {
  return async function* (_session, input) {
    yield nativeEvent(adapterId, "turn.started", {}, `${input.turnId}:started`);
    yield nativeEvent(adapterId, "content.delta", { text: `${adapterId}:` }, `${input.turnId}:delta`);
    yield nativeEvent(
      adapterId,
      "turn.completed",
      { content: `${adapterId}:${input.content}` },
      `${input.turnId}:completed`
    );
  };
}

interface Fixture {
  directory: string;
  store: SqliteGroupXStore;
  registry: AdapterRegistry;
  adapters: Record<"codex" | "grok" | "kimi", FakeAdapter>;
  published: GroupXEnvelope[];
  broker: GroupXBroker;
}

const fixtures = new Set<Fixture>();

function seedBindings(store: SqliteGroupXStore): void {
  const seeds = [
    ["user:web", "web", "instance:web", "binding:web", "local-rest"],
    ["agent:codex", "codex", "instance:codex", "binding:codex", "fixture"],
    ["agent:grok", "grok", "instance:grok", "binding:grok", "fixture"],
    ["agent:kimi", "kimi", "instance:kimi", "binding:kimi", "fixture"]
  ] as const;
  for (const [actorId, adapterId, instanceId, bindingId, protocol] of seeds) {
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
      protocol,
      ...(actorId.startsWith("agent:") ? { transport: "structured" as const } : {}),
      status: "ready",
      capabilities: { prompt: true },
      createdAt: "2026-08-11T00:00:00.000Z"
    });
  }
}

function createFixture(input: {
  sessionFailureActor?: string;
  closeTimeoutMs?: number;
  nativeCancelTimeoutMs?: number;
  contextProvider?: BrokerContextProvider;
  contextController?: BrokerDependencies["contextController"];
  datedMemoryController?: BrokerDependencies["datedMemoryController"];
  turnLifecycle?: BrokerTurnLifecycle;
  publish?: (event: GroupXEnvelope) => void | Promise<void>;
  selectedTransport?: "direct" | "structured";
  acceptMessageLimits?: BrokerDependencies["acceptMessageLimits"];
  agentController?: BrokerAgentController;
} = {}): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "groupx-broker-"));
  const store = new SqliteGroupXStore(join(directory, "groupx.db"));
  seedBindings(store);
  const registry = new AdapterRegistry();
  const adapters = {
    codex: new FakeAdapter("codex"),
    grok: new FakeAdapter("grok"),
    kimi: new FakeAdapter("kimi")
  };
  for (const adapter of Object.values(adapters)) registry.register(adapter);
  const published: GroupXEnvelope[] = [];
  const fixture = {
    directory,
    store,
    registry,
    adapters,
    published,
    broker: undefined as unknown as GroupXBroker
  };
  fixture.broker = new GroupXBroker({
    store,
    adapters: registry,
    selectedTransport: input.selectedTransport ?? "structured",
    ...(input.acceptMessageLimits === undefined
      ? {}
      : { acceptMessageLimits: input.acceptMessageLimits }),
    sessions: {
      resolve: ({ actorId, adapterId }) => {
        if (actorId === input.sessionFailureActor) {
          throw new GroupXError("SESSION_NOT_AVAILABLE", "fixture session unavailable");
        }
        return sessionFor(String(adapterId));
      }
    },
    publisher: {
      publish: (event) => {
        published.push(event);
        return input.publish?.(event);
      }
    },
    contextProvider: input.contextProvider ?? {
      prepare: ({ sourceEvent }) => ({ contextThroughSeq: sourceEvent.seq })
    },
    ...(input.contextController === undefined
      ? {}
      : { contextController: input.contextController }),
    ...(input.datedMemoryController === undefined
      ? {}
      : { datedMemoryController: input.datedMemoryController }),
    ...(input.turnLifecycle === undefined ? {} : { turnLifecycle: input.turnLifecycle }),
    ...(input.agentController === undefined ? {} : { agentController: input.agentController }),
    clock: { now: () => "2026-08-11T00:00:02.000Z" },
    idFactory: (() => {
      let sequence = 0;
      return (prefix: string) => `${prefix}_fixture_${++sequence}`;
    })(),
    partialCheckpointChars: 4,
    ...(input.nativeCancelTimeoutMs === undefined
      ? {}
      : { nativeCancelTimeoutMs: input.nativeCancelTimeoutMs }),
    ...(input.closeTimeoutMs === undefined ? {} : { closeTimeoutMs: input.closeTimeoutMs })
  });
  fixtures.add(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures) {
    await fixture.broker.close();
    fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
  fixtures.clear();
});

describe.sequential("GroupXBroker acceptance, dispatch and terminal semantics", () => {
  it("bootstraps from one bounded room snapshot and exposes only public Turn fields", async () => {
    const fixture = createFixture();
    const codexRelease = deferred();
    const grokRelease = deferred();
    fixture.adapters.codex.handler = async function* (_session, input) {
      yield nativeEvent("codex", "turn.started", {}, `${input.turnId}:start`);
      await codexRelease.promise;
      yield nativeEvent("codex", "turn.completed", { content: "main done" });
    };
    fixture.adapters.grok.handler = async function* (_session, input) {
      yield nativeEvent("grok", "turn.started", {}, `${input.turnId}:start`);
      await grokRelease.promise;
      yield nativeEvent("grok", "turn.completed", { content: "other done" });
    };
    const main = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      roomId: "room:main",
      request: { clientCommandId: "bootstrap-main", to: ["agent:codex"], content: "main" }
    });
    const other = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      roomId: "room:other",
      request: { clientCommandId: "bootstrap-other", to: ["agent:grok"], content: "other" }
    });
    await waitUntil(
      () =>
        fixture.store.getTurn(main.turns[0]!.turnId)?.status === "running" &&
        fixture.store.getTurn(other.turns[0]!.turnId)?.status === "running"
    );
    const legacyScan = vi
      .spyOn(fixture.store, "listEvents")
      .mockImplementation(() => {
        throw new Error("bootstrap must not scan event history");
      });

    const bootstrap = fixture.broker.bootstrap({ roomId: "room:main", recentLimit: 10 });
    legacyScan.mockRestore();

    expect(bootstrap.recentEvents.every((event) => event.roomId === "room:main")).toBe(true);
    expect(bootstrap.activeTurns).toEqual([
      {
        turnId: main.turns[0]!.turnId,
        targetActorId: "agent:codex",
        status: "running",
        sourceEventId: main.messageEventId
      }
    ]);
    expect(bootstrap.activeTurns[0]).not.toHaveProperty("adapterId");
    expect(bootstrap.activeTurns[0]).not.toHaveProperty("bindingId");
    expect(bootstrap.activeTurns.map((turn) => turn.turnId)).not.toContain(other.turns[0]!.turnId);

    codexRelease.resolve();
    grokRelease.resolve();
    await fixture.broker.waitForIdle();
  });

  it("atomically fans out from the supplied binding and runs different actors in parallel", async () => {
    const fixture = createFixture();
    const codexRelease = deferred();
    const grokRelease = deferred();
    fixture.adapters.codex.handler = async function* (_session, input) {
      yield nativeEvent("codex", "turn.started", {}, `${input.turnId}:start`);
      await codexRelease.promise;
      yield nativeEvent("codex", "turn.completed", { content: "codex done" });
    };
    fixture.adapters.grok.handler = async function* (_session, input) {
      yield nativeEvent("grok", "turn.started", {}, `${input.turnId}:start`);
      await grokRelease.promise;
      yield nativeEvent("grok", "turn.completed", { content: "grok done" });
    };

    const accepted = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: {
        clientCommandId: "parallel",
        to: ["agent:codex", "agent:grok"],
        content: "review"
      }
    });
    await waitUntil(
      () => fixture.adapters.codex.prompts.length === 1 && fixture.adapters.grok.prompts.length === 1
    );
    const source = fixture.store.getEvent(accepted.messageEventId)!;
    expect(source.actorId).toBe("user:web");
    expect(accepted.turns).toHaveLength(2);
    expect(fixture.store.listTurns().map((turn) => turn.status)).toEqual(["running", "running"]);

    codexRelease.resolve();
    grokRelease.resolve();
    await fixture.broker.waitForIdle();
    expect(fixture.store.listTurns().every((turn) => turn.status === "completed")).toBe(true);
  });

  it("does not publish or enqueue a replayed client command twice", async () => {
    const fixture = createFixture();
    const input = {
      bindingId: "binding:web",
      request: {
        clientCommandId: "replay",
        to: ["agent:codex"],
        content: "once"
      }
    } as const;
    const first = await fixture.broker.acceptMessage(input);
    await fixture.broker.waitForIdle();
    const promptCount = fixture.adapters.codex.prompts.length;
    const eventCount = fixture.store.countEvents();
    const publishCount = fixture.published.length;

    const replay = await fixture.broker.acceptMessage(input);
    await fixture.broker.waitForIdle();
    expect(replay).toEqual(first);
    expect(fixture.adapters.codex.prompts).toHaveLength(promptCount);
    expect(fixture.store.countEvents()).toBe(eventCount);
    expect(fixture.published).toHaveLength(publishCount);
  });

  it("single-flights and replays an explicit room compaction command", async () => {
    const release = deferred<import("../../../src/memory/types.js").RoomContextCompactionResult>();
    const usage = {
      roomId: "room:main",
      throughSeq: 20,
      estimatedCharacters: 128_000,
      maxCharacters: 256_000,
      compactionTriggerCharacters: 192_000,
      utilizationPercent: 50,
      uncompactedMessageCount: 18,
      compactable: true
    } as const;
    const compactNow = vi.fn(async () => await release.promise);
    const fixture = createFixture({
      contextController: {
        inspectUsage: () => usage,
        compactNow,
        resetNow: () => ({
          reset: false,
          throughSeq: usage.throughSeq,
          resetNativeSessions: false,
          usage
        })
      }
    });
    const command = {
      bindingId: "binding:web",
      clientCommandId: "context-command-1",
      roomId: "room:main"
    } as const;

    expect(fixture.broker.contextUsage()).toEqual(usage);
    const first = fixture.broker.compactContextFromBinding(command);
    const concurrent = fixture.broker.compactContextFromBinding(command);
    const result = { compacted: true, usage: { ...usage, compactable: false } };
    release.resolve(result);

    await expect(Promise.all([first, concurrent])).resolves.toEqual([result, result]);
    await expect(fixture.broker.compactContextFromBinding(command)).resolves.toEqual(result);
    expect(compactNow).toHaveBeenCalledTimes(1);
  });

  it("single-flights and replays an explicit room context reset command", async () => {
    const usage = {
      roomId: "room:main",
      throughSeq: 20,
      estimatedCharacters: 128_000,
      maxCharacters: 256_000,
      compactionTriggerCharacters: 192_000,
      utilizationPercent: 50,
      uncompactedMessageCount: 18,
      compactable: true
    } as const;
    const resetNow = vi.fn(() => ({
      reset: true,
      throughSeq: usage.throughSeq,
      resetNativeSessions: false,
      usage
    }));
    const fixture = createFixture({
      contextController: {
        inspectUsage: () => usage,
        compactNow: async () => ({ compacted: false, usage }),
        resetNow
      }
    });
    const command = {
      bindingId: "binding:web",
      clientCommandId: "context-reset-1",
      roomId: "room:main"
    } as const;

    const first = fixture.broker.resetContextFromBinding(command);
    const concurrent = fixture.broker.resetContextFromBinding(command);
    const [firstResult, concurrentResult] = await Promise.all([first, concurrent]);
    expect(firstResult).toEqual(concurrentResult);
    expect(firstResult.reset).toBe(true);
    await expect(fixture.broker.resetContextFromBinding(command)).resolves.toEqual(firstResult);
    expect(resetNow).toHaveBeenCalledTimes(1);
  });

  it("keeps one actor FIFO and persists only one response/terminal on duplicate native terminal", async () => {
    const fixture = createFixture();
    const firstRelease = deferred();
    fixture.adapters.codex.handler = async function* (_session, input) {
      yield nativeEvent("codex", "turn.started", {}, `${input.turnId}:start`);
      if (input.content === "first") await firstRelease.promise;
      yield nativeEvent("codex", "turn.completed", { content: input.content }, `${input.turnId}:one`);
      yield nativeEvent("codex", "turn.completed", { content: "duplicate" }, `${input.turnId}:two`);
    };

    const first = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: { clientCommandId: "fifo-1", to: ["agent:codex"], content: "first" }
    });
    await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: { clientCommandId: "fifo-2", to: ["agent:codex"], content: "second" }
    });
    await waitUntil(() => fixture.adapters.codex.prompts.length === 1);
    expect(fixture.store.listTurns({ status: "queued" })).toHaveLength(1);

    firstRelease.resolve();
    await fixture.broker.waitForIdle();
    expect(fixture.adapters.codex.prompts.map((prompt) => prompt.content)).toEqual([
      "first",
      "second"
    ]);
    const read = fixture.broker.readCorrelation({ correlationId: first.correlationId });
    expect(read.events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
    expect(read.events.filter((event) => event.type === "message.created")).toHaveLength(2);
  });

  it("broadcasts deltas transiently and stores a single final semantic response", async () => {
    const datedRollups: unknown[] = [];
    const fixture = createFixture({
      datedMemoryController: {
        noteCompleted(record) {
          datedRollups.push(record);
        }
      }
    });
    fixture.adapters.codex.handler = async function* (_session, input) {
      yield nativeEvent("codex", "turn.started", {}, `${input.turnId}:start`);
      yield nativeEvent("codex", "content.delta", { text: "ab" }, `${input.turnId}:1`);
      yield nativeEvent(
        "codex",
        "reasoning.delta",
        { text: "first thought\n" },
        `${input.turnId}:reasoning-1`
      );
      yield nativeEvent(
        "codex",
        "tool.started",
        { server: "groupx", tool: "memory_search", status: "in_progress" },
        "tool-call-1"
      );
      yield nativeEvent(
        "codex",
        "tool.completed",
        { status: "completed" },
        "tool-call-1"
      );
      yield nativeEvent(
        "codex",
        "reasoning.delta",
        { text: "second thought" },
        `${input.turnId}:reasoning-2`
      );
      yield nativeEvent("codex", "content.delta", { text: "cd" }, `${input.turnId}:2`);
      yield nativeEvent("codex", "turn.completed", {}, `${input.turnId}:done`);
    };
    const accepted = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: { clientCommandId: "delta", to: ["agent:codex"], content: "stream" }
    });
    await fixture.broker.waitForIdle();

    const transient = fixture.published.filter(
      (event) => event.type === "turn.content.delta" && event.durability === "transient"
    );
    expect(transient).toHaveLength(2);
    const transientReasoning = fixture.published.filter(
      (event) => event.type === "turn.reasoning.delta" && event.durability === "transient"
    );
    expect(transientReasoning).toHaveLength(2);
    const toolProgress = fixture.published.filter(
      (event) => event.type === "tool.progress" && event.durability === "transient"
    );
    expect(toolProgress).toHaveLength(2);
    expect(toolProgress[0]?.body).toMatchObject({
      turnId: accepted.turns[0]?.turnId,
      nativeType: "tool.started",
      toolCallId: "native-event:codex:tool-call-1",
      details: { server: "groupx", tool: "memory_search", status: "in_progress" }
    });
    expect(toolProgress[1]?.body).toMatchObject({
      nativeType: "tool.completed",
      toolCallId: "native-event:codex:tool-call-1",
      details: { status: "completed" }
    });
    const read = fixture.broker.readCorrelation({ correlationId: accepted.correlationId });
    const reasoningRecords = read.events.filter(
      (event) => event.type === "turn.reasoning.recorded"
    );
    expect(reasoningRecords).toHaveLength(1);
    expect(reasoningRecords[0]).toMatchObject({
      durability: "durable",
      body: {
        turnId: accepted.turns[0]?.turnId,
        content: "first thought\nsecond thought",
        terminalStatus: "completed"
      }
    });
    const durableToolProgress = read.events.filter(
      (event) => event.type === "tool.progress.recorded"
    );
    expect(durableToolProgress).toHaveLength(2);
    expect(durableToolProgress[0]).toMatchObject({
      durability: "durable",
      body: {
        turnId: accepted.turns[0]?.turnId,
        nativeType: "tool.started",
        toolCallId: "native-event:codex:tool-call-1",
        details: { server: "groupx", tool: "memory_search", status: "in_progress" }
      }
    });
    expect(durableToolProgress[1]?.body).toMatchObject({
      nativeType: "tool.completed",
      toolCallId: "native-event:codex:tool-call-1",
      details: { status: "completed" }
    });
    const responses = read.events.filter(
      (event) =>
        event.type === "message.created" &&
        typeof event.body === "object" &&
        event.body !== null &&
        "turnId" in event.body
    );
    expect(responses).toHaveLength(1);
    expect(responses[0]?.body).toMatchObject({ content: "abcd" });
    expect(datedRollups).toEqual([
      expect.objectContaining({ actorId: "agent:codex", pendingTurns: 1 })
    ]);
    expect(read.events.filter((event) => event.type === "memory.remembered")).toHaveLength(0);
    expect(reasoningRecords[0]!.seq).toBeLessThan(durableToolProgress[0]!.seq!);
    expect(durableToolProgress[1]!.seq).toBeLessThan(responses[0]!.seq!);
  });

  it("retries the new FIFO head when async context preparation observes a cancelled head", async () => {
    const preparationEntered = deferred();
    const preparationRelease = deferred();
    const fixture = createFixture({
      contextProvider: {
        prepare: async ({ sourceEvent }) => {
          if ((sourceEvent.body as Record<string, unknown>).content === "stale head") {
            preparationEntered.resolve();
            await preparationRelease.promise;
          }
          return { contextThroughSeq: sourceEvent.seq };
        }
      }
    });
    const first = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: { clientCommandId: "stale-1", to: ["agent:codex"], content: "stale head" }
    });
    await preparationEntered.promise;
    const second = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: { clientCommandId: "stale-2", to: ["agent:codex"], content: "next head" }
    });

    await expect(fixture.broker.cancelTurn(first.turns[0]!.turnId)).resolves.toMatchObject({
      accepted: true,
      status: "cancelled"
    });
    preparationRelease.resolve();
    await fixture.broker.waitForIdle();

    expect(fixture.adapters.codex.prompts.map((prompt) => prompt.content)).toEqual(["next head"]);
    expect(fixture.store.getTurn(first.turns[0]!.turnId)?.status).toBe("cancelled");
    expect(fixture.store.getTurn(second.turns[0]!.turnId)?.status).toBe("completed");
  });

  it("rebuilds context when another lane supersedes its prepared summary checkpoint", async () => {
    let fixture!: Fixture;
    let preparationCalls = 0;
    let seedSeq = 0;
    fixture = createFixture({
      contextProvider: {
        prepare: ({ sourceEvent }) => {
          preparationCalls += 1;
          const active = fixture.store.getActiveSummary(sourceEvent.roomId, sourceEvent.seq);
          if (active) {
            return {
              contextThroughSeq: sourceEvent.seq,
              summaryThroughSeq: active.throughSeq
            };
          }
          const stale = fixture.store.replaceActiveSummary({
            summaryId: "summary:stale-preparation",
            roomId: sourceEvent.roomId,
            fromSeq: seedSeq,
            throughSeq: seedSeq,
            content: "stale prepared checkpoint",
            generatorActorId: "agent:codex"
          });
          fixture.store.replaceActiveSummary({
            summaryId: "summary:advanced-concurrently",
            roomId: sourceEvent.roomId,
            fromSeq: seedSeq,
            throughSeq: sourceEvent.seq,
            content: "new active checkpoint",
            generatorActorId: "agent:grok",
            expectedPreviousSummaryId: stale.summaryId
          });
          return {
            contextThroughSeq: sourceEvent.seq,
            summaryThroughSeq: stale.throughSeq
          };
        }
      }
    });
    seedSeq = fixture.store.appendDurableEvent({
      eventId: "evt_summary_race_seed",
      roomId: "room:main",
      eventType: "system.error",
      actorId: "system:groupx",
      correlationId: "corr_summary_race_seed",
      body: { kind: "seed" }
    }).seq;

    const accepted = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: {
        clientCommandId: "summary-race",
        to: ["agent:codex"],
        content: "dispatch only after rebuilding the checkpoint"
      }
    });
    await fixture.broker.waitForIdle();

    expect(preparationCalls).toBe(2);
    expect(fixture.adapters.codex.prompts).toHaveLength(1);
    expect(fixture.store.getTurn(accepted.turns[0]!.turnId)?.status).toBe("completed");
    expect(fixture.store.listTurnAttempts(accepted.turns[0]!.turnId)[0]?.summaryThroughSeq).toBe(
      fixture.store.getActiveSummary("room:main")?.throughSeq
    );
  });

  it("terminalizes a queued Turn when context compaction fails without advancing its cursor", async () => {
    const fixture = createFixture({
      contextProvider: {
        prepare: () => {
          throw new GroupXError("CONTEXT_BUDGET_EXCEEDED", "compactor unavailable");
        }
      }
    });
    const accepted = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: {
        clientCommandId: "context-compaction-failure",
        to: ["agent:codex"],
        content: "must not be silently skipped"
      }
    });
    await fixture.broker.waitForIdle();

    const turn = fixture.store.getTurn(accepted.turns[0]!.turnId);
    expect(turn).toMatchObject({
      status: "failed",
      errorCode: "CONTEXT_BUDGET_EXCEEDED"
    });
    expect(fixture.adapters.codex.prompts).toHaveLength(0);
    expect(fixture.store.getDeliveryCursor("agent:codex", "room:main")).toBeUndefined();
    expect(fixture.published).toContainEqual(
      expect.objectContaining({ type: "turn.failed" })
    );
  });

  it("never claims below the durable delivery cursor when context preparation falls back", async () => {
    const fixture = createFixture({
      contextProvider: {
        prepare: ({ sourceEvent }) => ({ contextThroughSeq: sourceEvent.seq })
      }
    });
    const first = fixture.store.acceptMessage({
      sourceBindingId: "binding:web",
      clientCommandId: "cursor-floor-first",
      roomId: "room:main",
      targets: [{ actorId: "agent:codex", adapterId: "codex", transport: "structured" }],
      content: "already delivered"
    });
    const second = fixture.store.acceptMessage({
      sourceBindingId: "binding:web",
      clientCommandId: "cursor-floor-second",
      roomId: "room:main",
      targets: [{ actorId: "agent:codex", adapterId: "codex", transport: "structured" }],
      content: "must still dispatch"
    });
    const firstTurnId = first.turns[0]!.turnId;
    const secondTurn = fixture.store.getTurn(second.turns[0]!.turnId)!;
    const cursorThroughSeq = fixture.store.getEvent(secondTurn.queuedEventId)!.seq;
    const claim = fixture.store.claimNextQueuedTurn({
      targetActorId: "agent:codex",
      bindingId: "binding:codex",
      instanceId: "instance:codex",
      contextThroughSeq: cursorThroughSeq,
      expectedTurnId: firstTurnId,
      expectedTransport: "structured"
    })!;
    fixture.store.markPromptInvoked(claim.attempt.attemptId);
    fixture.store.markAttemptRunning(claim.attempt.attemptId, "native:cursor-floor");
    fixture.store.terminalizeTurn({
      turnId: firstTurnId,
      attemptId: claim.attempt.attemptId,
      status: "completed",
      content: "done"
    });

    fixture.broker.notifySessionReady("agent:codex");
    await fixture.broker.waitForIdle();

    expect(fixture.store.getTurn(secondTurn.turnId)?.status).toBe("completed");
    expect(fixture.adapters.codex.prompts.map((prompt) => prompt.content)).toEqual([
      "must still dispatch"
    ]);
    expect(
      fixture.store.getDeliveryCursor("agent:codex", "room:main")?.lastDeliveredSeq
    ).toBeGreaterThanOrEqual(cursorThroughSeq);
  });

  it("fails a queued Turn snapshot instead of dispatching it across transport modes", async () => {
    const fixture = createFixture({ sessionFailureActor: "agent:codex" });
    const accepted = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: {
        clientCommandId: "transport-snapshot",
        to: ["agent:codex"],
        content: "structured only"
      }
    });
    const turnId = accepted.turns[0]!.turnId;
    await fixture.broker.waitForIdle();
    expect(fixture.store.getTurn(turnId)).toMatchObject({
      status: "queued",
      transport: "structured"
    });
    await fixture.broker.close();

    let sessionResolutions = 0;
    fixture.broker = new GroupXBroker({
      store: fixture.store,
      adapters: fixture.registry,
      selectedTransport: "direct",
      sessions: {
        resolve: ({ adapterId }) => {
          sessionResolutions += 1;
          return sessionFor(String(adapterId));
        }
      },
      publisher: {
        publish: (event) => {
          fixture.published.push(event);
        }
      },
      clock: { now: () => "2026-08-11T00:00:03.000Z" }
    });
    fixture.broker.notifySessionReady("agent:codex");
    await fixture.broker.waitForIdle();

    expect(sessionResolutions).toBe(0);
    expect(fixture.adapters.codex.prompts).toHaveLength(0);
    expect(fixture.store.listTurnAttempts(turnId)).toHaveLength(0);
    expect(fixture.store.getTurn(turnId)).toMatchObject({
      status: "failed",
      transport: "structured",
      errorCode: "TRANSPORT_MODE_MISMATCH"
    });
    expect(
      fixture.broker
        .readCorrelation({ correlationId: accepted.correlationId })
        .events.filter((event) => event.type === "turn.failed")
    ).toHaveLength(1);
  });

  it("fails a Turn when the resolved runtime binding belongs to another transport", async () => {
    const fixture = createFixture({ selectedTransport: "direct" });
    const accepted = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: {
        clientCommandId: "runtime-transport-mismatch",
        to: ["agent:codex"],
        content: "do not cross"
      }
    });
    await fixture.broker.waitForIdle();
    const turnId = accepted.turns[0]!.turnId;

    expect(fixture.adapters.codex.prompts).toHaveLength(0);
    expect(fixture.store.listTurnAttempts(turnId)).toHaveLength(0);
    expect(fixture.store.getTurn(turnId)).toMatchObject({
      transport: "direct",
      status: "failed",
      errorCode: "TRANSPORT_MODE_MISMATCH"
    });
  });

  it("passes configured queue limits into the atomic fanout transaction", async () => {
    const fixture = createFixture({
      sessionFailureActor: "agent:codex",
      acceptMessageLimits: {
        rootTurns: 24,
        hopCount: 12,
        actorCallsPerRoot: 8,
        queuePerActor: 1
      }
    });
    await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: { clientCommandId: "limit-1", to: ["agent:codex"], content: "first" }
    });
    await expect(
      fixture.broker.acceptMessage({
        bindingId: "binding:web",
        request: { clientCommandId: "limit-2", to: ["agent:codex"], content: "second" }
      })
    ).rejects.toMatchObject({ code: "QUEUE_CAPACITY_REACHED" });
    expect(fixture.store.listTurns({ targetActorId: "agent:codex" })).toHaveLength(1);
  });

  it("rechecks cancellation after claim and never invokes a cancelled native prompt", async () => {
    const dispatchedEntered = deferred();
    const dispatchedRelease = deferred();
    const fixture = createFixture({
      publish: async (event) => {
        if (event.type === "turn.dispatched") {
          dispatchedEntered.resolve();
          await dispatchedRelease.promise;
        }
      }
    });
    const accepted = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: { clientCommandId: "cancel-before-prompt", to: ["agent:codex"], content: "stop" }
    });
    const turnId = accepted.turns[0]!.turnId;
    await dispatchedEntered.promise;
    expect(fixture.store.getTurn(turnId)?.status).toBe("dispatching");

    await expect(fixture.broker.cancelTurn(turnId)).resolves.toMatchObject({
      accepted: true,
      status: "cancelling"
    });
    dispatchedRelease.resolve();
    await fixture.broker.waitForIdle();

    expect(fixture.adapters.codex.prompts).toHaveLength(0);
    expect(fixture.store.getTurn(turnId)?.status).toBe("cancelled");
    expect(fixture.store.listTurnAttempts(turnId)[0]).toMatchObject({
      dispatchPhase: "terminal",
      deliveryCertainty: "not_delivered"
    });
    expect(fixture.store.getDeliveryCursor("agent:codex", "room:main")).toBeUndefined();
  });

  it("writes prompt invocation before Adapter entry and exposes lifecycle causality only while active", async () => {
    const activeByBinding = new Map<string, {
      turnId: string;
      rootCorrelationId: string;
      hopCount: number;
    }>();
    const deactivated: string[] = [];
    const terminalPublishEntered = deferred();
    const terminalPublishRelease = deferred();
    const fixture = createFixture({
      turnLifecycle: {
        activate: (context) => {
          activeByBinding.set(context.bindingId, {
            turnId: context.turnId,
            rootCorrelationId: context.rootCorrelationId,
            hopCount: context.hopCount
          });
        },
        deactivate: (context) => {
          activeByBinding.delete(context.bindingId);
          deactivated.push(context.turnId);
        }
      },
      publish: async (event) => {
        if (event.type === "turn.failed") {
          terminalPublishEntered.resolve();
          await terminalPublishRelease.promise;
        }
      }
    });
    let observed:
      | {
          dispatchPhase: string;
          deliveryCertainty: string;
          activeTurnId?: string;
        }
      | undefined;
    fixture.adapters.codex.handler = async function* (_session, input) {
      const attempt = fixture.store.listTurnAttempts(input.turnId)[0]!;
      observed = {
        dispatchPhase: attempt.dispatchPhase,
        deliveryCertainty: attempt.deliveryCertainty,
        ...(activeByBinding.get("binding:codex")?.turnId === undefined
          ? {}
          : { activeTurnId: activeByBinding.get("binding:codex")!.turnId })
      };
      throw new Error("fixture failure before any native event");
    };

    const accepted = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: { clientCommandId: "write-ahead", to: ["agent:codex"], content: "invoke" }
    });
    const turnId = accepted.turns[0]!.turnId;
    await terminalPublishEntered.promise;
    expect(activeByBinding.size).toBe(0);
    terminalPublishRelease.resolve();
    await fixture.broker.waitForIdle();

    expect(observed).toEqual({
      dispatchPhase: "prompt_invoked",
      deliveryCertainty: "unknown",
      activeTurnId: turnId
    });
    expect(fixture.store.getTurn(turnId)?.status).toBe("failed");
    expect(fixture.store.getDeliveryCursor("agent:codex", "room:main")).toBeUndefined();
    expect(deactivated).toEqual([turnId]);
  });

  it("persists a late native Turn id and rejects any later id change", async () => {
    const fixture = createFixture();
    fixture.adapters.codex.handler = async function* (_session, input) {
      const started = nativeEvent("codex", "turn.started", {}, `${input.turnId}:start`);
      delete started.nativeTurnId;
      yield started;
      yield {
        ...nativeEvent("codex", "content.delta", { text: "ok" }, `${input.turnId}:late`),
        nativeTurnId: "native:late"
      };
      yield {
        ...nativeEvent("codex", "turn.completed", { content: "ok" }, `${input.turnId}:done`),
        nativeTurnId: "native:late"
      };
    };
    const late = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: { clientCommandId: "late-native-id", to: ["agent:codex"], content: "late" }
    });
    await fixture.broker.waitForIdle();
    const lateTurnId = late.turns[0]!.turnId;
    expect(fixture.store.getTurn(lateTurnId)).toMatchObject({
      status: "completed",
      nativeTurnId: "native:late"
    });
    expect(fixture.store.listTurnAttempts(lateTurnId)[0]?.nativeTurnId).toBe("native:late");
    expect(fixture.store.getDeliveryCursor("agent:codex", "room:main")?.lastDeliveredSeq).toBe(
      fixture.store.getEvent(late.messageEventId)?.seq
    );

    fixture.adapters.codex.handler = async function* (_session, input) {
      const started = nativeEvent("codex", "turn.started", {}, `${input.turnId}:start`);
      delete started.nativeTurnId;
      yield started;
      yield {
        ...nativeEvent("codex", "content.delta", { text: "a" }, `${input.turnId}:a`),
        nativeTurnId: "native:stable"
      };
      yield {
        ...nativeEvent("codex", "content.delta", { text: "b" }, `${input.turnId}:b`),
        nativeTurnId: "native:changed"
      };
    };
    const changed = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: { clientCommandId: "changed-native-id", to: ["agent:codex"], content: "changed" }
    });
    await fixture.broker.waitForIdle();
    const changedTurnId = changed.turns[0]!.turnId;
    expect(fixture.store.getTurn(changedTurnId)).toMatchObject({
      status: "failed",
      nativeTurnId: "native:stable",
      errorCode: "PROTOCOL_INVALID_MESSAGE"
    });
    expect(fixture.store.listTurnAttempts(changedTurnId)[0]?.nativeTurnId).toBe("native:stable");
  });

  it("automatically replaces a poisoned structured session without replaying the failed prompt", async () => {
    const restarts: string[] = [];
    const fixture = createFixture({
      agentController: {
        restart: async (actorId) => {
          restarts.push(actorId);
        }
      }
    });
    let promptNumber = 0;
    fixture.adapters.grok.handler = async function* (_session, input) {
      promptNumber += 1;
      yield nativeEvent("grok", "turn.started", {}, `${input.turnId}:start`);
      if (promptNumber === 1) {
        yield nativeEvent(
          "grok",
          "transport.error",
          { errorCode: "PROTOCOL_INVALID_MESSAGE" },
          `${input.turnId}:protocol-error`
        );
        return;
      }
      yield nativeEvent(
        "grok",
        "turn.completed",
        { content: "recovered" },
        `${input.turnId}:completed`
      );
    };

    const failed = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: {
        clientCommandId: "grok-protocol-failure",
        to: ["agent:grok"],
        content: "first prompt"
      }
    });
    await fixture.broker.waitForIdle();

    expect(fixture.store.getTurn(failed.turns[0]!.turnId)).toMatchObject({
      status: "failed",
      errorCode: "PROTOCOL_INVALID_MESSAGE"
    });
    expect(restarts).toEqual(["agent:grok"]);
    expect(fixture.adapters.grok.prompts.map((prompt) => prompt.content)).toEqual(["first prompt"]);

    const recovered = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: {
        clientCommandId: "grok-after-protocol-recovery",
        to: ["agent:grok"],
        content: "next prompt"
      }
    });
    await fixture.broker.waitForIdle();

    expect(fixture.store.getTurn(recovered.turns[0]!.turnId)?.status).toBe("completed");
    expect(fixture.adapters.grok.prompts.map((prompt) => prompt.content)).toEqual([
      "first prompt",
      "next prompt"
    ]);
  });
});

describe.sequential("GroupXBroker wait, cancel and recovery", () => {
  it("wakes a durable terminal waiter before terminal publication finishes", async () => {
    const terminalPublishEntered = deferred();
    const terminalPublishRelease = deferred();
    const fixture = createFixture({
      publish: async (event) => {
        if (event.type === "turn.completed") {
          terminalPublishEntered.resolve();
          await terminalPublishRelease.promise;
        }
      }
    });
    const accepted = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: { clientCommandId: "terminal-before-publish", to: ["agent:codex"], content: "go" }
    });
    const waiting = fixture.broker.waitForCorrelation({
      correlationId: accepted.correlationId,
      childTurnIds: accepted.turns.map((turn) => turn.turnId),
      timeoutMs: 1_000
    });
    await terminalPublishEntered.promise;

    await expect(
      Promise.race([
        waiting,
        new Promise<never>((_resolve, reject) =>
          setTimeout(() => reject(new Error("durable waiter stayed publication-gated")), 100)
        )
      ])
    ).resolves.toMatchObject({ state: "terminal" });
    terminalPublishRelease.resolve();
    await fixture.broker.waitForIdle();
  });

  it("rejects an empty or unknown correlation instead of reporting terminal", async () => {
    const fixture = createFixture();
    await expect(
      fixture.broker.waitForCorrelation({ correlationId: "corr:missing", timeoutMs: 5 })
    ).rejects.toMatchObject({ code: "UNKNOWN_TARGET" });
    await expect(
      fixture.broker.waitForCorrelation({
        correlationId: "corr:missing",
        childTurnIds: [],
        timeoutMs: 5
      })
    ).rejects.toMatchObject({ code: "UNKNOWN_TARGET" });
  });

  it("reports actor queue position and waits by the exact source message", async () => {
    const fixture = createFixture();
    const release = deferred();
    fixture.adapters.codex.handler = async function* (_session, input) {
      yield nativeEvent("codex", "turn.started", {}, `${input.turnId}:start`);
      if (input.content === "first") await release.promise;
      yield nativeEvent("codex", "turn.completed", { content: input.content });
    };
    const first = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: { clientCommandId: "queue-first", to: ["agent:codex"], content: "first" }
    });
    await waitUntil(() => fixture.store.getTurn(first.turns[0]!.turnId)?.status === "running");
    const second = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: { clientCommandId: "queue-second", to: ["agent:codex"], content: "second" }
    });

    expect(fixture.broker.inspectTurnQueue(second.turns[0]!.turnId)).toEqual({
      turnId: second.turns[0]!.turnId,
      queuePosition: 1,
      activeTurnId: first.turns[0]!.turnId
    });
    await expect(
      fixture.broker.waitForCorrelation({
        correlationId: second.correlationId,
        sourceEventId: second.messageEventId,
        timeoutMs: 5
      })
    ).resolves.toMatchObject({
      state: "timeout",
      turns: [{ turnId: second.turns[0]!.turnId }]
    });
    await expect(
      fixture.broker.waitForCorrelation({
        correlationId: first.correlationId,
        sourceEventId: second.messageEventId,
        timeoutMs: 5
      })
    ).rejects.toMatchObject({ code: "UNKNOWN_TARGET" });

    release.resolve();
    await fixture.broker.waitForIdle();
    expect(fixture.broker.inspectTurnQueue(second.turns[0]!.turnId).queuePosition).toBe(0);
  });

  it("times out an ask wait without inventing a terminal Turn", async () => {
    const fixture = createFixture();
    const release = deferred();
    fixture.adapters.codex.handler = async function* (_session, input) {
      yield nativeEvent("codex", "turn.started", {}, `${input.turnId}:start`);
      await release.promise;
      yield nativeEvent("codex", "turn.completed", { content: "late" });
    };
    const accepted = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: { clientCommandId: "ask-timeout", to: ["agent:codex"], content: "wait" }
    });
    await waitUntil(() => fixture.store.getTurn(accepted.turns[0]!.turnId)?.status === "running");
    const waited = await fixture.broker.waitForCorrelation({
      correlationId: accepted.correlationId,
      childTurnIds: accepted.turns.map((turn) => turn.turnId),
      timeoutMs: 5
    });
    expect(waited.state).toBe("timeout");
    expect(waited.turns[0]?.status).toBe("running");
    expect(
      waited.read.events.some((event) =>
        ["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"].includes(
          event.type
        )
      )
    ).toBe(false);

    const terminalWait = fixture.broker.waitForCorrelation({
      correlationId: accepted.correlationId,
      childTurnIds: accepted.turns.map((turn) => turn.turnId),
      timeoutMs: 1_000
    });
    release.resolve();
    expect((await terminalWait).state).toBe("terminal");
    await fixture.broker.waitForIdle();
  });

  it("returns exact child responses even when the correlation read page is full", async () => {
    const fixture = createFixture();
    const release = deferred();
    fixture.adapters.codex.handler = async function* (_session, input) {
      yield nativeEvent("codex", "turn.started", {}, `${input.turnId}:start`);
      await release.promise;
      yield nativeEvent("codex", "turn.completed", { content: "answer after history" });
    };
    const accepted = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: { clientCommandId: "ask-long-history", to: ["agent:codex"], content: "wait" }
    });
    const turnId = accepted.turns[0]!.turnId;
    await waitUntil(() => fixture.store.getTurn(turnId)?.status === "running");
    for (let index = 0; index < 120; index += 1) {
      fixture.store.appendDurableEvent({
        eventId: `evt_long_history_${index}`,
        roomId: "room:main",
        eventType: "system.error",
        actorId: "system:groupx",
        correlationId: accepted.correlationId,
        body: { index }
      });
    }

    const waiting = fixture.broker.waitForCorrelation({
      correlationId: accepted.correlationId,
      childTurnIds: [turnId],
      timeoutMs: 1_000
    });
    release.resolve();
    const waited = await waiting;
    const responseEventId = waited.turns[0]?.responseEventId;

    expect(waited.state).toBe("terminal");
    expect(waited.read.events).toHaveLength(100);
    expect(waited.read.events.some((event) => event.eventId === responseEventId)).toBe(false);
    expect(waited.responseEvents).toEqual([
      expect.objectContaining({
        eventId: responseEventId,
        body: expect.objectContaining({ content: "answer after history" })
      })
    ]);
    await fixture.broker.waitForIdle();
  });

  it("shares one native cancel call and returns the terminal state that wins the race", async () => {
    const fixture = createFixture();
    const streamRelease = deferred();
    const cancelEntered = deferred();
    const cancelRelease = deferred<CancelResult>();
    fixture.adapters.codex.handler = async function* (_session, input) {
      yield nativeEvent("codex", "turn.started", {}, `${input.turnId}:start`);
      await streamRelease.promise;
      yield nativeEvent("codex", "turn.completed", { content: "completed wins" });
    };
    fixture.adapters.codex.cancelHandler = async () => {
      cancelEntered.resolve();
      return await cancelRelease.promise;
    };
    const accepted = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: { clientCommandId: "cancel-race", to: ["agent:codex"], content: "race" }
    });
    const turnId = accepted.turns[0]!.turnId;
    await waitUntil(() => fixture.store.getTurn(turnId)?.status === "running");

    const first = fixture.broker.cancelTurn(turnId);
    await cancelEntered.promise;
    const second = fixture.broker.cancelTurn(turnId);
    streamRelease.resolve();
    await waitUntil(() => fixture.store.getTurn(turnId)?.status === "completed");
    cancelRelease.resolve({ requested: true, supported: true, terminalObserved: false });
    expect(await first).toMatchObject({ accepted: true, status: "completed" });
    expect(await second).toMatchObject({ accepted: true, status: "completed" });
    expect(fixture.adapters.codex.cancellations).toHaveLength(1);
    await fixture.broker.waitForIdle();
  });

  it("persists REST cancel idempotency and shares one in-flight native cancel", async () => {
    const streamRelease = deferred();
    const cancelEntered = deferred();
    const cancelRelease = deferred<CancelResult>();
    const fixture = createFixture();
    fixture.adapters.codex.handler = async function* (_session, input) {
      yield nativeEvent("codex", "turn.started", {}, `${input.turnId}:start`);
      await streamRelease.promise;
    };
    fixture.adapters.codex.cancelHandler = async () => {
      cancelEntered.resolve();
      return await cancelRelease.promise;
    };
    const accepted = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: { clientCommandId: "cancel-command-turn", to: ["agent:codex"], content: "wait" }
    });
    const turnId = accepted.turns[0]!.turnId;
    await waitUntil(() => fixture.store.getTurn(turnId)?.status === "running");
    const command = {
      turnId,
      bindingId: "binding:web",
      clientCommandId: "cancel-command"
    } as const;

    const first = fixture.broker.cancelFromBinding(command);
    await cancelEntered.promise;
    const concurrentReplay = fixture.broker.cancelFromBinding(command);
    cancelRelease.resolve({ requested: true, supported: true, terminalObserved: true });
    const firstResult = await first;
    expect(await concurrentReplay).toEqual(firstResult);
    expect(firstResult).toMatchObject({ accepted: true, status: "cancelled" });
    expect(fixture.adapters.codex.cancellations).toEqual(["native:codex"]);

    await expect(fixture.broker.cancelFromBinding(command)).resolves.toEqual(firstResult);
    expect(fixture.adapters.codex.cancellations).toHaveLength(1);
    streamRelease.resolve();
    await fixture.broker.waitForIdle();
  });

  it("sends exactly one native cancel when the native Turn id arrives late", async () => {
    const lateEventRelease = deferred();
    const fixture = createFixture();
    fixture.adapters.codex.cancelResult = {
      requested: true,
      supported: true,
      terminalObserved: true
    };
    fixture.adapters.codex.handler = async function* (_session, input) {
      const started = nativeEvent("codex", "turn.started", {}, `${input.turnId}:start`);
      delete started.nativeTurnId;
      yield started;
      await lateEventRelease.promise;
      yield {
        ...nativeEvent("codex", "content.delta", { text: "late" }, `${input.turnId}:late`),
        nativeTurnId: "native:late-cancel"
      };
    };
    const accepted = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: { clientCommandId: "cancel-late-id", to: ["agent:codex"], content: "cancel" }
    });
    const turnId = accepted.turns[0]!.turnId;
    await waitUntil(() => fixture.store.getTurn(turnId)?.status === "running");

    await expect(fixture.broker.cancelTurn(turnId)).resolves.toMatchObject({
      accepted: true,
      status: "cancelling"
    });
    lateEventRelease.resolve();
    await fixture.broker.waitForIdle();

    expect(fixture.adapters.codex.cancellations).toEqual(["native:late-cancel"]);
    expect(fixture.store.getTurn(turnId)).toMatchObject({
      status: "cancelled",
      nativeTurnId: "native:late-cancel"
    });
  });

  it("waits boundedly for a late native cancel receipt before settling the Turn", async () => {
    const lateEventRelease = deferred();
    const cancelEntered = deferred();
    const cancelRelease = deferred<CancelResult>();
    const fixture = createFixture({ nativeCancelTimeoutMs: 1_000 });
    fixture.adapters.codex.handler = async function* (_session, input) {
      const started = nativeEvent("codex", "turn.started", {}, `${input.turnId}:start`);
      delete started.nativeTurnId;
      yield started;
      await lateEventRelease.promise;
      yield {
        ...nativeEvent("codex", "content.delta", { text: "late" }, `${input.turnId}:late`),
        nativeTurnId: "native:late-receipt"
      };
    };
    fixture.adapters.codex.cancelHandler = async () => {
      cancelEntered.resolve();
      return await cancelRelease.promise;
    };
    const accepted = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: { clientCommandId: "cancel-late-receipt", to: ["agent:codex"], content: "cancel" }
    });
    const turnId = accepted.turns[0]!.turnId;
    await waitUntil(() => fixture.store.getTurn(turnId)?.status === "running");
    await fixture.broker.cancelTurn(turnId);
    lateEventRelease.resolve();
    await cancelEntered.promise;

    expect(fixture.store.getTurn(turnId)?.status).toBe("cancelling");
    cancelRelease.resolve({ requested: true, supported: true, terminalObserved: true });
    await fixture.broker.waitForIdle();
    expect(fixture.store.getTurn(turnId)?.status).toBe("cancelled");
    expect(fixture.adapters.codex.cancellations).toEqual(["native:late-receipt"]);
  });

  it("bounds a hanging public native cancellation", async () => {
    const streamRelease = deferred();
    const cancelRelease = deferred<CancelResult>();
    const fixture = createFixture({ nativeCancelTimeoutMs: 5 });
    fixture.adapters.codex.handler = async function* (_session, input) {
      yield nativeEvent("codex", "turn.started", {}, `${input.turnId}:start`);
      await streamRelease.promise;
    };
    fixture.adapters.codex.cancelHandler = async () => await cancelRelease.promise;
    const accepted = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: { clientCommandId: "cancel-timeout", to: ["agent:codex"], content: "hang" }
    });
    const turnId = accepted.turns[0]!.turnId;
    await waitUntil(() => fixture.store.getTurn(turnId)?.status === "running");
    const startedAt = Date.now();

    await expect(fixture.broker.cancelTurn(turnId)).resolves.toEqual({
      turnId,
      accepted: true,
      status: "cancelling"
    });
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(fixture.adapters.codex.cancellations).toEqual(["native:codex"]);
    cancelRelease.resolve({ requested: true, supported: true, terminalObserved: true });
    await waitUntil(() => fixture.store.getTurn(turnId)?.status === "cancelled");
    streamRelease.resolve();
    await fixture.broker.waitForIdle();
    expect(fixture.store.getTurn(turnId)?.status).toBe("cancelled");
  });

  it("allows a later explicit native cancel retry after the first receipt fails", async () => {
    const streamRelease = deferred();
    const fixture = createFixture({ nativeCancelTimeoutMs: 1_000 });
    fixture.adapters.codex.handler = async function* (_session, input) {
      yield nativeEvent("codex", "turn.started", {}, `${input.turnId}:start`);
      await streamRelease.promise;
    };
    let cancelAttempt = 0;
    fixture.adapters.codex.cancelHandler = async () => {
      cancelAttempt += 1;
      if (cancelAttempt === 1) throw new Error("fixture native cancel failed");
      return { requested: true, supported: true, terminalObserved: true };
    };
    const accepted = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      roomId: "room:main",
      request: {
        clientCommandId: "cancel-retry",
        to: ["agent:codex"],
        content: "cancel twice"
      }
    });
    const turnId = accepted.turns[0]!.turnId;
    await waitUntil(() => fixture.store.getTurn(turnId)?.status === "running");

    await expect(fixture.broker.cancelTurn(turnId)).resolves.toMatchObject({
      accepted: true,
      status: "cancelling"
    });
    await expect(fixture.broker.cancelTurn(turnId)).resolves.toMatchObject({
      accepted: true,
      status: "cancelled"
    });
    expect(fixture.adapters.codex.cancellations).toEqual(["native:codex", "native:codex"]);

    streamRelease.resolve();
    await fixture.broker.waitForIdle();
  });

  it("wakes correlation waiters and returns from close at its bound", async () => {
    const activeBindings = new Set<string>();
    const fixture = createFixture({
      closeTimeoutMs: 5,
      turnLifecycle: {
        activate: (context) => {
          activeBindings.add(context.bindingId);
        },
        deactivate: (context) => {
          activeBindings.delete(context.bindingId);
        }
      }
    });
    const never = deferred();
    fixture.adapters.codex.handler = async function* (_session, input) {
      yield nativeEvent("codex", "turn.started", {}, `${input.turnId}:start`);
      await never.promise;
    };
    const accepted = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: { clientCommandId: "close-wait", to: ["agent:codex"], content: "hang" }
    });
    await waitUntil(() => fixture.store.getTurn(accepted.turns[0]!.turnId)?.status === "running");
    const waiting = fixture.broker.waitForCorrelation({
      correlationId: accepted.correlationId,
      childTurnIds: accepted.turns.map((turn) => turn.turnId),
      timeoutMs: 1_000
    });
    const startedAt = Date.now();
    await fixture.broker.close();
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect((await waiting).state).toBe("aborted");
    expect(activeBindings.size).toBe(0);
  });

  it("does not claim after a delayed context continuation outlives close", async () => {
    const contextEntered = deferred();
    const contextRelease = deferred();
    let claimCalls = 0;
    const fixture = createFixture({
      closeTimeoutMs: 5,
      contextProvider: {
        prepare: async ({ sourceEvent }) => {
          contextEntered.resolve();
          await contextRelease.promise;
          return { contextThroughSeq: sourceEvent.seq };
        }
      }
    });
    const claimNextQueuedTurn = fixture.store.claimNextQueuedTurn.bind(fixture.store);
    fixture.store.claimNextQueuedTurn = (input) => {
      claimCalls += 1;
      return claimNextQueuedTurn(input);
    };
    await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: { clientCommandId: "close-context-fence", to: ["agent:codex"], content: "wait" }
    });
    await contextEntered.promise;

    await fixture.broker.close();
    fixture.store.close();
    contextRelease.resolve();
    await fixture.broker.waitForIdle();
    expect(claimCalls).toBe(0);
  });

  it("does not read or complete a cancel receipt after the close fence", async () => {
    const streamRelease = deferred();
    const cancelEntered = deferred();
    const cancelRelease = deferred<CancelResult>();
    const fixture = createFixture({ closeTimeoutMs: 5, nativeCancelTimeoutMs: 1_000 });
    fixture.adapters.codex.handler = async function* (_session, input) {
      yield nativeEvent("codex", "turn.started", {}, `${input.turnId}:start`);
      await streamRelease.promise;
    };
    fixture.adapters.codex.cancelHandler = async () => {
      cancelEntered.resolve();
      return await cancelRelease.promise;
    };
    const accepted = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: { clientCommandId: "close-cancel-turn", to: ["agent:codex"], content: "wait" }
    });
    const turnId = accepted.turns[0]!.turnId;
    await waitUntil(() => fixture.store.getTurn(turnId)?.status === "running");
    const cancellation = fixture.broker.cancelFromBinding({
      turnId,
      bindingId: "binding:web",
      clientCommandId: "close-cancel-command"
    });
    await cancelEntered.promise;

    await fixture.broker.close();
    fixture.store.close();
    cancelRelease.resolve({ requested: true, supported: true, terminalObserved: true });
    await expect(cancellation).rejects.toMatchObject({ code: "SESSION_NOT_AVAILABLE" });
    streamRelease.resolve();
    await fixture.broker.waitForIdle();
    expect(fixture.adapters.codex.cancellations).toEqual(["native:codex"]);
  });

  it("cancels a queued Turn without invoking the native Adapter", async () => {
    const fixture = createFixture({ sessionFailureActor: "agent:codex" });
    const accepted = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: { clientCommandId: "cancel-queued", to: ["agent:codex"], content: "later" }
    });
    await fixture.broker.waitForIdle();
    const outcome = await fixture.broker.cancelTurn(accepted.turns[0]!.turnId);
    expect(outcome).toMatchObject({ accepted: true, status: "cancelled" });
    expect(fixture.adapters.codex.cancellations).toHaveLength(0);
    expect(fixture.store.getTurn(accepted.turns[0]!.turnId)?.status).toBe("cancelled");
  });

  it("continues cancellation when the FIFO pump claims a queued Turn before the CAS", async () => {
    const fixture = createFixture({ sessionFailureActor: "agent:codex" });
    const accepted = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: { clientCommandId: "cancel-claim-race", to: ["agent:codex"], content: "race" }
    });
    await fixture.broker.waitForIdle();
    const turnId = accepted.turns[0]!.turnId;
    const source = fixture.store.getEvent(accepted.messageEventId)!;
    const cancelQueuedTurn = fixture.store.cancelQueuedTurn.bind(fixture.store);
    fixture.store.cancelQueuedTurn = (candidateTurnId, occurredAt) => {
      fixture.store.claimNextQueuedTurn({
        targetActorId: "agent:codex",
        bindingId: "binding:codex",
        instanceId: "instance:codex",
        contextThroughSeq: source.seq,
        expectedTurnId: candidateTurnId,
        expectedTransport: "structured"
      });
      return cancelQueuedTurn(candidateTurnId, occurredAt);
    };

    await expect(fixture.broker.cancelTurn(turnId)).resolves.toMatchObject({
      accepted: true,
      status: "cancelling"
    });
    expect(fixture.store.getTurn(turnId)?.status).toBe("cancelling");
    expect(fixture.adapters.codex.cancellations).toHaveLength(0);
  });

  it("interrupts an already claimed Turn on restart and dispatches only queued work", async () => {
    const fixture = createFixture();
    const first = fixture.store.acceptMessage({
      sourceBindingId: "binding:web",
      clientCommandId: "crash-active",
      roomId: "room:main",
      targets: [{ actorId: "agent:codex", adapterId: "codex", transport: "structured" }],
      content: "must not replay"
    });
    const second = fixture.store.acceptMessage({
      sourceBindingId: "binding:web",
      clientCommandId: "crash-queued",
      roomId: "room:main",
      targets: [{ actorId: "agent:codex", adapterId: "codex", transport: "structured" }],
      content: "safe queued"
    });
    const claim = fixture.store.claimNextQueuedTurn({
      targetActorId: "agent:codex",
      bindingId: "binding:codex",
      instanceId: "instance:codex",
      contextThroughSeq: fixture.store.getEvent(first.messageEventId)!.seq,
      expectedTurnId: first.turns[0]!.turnId,
      expectedTransport: "structured"
    });
    expect(claim?.turn.turnId).toBe(first.turns[0]!.turnId);
    fixture.store.markPromptInvoked(claim!.attempt.attemptId);
    fixture.store.markAttemptRunning(claim!.attempt.attemptId, "native:old");

    const recovered = await fixture.broker.recoverAfterRestart();
    await fixture.broker.waitForIdle();
    expect(recovered.interruptedTurns.map((turn) => turn.turnId)).toEqual([
      first.turns[0]!.turnId
    ]);
    expect(fixture.store.getTurn(first.turns[0]!.turnId)?.status).toBe("interrupted");
    expect(fixture.store.getTurn(second.turns[0]!.turnId)?.status).toBe("completed");
    expect(fixture.adapters.codex.prompts.map((prompt) => prompt.content)).toEqual([
      "safe queued"
    ]);
  });
});

describe.sequential("GroupXBroker unrestricted native policy and facade methods", () => {
  it.each(["UNEXPECTED_NATIVE_INTERACTION", "NATIVE_POLICY_BLOCKED"] as const)(
    "persists a generic Adapter policy failure as %s without an interaction event",
    async (errorCode) => {
      const fixture = createFixture();
      fixture.adapters.codex.handler = async function* (_session, input) {
        yield nativeEvent(
          "codex",
          "transport.error",
          { errorCode },
          `${input.turnId}:policy`
        );
      };
      const accepted = await fixture.broker.acceptMessage({
        bindingId: "binding:web",
        request: {
          clientCommandId: `policy-${errorCode}`,
          to: ["agent:codex"],
          content: "native policy"
        }
      });
      await fixture.broker.waitForIdle();
      const turn = fixture.store.getTurn(accepted.turns[0]!.turnId)!;
      expect(turn.status).toBe("failed");
      expect(turn.errorCode).toBe(errorCode);
      const read = fixture.broker.readCorrelation({ correlationId: accepted.correlationId });
      expect(read.events.filter((event) => event.type === "turn.failed")).toHaveLength(1);
    }
  );

  it("publishes idempotent mutations and derives authors without subject authorization", async () => {
    const fixture = createFixture();
    const input = {
      bindingId: "binding:codex",
      clientCommandId: "memory-once",
      scopeType: "room",
      scopeId: "room:main",
      kind: "note",
      content: "shared"
    } as const;
    const memory = await fixture.broker.rememberMemory(input);
    expect(memory.authorActorId).toBe("agent:codex");
    const publishedAfterFirst = fixture.published.length;
    await expect(fixture.broker.rememberMemory(input)).resolves.toEqual(memory);
    expect(fixture.published).toHaveLength(publishedAfterFirst);
    expect(fixture.published.filter((event) => event.type === "memory.remembered")).toHaveLength(1);
    const replacedMemory = await fixture.broker.supersedeMemory(memory.memoryId, {
      bindingId: "binding:codex",
      clientCommandId: "memory-supersede",
      kind: "decision",
      content: "shared update"
    });
    expect(replacedMemory).toMatchObject({
      supersedesMemoryId: memory.memoryId,
      kind: "decision",
      authorActorId: "agent:codex",
      sourceKind: "mcp"
    });
    await fixture.broker.retractMemory(replacedMemory.memoryId, {
      bindingId: "binding:codex",
      clientCommandId: "memory-retract"
    });
    const identity = await fixture.broker.rememberIdentity({
      bindingId: "binding:codex",
      clientCommandId: "identity-other",
      subjectActorId: "agent:grok",
      kind: "instruction",
      content: "observed identity"
    });
    expect(identity).toMatchObject({
      authorActorId: "agent:codex",
      subjectActorId: "agent:grok",
      kind: "note",
      sourceKind: "adapter"
    });
    const replacedIdentity = await fixture.broker.supersedeIdentity(identity.identityId, {
      bindingId: "binding:codex",
      clientCommandId: "identity-supersede",
      kind: "constraint",
      content: "updated observation"
    });
    expect(replacedIdentity).toMatchObject({
      supersedesIdentityId: identity.identityId,
      authorActorId: "agent:codex",
      subjectActorId: "agent:grok",
      kind: "note",
      sourceKind: "adapter"
    });
    await fixture.broker.retractIdentity(replacedIdentity.identityId, {
      bindingId: "binding:codex",
      clientCommandId: "identity-retract"
    });
    for (const type of [
      "memory.remembered",
      "memory.superseded",
      "memory.retracted",
      "identity.remembered",
      "identity.superseded",
      "identity.retracted"
    ] as const) {
      expect(fixture.published.filter((event) => event.type === type)).toHaveLength(1);
    }
  });
});
