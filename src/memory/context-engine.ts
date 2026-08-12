import { createId } from "../core/envelope.js";
import { GroupXError, toGroupXError } from "../core/errors.js";
import type { StoredEventRecord, SummaryRecord } from "../storage/types.js";
import { ContextPacketBuilder } from "./context-packet.js";
import type { BuildContextPacketInput, ContextPacket, ContextPacketStore } from "./types.js";

const EVENT_PAGE_LIMIT = 500;
const DEFAULT_MAX_PASSES = 8;
const DEFAULT_COMPACTION_TRIGGER_RATIO = 0.75;
const MAX_SUMMARY_CHARS = 8_000;
const MIN_COMPACTION_INPUT_CHARS = 40_000;

export interface RoomSummaryMessage {
  seq: number;
  eventId: string;
  actorId: string;
  actorDisplayName: string;
  occurredAt: string;
  content: string;
}

export interface RoomCompactionRequest {
  roomId: string;
  previousSummary?: SummaryRecord;
  messages: readonly RoomSummaryMessage[];
  fromSeq: number;
  throughSeq: number;
  maxOutputChars: number;
  signal: AbortSignal;
}

export type RoomCompactionProgress =
  | {
      phase: "started";
      roomId: string;
      operationId: string;
      attempt: number;
      maxAttempts: number;
      fromSeq: number;
      throughSeq: number;
      messageCount: number;
    }
  | {
      phase: "retrying";
      roomId: string;
      operationId: string;
      attempt: number;
      maxAttempts: number;
      fromSeq: number;
      throughSeq: number;
      messageCount: number;
      nextDelayMs: number;
      errorCode: string;
    }
  | {
      phase: "completed";
      roomId: string;
      operationId: string;
      attempt: number;
      maxAttempts: number;
      fromSeq: number;
      throughSeq: number;
      messageCount: number;
      generatorActorId: string;
      summaryChars: number;
    }
  | {
      phase: "failed";
      roomId: string;
      operationId: string;
      attempt: number;
      maxAttempts: number;
      fromSeq: number;
      throughSeq: number;
      messageCount: number;
      errorCode: string;
    };

export interface RoomCompactionResult {
  content: string;
  generatorActorId: string;
}

export interface RoomContextSummarizer {
  compact(input: RoomCompactionRequest): Promise<RoomCompactionResult>;
}

export interface RoomContextEngineOptions {
  store: ContextPacketStore & {
    replaceActiveSummary(input: {
      summaryId?: string;
      roomId: string;
      fromSeq: number;
      throughSeq: number;
      content: string;
      generatorActorId: string;
      expectedPreviousSummaryId?: string;
      createdAt?: string;
    }): SummaryRecord;
  };
  summarizer: RoomContextSummarizer;
  maxChars: number;
  /** Soft packet target. The configured maxChars remains the hard ceiling. */
  compactionTriggerChars?: number;
  maxPasses?: number;
  maxCompactionInputChars?: number;
  maxSummaryChars?: number;
  /** Total attempts for one compactable chunk, including the first attempt. */
  compactionAttempts?: number;
  compactionRetryBaseMs?: number;
  onProgress?: (progress: RoomCompactionProgress) => void | Promise<void>;
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

function messageContent(event: StoredEventRecord): string {
  if (event.eventType !== "message.created") {
    throw new GroupXError("INVALID_ENVELOPE", "Compaction source must be a message event");
  }
  const body = event.body as Record<string, unknown> | null;
  if (body === null || typeof body.content !== "string") {
    throw new GroupXError("STORE_UNAVAILABLE", "Compaction message has no string content");
  }
  return body.content;
}

function toSummaryMessage(event: StoredEventRecord): RoomSummaryMessage {
  return {
    seq: event.seq,
    eventId: event.eventId,
    actorId: event.actorId,
    actorDisplayName: event.actorDisplayName,
    occurredAt: event.occurredAt,
    content: messageContent(event)
  };
}

function renderedMessageChars(message: RoomSummaryMessage): number {
  return (
    message.content.length +
    message.actorId.length +
    message.actorDisplayName.length +
    message.occurredAt.length +
    96
  );
}

/**
 * Builds bounded room context and rolls old transcript into a durable checkpoint
 * only when the packet would otherwise omit unread messages.
 */
export class RoomContextEngine {
  readonly #store: RoomContextEngineOptions["store"];
  readonly #builder: ContextPacketBuilder;
  readonly #summarizer: RoomContextSummarizer;
  readonly #maxChars: number;
  readonly #compactionTriggerChars: number;
  readonly #maxPasses: number;
  readonly #maxCompactionInputChars: number;
  readonly #maxSummaryChars: number;
  readonly #compactionAttempts: number;
  readonly #compactionRetryBaseMs: number;
  readonly #onProgress: RoomContextEngineOptions["onProgress"];
  readonly #roomFlights = new Map<string, Promise<void>>();
  readonly #activeControllers = new Set<AbortController>();
  #closed = false;

