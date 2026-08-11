import { describe, expect, it } from "vitest";
import { Dispatcher, type LaneTask, type LaneTaskResult } from "../../../src/core/dispatcher.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function controlledTask<T>(
  turnId: string,
  started: string[],
  completion: Deferred<T>
): LaneTask<T> {
  return {
    turnId,
    run(signal) {
      started.push(turnId);
      return new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        completion.promise.then(
          (value) => {
            signal.removeEventListener("abort", onAbort);
            resolve(value);
          },
          (error: unknown) => {
            signal.removeEventListener("abort", onAbort);
            reject(error);
          }
        );
      });
    }
  };
}

function expectSynchronousCode(run: () => unknown, code: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toMatchObject({ code });
}

describe("Dispatcher", () => {
  it("runs one actor lane in FIFO order with only one active turn", async () => {
    const transitions: string[] = [];
    const dispatcher = new Dispatcher({
      maxQueuedPerAgent: 4,
      onState: (actorId, turnId, state) => transitions.push(`${actorId}:${turnId}:${state}`)
    });
    const started: string[] = [];
    const firstCompletion = deferred<string>();
    const secondCompletion = deferred<string>();

    const first = dispatcher.enqueue(
      "agent:codex",
      controlledTask("turn:1", started, firstCompletion)
    );
    const second = dispatcher.enqueue(
      "agent:codex",
      controlledTask("turn:2", started, secondCompletion)
    );

    expect(started).toEqual(["turn:1"]);
    expect(dispatcher.stats()).toEqual([
      { actorId: "agent:codex", activeTurnId: "turn:1", queued: 1 }
    ]);

    firstCompletion.resolve("first-result");
    await expect(first).resolves.toEqual({
      turnId: "turn:1",
      state: "completed",
      value: "first-result"
    });
    await viWaitFor(() => expect(started).toEqual(["turn:1", "turn:2"]));

    secondCompletion.resolve("second-result");
    await expect(second).resolves.toEqual({
      turnId: "turn:2",
      state: "completed",
      value: "second-result"
    });
    expect(transitions).toEqual([
      "agent:codex:turn:1:queued",
      "agent:codex:turn:1:running",
      "agent:codex:turn:2:queued",
      "agent:codex:turn:1:completed",
      "agent:codex:turn:2:running",
      "agent:codex:turn:2:completed"
    ]);
  });

  it("runs different actor lanes concurrently", async () => {
    const dispatcher = new Dispatcher({ maxQueuedPerAgent: 2 });
    const started: string[] = [];
    const codexCompletion = deferred<string>();
    const grokCompletion = deferred<string>();

    const codex = dispatcher.enqueue(
      "agent:codex",
      controlledTask("turn:codex", started, codexCompletion)
    );
    const grok = dispatcher.enqueue(
      "agent:grok",
      controlledTask("turn:grok", started, grokCompletion)
    );

    expect(started).toEqual(["turn:codex", "turn:grok"]);
    expect(dispatcher.stats()).toEqual([
      { actorId: "agent:codex", activeTurnId: "turn:codex", queued: 0 },
      { actorId: "agent:grok", activeTurnId: "turn:grok", queued: 0 }
    ]);

    grokCompletion.resolve("grok-result");
    await expect(grok).resolves.toMatchObject({ state: "completed", value: "grok-result" });
    expect(dispatcher.stats()[0]).toMatchObject({ activeTurnId: "turn:codex" });

    codexCompletion.resolve("codex-result");
    await expect(codex).resolves.toMatchObject({ state: "completed", value: "codex-result" });
  });

  it("rejects work beyond the per-agent queued backlog limit", async () => {
    const dispatcher = new Dispatcher({ maxQueuedPerAgent: 1 });
    const started: string[] = [];
    const activeCompletion = deferred<void>();
    const queuedCompletion = deferred<void>();
    const active = dispatcher.enqueue(
      "agent:kimi",
      controlledTask("turn:active", started, activeCompletion)
    );
    const queued = dispatcher.enqueue(
      "agent:kimi",
      controlledTask("turn:queued", started, queuedCompletion)
    );

    expectSynchronousCode(
      () => dispatcher.enqueue("agent:kimi", {
        turnId: "turn:overflow",
        async run() {
          return;
        }
      }),
      "QUEUE_CAPACITY_REACHED"
    );
    expect(started).toEqual(["turn:active"]);

    activeCompletion.resolve();
    await active;
    await viWaitFor(() => expect(started).toEqual(["turn:active", "turn:queued"]));
    queuedCompletion.resolve();
    await queued;
  });

  it("cancels queued work without running it", async () => {
    const dispatcher = new Dispatcher({ maxQueuedPerAgent: 2 });
    const started: string[] = [];
    const activeCompletion = deferred<void>();
    const queuedCompletion = deferred<void>();
    const active = dispatcher.enqueue(
      "agent:codex",
      controlledTask("turn:active", started, activeCompletion)
    );
    const queued = dispatcher.enqueue(
      "agent:codex",
      controlledTask("turn:queued", started, queuedCompletion)
    );

    expect(dispatcher.cancel("agent:codex", "turn:queued")).toBe(true);
    await expect(queued).resolves.toEqual({ turnId: "turn:queued", state: "cancelled" });
    expect(started).toEqual(["turn:active"]);
    expect(dispatcher.cancel("agent:codex", "turn:missing")).toBe(false);

    activeCompletion.resolve();
    await active;
  });

  it("aborts active work and reports a cancelled terminal result", async () => {
    const dispatcher = new Dispatcher({ maxQueuedPerAgent: 2 });
    let observedSignal: AbortSignal | undefined;
    const result = dispatcher.enqueue("agent:grok", {
      turnId: "turn:active",
      run(signal) {
        observedSignal = signal;
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
    });

    expect(dispatcher.cancel("agent:grok", "turn:active")).toBe(true);
    await expect(result).resolves.toMatchObject({
      turnId: "turn:active",
      state: "cancelled",
      error: expect.objectContaining({ code: "TURN_INTERRUPTED" })
    });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("rejects duplicate turn ids while either active or queued", async () => {
    const dispatcher = new Dispatcher({ maxQueuedPerAgent: 3 });
    const started: string[] = [];
    const activeCompletion = deferred<void>();
    const queuedCompletion = deferred<void>();
    const activeTask = controlledTask("turn:active", started, activeCompletion);
    const queuedTask = controlledTask("turn:queued", started, queuedCompletion);
    const active = dispatcher.enqueue("agent:codex", activeTask);
    const queued = dispatcher.enqueue("agent:codex", queuedTask);

    expectSynchronousCode(
      () => dispatcher.enqueue("agent:codex", activeTask),
      "DUPLICATE_DISPATCH"
    );
    expectSynchronousCode(
      () => dispatcher.enqueue("agent:codex", queuedTask),
      "DUPLICATE_DISPATCH"
    );

    activeCompletion.resolve();
    await active;
    await viWaitFor(() => expect(started).toEqual(["turn:active", "turn:queued"]));
    queuedCompletion.resolve();
    await queued;
  });
});

async function viWaitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    }
  }
}
