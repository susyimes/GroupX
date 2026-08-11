import type { GroupXEnvelope } from "../../core/envelope.js";
import { encodeSseEnvelope, SSE_HEARTBEAT_FRAME, sseFrameBytes } from "./codec.js";
import type {
  DurableGroupXEnvelope,
  OpenSseConnectionOptions,
  SseCloseCode,
  SseCloseInfo,
  SseConnectionSnapshot,
  SseDurableEventReader,
  SseRuntimeOptions
} from "./types.js";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_MAX_BUFFERED_EVENTS = 256;
const DEFAULT_MAX_BUFFERED_BYTES = 1_048_576;

type ConnectionPhase = "replaying" | "live" | "closed";

interface PendingFrame {
  kind: "event" | "heartbeat";
  frame: string;
  bytes: number;
  counted: boolean;
  envelope?: GroupXEnvelope;
}

const DURABLE_DEDUP_WINDOW = 1_024;

function abortError(): Error {
  const error = new Error("SSE connection aborted");
  error.name = "AbortError";
  return error;
}

async function awaitWithAbort<T>(value: T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw abortError();
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function cursor(value: number | undefined): number {
  const normalized = value ?? 0;
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw new RangeError("afterSeq must be a non-negative safe integer");
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function transientTurnId(envelope: GroupXEnvelope): string | undefined {
  if (envelope.durability !== "transient" || !isRecord(envelope.body)) {
    return undefined;
  }
  return typeof envelope.body.turnId === "string" ? envelope.body.turnId : undefined;
}

function mergeTransient(
  previous: GroupXEnvelope,
  next: GroupXEnvelope
): GroupXEnvelope | undefined {
  const previousTurnId = transientTurnId(previous);
  if (
    previousTurnId === undefined ||
    previousTurnId !== transientTurnId(next) ||
    previous.type !== next.type ||
    previous.actor.actorId !== next.actor.actorId ||
    previous.actor.instanceId !== next.actor.instanceId ||
    previous.correlationId !== next.correlationId ||
    !isRecord(previous.body) ||
    !isRecord(next.body)
  ) {
    return undefined;
  }

  if (
    (next.type === "turn.content.delta" || next.type === "turn.reasoning.delta") &&
    typeof previous.body.text === "string" &&
    typeof next.body.text === "string"
  ) {
    return {
      ...next,
      body: {
        ...next.body,
        text: `${previous.body.text}${next.body.text}`
      }
    };
  }

  // Progress-like transient events are snapshots; retaining only the newest
  // value is a loss-tolerant coalesce for the same turn and event type.
  return next;
}

function pendingEvent(envelope: GroupXEnvelope): PendingFrame {
  const frame = encodeSseEnvelope(envelope);
  return {
    kind: "event",
    frame,
    bytes: sseFrameBytes(frame),
    counted: false,
    envelope
  };
}

function pendingHeartbeat(): PendingFrame {
  return {
    kind: "heartbeat",
    frame: SSE_HEARTBEAT_FRAME,
    bytes: sseFrameBytes(SSE_HEARTBEAT_FRAME),
    counted: false
  };
}

export class SseConnection {
  readonly ready: Promise<void>;
  readonly closed: Promise<SseCloseInfo>;

  readonly #reader: SseDurableEventReader;
  readonly #roomId: string;
  readonly #afterSeq: number;
  readonly #sink: OpenSseConnectionOptions["sink"];
  readonly #maxBufferedEvents: number;
  readonly #maxBufferedBytes: number;
  readonly #onClosed: (connection: SseConnection) => void;
  readonly #signal: AbortSignal | undefined;
  readonly #output: PendingFrame[] = [];
  readonly #bootstrapLive: PendingFrame[] = [];
  readonly #replayLookahead: PendingFrame[] = [];
  readonly #bootstrapDurableSeqs = new Map<number, string>();
  readonly #seenDurableEvents = new Map<number, string>();
  readonly #internalAbort = new AbortController();
  readonly #closedPromiseResolve: (info: SseCloseInfo) => void;
  readonly #readyPromiseResolve: () => void;

  #phase: ConnectionPhase = "replaying";
  #highWaterSeq: number | undefined;
  #lastAcceptedDurableSeq: number;
  #lastSentDurableSeq: number;
  #bufferedEvents = 0;
  #bufferedBytes = 0;
  #inFlight: PendingFrame | undefined;
  #pumping = false;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #abortListener: (() => void) | undefined;
  #started = false;

  constructor(
    reader: SseDurableEventReader,
    options: OpenSseConnectionOptions,
    runtimeOptions: Required<SseRuntimeOptions>,
    onClosed: (connection: SseConnection) => void
  ) {
    this.#reader = reader;
    this.#roomId = options.roomId;
    this.#afterSeq = cursor(options.afterSeq);
    this.#lastAcceptedDurableSeq = this.#afterSeq;
    this.#lastSentDurableSeq = this.#afterSeq;
    this.#sink = options.sink;
    this.#maxBufferedEvents = runtimeOptions.maxBufferedEvents;
    this.#maxBufferedBytes = runtimeOptions.maxBufferedBytes;
    this.#onClosed = onClosed;
    this.#signal = options.signal;

    let resolveClosed: ((info: SseCloseInfo) => void) | undefined;
    this.closed = new Promise<SseCloseInfo>((resolve) => {
      resolveClosed = resolve;
    });
    this.#closedPromiseResolve = resolveClosed as (info: SseCloseInfo) => void;

    let resolveReady: (() => void) | undefined;
    this.ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    this.#readyPromiseResolve = resolveReady as () => void;

    this.#heartbeatIntervalMs = runtimeOptions.heartbeatIntervalMs;
  }

  readonly #heartbeatIntervalMs: number;

  /** Called by SseRuntime only after the connection has been registered. */
  start(): void {
    if (this.#started) {
      return;
    }
    this.#started = true;

    if (this.#signal) {
      this.#abortListener = () => this.close("aborted");
      if (this.#signal.aborted) {
        this.close("aborted");
        this.#readyPromiseResolve();
        return;
      }
      this.#signal.addEventListener("abort", this.#abortListener, { once: true });
    }

    this.#heartbeat = setInterval(() => {
      this.#offerHeartbeat();
    }, this.#heartbeatIntervalMs);
    this.#heartbeat.unref?.();

    void this.#bootstrap()
      .catch((error: unknown) => {
        this.#closeWithInfo({ code: "replay_error", error });
      })
      .finally(() => {
        this.#readyPromiseResolve();
      });
  }

  get roomId(): string {
    return this.#roomId;
  }

  get isClosed(): boolean {
    return this.#phase === "closed";
  }

  snapshot(): SseConnectionSnapshot {
    const result: SseConnectionSnapshot = {
      phase: this.#phase,
      afterSeq: this.#afterSeq,
      lastSentDurableSeq: this.#lastSentDurableSeq,
      bufferedEvents: this.#bufferedEvents,
      bufferedBytes: this.#bufferedBytes
    };
    if (this.#highWaterSeq !== undefined) {
      result.highWaterSeq = this.#highWaterSeq;
    }
    return result;
  }

  receiveLive(envelope: GroupXEnvelope): void {
    if (this.#phase === "closed" || envelope.roomId !== this.#roomId) {
      return;
    }

    if (this.#phase === "replaying") {
      if (
        envelope.durability === "durable" &&
        envelope.seq !== null &&
        this.#highWaterSeq !== undefined &&
        envelope.seq <= this.#highWaterSeq
      ) {
        // This commit is inside the pinned replay range. Keeping its live copy
        // would both duplicate delivery and waste the connection's bound.
        return;
      }
      if (
        envelope.durability === "durable" &&
        envelope.seq !== null &&
        this.#bootstrapDurableSeqs.has(envelope.seq)
      ) {
        if (this.#bootstrapDurableSeqs.get(envelope.seq) !== envelope.eventId) {
          this.#closeWithInfo({ code: "sequence_error" });
        }
        return;
      }
      const item = pendingEvent(envelope);
      if (this.#offer(item, this.#bootstrapLive) && envelope.durability === "durable") {
        this.#bootstrapDurableSeqs.set(envelope.seq as number, envelope.eventId);
      }
      return;
    }

    this.#acceptLiveItem(pendingEvent(envelope));
  }

  close(code: Extract<SseCloseCode, "client_closed" | "server_closed" | "aborted"> = "client_closed"): void {
    this.#closeWithInfo({ code });
  }

  async #bootstrap(): Promise<void> {
    if (this.isClosed) {
      return;
    }

    const highWaterSeq = await awaitWithAbort(
      this.#reader.captureHighWaterSeq(this.#roomId, this.#internalAbort.signal),
      this.#internalAbort.signal
    );
    if (!Number.isSafeInteger(highWaterSeq) || highWaterSeq < 0) {
      throw new RangeError("captureHighWaterSeq returned an invalid cursor");
    }
    if (this.isClosed) {
      return;
    }
    this.#highWaterSeq = highWaterSeq;

    // Events published between registration and high-water capture may also
    // be present in storage. Remove those live copies before replay so the
    // connection budget never temporarily counts the same durable event twice.
    for (let index = this.#bootstrapLive.length - 1; index >= 0; index -= 1) {
      const item = this.#bootstrapLive[index];
      const envelope = item?.envelope;
      if (
        item &&
        envelope?.durability === "durable" &&
        envelope.seq !== null &&
        envelope.seq <= highWaterSeq
      ) {
        this.#bootstrapLive.splice(index, 1);
        this.#bootstrapDurableSeqs.delete(envelope.seq);
        this.#release(item);
      }
    }

    if (highWaterSeq > this.#afterSeq) {
      const source = this.#reader.readDurableRange({
        roomId: this.#roomId,
        afterSeq: this.#afterSeq,
        throughSeq: highWaterSeq,
        signal: this.#internalAbort.signal
      });
      const iterator: Iterator<DurableGroupXEnvelope> | AsyncIterator<DurableGroupXEnvelope> =
        Symbol.asyncIterator in source
          ? source[Symbol.asyncIterator]()
          : source[Symbol.iterator]();
      let completed = false;
      try {
        while (!this.isClosed) {
          const result = await awaitWithAbort(
            Promise.resolve(iterator.next()),
            this.#internalAbort.signal
          );
          if (result.done) {
            break;
          }
          const envelope = result.value;
          this.#assertReplayEnvelope(envelope, highWaterSeq);
          if (!this.#stageReplayEnvelope(envelope)) {
            return;
          }
        }
        completed = true;
      } finally {
        if ((!completed || this.isClosed) && iterator.return) {
          try {
            void Promise.resolve(iterator.return()).catch(() => undefined);
          } catch {
            // The connection is already closed; iterator cleanup is best effort.
          }
        }
      }
      this.#flushReplayLookahead();
    }

    if (this.isClosed) {
      return;
    }

    for (const item of this.#bootstrapLive.splice(0)) {
      const envelope = item.envelope;
      if (
        envelope?.durability === "durable" &&
        envelope.seq !== null &&
        envelope.seq <= highWaterSeq
      ) {
        this.#release(item);
        continue;
      }
      this.#acceptPreparedLiveItem(item);
      if (this.isClosed) {
        return;
      }
    }
    this.#bootstrapDurableSeqs.clear();
    this.#phase = "live";
    this.#pump();
  }

  #assertReplayEnvelope(envelope: DurableGroupXEnvelope, highWaterSeq: number): void {
    if (
      envelope.roomId !== this.#roomId ||
      envelope.durability !== "durable" ||
      !Number.isSafeInteger(envelope.seq) ||
      envelope.seq <= this.#afterSeq ||
      envelope.seq > highWaterSeq
    ) {
      throw new TypeError("readDurableRange returned an event outside the requested range");
    }
  }

  #stageReplayEnvelope(envelope: DurableGroupXEnvelope): boolean {
    const previous = this.#replayLookahead[0]?.envelope;
    if (previous?.durability === "durable") {
      const previousSeq = previous.seq as number;
      if (envelope.seq < previousSeq) {
        throw new TypeError("readDurableRange returned events out of sequence");
      }
      if (envelope.seq === previousSeq) {
        if (envelope.eventId !== previous.eventId) {
          throw new TypeError("readDurableRange returned conflicting events for one seq");
        }
        return true;
      }
      this.#flushReplayLookahead();
    }
    return this.#offer(pendingEvent(envelope), this.#replayLookahead);
  }

  #flushReplayLookahead(): void {
    const item = this.#replayLookahead.shift();
    if (!item || this.isClosed) {
      return;
    }
    const classification = this.#classifyDurable(item);
    if (classification === "duplicate") {
      this.#release(item);
      return;
    }
    if (classification === "violation") {
      this.#release(item);
      throw new TypeError("readDurableRange violated durable sequence identity");
    }
    this.#rememberDurable(item);
    this.#output.push(item);
    this.#pump();
  }

  #acceptLiveItem(item: PendingFrame): void {
    const envelope = item.envelope;
    if (envelope?.durability === "durable") {
      const classification = this.#classifyDurable(item);
      if (classification === "duplicate") {
        return;
      }
      if (classification === "violation") {
        this.#closeWithInfo({ code: "sequence_error" });
        return;
      }
    }
    if (!this.#offer(item, this.#output)) {
      return;
    }
    if (envelope?.durability === "durable") {
      this.#rememberDurable(item);
    }
    this.#pump();
  }

  #acceptPreparedLiveItem(item: PendingFrame): void {
    const envelope = item.envelope;
    if (envelope?.durability === "durable") {
      const classification = this.#classifyDurable(item);
      if (classification === "duplicate") {
        this.#release(item);
        return;
      }
      if (classification === "violation") {
        this.#release(item);
        this.#closeWithInfo({ code: "sequence_error" });
        return;
      }
      this.#rememberDurable(item);
    }
    this.#output.push(item);
  }

  #classifyDurable(item: PendingFrame): "accept" | "duplicate" | "violation" {
    const envelope = item.envelope;
    if (envelope?.durability !== "durable" || envelope.seq === null) {
      return "violation";
    }
    if (envelope.seq <= this.#afterSeq) {
      return "duplicate";
    }
    const seenEventId = this.#seenDurableEvents.get(envelope.seq);
    if (seenEventId !== undefined) {
      return seenEventId === envelope.eventId ? "duplicate" : "violation";
    }
    return envelope.seq > this.#lastAcceptedDurableSeq ? "accept" : "violation";
  }

  #rememberDurable(item: PendingFrame): void {
    const envelope = item.envelope as DurableGroupXEnvelope;
    this.#lastAcceptedDurableSeq = envelope.seq;
    this.#seenDurableEvents.set(envelope.seq, envelope.eventId);
    if (this.#seenDurableEvents.size > DURABLE_DEDUP_WINDOW) {
      const oldest = this.#seenDurableEvents.keys().next().value as number | undefined;
      if (oldest !== undefined) {
        this.#seenDurableEvents.delete(oldest);
      }
    }
  }

  #offer(item: PendingFrame, target: PendingFrame[]): boolean {
    if (this.#phase === "closed") {
      return false;
    }

    if (item.envelope?.durability === "transient" && this.#tryCoalesce(item)) {
      return true;
    }

    if (!this.#fits(item)) {
      if (item.envelope?.durability !== "durable") {
        return false;
      }
      this.#discardQueuedTransient();
      if (!this.#fits(item)) {
        this.#closeWithInfo({ code: "durable_overflow" });
        return false;
      }
    }

    target.push(item);
    item.counted = true;
    this.#bufferedEvents += 1;
    this.#bufferedBytes += item.bytes;
    return true;
  }

  #fits(item: PendingFrame): boolean {
    return (
      this.#bufferedEvents + 1 <= this.#maxBufferedEvents &&
      this.#bufferedBytes + item.bytes <= this.#maxBufferedBytes
    );
  }

  #tryCoalesce(next: PendingFrame): boolean {
    const nextEnvelope = next.envelope;
    if (!nextEnvelope) {
      return false;
    }

    for (const collection of [this.#bootstrapLive, this.#output]) {
      for (let index = collection.length - 1; index >= 0; index -= 1) {
        const current = collection[index];
        if (!current?.envelope) {
          continue;
        }
        const mergedEnvelope = mergeTransient(current.envelope, nextEnvelope);
        if (!mergedEnvelope) {
          continue;
        }
        const merged = pendingEvent(mergedEnvelope);
        const mergedTotalBytes = this.#bufferedBytes - current.bytes + merged.bytes;
        if (mergedTotalBytes <= this.#maxBufferedBytes) {
          collection[index] = merged;
          current.counted = false;
          merged.counted = true;
          this.#bufferedBytes = mergedTotalBytes;
          return true;
        }

        // The combined delta is too large. Retaining the newest transient is
        // still legal and keeps memory bounded without harming durable final.
        const newestTotalBytes = this.#bufferedBytes - current.bytes + next.bytes;
        if (newestTotalBytes <= this.#maxBufferedBytes) {
          collection[index] = next;
          current.counted = false;
          next.counted = true;
          this.#bufferedBytes = newestTotalBytes;
          return true;
        }
        return true;
      }
    }
    return false;
  }

  #discardQueuedTransient(): void {
    for (const collection of [this.#bootstrapLive, this.#output]) {
      for (let index = collection.length - 1; index >= 0; index -= 1) {
        const item = collection[index];
        if (item?.kind === "heartbeat" || item?.envelope?.durability === "transient") {
          collection.splice(index, 1);
          this.#release(item);
        }
      }
    }
  }

  #offerHeartbeat(): void {
    if (this.#phase === "closed") {
      return;
    }
    if (this.#output.some((item) => item.kind === "heartbeat")) {
      return;
    }
    const item = pendingHeartbeat();
    if (this.#offer(item, this.#output)) {
      this.#pump();
    }
  }

  #release(item: PendingFrame): void {
    if (!item.counted) {
      return;
    }
    item.counted = false;
    this.#bufferedEvents -= 1;
    this.#bufferedBytes -= item.bytes;
  }

  #pump(): void {
    if (this.#pumping || this.#phase === "closed") {
      return;
    }
    this.#pumping = true;
    queueMicrotask(() => {
      void this.#runPump();
    });
  }

  async #runPump(): Promise<void> {
    try {
      while (this.#phase !== "closed") {
        const item = this.#output.shift();
        if (!item) {
          return;
        }
        this.#inFlight = item;
        const writeSignal = this.#internalAbort.signal;
        try {
          await awaitWithAbort(this.#sink.write(item.frame, writeSignal), writeSignal);
        } catch (error: unknown) {
          this.#release(item);
          this.#inFlight = undefined;
          if (!this.isClosed) {
            this.#closeWithInfo({ code: "sink_error", error });
          }
          return;
        }
        if (this.isClosed || writeSignal.aborted) {
          this.#release(item);
          this.#inFlight = undefined;
          return;
        }
        this.#release(item);
        this.#inFlight = undefined;
        if (item.envelope?.durability === "durable") {
          this.#lastSentDurableSeq = item.envelope.seq as number;
        }
      }
    } finally {
      this.#pumping = false;
      if (this.#phase !== "closed" && this.#output.length > 0) {
        this.#pump();
      }
    }
  }

  #closeWithInfo(info: SseCloseInfo): void {
    if (this.#phase === "closed") {
      return;
    }
    this.#phase = "closed";
    this.#internalAbort.abort();
    this.#readyPromiseResolve();
    if (this.#heartbeat) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = undefined;
    }
    for (const item of this.#output.splice(0)) {
      this.#release(item);
    }
    for (const item of this.#bootstrapLive.splice(0)) {
      this.#release(item);
    }
    for (const item of this.#replayLookahead.splice(0)) {
      this.#release(item);
    }
    if (this.#inFlight) {
      this.#release(this.#inFlight);
      this.#inFlight = undefined;
    }
    this.#bootstrapDurableSeqs.clear();
    if (this.#signal && this.#abortListener) {
      this.#signal.removeEventListener("abort", this.#abortListener);
      this.#abortListener = undefined;
    }
    this.#onClosed(this);
    this.#closedPromiseResolve(info);
    try {
      void Promise.resolve(this.#sink.close(info)).catch(() => undefined);
    } catch {
      // Closing is best effort; the connection is already detached.
    }
  }
}

