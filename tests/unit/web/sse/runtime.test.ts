import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BUILTIN_ACTORS,
  GROUPX_SCHEMA,
  type GroupXEnvelope,
  type GroupXEventType
} from "../../../../src/core/envelope.js";
import {
  encodeSseEnvelope,
  SseRuntime,
  type DurableGroupXEnvelope,
  type DurableRangeRequest,
  type SseCloseInfo,
  type SseDurableEventReader,
  type SseSink
} from "../../../../src/web/sse/index.js";

function durable(
  seq: number,
  body: Record<string, unknown> = { content: `message ${seq}` },
  type: GroupXEventType = "message.created"
): DurableGroupXEnvelope<Record<string, unknown>> {
  return {
    schema: GROUPX_SCHEMA,
    eventId: `evt_${seq}`,
    seq,
    roomId: "room:main",
    type,
    actor: BUILTIN_ACTORS.codex,
    to: ["agent:grok"],
    correlationId: "corr_runtime",
    rootCorrelationId: "corr_runtime",
    occurredAt: `2026-08-11T00:00:${String(seq).padStart(2, "0")}.000Z`,
    durability: "durable",
    body
  };
}

function transient(
  eventId: string,
  turnId: string,
  text: string,
  type: GroupXEventType = "turn.content.delta"
): GroupXEnvelope<Record<string, unknown>> {
  return {
    schema: GROUPX_SCHEMA,
    eventId,
    seq: null,
    roomId: "room:main",
    type,
    actor: BUILTIN_ACTORS.codex,
    to: ["agent:grok"],
    correlationId: "corr_runtime",
    rootCorrelationId: "corr_runtime",
    occurredAt: "2026-08-11T00:01:00.000Z",
    durability: "transient",
    body: { turnId, text }
  };
}

class FakeReader implements SseDurableEventReader {
  constructor(
    readonly highWater: number,
    readonly events: DurableGroupXEnvelope[] = []
  ) {}

  captureHighWaterSeq(): number {
    return this.highWater;
  }

  *readDurableRange(request: DurableRangeRequest): Iterable<DurableGroupXEnvelope> {
    for (const event of this.events) {
      if (
        event.roomId === request.roomId &&
        event.seq > request.afterSeq &&
        event.seq <= request.throughSeq
      ) {
        yield event;
      }
    }
  }
}

class RecordingSink implements SseSink {
  readonly frames: string[] = [];
  readonly closes: SseCloseInfo[] = [];

  write(frame: string): void | Promise<void> {
    this.frames.push(frame);
  }

  close(info: SseCloseInfo): void {
    this.closes.push(info);
  }
}

class FirstWriteBlockedSink extends RecordingSink {
  readonly #blocked: Promise<void>;
  #release: (() => void) | undefined;
  #used = false;

  constructor() {
    super();
    this.#blocked = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
  }

  override write(frame: string): void | Promise<void> {
    super.write(frame);
    if (!this.#used) {
      this.#used = true;
      return this.#blocked;
    }
  }

  release(): void {
    this.#release?.();
  }
}

function envelopeData(frame: string): GroupXEnvelope {
  const data = frame.split("\n").find((line) => line.startsWith("data: "));
  if (!data) {
    throw new Error(`not an event frame: ${frame}`);
  }
  return JSON.parse(data.slice("data: ".length)) as GroupXEnvelope;
}