  constructor(options: RoomContextEngineOptions) {
    this.#store = options.store;
    this.#builder = new ContextPacketBuilder(options.store);
    this.#summarizer = options.summarizer;
    this.#maxChars = options.maxChars;
    this.#compactionTriggerChars =
      options.compactionTriggerChars ??
      Math.min(
        options.maxChars,
        Math.max(1_024, Math.floor(options.maxChars * DEFAULT_COMPACTION_TRIGGER_RATIO))
      );
    this.#maxPasses = options.maxPasses ?? DEFAULT_MAX_PASSES;
    this.#maxCompactionInputChars =
      options.maxCompactionInputChars ??
      Math.max(MIN_COMPACTION_INPUT_CHARS, Math.min(options.maxChars, 120_000));
    this.#maxSummaryChars =
      options.maxSummaryChars ??
      Math.max(1_024, Math.min(MAX_SUMMARY_CHARS, Math.floor(options.maxChars / 4)));
    this.#compactionAttempts = options.compactionAttempts ?? 3;
    this.#compactionRetryBaseMs = options.compactionRetryBaseMs ?? 300;
    this.#onProgress = options.onProgress;
    for (const [name, value] of [
      ["maxChars", this.#maxChars],
      ["compactionTriggerChars", this.#compactionTriggerChars],
      ["maxPasses", this.#maxPasses],
      ["maxCompactionInputChars", this.#maxCompactionInputChars],
      ["maxSummaryChars", this.#maxSummaryChars],
      ["compactionAttempts", this.#compactionAttempts],
      ["compactionRetryBaseMs", this.#compactionRetryBaseMs]
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive safe integer`);
      }
    }
    if (this.#compactionTriggerChars > this.#maxChars) {
      throw new RangeError("compactionTriggerChars must not exceed maxChars");
    }
  }

  async prepare(input: Omit<BuildContextPacketInput, "maxChars">): Promise<ContextPacket> {
    if (this.#closed) {
      throw new GroupXError("SESSION_NOT_AVAILABLE", "Room context engine is closed");
    }
    const build = (maxChars = this.#compactionTriggerChars): ContextPacket =>
      this.#builder.buildContextPacket(
        input.currentEvent === undefined
          ? {
              roomId: input.roomId,
              targetActorId: input.targetActorId,
              ...(input.configuredIdentity === undefined
                ? {}
                : { configuredIdentity: input.configuredIdentity }),
              throughSeq: input.throughSeq,
              maxChars,
              currentMessage:
                input.currentMessage ??
                (() => {
                  throw new GroupXError("INVALID_ENVELOPE", "currentMessage is required");
                })()
            }
          : {
              roomId: input.roomId,
              targetActorId: input.targetActorId,
              ...(input.configuredIdentity === undefined
                ? {}
                : { configuredIdentity: input.configuredIdentity }),
              throughSeq: input.throughSeq,
              maxChars,
              currentEvent: input.currentEvent
            }
      );
    for (let pass = 0; ; pass += 1) {
      let packet: ContextPacket;
      try {
        packet = build();
      } catch (error) {
        if (!(error instanceof GroupXError) || error.code !== "CONTEXT_BUDGET_EXCEEDED") {
          throw error;
        }
        if (!this.#hasCompactableHistory(input)) {
          // A large current message or required reply chain may exceed the
          // 75% target without exceeding the configured hard ceiling.
          return build(this.#maxChars);
        }
        if (pass >= this.#maxPasses) {
          throw new GroupXError(
            "CONTEXT_BUDGET_EXCEEDED",
            "Required room context still exceeds the soft target after bounded compaction",
            { maxPasses: this.#maxPasses, triggerChars: this.#compactionTriggerChars },
            { cause: error }
          );
        }
        await this.#compactSingleFlight(input.roomId, input.throughSeq, undefined);
        continue;
      }
      if (packet.omitted.unreadTranscript === 0) return packet;
      if (pass >= this.#maxPasses) {
        throw new GroupXError(
          "CONTEXT_BUDGET_EXCEEDED",
          "Room history still exceeds the context budget after bounded compaction",
          {
            omittedMessages: packet.omitted.unreadTranscript,
            maxPasses: this.#maxPasses,
            triggerChars: this.#compactionTriggerChars
          }
        );
      }
      await this.#compactSingleFlight(input.roomId, input.throughSeq, packet);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const controller of this.#activeControllers) {
      controller.abort(new GroupXError("TURN_INTERRUPTED", "Room context engine is closing"));
    }
  }

  async #compactSingleFlight(
    roomId: string,
    throughSeq: number,
    packet: ContextPacket | undefined
  ): Promise<void> {
    const existing = this.#roomFlights.get(roomId);
    if (existing) {
      await existing;
      return;
    }
    const operation = this.#compactOneChunk(roomId, throughSeq, packet);
    this.#roomFlights.set(roomId, operation);
    try {
      await operation;
    } finally {
      if (this.#roomFlights.get(roomId) === operation) this.#roomFlights.delete(roomId);
    }
  }

  async #compactOneChunk(
    roomId: string,
    throughSeq: number,
    packet: ContextPacket | undefined
  ): Promise<void> {
    const previous = this.#store.getActiveSummary(roomId, throughSeq);
    const firstRetainedSeq =
      packet?.sections.unreadTranscript.reduce(
        (minimum, entry) => Math.min(minimum, entry.seq ?? Number.MAX_SAFE_INTEGER),
        throughSeq
      ) ?? throughSeq;
    const desiredCutoff = Math.max(0, firstRetainedSeq - 1);
    const afterSeq = previous?.throughSeq ?? 0;
    if (desiredCutoff <= afterSeq) {
      throw new GroupXError(
        "CONTEXT_BUDGET_EXCEEDED",
        "The persisted summary and retained transcript cannot fit the context budget"
      );
    }

    const previousChars = previous?.content.length ?? 0;
    const sourceBudget = Math.max(
      1,
      this.#maxCompactionInputChars - previousChars - 4_000
    );
    const selected = this.#readMessages(roomId, afterSeq, desiredCutoff, sourceBudget);
    if (selected.length === 0) {
      throw new GroupXError(
        "CONTEXT_BUDGET_EXCEEDED",
        "No compactable room messages precede the retained transcript"
      );
    }

    const selectedThroughSeq = selected.at(-1)!.seq;
    let generated: RoomCompactionResult | undefined;
    const controller = new AbortController();
    this.#activeControllers.add(controller);
    const operationId = createId("compaction");
    const progressBase = {
      roomId,
      operationId,
      maxAttempts: this.#compactionAttempts,
      fromSeq: previous?.fromSeq ?? selected[0]!.seq,
      throughSeq: selectedThroughSeq,
      messageCount: selected.length
    };
    let lastError: unknown;
    let completedAttempt = 1;
    try {
      for (let attempt = 1; attempt <= this.#compactionAttempts; attempt += 1) {
        await this.#emitProgress({ phase: "started", ...progressBase, attempt });
        try {
          generated = await this.#summarizer.compact({
            roomId,
            ...(previous === undefined ? {} : { previousSummary: previous }),
            messages: selected,
            fromSeq: progressBase.fromSeq,
            throughSeq: selectedThroughSeq,
            maxOutputChars: this.#maxSummaryChars,
            signal: controller.signal
          });
          completedAttempt = attempt;
          break;
        } catch (error) {
          lastError = error;
          if (
            attempt >= this.#compactionAttempts ||
            !new Set([
              "ADAPTER_START_FAILED",
              "PROTOCOL_HANDSHAKE_TIMEOUT",
              "SESSION_NOT_AVAILABLE",
              "TURN_FIRST_EVENT_TIMEOUT",
              "TURN_IDLE_TIMEOUT",
              "TURN_INTERRUPTED"
            ]).has(
              toGroupXError(error, "SESSION_NOT_AVAILABLE").code
            ) ||
            controller.signal.aborted
          ) {
            await this.#emitProgress({
              phase: "failed",
              ...progressBase,
              attempt,
              errorCode: toGroupXError(error, "SESSION_NOT_AVAILABLE").code
            });
            break;
          }
          const nextDelayMs = this.#compactionRetryBaseMs * 2 ** (attempt - 1);
          await this.#emitProgress({
            phase: "retrying",
            ...progressBase,
            attempt,
            nextDelayMs,
            errorCode: toGroupXError(error, "SESSION_NOT_AVAILABLE").code
          });
          await waitForRetry(nextDelayMs, controller.signal);
        }
      }
    } catch (error) {
      lastError = error;
    } finally {
      this.#activeControllers.delete(controller);
    }
    if (generated === undefined) {
      throw new GroupXError(
        "CONTEXT_BUDGET_EXCEEDED",
        "No available Agent could compact the room context",
        { throughSeq: selectedThroughSeq },
        { cause: toGroupXError(lastError, "SESSION_NOT_AVAILABLE") }
      );
    }
    const content = generated.content.trim();
    if (content.length === 0 || content.length > this.#maxSummaryChars) {
      await this.#emitProgress({
        phase: "failed",
        ...progressBase,
        attempt: completedAttempt,
        errorCode: "PROTOCOL_INVALID_MESSAGE"
      });
      throw new GroupXError(
        "CONTEXT_BUDGET_EXCEEDED",
        "Agent-generated room summary is empty or exceeds its output budget",
        { summaryChars: content.length, maxSummaryChars: this.#maxSummaryChars }
      );
    }

    try {
      this.#store.replaceActiveSummary({
        summaryId: createId("summary"),
        roomId,
        fromSeq: previous?.fromSeq ?? selected[0]!.seq,
        throughSeq: selectedThroughSeq,
        content,
        generatorActorId: generated.generatorActorId,
        ...(previous === undefined ? {} : { expectedPreviousSummaryId: previous.summaryId })
      });
    } catch (error) {
      await this.#emitProgress({
        phase: "failed",
        ...progressBase,
        attempt: completedAttempt,
        errorCode: toGroupXError(error, "STORE_UNAVAILABLE").code
      });
      throw error;
    }
    await this.#emitProgress({
      phase: "completed",
      ...progressBase,
      attempt: completedAttempt,
      generatorActorId: generated.generatorActorId,
      summaryChars: content.length
    });
  }

  async #emitProgress(progress: RoomCompactionProgress): Promise<void> {
    try {
      await this.#onProgress?.(progress);
    } catch {
      // UI telemetry is best effort and must not decide whether compaction succeeds.
    }
  }

  #hasCompactableHistory(input: Omit<BuildContextPacketInput, "maxChars">): boolean {
    const cursorSeq =
      this.#store.getDeliveryCursor(input.targetActorId, input.roomId)?.lastDeliveredSeq ?? 0;
    const summarySeq = this.#store.getActiveSummary(input.roomId, input.throughSeq)?.throughSeq ?? 0;
    let afterSeq = Math.max(cursorSeq, summarySeq);
    const currentEventId = input.currentEvent?.eventId;
    while (afterSeq < input.throughSeq) {
      const page = this.#store.listEventsThrough({
        roomId: input.roomId,
        afterSeq,
        throughSeq: input.throughSeq,
        limit: EVENT_PAGE_LIMIT
      });
      if (
        page.events.some(
          (event) => event.eventType === "message.created" && event.eventId !== currentEventId
        )
      ) {
        return true;
      }
      if (page.nextAfterSeq <= afterSeq || !page.hasMore) return false;
      afterSeq = page.nextAfterSeq;
    }
    return false;
  }

  #readMessages(
    roomId: string,
    afterSeq: number,
    throughSeq: number,
    sourceBudget: number
  ): RoomSummaryMessage[] {
    const messages: RoomSummaryMessage[] = [];
    let selectedChars = 0;
    let cursor = afterSeq;
    while (cursor < throughSeq) {
      const page = this.#store.listEventsThrough({
        roomId,
        afterSeq: cursor,
        throughSeq,
        limit: EVENT_PAGE_LIMIT
      });
      if (page.events.length === 0) break;
      for (const event of page.events) {
        cursor = event.seq;
        if (event.eventType !== "message.created") continue;
        const message = toSummaryMessage(event);
        const nextChars = renderedMessageChars(message);
        if (messages.length > 0 && selectedChars + nextChars > sourceBudget) return messages;
        messages.push(message);
        selectedChars += nextChars;
      }
      if (!page.hasMore) break;
    }
    return messages;
  }
}
