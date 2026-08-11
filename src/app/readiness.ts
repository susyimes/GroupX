import { GroupXError } from "../core/errors.js";

export type RuntimeReadinessState = "starting" | "ready" | "closing" | "failed";

/** Small startup gate used while HTTP is listening before structured sessions start. */
export class RuntimeReadiness {
  #state: RuntimeReadinessState = "starting";
  #failure: unknown;

  get state(): RuntimeReadinessState {
    return this.#state;
  }

  get isReady(): boolean {
    return this.#state === "ready";
  }

  markReady(): void {
    if (this.#state !== "starting") {
      throw new GroupXError("STORE_CONFLICT", `Cannot become ready while runtime is ${this.#state}`);
    }
    this.#state = "ready";
  }

  markClosing(): void {
    if (this.#state === "failed") return;
    this.#state = "closing";
  }

  markFailed(error: unknown): void {
    this.#failure = error;
    this.#state = "failed";
  }

  requireReady(): void {
    if (this.#state === "ready") return;
    throw new GroupXError(
      "SESSION_NOT_AVAILABLE",
      `GroupX runtime is ${this.#state}`,
      this.#failure === undefined ? undefined : { startupFailed: true }
    );
  }
}
