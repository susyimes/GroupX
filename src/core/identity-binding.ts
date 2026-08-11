import { createId } from "./envelope.js";
import { GroupXError } from "./errors.js";

export interface IdentityBinding {
  bindingId: string;
  actorId: string;
  adapterId: string;
  instanceId: string;
  nativeSessionId?: string;
  status: "active" | "closed";
  createdAt: string;
  closedAt?: string;
}

export class IdentityBindingRegistry {
  readonly #bindings = new Map<string, IdentityBinding>();

  create(input: {
    actorId: string;
    adapterId: string;
    instanceId: string;
    nativeSessionId?: string;
    bindingId?: string;
  }): IdentityBinding {
    const bindingId = input.bindingId ?? createId("binding");
    if (this.#bindings.has(bindingId)) {
      throw new GroupXError("STORE_CONFLICT", `Binding already exists: ${bindingId}`);
    }
    const binding: IdentityBinding = {
      bindingId,
      actorId: input.actorId,
      adapterId: input.adapterId,
      instanceId: input.instanceId,
      ...(input.nativeSessionId ? { nativeSessionId: input.nativeSessionId } : {}),
      status: "active",
      createdAt: new Date().toISOString()
    };
    this.#bindings.set(bindingId, binding);
    return { ...binding };
  }

  require(bindingId: string): IdentityBinding {
    const binding = this.#bindings.get(bindingId);
    if (!binding || binding.status !== "active") {
      throw new GroupXError("MCP_BINDING_MISMATCH", "Unknown or inactive GroupX binding");
    }
    return { ...binding };
  }

  resolveActor(bindingId: string): string {
    return this.require(bindingId).actorId;
  }

  assertActor(bindingId: string, actorId: string): void {
    const binding = this.require(bindingId);
    if (binding.actorId !== actorId) {
      throw new GroupXError("MCP_BINDING_MISMATCH", "Binding does not belong to the requested actor");
    }
  }

  close(bindingId: string): IdentityBinding {
    const binding = this.require(bindingId);
    const closed: IdentityBinding = {
      ...binding,
      status: "closed",
      closedAt: new Date().toISOString()
    };
    this.#bindings.set(bindingId, closed);
    return { ...closed };
  }

  list(actorId?: string): IdentityBinding[] {
    return [...this.#bindings.values()]
      .filter((binding) => !actorId || binding.actorId === actorId)
      .map((binding) => ({ ...binding }));
  }
}
