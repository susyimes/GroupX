import type { RestartAgentAccepted } from "../contracts/rest.js";
import { parseRestartAgentAccepted } from "../contracts/rest.js";
import { GroupXError } from "../core/errors.js";
import type { GroupXStore } from "../storage/types.js";
import type { AgentSessionManager } from "./session-manager.js";

export interface RestartAgentCommandInput {
  actorId: string;
  bindingId: string;
  clientCommandId: string;
}

export interface RestartAgentCommandCoordinatorOptions {
  store: Pick<GroupXStore, "beginClientCommand" | "completeClientCommand">;
  sessions: Pick<AgentSessionManager, "restart">;
  onSessionReady?: (actorId: string) => void;
}

/**
 * Restart receipts are at-most-once, not exactly-once. A persisted pending
 * receipt with no in-process flight is deliberately reported as uncertain;
 * GroupX never repeats an external process restart after a crash window.
 */
export class RestartAgentCommandCoordinator {
  readonly #store: RestartAgentCommandCoordinatorOptions["store"];
  readonly #sessions: RestartAgentCommandCoordinatorOptions["sessions"];
  readonly #onSessionReady: ((actorId: string) => void) | undefined;
  readonly #flights = new Map<string, Promise<RestartAgentAccepted>>();

  constructor(options: RestartAgentCommandCoordinatorOptions) {
    this.#store = options.store;
    this.#sessions = options.sessions;
    this.#onSessionReady = options.onSessionReady;
  }

  async restart(input: RestartAgentCommandInput): Promise<RestartAgentAccepted> {
    const receipt = this.#store.beginClientCommand<RestartAgentAccepted>({
      sourceBindingId: input.bindingId,
      clientCommandId: input.clientCommandId,
      commandType: "agent.restart",
      canonicalPayload: { actorId: input.actorId }
    });
    if (receipt.disposition === "replayed") {
      return parseRestartAgentAccepted(receipt.result);
    }

    const key = JSON.stringify([input.bindingId, input.clientCommandId]);
    const existing = this.#flights.get(key);
    if (existing) return await existing;
    if (receipt.disposition === "pending") {
      throw new GroupXError(
        "STORE_CONFLICT",
        "Agent restart outcome is uncertain; GroupX will not repeat the restart"
      );
    }

    const flight = this.#execute(input);
    this.#flights.set(key, flight);
    try {
      return await flight;
    } finally {
      if (this.#flights.get(key) === flight) this.#flights.delete(key);
    }
  }

  async #execute(input: RestartAgentCommandInput): Promise<RestartAgentAccepted> {
    const restarted = await this.#sessions.restart(input.actorId);
    const result = parseRestartAgentAccepted({
      actorId: input.actorId,
      accepted: true,
      ...(restarted.previousInstanceId === undefined
        ? {}
        : { previousInstanceId: restarted.previousInstanceId })
    });
    const completed = this.#store.completeClientCommand({
      sourceBindingId: input.bindingId,
      clientCommandId: input.clientCommandId,
      result
    });
    // Persist the irreversible process outcome before the scheduling nudge.
    // A failed nudge can then be safely replayed without another restart.
    this.#onSessionReady?.(input.actorId);
    return completed;
  }
}
