import { GroupXError } from "../core/errors.js";
import type { AdapterHealth, AdapterId, CliAdapter } from "./types.js";

export class AdapterRegistry {
  readonly #byAdapterId = new Map<AdapterId, CliAdapter>();
  readonly #byActorId = new Map<string, CliAdapter>();

  register(adapter: CliAdapter): void {
    if (this.#byAdapterId.has(adapter.adapterId)) {
      throw new GroupXError("STORE_CONFLICT", `Adapter is already registered: ${adapter.adapterId}`);
    }
    if (this.#byActorId.has(adapter.actorId)) {
      throw new GroupXError("STORE_CONFLICT", `Actor already has an adapter: ${adapter.actorId}`);
    }
    this.#byAdapterId.set(adapter.adapterId, adapter);
    this.#byActorId.set(adapter.actorId, adapter);
  }

  get(adapterId: AdapterId): CliAdapter {
    const adapter = this.#byAdapterId.get(adapterId);
    if (!adapter) {
      throw new GroupXError("ADAPTER_NOT_FOUND", `Unknown adapter: ${adapterId}`);
    }
    return adapter;
  }

  getByActor(actorId: string): CliAdapter {
    const adapter = this.#byActorId.get(actorId);
    if (!adapter) {
      throw new GroupXError("UNKNOWN_TARGET", `No adapter is bound to actor: ${actorId}`);
    }
    return adapter;
  }

  hasActor(actorId: string): boolean {
    return this.#byActorId.has(actorId);
  }

  list(): CliAdapter[] {
    return [...this.#byAdapterId.values()];
  }

  health(): AdapterHealth[] {
    return this.list().map((adapter) => adapter.health());
  }
}
