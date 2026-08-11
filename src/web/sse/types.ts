import type { GroupXEnvelope } from "../../core/envelope.js";

export type DurableGroupXEnvelope<TBody = unknown> = GroupXEnvelope<TBody> & {
  durability: "durable";
  seq: number;
};

export type TransientGroupXEnvelope<TBody = unknown> = GroupXEnvelope<TBody> & {
  durability: "transient";
  seq: null;
};

export interface DurableRangeRequest {
  roomId: string;
  afterSeq: number;
  throughSeq: number;
  signal: AbortSignal;
}

/**
 * The storage-facing side of SSE. Implementations must take the high-water
 * mark from the same committed durable sequence space used by readDurableRange.
 * readDurableRange must yield committed events in ascending seq order and
 * must never expose a higher seq before a lower event from the same room.
 */
export interface SseDurableEventReader {
  captureHighWaterSeq(roomId: string, signal: AbortSignal): number | Promise<number>;
  readDurableRange(
    request: DurableRangeRequest
  ): AsyncIterable<DurableGroupXEnvelope> | Iterable<DurableGroupXEnvelope>;
}

/**
 * A single HTTP response (or a test double). A write promise resolves only
 * when that frame has passed the sink's own backpressure boundary.
 */
export interface SseSink {
  write(frame: string, signal: AbortSignal): void | Promise<void>;
  close(info: SseCloseInfo): void | Promise<void>;
}

export type SseCloseCode =
  | "client_closed"
  | "server_closed"
  | "aborted"
  | "durable_overflow"
  | "sequence_error"
  | "sink_error"
  | "replay_error";

export interface SseCloseInfo {
  code: SseCloseCode;
  error?: unknown;
}

export interface OpenSseConnectionOptions {
  roomId: string;
  afterSeq?: number;
  sink: SseSink;
  signal?: AbortSignal;
}

export interface SseRuntimeOptions {
  heartbeatIntervalMs?: number;
  maxBufferedEvents?: number;
  maxBufferedBytes?: number;
}

export interface SseConnectionSnapshot {
  phase: "replaying" | "live" | "closed";
  afterSeq: number;
  highWaterSeq?: number;
  lastSentDurableSeq: number;
  bufferedEvents: number;
  bufferedBytes: number;
}