function durableSeqs(frames: readonly string[]): number[] {
  return frames
    .filter((frame) => frame.startsWith("id: "))
    .map((frame) => envelopeData(frame).seq as number);
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SseRuntime replay/live cutover", () => {
  it("registers before high-water capture, replays a fixed range, and de-duplicates cached live", async () => {
    let resolveHighWater: ((value: number) => void) | undefined;
    const highWater = new Promise<number>((resolve) => {
      resolveHighWater = resolve;
    });
    let runtime: SseRuntime;
    const reader: SseDurableEventReader = {
      captureHighWaterSeq: () => {
        expect(runtime.connectionCount).toBe(1);
        return highWater;
      },
      readDurableRange: function* (request) {
        expect(request).toMatchObject({ roomId: "room:main", afterSeq: 0, throughSeq: 2 });
        expect(request.signal).toBeInstanceOf(AbortSignal);
        yield durable(1);
        yield durable(2);
      }
    };
    runtime = new SseRuntime(reader);
    const sink = new RecordingSink();
    const connection = runtime.open({ roomId: "room:main", sink });

    // seq=1 was committed before capture and is therefore both in the live
    // cache and the fixed replay range. It must be emitted only by replay.
    runtime.publish(durable(1));
    runtime.publish(durable(3));
    runtime.publish(transient("delta_cutover", "turn_cutover", "live"));
    resolveHighWater?.(2);

    await connection.ready;
    await vi.waitFor(() => expect(sink.frames).toHaveLength(4));

    expect(durableSeqs(sink.frames)).toEqual([1, 2, 3]);
    expect(sink.frames.map(envelopeData).map((event) => event.eventId)).toEqual([
      "evt_1",
      "evt_2",
      "evt_3",
      "delta_cutover"
    ]);
    expect(connection.snapshot().phase).toBe("live");
    runtime.close();
  });

  it("buffers post-high-water live events until an asynchronous replay finishes", async () => {
    let releaseReplay: (() => void) | undefined;
    const replayGate = new Promise<void>((resolve) => {
      releaseReplay = resolve;
    });
    const reader: SseDurableEventReader = {
      captureHighWaterSeq: () => 2,
      readDurableRange: async function* () {
        yield durable(1);
        await replayGate;
        yield durable(2);
      }
    };
    const runtime = new SseRuntime(reader);
    const sink = new RecordingSink();
    const connection = runtime.open({ roomId: "room:main", sink });

    await settle();
    expect(durableSeqs(sink.frames)).toEqual([]);
    runtime.publish(durable(3));
    runtime.publish(durable(3));
    expect(durableSeqs(sink.frames)).toEqual([]);

    releaseReplay?.();
    await connection.ready;
    await vi.waitFor(() => expect(durableSeqs(sink.frames)).toEqual([1, 2, 3]));
    runtime.close();
  });

  it("does not charge a pre-capture live duplicate twice against the event limit", async () => {
    let resolveHighWater: ((value: number) => void) | undefined;
    const highWater = new Promise<number>((resolve) => {
      resolveHighWater = resolve;
    });
    const reader: SseDurableEventReader = {
      captureHighWaterSeq: () => highWater,
      readDurableRange: function* () {
        yield durable(1);
      }
    };
    const runtime = new SseRuntime(reader, {
      maxBufferedEvents: 1,
      maxBufferedBytes: 100_000
    });
    const sink = new RecordingSink();
    const connection = runtime.open({ roomId: "room:main", sink });

    runtime.publish(durable(1));
    resolveHighWater?.(1);
    await connection.ready;
    await vi.waitFor(() => expect(durableSeqs(sink.frames)).toEqual([1]));

    expect(connection.isClosed).toBe(false);
    runtime.close();
  });

  it("preserves live durable order and suppresses duplicate publication", async () => {
    const runtime = new SseRuntime(new FakeReader(0));
    const sink = new RecordingSink();
    const connection = runtime.open({ roomId: "room:main", sink });
    await connection.ready;

    runtime.publish(durable(1));
    runtime.publish(durable(1));
    runtime.publish(durable(2));
    runtime.publish({ ...durable(3), roomId: "room:other" });

    await vi.waitFor(() => expect(durableSeqs(sink.frames)).toEqual([1, 2]));
    expect(connection.snapshot().lastSentDurableSeq).toBe(2);
    runtime.close();
  });

  it("fails closed before writing a synchronous live sequence reversal", async () => {
    const runtime = new SseRuntime(new FakeReader(0));
    const sink = new RecordingSink();
    const connection = runtime.open({ roomId: "room:main", sink });
    await connection.ready;

    runtime.publish(durable(3));
    runtime.publish(durable(2));

    await expect(connection.closed).resolves.toMatchObject({ code: "sequence_error" });
    expect(sink.frames).toEqual([]);
  });

  it("rejects conflicting event identity for the same durable seq", async () => {
    const runtime = new SseRuntime(new FakeReader(0));
    const sink = new RecordingSink();
    const connection = runtime.open({ roomId: "room:main", sink });
    await connection.ready;

    runtime.publish(durable(1));
    await vi.waitFor(() => expect(connection.snapshot().lastSentDurableSeq).toBe(1));
    runtime.publish({ ...durable(1), eventId: "evt_conflict" });

    await expect(connection.closed).resolves.toMatchObject({ code: "sequence_error" });
    expect(durableSeqs(sink.frames)).toEqual([1]);
  });

  it("rejects out-of-order replay before sending its higher cursor", async () => {
    const runtime = new SseRuntime(new FakeReader(3, [durable(3), durable(2)]));
    const sink = new RecordingSink();
    const connection = runtime.open({ roomId: "room:main", sink });

    await connection.ready;
    await expect(connection.closed).resolves.toMatchObject({ code: "replay_error" });
    expect(sink.frames).toEqual([]);
  });
});

