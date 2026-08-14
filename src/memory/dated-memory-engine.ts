import { GroupXError, toGroupXError } from "../core/errors.js";
import type {
  AgentDatedMemoryRollupRecord,
  AgentDatedMemorySourceRecord,
  GroupXStore,
  MemoryRecord,
  StoredEventRecord
} from "../storage/types.js";

export const AGENT_DATED_MEMORY_TURN_THRESHOLD = 8;
export const AGENT_DATED_MEMORY_CHAR_THRESHOLD = 16_000;
export const AGENT_DATED_MEMORY_DEBOUNCE_MS = 5 * 60 * 1_000;
export const AGENT_DATED_MEMORY_MAX_INPUT_CHARS = 120_000;
export const AGENT_DATED_MEMORY_MAX_OUTPUT_CHARS = 8_000;
export const AGENT_DATED_MEMORY_NO_CONTENT = "GROUPX_NO_DATED_MEMORY";

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 500;
const FAILED_RETRY_BASE_MS = 60_000;
const FAILED_RETRY_MAX_MS = 15 * 60_000;
const MAX_TIMER_MS = 2_147_000_000;

export interface AgentDatedMemorySummaryRequest {
  roomId: string;
  actorId: string;
  localDate: string;
  previousMemory?: MemoryRecord;
  sources: readonly AgentDatedMemorySourceRecord[];
  maxOutputChars: number;
  noContentSentinel: string;
  signal: AbortSignal;
}

export interface AgentDatedMemorySummaryResult {
  content: string;
  generatorActorId: string;
}

export interface AgentDatedMemorySummarizer {
  summarize(input: AgentDatedMemorySummaryRequest): Promise<AgentDatedMemorySummaryResult>;
}

export interface AgentDatedMemoryEngineOptions {
  store: GroupXStore;
  summarizer: AgentDatedMemorySummarizer;
  publish?: (event: StoredEventRecord) => void | Promise<void>;
  onError?: (error: unknown, context: {
    operation: "summarize" | "publish";
    roomId: string;
    actorId: string;
    localDate: string;
  }) => void;
  now?: () => Date;
  turnThreshold?: number;
  charThreshold?: number;
  debounceMs?: number;
  maxInputChars?: number;
  maxOutputChars?: number;
  attempts?: number;
  retryBaseMs?: number;
}

export type AgentDatedMemoryFlushResult = "completed" | "skipped" | "failed";

function keyFor(record: Pick<AgentDatedMemoryRollupRecord, "roomId" | "actorId" | "localDate">): string {
  return `${record.roomId}\u0000${record.actorId}\u0000${record.localDate}`;
}

