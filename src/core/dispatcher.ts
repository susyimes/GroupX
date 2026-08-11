import { GroupXError } from "./errors.js";

export type LaneTaskState = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface LaneTask<T = unknown> {
  turnId: string;
  run(signal: AbortSignal): Promise<T>;
}

export interface LaneTaskResult<T = unknown> {
  turnId: string;
  state: Exclude<LaneTaskState, "queued" | "running">;
  value?: T;
  error?: unknown;
}

interface QueuedTask<T> {
  task: LaneTask<T>;
  resolve: (result: LaneTaskResult<T>) => void;
}

export class AgentLane {
  readonly actorId: string;
  readonly #maxQueued: number;
  readonly #onState: ((turnId: string, state: LaneTaskState) => void) | undefined;
  readonly #queue: Array<QueuedTask<unknown>> = [];
  #active: { turnId: string; controller: AbortController } | undefined;
  #closed = false;

  constructor(input: {
    actorId: string;
    maxQueued: number;
    onState?: (turnId: string, state: LaneTaskState) => void;
  }) {
    this.actorId = input.actorId;
    this.#maxQueued = input.maxQueued;
    this.#onState = input.onState;
  }

  get queued(): number {
    return this.#queue.length;
  }

  get activeTurnId(): string | undefined {
    return this.#active?.turnId;
  }

  enqueue<T>(task: LaneTask<T>): Promise<LaneTaskResult<T>> {
    if (this.#closed) {
      throw new GroupXError("SESSION_NOT_AVAILABLE", `Agent lane is closed: ${this.actorId}`);
    }
    if (this.#queue.some((item) => item.task.turnId === task.turnId) || this.#active?.turnId === task.turnId) {
      throw new GroupXError("DUPLICATE_DISPATCH", `Turn is already in lane: ${task.turnId}`);
    }
    if (this.#queue.length >= this.#maxQueued) {
      throw new GroupXError("QUEUE_CAPACITY_REACHED", `Agent queue is full: ${this.actorId}`);
    }
    const promise = new Promise<LaneTaskResult<T>>((resolve) => {
      this.#queue.push({ task, resolve: resolve as (result: LaneTaskResult<unknown>) => void });
    });
    this.#onState?.(task.turnId, "queued");
    void this.#drain();
    return promise;
  }

  cancel(turnId: string): boolean {
    const queuedIndex = this.#queue.findIndex((item) => item.task.turnId === turnId);
    if (queuedIndex >= 0) {
      const [queued] = this.#queue.splice(queuedIndex, 1);
      if (queued) {
        this.#onState?.(turnId, "cancelled");
        queued.resolve({ turnId, state: "cancelled" });
      }
      return true;
    }
    if (this.#active?.turnId === turnId) {
      this.#active.controller.abort(new GroupXError("TURN_INTERRUPTED", "Turn cancellation requested"));
      return true;
    }
    return false;
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#active?.controller.abort(new GroupXError("TURN_INTERRUPTED", "Agent lane closed"));
    for (const queued of this.#queue.splice(0)) {
      this.#onState?.(queued.task.turnId, "cancelled");
      queued.resolve({ turnId: queued.task.turnId, state: "cancelled" });
    }
  }

  async #drain(): Promise<void> {
    if (this.#active || this.#closed) {
      return;
    }
    const queued = this.#queue.shift();
    if (!queued) {
      return;
    }
    const controller = new AbortController();
    this.#active = { turnId: queued.task.turnId, controller };
    this.#onState?.(queued.task.turnId, "running");
    try {
      const value = await queued.task.run(controller.signal);
      this.#onState?.(queued.task.turnId, "completed");
      queued.resolve({ turnId: queued.task.turnId, state: "completed", value });
    } catch (error) {
      const state = controller.signal.aborted ? "cancelled" : "failed";
      this.#onState?.(queued.task.turnId, state);
      queued.resolve({ turnId: queued.task.turnId, state, error });
    } finally {
      this.#active = undefined;
      queueMicrotask(() => void this.#drain());
    }
  }
}

export class Dispatcher {
  readonly #lanes = new Map<string, AgentLane>();
  readonly #maxQueued: number;
  readonly #onState: ((actorId: string, turnId: string, state: LaneTaskState) => void) | undefined;

  constructor(input: {
    maxQueuedPerAgent: number;
    onState?: (actorId: string, turnId: string, state: LaneTaskState) => void;
  }) {
    this.#maxQueued = input.maxQueuedPerAgent;
    this.#onState = input.onState;
  }

  enqueue<T>(actorId: string, task: LaneTask<T>): Promise<LaneTaskResult<T>> {
    return this.#lane(actorId).enqueue(task);
  }

  cancel(actorId: string, turnId: string): boolean {
    return this.#lanes.get(actorId)?.cancel(turnId) ?? false;
  }

  stats(): Array<{ actorId: string; queued: number; activeTurnId?: string }> {
    return [...this.#lanes.values()].map((lane) => ({
      actorId: lane.actorId,
      queued: lane.queued,
      ...(lane.activeTurnId ? { activeTurnId: lane.activeTurnId } : {})
    }));
  }

  close(): void {
    for (const lane of this.#lanes.values()) {
      lane.close();
    }
  }

  #lane(actorId: string): AgentLane {
    let lane = this.#lanes.get(actorId);
    if (!lane) {
      lane = new AgentLane({
        actorId,
        maxQueued: this.#maxQueued,
        ...(this.#onState
          ? { onState: (turnId, state) => this.#onState?.(actorId, turnId, state) }
          : {})
      });
      this.#lanes.set(actorId, lane);
    }
    return lane;
  }
}
