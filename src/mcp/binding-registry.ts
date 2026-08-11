import { GroupXError } from "../core/errors.js";

export type McpBindingStatus = "reserved" | "ready" | "closed";

export interface McpBindingContext {
  bindingId: string;
  actorId: string;
  instanceId: string;
  nativeSessionId?: string;
  activeGroupxTurnId?: string;
  status: McpBindingStatus;
  createdAt: string;
  closedAt?: string;
}

/**
 * Associates one Adapter/session channel with its GroupX actor.
 *
 * A bindingId is a correlation handle, not a credential or security token.
 * The registry prevents message/tool payload fields from changing attribution
 * during the normal Broker flow; it does not defend against hostile local
 * processes that can call the loopback endpoint or modify Broker state.
 */
export class McpBindingRegistry {
  readonly #bindings = new Map<string, McpBindingContext>();

  register(input: {
    bindingId: string;
    actorId: string;
    instanceId: string;
    nativeSessionId?: string;
  }): McpBindingContext {
    if (this.#bindings.has(input.bindingId)) {
      throw new GroupXError("STORE_CONFLICT", `MCP binding already exists: ${input.bindingId}`);
    }

    const context: McpBindingContext = {
      bindingId: input.bindingId,
      actorId: input.actorId,
      instanceId: input.instanceId,
      ...(input.nativeSessionId ? { nativeSessionId: input.nativeSessionId } : {}),
      status: input.nativeSessionId ? "ready" : "reserved",
      createdAt: new Date().toISOString()
    };
    this.#bindings.set(input.bindingId, context);
    return { ...context };
  }

  require(bindingId: string): McpBindingContext {
    const context = this.#requireOpen(bindingId);
    return { ...context };
  }

  markReady(bindingId: string, nativeSessionId?: string): McpBindingContext {
    const context = this.#requireOpen(bindingId);
    const next: McpBindingContext = {
      ...context,
      ...(nativeSessionId ? { nativeSessionId } : {}),
      status: "ready"
    };
    this.#bindings.set(bindingId, next);
    return { ...next };
  }

  setActiveTurn(bindingId: string, turnId: string): McpBindingContext {
    const context = this.#requireOpen(bindingId);
    if (context.activeGroupxTurnId && context.activeGroupxTurnId !== turnId) {
      throw new GroupXError("STORE_CONFLICT", "MCP binding already has a different active GroupX turn");
    }
    const next = { ...context, activeGroupxTurnId: turnId };
    this.#bindings.set(bindingId, next);
    return { ...next };
  }

  clearActiveTurn(bindingId: string, turnId: string): McpBindingContext {
    const context = this.#requireOpen(bindingId);
    if (context.activeGroupxTurnId !== turnId) {
      throw new GroupXError("MCP_BINDING_MISMATCH", "Active GroupX turn does not match binding context");
    }
    const { activeGroupxTurnId: _removed, ...next } = context;
    this.#bindings.set(bindingId, next);
    return { ...next };
  }

  close(bindingId: string): McpBindingContext {
    const context = this.#requireOpen(bindingId);
    const closed: McpBindingContext = {
      ...context,
      status: "closed",
      closedAt: new Date().toISOString()
    };
    this.#bindings.set(bindingId, closed);
    return { ...closed };
  }

  #requireOpen(bindingId: string): McpBindingContext {
    const context = this.#bindings.get(bindingId);
    if (!context || context.status === "closed") {
      throw new GroupXError("MCP_BINDING_MISMATCH", "Unknown or closed MCP binding");
    }
    return context;
  }
}