function localDateKey(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function nextLocalMidnight(date: Date): number {
  const next = new Date(date);
  next.setHours(24, 0, 0, 0);
  return next.getTime();
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

function retryable(error: unknown): boolean {
  return new Set([
    "ADAPTER_START_FAILED",
    "PROTOCOL_HANDSHAKE_TIMEOUT",
    "SESSION_NOT_AVAILABLE",
    "TURN_FIRST_EVENT_TIMEOUT",
    "TURN_IDLE_TIMEOUT",
    "TURN_INTERRUPTED"
  ]).has(toGroupXError(error, "TURN_INTERRUPTED").code);
}

/**
 * Converts durable successful-Turn source rows into one generated per-day Agent
 * memory. Business Turns never wait for this engine: failures leave the source
 * rows pending and are retried without deleting transcript data.
 */
export class AgentDatedMemoryEngine {
  readonly #store: GroupXStore;
  readonly #summarizer: AgentDatedMemorySummarizer;
  readonly #publish: AgentDatedMemoryEngineOptions["publish"];
  readonly #onError: AgentDatedMemoryEngineOptions["onError"];
  readonly #now: NonNullable<AgentDatedMemoryEngineOptions["now"]>;
  readonly #turnThreshold: number;
  readonly #charThreshold: number;
  readonly #debounceMs: number;
  readonly #maxInputChars: number;
  readonly #maxOutputChars: number;
  readonly #attempts: number;
  readonly #retryBaseMs: number;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #flights = new Map<string, Promise<AgentDatedMemoryFlushResult>>();
  readonly #controllers = new Set<AbortController>();
  #closed = false;

  constructor(options: AgentDatedMemoryEngineOptions) {
    this.#store = options.store;
    this.#summarizer = options.summarizer;
    this.#publish = options.publish;
    this.#onError = options.onError;
    this.#now = options.now ?? (() => new Date());
    this.#turnThreshold = options.turnThreshold ?? AGENT_DATED_MEMORY_TURN_THRESHOLD;
    this.#charThreshold = options.charThreshold ?? AGENT_DATED_MEMORY_CHAR_THRESHOLD;
    this.#debounceMs = options.debounceMs ?? AGENT_DATED_MEMORY_DEBOUNCE_MS;
    this.#maxInputChars = options.maxInputChars ?? AGENT_DATED_MEMORY_MAX_INPUT_CHARS;
    this.#maxOutputChars = options.maxOutputChars ?? AGENT_DATED_MEMORY_MAX_OUTPUT_CHARS;
    this.#attempts = options.attempts ?? DEFAULT_ATTEMPTS;
    this.#retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    for (const [name, value] of [
      ["turnThreshold", this.#turnThreshold],
      ["charThreshold", this.#charThreshold],
      ["debounceMs", this.#debounceMs],
      ["maxInputChars", this.#maxInputChars],
      ["maxOutputChars", this.#maxOutputChars],
      ["attempts", this.#attempts],
      ["retryBaseMs", this.#retryBaseMs]
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive safe integer`);
      }
    }
  }

  /** Called after a completed Turn commit; it only (re)schedules background work. */
  noteCompleted(record: AgentDatedMemoryRollupRecord): void {
    if (this.#closed || record.pendingTurns === 0) return;
    this.#schedule(record);
  }

  /** Reconstructs timers from SQLite after native sessions are ready. */
  recover(roomId?: string): void {
    if (this.#closed) return;
    for (const record of this.#store.listAgentDatedMemoryRollups({
      ...(roomId === undefined ? {} : { roomId }),
      pendingOnly: true
    })) {
      this.#schedule(record);
    }
  }

  /** Best-effort flush before a room checkpoint stops carrying older raw messages. */
  async flushBeforeCompaction(input: {
    roomId: string;
    throughSeq: number;
    signal?: AbortSignal;
  }): Promise<void> {
    if (this.#closed) return;
    const records = this.#store.listAgentDatedMemoryRollups({
      roomId: input.roomId,
      pendingOnly: true
    });
    await Promise.allSettled(
      records.map(async (record) => {
        input.signal?.throwIfAborted();
        await this.flushNow(record, { force: true, throughSeq: input.throughSeq });
      })
    );
  }

  async flushNow(
    record: Pick<AgentDatedMemoryRollupRecord, "roomId" | "actorId" | "localDate">,
    input: { force?: boolean; throughSeq?: number } = {}
  ): Promise<AgentDatedMemoryFlushResult> {
    if (this.#closed) return "skipped";
    const key = keyFor(record);
    const existing = this.#flights.get(key);
    if (existing) return await existing;
    const operation = this.#flush(record, input);
    this.#flights.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.#flights.get(key) === operation) this.#flights.delete(key);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    for (const controller of this.#controllers) {
      controller.abort(new GroupXError("TURN_INTERRUPTED", "Agent memory engine is closing"));
    }
    await Promise.allSettled(this.#flights.values());
  }

  async #flush(
    key: Pick<AgentDatedMemoryRollupRecord, "roomId" | "actorId" | "localDate">,
    input: { force?: boolean; throughSeq?: number }
  ): Promise<AgentDatedMemoryFlushResult> {
    const record = this.#store.getAgentDatedMemoryRollup(key);
    if (!record || record.pendingTurns === 0) return "skipped";
    if (!input.force && !this.#isDue(record, this.#now())) {
      this.#schedule(record);
      return "skipped";
    }

    const allSources = this.#store.listAgentDatedMemorySources({
      roomId: record.roomId,
      actorId: record.actorId,
      localDate: record.localDate,
      pendingOnly: true,
      limit: 1_000
    });
    const eligible =
      input.throughSeq === undefined
        ? allSources
        : allSources.filter(
            (source) =>
              source.sourceSeq <= input.throughSeq! || source.responseSeq <= input.throughSeq!
          );
    const selected: AgentDatedMemorySourceRecord[] = [];
    let selectedChars = 0;
    for (const source of eligible) {
      if (selected.length > 0 && selectedChars + source.sourceChars > this.#maxInputChars) break;
      selected.push(source);
      selectedChars += source.sourceChars;
    }
    if (selected.length === 0) return "skipped";

    const previousMemory =
      record.memoryId === undefined ? undefined : this.#store.getMemory(record.memoryId);
    if (record.memoryId !== undefined && previousMemory?.status !== "active") {
      this.#report(
        new GroupXError("STORE_CONFLICT", "Active dated-memory checkpoint is missing"),
        record
      );
      return "failed";
    }

    const controller = new AbortController();
    this.#controllers.add(controller);
    let lastError: unknown;
    try {
      for (let attempt = 1; attempt <= this.#attempts; attempt += 1) {
        try {
          const generated = await this.#summarizer.summarize({
            roomId: record.roomId,
            actorId: record.actorId,
            localDate: record.localDate,
            ...(previousMemory === undefined ? {} : { previousMemory }),
            sources: selected,
            maxOutputChars: this.#maxOutputChars,
            noContentSentinel: AGENT_DATED_MEMORY_NO_CONTENT,
            signal: controller.signal
          });
          if (generated.generatorActorId !== record.actorId) {
            throw new GroupXError(
              "PROTOCOL_INVALID_MESSAGE",
              "An Agent dated-memory rollup must be generated by its owning Agent"
            );
          }
          const normalized = generated.content.trim();
          const content = normalized === AGENT_DATED_MEMORY_NO_CONTENT ? "" : normalized;
          if (content.length > this.#maxOutputChars) {
            throw new GroupXError(
              "PROTOCOL_INVALID_MESSAGE",
              "Agent dated-memory rollup exceeded its output budget"
            );
          }
          const committed = this.#store.commitAgentDatedMemoryRollup({
            roomId: record.roomId,
            actorId: record.actorId,
            localDate: record.localDate,
            ...(record.memoryId === undefined ? {} : { expectedMemoryId: record.memoryId }),
            selectedTurnIds: selected.map((source) => source.turnId),
            content,
            generatedAt: this.#now().toISOString()
          });
          if (committed.event !== undefined) {
            try {
              await this.#publish?.(committed.event);
            } catch (error) {
              this.#report(error, record, "publish");
            }
          }
          if (committed.rollup.pendingTurns > 0) this.#schedule(committed.rollup);
          return "completed";
        } catch (error) {
          lastError = error;
          if (controller.signal.aborted) return "skipped";
          if (attempt >= this.#attempts || !retryable(error)) break;
          await waitForRetry(this.#retryBaseMs * 2 ** (attempt - 1), controller.signal);
        }
      }
    } finally {
      this.#controllers.delete(controller);
    }

    const normalized = toGroupXError(lastError, "TURN_INTERRUPTED");
    if (normalized.code === "STORE_CONFLICT") {
      // A user edit/retraction or another process may advance the same daily
      // checkpoint while the owner Agent is summarizing. Re-read the durable
      // head instead of recording a failure against a stale memory id.
      const refreshed = this.#store.getAgentDatedMemoryRollup(record);
      if (refreshed !== undefined && refreshed.pendingTurns > 0) {
        this.#schedule(refreshed);
      }
      this.#report(normalized, record);
      return "failed";
    }
    try {
      const delay = Math.min(
        FAILED_RETRY_MAX_MS,
        FAILED_RETRY_BASE_MS * 2 ** Math.min(record.failureCount, 4)
      );
      const nextAttemptAt = new Date(this.#now().getTime() + delay).toISOString();
      const failed = this.#store.recordAgentDatedMemoryRollupFailure({
        roomId: record.roomId,
        actorId: record.actorId,
        localDate: record.localDate,
        ...(record.memoryId === undefined ? {} : { expectedMemoryId: record.memoryId }),
        errorCode: normalized.code,
        attemptedAt: this.#now().toISOString(),
        nextAttemptAt
      });
      this.#schedule(failed);
    } catch (checkpointError) {
      this.#report(checkpointError, record);
    }
    this.#report(normalized, record);
    return "failed";
  }

  #isDue(record: AgentDatedMemoryRollupRecord, now: Date): boolean {
    if (record.nextAttemptAt !== undefined) {
      return new Date(record.nextAttemptAt).getTime() <= now.getTime();
    }
    if (record.localDate < localDateKey(now)) return true;
    if (
      record.pendingTurns < this.#turnThreshold &&
      record.pendingChars < this.#charThreshold
    ) {
      return false;
    }
    const lastPending = new Date(record.lastPendingAt ?? record.updatedAt).getTime();
    return lastPending + this.#debounceMs <= now.getTime();
  }

  #dueAt(record: AgentDatedMemoryRollupRecord, now: Date): number {
    if (record.nextAttemptAt !== undefined) {
      return new Date(record.nextAttemptAt).getTime();
    }
    if (record.localDate < localDateKey(now)) return now.getTime();
    if (
      record.pendingTurns >= this.#turnThreshold ||
      record.pendingChars >= this.#charThreshold
    ) {
      return new Date(record.lastPendingAt ?? record.updatedAt).getTime() + this.#debounceMs;
    }
    return nextLocalMidnight(now);
  }

  #schedule(record: AgentDatedMemoryRollupRecord): void {
    if (this.#closed || record.pendingTurns === 0) return;
    const key = keyFor(record);
    const previous = this.#timers.get(key);
    if (previous !== undefined) clearTimeout(previous);
    const now = this.#now();
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, this.#dueAt(record, now) - now.getTime()));
    const timer = setTimeout(() => {
      if (this.#timers.get(key) === timer) this.#timers.delete(key);
      void this.flushNow(record).catch((error) => this.#report(error, record));
    }, delay);
    timer.unref?.();
    this.#timers.set(key, timer);
  }

  #report(
    error: unknown,
    record: Pick<AgentDatedMemoryRollupRecord, "roomId" | "actorId" | "localDate">,
    operation: "summarize" | "publish" = "summarize"
  ): void {
    try {
      this.#onError?.(error, { operation, ...record });
    } catch {
      // Background diagnostics never decide chat or memory durability.
    }
  }
}