describe("SseRuntime connection-local backpressure", () => {
  it("coalesces same-turn deltas and drops excess transient events without closing", async () => {
    const runtime = new SseRuntime(new FakeReader(0), {
      maxBufferedEvents: 2,
      maxBufferedBytes: 100_000
    });
    const sink = new FirstWriteBlockedSink();
    const connection = runtime.open({ roomId: "room:main", sink });
    await connection.ready;

    runtime.publish(durable(1));
    await vi.waitFor(() => expect(sink.frames).toHaveLength(1));
    runtime.publish(transient("delta_a", "turn_a", "A"));
    runtime.publish(transient("delta_b", "turn_a", "B"));
    runtime.publish(transient("delta_other", "turn_b", "dropped"));

    expect(connection.isClosed).toBe(false);
    expect(connection.snapshot().bufferedEvents).toBe(2);

    sink.release();
    await vi.waitFor(() => expect(sink.frames).toHaveLength(2));
    const merged = envelopeData(sink.frames[1] as string);
    expect(merged).toMatchObject({
      schema: GROUPX_SCHEMA,
      eventId: "delta_b",
      seq: null,
      durability: "transient",
      body: { turnId: "turn_a", text: "AB" }
    });
    expect(connection.isClosed).toBe(false);
    runtime.close();
  });

  it("closes only the slow connection when a durable event exceeds its event budget", async () => {
    const runtime = new SseRuntime(new FakeReader(0), {
      maxBufferedEvents: 1,
      maxBufferedBytes: 100_000
    });
    const slow = new FirstWriteBlockedSink();
    const fast = new RecordingSink();
    const slowConnection = runtime.open({ roomId: "room:main", sink: slow });
    const fastConnection = runtime.open({ roomId: "room:main", sink: fast });
    await Promise.all([slowConnection.ready, fastConnection.ready]);

    runtime.publish(durable(1));
    await vi.waitFor(() => {
      expect(slow.frames).toHaveLength(1);
      expect(fastConnection.snapshot().lastSentDurableSeq).toBe(1);
    });
    runtime.publish(durable(2));

    await vi.waitFor(() => expect(slow.closes[0]?.code).toBe("durable_overflow"));
    await vi.waitFor(() => expect(durableSeqs(fast.frames)).toEqual([1, 2]));
    expect(slowConnection.isClosed).toBe(true);
    expect(fastConnection.isClosed).toBe(false);
    expect(runtime.connectionCount).toBe(1);

    slow.release();
    runtime.close();
  });

  it("applies the byte budget using encoded UTF-8 size", async () => {
    const first = durable(1, { content: "🙂" });
    const limit = Buffer.byteLength(encodeSseEnvelope(first), "utf8");
    const runtime = new SseRuntime(new FakeReader(0), {
      maxBufferedEvents: 10,
      maxBufferedBytes: limit
    });
    const sink = new FirstWriteBlockedSink();
    const connection = runtime.open({ roomId: "room:main", sink });
    await connection.ready;

    runtime.publish(first);
    await vi.waitFor(() => expect(sink.frames).toHaveLength(1));
    runtime.publish(durable(2, { content: "🙂" }));

    await expect(connection.closed).resolves.toMatchObject({ code: "durable_overflow" });
    sink.release();
  });
});

