import type {
  ActiveBrokerTurnContext,
  BrokerTurnLifecycle
} from "../broker/types.js";
import { GroupXError } from "../core/errors.js";
import { McpBindingRegistry } from "../mcp/binding-registry.js";
import type { ToolCallerContext } from "../mcp/server/broker-api.js";
import type { TransportMode } from "../config.js";
import { AgentSessionManager } from "./session-manager.js";

/**
 * Correlates one binding with the Broker Turn currently driving its model.
 * This is provenance/causality state only; it grants no permission.
 */
export class ActiveTurnCoordinator implements BrokerTurnLifecycle {
  readonly #transport: TransportMode;
  readonly #bindings: Pick<
    McpBindingRegistry,
    "setActiveTurn" | "clearActiveTurn"
  >;
  readonly #sessions: Pick<AgentSessionManager, "syncNativeSession">;
  readonly #active = new Map<string, ActiveBrokerTurnContext>();

  constructor(input: {
    transport: TransportMode;
    bindings: Pick<McpBindingRegistry, "setActiveTurn" | "clearActiveTurn">;
    sessions: Pick<AgentSessionManager, "syncNativeSession">;
  }) {
    this.#transport = input.transport;
    this.#bindings = input.bindings;
    this.#sessions = input.sessions;
  }

  activate(context: ActiveBrokerTurnContext): void {
    const existing = this.#active.get(context.bindingId);
    if (existing !== undefined && existing.turnId !== context.turnId) {
      throw new GroupXError("STORE_CONFLICT", "Binding already has another active GroupX Turn");
    }
    this.#active.set(context.bindingId, { ...context });
    if (this.#transport === "structured") {
      this.#bindings.setActiveTurn(context.bindingId, context.turnId);
    }
  }

  deactivate(context: ActiveBrokerTurnContext): void {
    const existing = this.#active.get(context.bindingId);
    if (!existing || existing.turnId !== context.turnId) {
      throw new GroupXError(
        "MCP_BINDING_MISMATCH",
        "Turn lifecycle deactivation does not match the active binding"
      );
    }

    let failure: unknown;
    try {
      // Direct adapters can learn a resumable native session id only after a
      // successful prompt. Persist the Adapter-owned session snapshot before
      // releasing causal state.
      this.#sessions.syncNativeSession(context.bindingId);
    } catch (error) {
      failure = error;
    }
    try {
      if (this.#transport === "structured") {
        this.#bindings.clearActiveTurn(context.bindingId, context.turnId);
      }
    } catch (error) {
      failure ??= error;
    } finally {
      this.#active.delete(context.bindingId);
    }
    if (failure !== undefined) throw failure;
  }

  requireForCaller(caller: ToolCallerContext): ActiveBrokerTurnContext {
    if (this.#transport !== "structured") {
      throw new GroupXError(
        "MCP_UNAVAILABLE",
        "Current-turn GroupX tools exist only in structured transport"
      );
    }
    const context = this.#active.get(caller.bindingId);
    if (!context || caller.activeGroupxTurnId !== context.turnId) {
      throw new GroupXError(
        "MCP_BINDING_MISMATCH",
        "MCP call is not associated with the binding's active GroupX Turn"
      );
    }
    return { ...context };
  }

  get(bindingId: string): ActiveBrokerTurnContext | undefined {
    const context = this.#active.get(bindingId);
    return context === undefined ? undefined : { ...context };
  }
}