export class SseRuntime {
  readonly #reader: SseDurableEventReader;
  readonly #options: Required<SseRuntimeOptions>;
  readonly #connections = new Set<SseConnection>();

  constructor(reader: SseDurableEventReader, options: SseRuntimeOptions = {}) {
    this.#reader = reader;
    this.#options = {
      heartbeatIntervalMs: positiveInteger(
        options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
        "heartbeatIntervalMs"
      ),
      maxBufferedEvents: positiveInteger(
        options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS,
        "maxBufferedEvents"
      ),
      maxBufferedBytes: positiveInteger(
        options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
        "maxBufferedBytes"
      )
    };
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  open(options: OpenSseConnectionOptions): SseConnection {
    let connection: SseConnection;
    connection = new SseConnection(this.#reader, options, this.#options, (closed) => {
      this.#connections.delete(closed);
    });
    // Registration intentionally precedes captureHighWaterSeq.
    this.#connections.add(connection);
    connection.start();
    return connection;
  }

  publish(envelope: GroupXEnvelope): void {
    // Validate/serialize before touching any connection so malformed input
    // cannot be delivered to only a subset of subscribers.
    // The Broker must call publish in durable commit order. A later observed
    // reversal is fail-closed, but an already-written SSE id cannot be undone.
    encodeSseEnvelope(envelope);
    for (const connection of this.#connections) {
      connection.receiveLive(envelope);
    }
  }

  close(): void {
    for (const connection of [...this.#connections]) {
      connection.close("server_closed");
    }
  }
}