describe("SseRuntime heartbeat", () => {
  it("writes a comment every 15 seconds and stops after close", async () => {
    vi.useFakeTimers();
    const runtime = new SseRuntime(new FakeReader(0));
    const sink = new RecordingSink();
    const connection = runtime.open({ roomId: "room:main", sink });
    await connection.ready;

    await vi.advanceTimersByTimeAsync(14_999);
    expect(sink.frames).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(sink.frames).toEqual([": heartbeat\n\n"]);
    expect(connection.snapshot().lastSentDurableSeq).toBe(0);

    connection.close();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sink.frames).toHaveLength(1);
  });
});

describe("SseRuntime close", () => {
  it("releases an in-flight frame and ignores its late completion", async () => {
    const runtime = new SseRuntime(new FakeReader(0));
    const sink = new FirstWriteBlockedSink();
    const connection = runtime.open({ roomId: "room:main", sink });
    await connection.ready;
    runtime.publish(durable(1));
    await vi.waitFor(() => expect(sink.frames).toHaveLength(1));

    connection.close();
    await connection.closed;
    expect(connection.snapshot()).toMatchObject({
      phase: "closed",
      bufferedEvents: 0,
      bufferedBytes: 0,
      lastSentDurableSeq: 0
    });

    sink.release();
    await settle();
    expect(connection.snapshot().lastSentDurableSeq).toBe(0);
  });

  it("settles ready and aborts a pending high-water capture", async () => {
    let captureSignal: AbortSignal | undefined;
    const reader: SseDurableEventReader = {
      captureHighWaterSeq: (_roomId, signal) => {
        captureSignal = signal;
        return new Promise<number>(() => undefined);
      },
      readDurableRange: () => []
    };
    const runtime = new SseRuntime(reader);
    const connection = runtime.open({ roomId: "room:main", sink: new RecordingSink() });

    connection.close();
    await connection.ready;

    expect(captureSignal?.aborted).toBe(true);
    expect(connection.snapshot()).toMatchObject({
      phase: "closed",
      bufferedEvents: 0,
      bufferedBytes: 0
    });
  });

  it("requests iterator cleanup when replay is closed during a pending read", async () => {
    let nextStarted = false;
    let returned = false;
    let replaySignal: AbortSignal | undefined;
    const reader: SseDurableEventReader = {
      captureHighWaterSeq: () => 1,
      readDurableRange: (request) => {
        replaySignal = request.signal;
        return {
          [Symbol.asyncIterator](): AsyncIterator<DurableGroupXEnvelope> {
            return {
              next: () => {
                nextStarted = true;
                return new Promise<IteratorResult<DurableGroupXEnvelope>>(() => undefined);
              },
              return: async () => {
                returned = true;
                return { value: undefined, done: true };
              }
            };
          }
        };
      }
    };
    const runtime = new SseRuntime(reader);
    const connection = runtime.open({ roomId: "room:main", sink: new RecordingSink() });
    await vi.waitFor(() => expect(nextStarted).toBe(true));

    connection.close();
    await connection.ready;
    await vi.waitFor(() => expect(returned).toBe(true));

    expect(replaySignal?.aborted).toBe(true);
    expect(connection.snapshot().bufferedEvents).toBe(0);
  });

  it("requests iterator cleanup when replay validation throws", async () => {
    let returned = false;
    let emitted = false;
    const reader: SseDurableEventReader = {
      captureHighWaterSeq: () => 1,
      readDurableRange: () => ({
        [Symbol.iterator](): Iterator<DurableGroupXEnvelope> {
          return {
            next: () => {
              if (emitted) {
                return { value: undefined, done: true };
              }
              emitted = true;
              return { value: { ...durable(1), roomId: "room:wrong" }, done: false };
            },
            return: () => {
              returned = true;
              return { value: undefined, done: true };
            }
          };
        }
      })
    };
    const runtime = new SseRuntime(reader);
    const connection = runtime.open({ roomId: "room:main", sink: new RecordingSink() });

    await connection.ready;
    await expect(connection.closed).resolves.toMatchObject({ code: "replay_error" });
    expect(returned).toBe(true);
  });
});
