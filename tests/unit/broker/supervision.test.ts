import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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
import type { GroupXEnvelope } from "../../../src/core/envelope.js";
import { GroupXError } from "../../../src/core/errors.js";
import { SUPERVISION_WATCH_KIND } from "../../../src/core/supervision.js";
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

async function waitUntil(predicate: () => boolean, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not reached");
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

type PromptHandler = (session: NativeSession, input: PromptInput) => AsyncIterable<NativeEvent>;

class FakeAdapter implements CliAdapter {
  readonly adapterId: string;
  readonly actorId: string;
  readonly prompts: PromptInput[] = [];
  readonly cancellations: string[] = [];
  handler: PromptHandler;
  cancelResult: CancelResult = { requested: true, supported: true, terminalObserved: false };

  constructor(adapterId: string, handler: PromptHandler = completedHandler(adapterId)) {
    this.adapterId = adapterId;
    this.actorId = `agent:${adapterId}`;
    this.handler = handler;
  }

  async probe(): Promise<CapabilityReport> {
    return {
      adapterId: this.adapterId,
      launchArgvShape: ["--permission-mode", "bypassPermissions"],
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
    yield nativeEvent(adapterId, "turn.completed", { content: `${adapterId} done` });
  };
}

interface Fixture {
  directory: string;
  store: SqliteGroupXStore;
  adapters: Record<"codex" | "grok", FakeAdapter>;
  published: GroupXEnvelope[];
  broker: GroupXBroker;
}

const fixtures = new Set<Fixture>();

function seedBindings(store: SqliteGroupXStore): void {
  const seeds = [
    ["user:web", "web", "instance:web", "binding:web", "local-rest"],
    ["agent:codex", "codex", "instance:codex", "binding:codex", "fixture"],
    ["agent:grok", "grok", "instance:grok", "binding:grok", "fixture"]
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

function createFixture(input: { steerLimit?: number } = {}): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "groupx-supervision-broker-"));
  const store = new SqliteGroupXStore(join(directory, "groupx.db"));
  seedBindings(store);
  const registry = new AdapterRegistry();
  const adapters = {
    codex: new FakeAdapter("codex"),
    grok: new FakeAdapter("grok")
  };
  for (const adapter of Object.values(adapters)) registry.register(adapter);
  const published: GroupXEnvelope[] = [];
  const fixture: Fixture = {
    directory,
    store,
    adapters,
    published,
    broker: undefined as unknown as GroupXBroker
  };
  fixture.broker = new GroupXBroker({
    store,
    adapters: registry,
    selectedTransport: "structured",
    steerLimit: input.steerLimit ?? 3,
    watchTimeoutMs: 250,
    sessions: { resolve: ({ adapterId }) => sessionFor(String(adapterId)) },
    publisher: {
      publish: (event) => {
        published.push(event);
      }
    },
    contextProvider: { prepare: ({ sourceEvent }) => ({ contextThroughSeq: sourceEvent.seq }) },
    nativeCancelTimeoutMs: 50,
    closeTimeoutMs: 50,
    clock: { now: () => "2026-08-11T00:00:02.000Z" },
    idFactory: (() => {
      let sequence = 0;
      return (prefix: string) => `${prefix}_sup_${++sequence}`;
    })()
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

describe.sequential("live supervision pairing", () => {
  it("runs worker and observer in parallel and keeps the observer prompt off the user task", async () => {
    const fixture = createFixture();
    const workerHold = deferred();
    const observerHold = deferred();
    fixture.adapters.codex.handler = async function* (_session, input) {
      yield nativeEvent("codex", "turn.started", {}, `${input.turnId}:start`);
      await workerHold.promise;
      yield nativeEvent("codex", "turn.completed", { content: "worker done" });
    };
    fixture.adapters.grok.handler = async function* (_session, input) {
      yield nativeEvent("grok", "turn.started", {}, `${input.turnId}:start`);
      await observerHold.promise;
      yield nativeEvent("grok", "turn.completed", { content: "observer note" });
    };

    const accepted = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: {
        clientCommandId: "supervise-parallel",
        to: ["agent:codex"],
        content: "implement the feature",
        supervision: { observers: ["agent:grok"], mode: "live_steer" }
      }
    });

    await waitUntil(
      () =>
        fixture.store.getTurn(accepted.turns[0]!.turnId)?.status === "running" &&
        fixture.store.getTurn(accepted.watchTurns![0]!.turnId)?.status === "running"
    );
    expect(fixture.adapters.codex.prompts[0]?.content).toBe("implement the feature");
    expect(fixture.adapters.grok.prompts[0]?.content).toContain("not a second executor");
    expect(fixture.adapters.grok.prompts[0]?.content).not.toBe("implement the feature");
    expect(fixture.published.some((event) => event.type === "supervision.paired")).toBe(true);
    expect(fixture.published.some((event) => event.type.startsWith("approval."))).toBe(false);

    workerHold.resolve();
    observerHold.resolve();
    await fixture.broker.waitForIdle();
  });

  it("returns a bounded milestone snapshot and refuses watch on a business turn", async () => {
    const fixture = createFixture();
    const releaseTool = deferred();
    const workerHold = deferred();
    fixture.adapters.codex.handler = async function* (_session, input) {
      yield nativeEvent("codex", "turn.started", {}, `${input.turnId}:start`);
      await releaseTool.promise;
      yield nativeEvent(
        "codex",
        "tool.started",
        { name: "bash", arguments: ["rm", "-rf", "/secret"] },
        `${input.turnId}:tool`
      );
      await workerHold.promise;
      yield nativeEvent("codex", "turn.completed", { content: "worker done" });
    };
    fixture.adapters.grok.handler = async function* (_session, input) {
      yield nativeEvent("grok", "turn.started", {}, `${input.turnId}:start`);
      await workerHold.promise;
      yield nativeEvent("grok", "turn.completed", { content: "observer done" });
    };

    const accepted = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: {
        clientCommandId: "supervise-watch",
        to: ["agent:codex"],
        content: "implement the feature",
        supervision: { observers: ["agent:grok"], mode: "live_steer" }
      }
    });
    const watchTurnId = accepted.watchTurns![0]!.turnId;
    const workerTurnId = accepted.turns[0]!.turnId;
    await waitUntil(() => fixture.store.getTurn(workerTurnId)?.status === "running");

    const watchedPromise = fixture.broker.watchSubject({
      watchTurnId,
      until: "next_milestone",
      timeoutMs: 500
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseTool.resolve();
    const watched = await watchedPromise;
    expect(watched.snapshot.turnId).toBe(workerTurnId);
    expect(watched.snapshot.task.excerpt).toBe("implement the feature");
    expect(watched.snapshot.tools).toEqual([
      expect.objectContaining({ name: "bash", status: "started" })
    ]);
    expect(watched.snapshot.tools[0]).not.toHaveProperty("arguments");
    expect(watched.snapshot.tools[0]).not.toHaveProperty("argv");
    expect(JSON.stringify(watched.snapshot)).not.toContain("/secret");
    expect(fixture.published.some((event) => event.type === "supervision.observed")).toBe(true);

    await expect(
      fixture.broker.watchSubject({
        watchTurnId: workerTurnId,
        until: "next_milestone"
      })
    ).rejects.toMatchObject({ code: "SUPERVISION_WATCH_REQUIRED" });

    expect(() => fixture.broker.assertObserverRouting(watchTurnId, ["agent:codex"])).toThrow(
      expect.objectContaining({ code: "SUPERVISION_STEER_REQUIRED" })
    );

    workerHold.resolve();
    await fixture.broker.waitForIdle();
  });

  it("interrupts the whole worker turn and queues public guidance from the observer binding", async () => {
    const fixture = createFixture();
    const workerHold = deferred();
    fixture.adapters.codex.handler = async function* (_session, input) {
      yield nativeEvent("codex", "turn.started", {}, `${input.turnId}:start`);
      await workerHold.promise;
      yield nativeEvent("codex", "turn.completed", { content: "should be cancelled" });
    };
    fixture.adapters.grok.handler = async function* (_session, input) {
      yield nativeEvent("grok", "turn.started", {}, `${input.turnId}:start`);
      yield nativeEvent("grok", "turn.completed", { content: "watching" });
    };

    const accepted = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: {
        clientCommandId: "supervise-steer",
        to: ["agent:codex"],
        content: "implement the feature",
        supervision: { observers: ["agent:grok"], mode: "live_steer" }
      }
    });
    const workerTurnId = accepted.turns[0]!.turnId;
    const watchTurnId = accepted.watchTurns![0]!.turnId;
    await waitUntil(() => fixture.store.getTurn(workerTurnId)?.status === "running");

    const steered = await fixture.broker.steerSubject({
      bindingId: "binding:grok",
      watchTurnId,
      action: "interrupt",
      reason: "wrong approach",
      content: "rewrite the plan first",
      clientCommandId: "steer-1"
    });
    expect(steered.nextTurnId).toBeDefined();
    expect(fixture.store.getTurn(workerTurnId)?.status).toMatch(/cancelled|interrupted|cancelling/);
    const next = fixture.store.getTurn(steered.nextTurnId!)!;
    expect(next.targetActorId).toBe("agent:codex");
    expect(fixture.store.getSupervisionTurnRole(next.turnId)).toBe("worker");
    expect(fixture.store.getEvent(steered.messageEventId)?.actorId).toBe("agent:grok");
    expect(fixture.published.some((event) => event.type === "supervision.steered")).toBe(true);
    expect(fixture.published.some((event) => event.type.startsWith("approval."))).toBe(false);
    workerHold.resolve();
    await waitUntil(() =>
      fixture.adapters.codex.prompts.some((prompt) => prompt.content === "rewrite the plan first")
    );

    await fixture.broker.waitForIdle();
  });

  it("enforces steersPerSubjectTurn on the same watched turn", async () => {
    const fixture = createFixture({ steerLimit: 1 });
    const workerHold = deferred();
    fixture.adapters.codex.handler = async function* (_session, input) {
      yield nativeEvent("codex", "turn.started", {}, `${input.turnId}:start`);
      await workerHold.promise;
      yield nativeEvent("codex", "turn.completed", { content: "worker done" });
    };
    fixture.adapters.grok.handler = completedHandler("grok");

    const accepted = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: {
        clientCommandId: "supervise-limit",
        to: ["agent:codex"],
        content: "implement the feature",
        supervision: { observers: ["agent:grok"], mode: "live_steer" }
      }
    });
    const watchTurnId = accepted.watchTurns![0]!.turnId;
    await waitUntil(() => fixture.store.getTurn(accepted.turns[0]!.turnId)?.status === "running");

    await expect(
      fixture.broker.steerSubject({
        bindingId: "binding:grok",
        watchTurnId,
        action: "nudge",
        reason: "first",
        content: "try a smaller change",
        clientCommandId: "steer-nudge-1"
      })
    ).resolves.toMatchObject({ action: "nudge" });
    await expect(
      fixture.broker.steerSubject({
        bindingId: "binding:grok",
        watchTurnId,
        action: "nudge",
        reason: "second",
        content: "too many steers",
        clientCommandId: "steer-nudge-2"
      })
    ).rejects.toMatchObject({ code: "STEER_LIMIT_REACHED" });

    workerHold.resolve();
    await fixture.broker.waitForIdle();
  });

  it("does not treat an ordinary message as a watch brief", async () => {
    const fixture = createFixture();
    const accepted = await fixture.broker.acceptMessage({
      bindingId: "binding:web",
      request: {
        clientCommandId: "plain-message",
        to: ["agent:codex"],
        content: "just work"
      }
    });
    expect(accepted.watchTurns).toBeUndefined();
    const source = fixture.store.getEvent(accepted.messageEventId)!;
    expect(source.body).toEqual({ content: "just work" });
    expect((source.body as { kind?: string }).kind).not.toBe(SUPERVISION_WATCH_KIND);
    await fixture.broker.waitForIdle();
  });
});

describe("supervision errors stay GroupX errors", () => {
  it("wraps missing watch turns", async () => {
    const fixture = createFixture();
    await expect(
      fixture.broker.watchSubject({
        watchTurnId: "turn_missing",
        until: "terminal"
      })
    ).rejects.toBeInstanceOf(GroupXError);
    await fixture.broker.waitForIdle();
  });
});
