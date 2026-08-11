import type { GroupXEnvelope } from "../core/envelope.js";
import { GroupXError } from "../core/errors.js";
import type { GroupXStore } from "../storage/types.js";
import type {
  DurableGroupXEnvelope,
  DurableRangeRequest,
  SseDurableEventReader
} from "../web/sse/types.js";
import { toDurableEnvelope } from "./record-mappers.js";

const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

function assertNonNegativeSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

/** SQLite-backed replay reader used by every SSE connection. */
export class SqliteSseEventReader implements SseDurableEventReader {
  readonly #store: GroupXStore;
  readonly #pageSize: number;

  constructor(store: GroupXStore, input: { pageSize?: number } = {}) {
    this.#store = store;
    this.#pageSize = input.pageSize ?? DEFAULT_PAGE_SIZE;
    if (!Number.isSafeInteger(this.#pageSize) || this.#pageSize < 1 || this.#pageSize > 500) {
      throw new RangeError("pageSize must be an integer between 1 and 500");
    }
  }

  captureHighWaterSeq(roomId: string, signal: AbortSignal): number {
    throwIfAborted(signal);
    return this.#store.getRoomHighWaterSeq(roomId);
  }

  *readDurableRange(request: DurableRangeRequest): Iterable<DurableGroupXEnvelope> {
    assertNonNegativeSafeInteger(request.afterSeq, "afterSeq");
    assertNonNegativeSafeInteger(request.throughSeq, "throughSeq");
    if (request.throughSeq < request.afterSeq) {
      throw new RangeError("throughSeq must be greater than or equal to afterSeq");
    }

    let cursor = request.afterSeq;
    while (cursor < request.throughSeq) {
      throwIfAborted(request.signal);
      const page = this.#store.listEventsThrough({
        roomId: request.roomId,
        afterSeq: cursor,
        throughSeq: request.throughSeq,
        limit: this.#pageSize
      });
      if (page.events.length === 0) return;

      for (const event of page.events) {
        throwIfAborted(request.signal);
        if (event.seq <= cursor || event.seq > request.throughSeq) {
          throw new GroupXError(
            "STORE_UNAVAILABLE",
            "SQLite durable replay returned an event outside its fixed snapshot"
          );
        }
        cursor = event.seq;
        yield toDurableEnvelope(event);
      }
      if (!page.hasMore) return;
    }
  }
}

export interface LiveEnvelopePublisher {
  publish(envelope: GroupXEnvelope): void | Promise<void>;
}

export interface SequencedEventPublisherOptions {
  closeTimeoutMs?: number;
}

/**
 * Converts Broker commit notifications into monotonic live publication.
 *
 * A notification is only a wake-up signal. Durable events are re-read from
 * SQLite through a captured high-water mark, so concurrent callers cannot
 * publish a later committed sequence before an earlier one.
 */
export class SequencedEventPublisher {
  readonly #store: GroupXStore;
  readonly #live: LiveEnvelopePublisher;
  readonly #closeTimeoutMs: number;
  readonly #publishedThrough = new Map<string, number>();
  readonly #tails = new Map<string, Promise<void>>();
  #closed = false;

  constructor(
    store: GroupXStore,
    live: LiveEnvelopePublisher,
    options: SequencedEventPublisherOptions = {}
  ) {
    this.#store = store;
    this.#live = live;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#closeTimeoutMs) || this.#closeTimeoutMs < 1) {
      throw new RangeError("closeTimeoutMs must be a positive integer");
    }
  }

  /** Seed rooms before serving traffic so historical rows remain replay-only. */
  initialize(roomIds: readonly string[]): void {
    if (this.#closed) {
      throw new GroupXError("SESSION_NOT_AVAILABLE", "Event publisher is closed");
    }
    if (this.#tails.size > 0) {
      throw new GroupXError("STORE_CONFLICT", "Event publisher is already active");
    }
    for (const roomId of new Set(roomIds)) {
      const highWater = this.#store.getRoomHighWaterSeq(roomId);
      const current = this.#publishedThrough.get(roomId) ?? 0;
      this.#publishedThrough.set(roomId, Math.max(current, highWater));
    }
  }

  async publish(envelope: GroupXEnvelope): Promise<void> {
    if (this.#closed) {
      throw new GroupXError("SESSION_NOT_AVAILABLE", "Event publisher is closed");
    }

    const roomId = envelope.roomId;
    const previous = this.#tails.get(roomId) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        await this.#drainDurable(roomId);
        if (envelope.durability === "transient") {
          await this.#live.publish(envelope);
        }
      });
    this.#tails.set(roomId, operation);
    try {
      await operation;
    } finally {
      if (this.#tails.get(roomId) === operation) {
        this.#tails.delete(roomId);
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const pending = Promise.allSettled([...this.#tails.values()]).then(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new GroupXError("TURN_INTERRUPTED", "Event publisher close timed out")),
        this.#closeTimeoutMs
      );
    });
    try {
      await Promise.race([pending, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
      this.#tails.clear();
    }
  }

  async #drainDurable(roomId: string): Promise<void> {
    let cursor = this.#publishedThrough.get(roomId) ?? 0;
    const throughSeq = this.#store.getRoomHighWaterSeq(roomId);
    while (cursor < throughSeq) {
      const page = this.#store.listEventsThrough({
        roomId,
        afterSeq: cursor,
        throughSeq,
        limit: DEFAULT_PAGE_SIZE
      });
      if (page.events.length === 0) break;
      for (const event of page.events) {
        if (event.seq <= cursor || event.seq > throughSeq) {
          throw new GroupXError(
            "STORE_UNAVAILABLE",
            "SQLite live drain returned an event outside its fixed snapshot"
          );
        }
        await this.#live.publish(toDurableEnvelope(event));
        cursor = event.seq;
        this.#publishedThrough.set(roomId, cursor);
      }
      if (!page.hasMore) break;
    }
  }
}
