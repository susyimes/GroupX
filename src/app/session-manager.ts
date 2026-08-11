import type { AdapterId, CliAdapter, LaunchProfile, NativeSession } from "../adapters/types.js";
import { AdapterRegistry } from "../adapters/registry.js";
import { TRANSPORT_LIFECYCLE, type GroupXConfig, type TransportMode } from "../config.js";
import { createId } from "../core/envelope.js";
import { GroupXError, toGroupXError } from "../core/errors.js";
import { McpBindingRegistry } from "../mcp/binding-registry.js";
import type { GroupXStore, RuntimeRecoveryResult } from "../storage/types.js";

export type ManagedAgentId = "codex" | "grok" | "kimi";

export type SessionManagerState = "idle" | "starting" | "ready" | "closing" | "closed";

export interface SessionResumePlan {
  stale: RuntimeRecoveryResult;
  nativeSessionIds: Partial<Record<ManagedAgentId, string>>;
}

export interface ManagedSessionSnapshot {
  agentId: ManagedAgentId;
  actorId: string;
  adapterId: AdapterId;
  instanceId: string;
  bindingId: string;
  nativeSessionId?: string;
  protocol: string;
  transport: TransportMode;
}

export interface RestartSessionResult {
  actorId: string;
  previousInstanceId?: string;
  session: NativeSession;
}

export interface SessionManagerOptions {
  config: Pick<GroupXConfig, "transport" | "agents" | "timeouts">;
  store: GroupXStore;
  adapters: AdapterRegistry;
  mcpBindings?: McpBindingRegistry;
  idFactory?: (kind: "instance" | "binding", agentId: ManagedAgentId) => string;
  protocolFor?: (agentId: ManagedAgentId, transport: TransportMode) => string;
  closeTimeoutMs?: number;
}

interface ManagedSession {
  agentId: ManagedAgentId;
  adapter: CliAdapter;
  session: NativeSession;
  mcpRegistered: boolean;
}

const AGENT_IDS = ["codex", "grok", "kimi"] as const satisfies readonly ManagedAgentId[];

function defaultProtocol(agentId: ManagedAgentId, transport: TransportMode): string {
  if (transport === "direct") return "direct-jsonl";
  return agentId === "codex" ? "codex-app-server-stdio-jsonrpc-v2" : "acp";
}

function defaultIdFactory(kind: "instance" | "binding", agentId: ManagedAgentId): string {
  return createId(`${kind}_${agentId}`);
}

function isManagedAgentId(value: AdapterId): value is ManagedAgentId {
  return value === "codex" || value === "grok" || value === "kimi";
}

/** Owns one selected-transport runtime session for each enabled built-in Agent. */
export class AgentSessionManager {
  readonly #config: SessionManagerOptions["config"];
  readonly #store: GroupXStore;
  readonly #adapters: AdapterRegistry;
  readonly #mcpBindings: McpBindingRegistry | undefined;
  readonly #idFactory: NonNullable<SessionManagerOptions["idFactory"]>;
  readonly #protocolFor: NonNullable<SessionManagerOptions["protocolFor"]>;
  readonly #closeTimeoutMs: number;
  readonly #sessions = new Map<string, ManagedSession>();
  readonly #sessionsByBinding = new Map<string, ManagedSession>();
  #mcpUrl: string | undefined;
  #state: SessionManagerState = "idle";
  #closePromise: Promise<void> | undefined;

  constructor(options: SessionManagerOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#adapters = options.adapters;
    this.#mcpBindings = options.mcpBindings;
    this.#idFactory = options.idFactory ?? defaultIdFactory;
    this.#protocolFor = options.protocolFor ?? defaultProtocol;
    this.#closeTimeoutMs = options.closeTimeoutMs ?? options.config.timeouts.closeMs;
    if (!Number.isSafeInteger(this.#closeTimeoutMs) || this.#closeTimeoutMs < 1) {
      throw new RangeError("closeTimeoutMs must be a positive integer");
    }
  }

  get state(): SessionManagerState {
    return this.#state;
  }

  get transport(): TransportMode {
    return this.#config.transport;
  }

  setStructuredMcpUrl(url: string): void {
    if (this.#config.transport !== "structured") {
      throw new GroupXError(
        "TRANSPORT_MODE_MISMATCH",
        "Direct transport does not attach the current-turn GroupX MCP server"
      );
    }
    if (this.#state !== "idle") {
      throw new GroupXError("STORE_CONFLICT", "MCP URL must be set before Agent sessions start");
    }
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new TypeError("Structured MCP URL must use HTTP or HTTPS");
    }
    this.#mcpUrl = parsed.toString();
  }

  /**
   * Close stale process records and derive a bounded same-transport/same-cwd
   * native resume plan. The cwd capability is a continuity snapshot, not a
   * credential or security check.
   */
  prepareRecovery(): SessionResumePlan {
    if (this.#state !== "idle") {
      throw new GroupXError("STORE_CONFLICT", "Runtime recovery must run before sessions start");
    }
    const stale = this.#store.recoverStaleRuntimeRecords();
    const nativeSessionIds: Partial<Record<ManagedAgentId, string>> = {};
    const bindings = this.#store.listSessionBindings();
    for (let index = bindings.length - 1; index >= 0; index -= 1) {
      const binding = bindings[index];
      const adapter = binding
        ? this.#adapters.list().find((candidate) => candidate.actorId === binding.actorId)
        : undefined;
      if (
        !binding?.nativeSessionId ||
        binding.transport !== this.#config.transport ||
        !adapter ||
        !isManagedAgentId(adapter.adapterId) ||
        nativeSessionIds[adapter.adapterId] !== undefined ||
        binding.capabilities.cwd !== this.#config.agents[adapter.adapterId].cwd
      ) {
        continue;
      }
      nativeSessionIds[adapter.adapterId] = binding.nativeSessionId;
    }
    return { stale, nativeSessionIds };
  }

  async startAll(
    input: { nativeSessionIds?: Partial<Record<ManagedAgentId, string>> } = {}
  ): Promise<NativeSession[]> {
    if (this.#state !== "idle") {
      throw new GroupXError("STORE_CONFLICT", `Cannot start sessions while manager is ${this.#state}`);
    }
    this.#assertStructuredMcpReady();
    this.#state = "starting";
    const started: ManagedSession[] = [];
    try {
      for (const agentId of AGENT_IDS) {
        if (!this.#config.agents[agentId].enabled) continue;
        const managed = await this.#startAgent(agentId, input.nativeSessionIds?.[agentId]);
        started.push(managed);
      }
      this.#state = "ready";
      return started.map((managed) => managed.session);
    } catch (error) {
      await Promise.allSettled(started.reverse().map(async (managed) => this.#stopManaged(managed)));
      this.#state = "idle";
      throw error;
    }
  }

  resolve(input: { actorId: string; adapterId: AdapterId }): NativeSession {
    if (this.#state !== "ready") {
      throw new GroupXError("SESSION_NOT_AVAILABLE", "Agent sessions are not ready");
    }
    const managed = this.#sessions.get(input.actorId);
    if (!managed || managed.adapter.adapterId !== input.adapterId) {
      throw new GroupXError("SESSION_NOT_AVAILABLE", `No ready session for ${input.actorId}`);
    }
    return managed.session;
  }

  get(actorId: string): NativeSession | undefined {
    return this.#sessions.get(actorId)?.session;
  }

  list(): ManagedSessionSnapshot[] {
    return [...this.#sessions.values()].map(({ agentId, adapter, session }) => ({
      agentId,
      actorId: session.actorId,
      adapterId: adapter.adapterId,
      instanceId: session.instanceId,
      bindingId: session.bindingId,
      ...(session.nativeSessionId === undefined
        ? {}
        : { nativeSessionId: session.nativeSessionId }),
      protocol: session.protocol,
      transport: this.#config.transport
    }));
  }

  /** Persist a native session id learned during a Direct (or late structured) turn. */
  syncNativeSession(bindingId: string): void {
    const managed = this.#sessionsByBinding.get(bindingId);
    if (!managed) {
      throw new GroupXError(
        "SESSION_NOT_AVAILABLE",
        `No ready session for GroupX binding ${bindingId}`
      );
    }
    const nativeSessionId = managed.session.nativeSessionId;
    if (nativeSessionId === undefined) return;
    const stored = this.#store.getSessionBinding(bindingId);
    if (!stored || stored.status !== "ready" || stored.closedAt !== undefined) {
      throw new GroupXError("STORE_CONFLICT", "Cannot synchronize a non-ready session binding");
    }
    if (stored.nativeSessionId === nativeSessionId) return;
    this.#store.markSessionBindingReady(bindingId, {
      nativeSessionId,
      capabilities: stored.capabilities
    });
    if (managed.mcpRegistered) {
      this.#mcpBindings!.markReady(bindingId, nativeSessionId);
    }
  }

  async restart(actorId: string): Promise<RestartSessionResult> {
    if (this.#state !== "ready") {
      throw new GroupXError("SESSION_NOT_AVAILABLE", "Agent sessions are not ready");
    }
    const previous = this.#sessions.get(actorId);
    if (!previous) {
      throw new GroupXError("UNKNOWN_TARGET", `No managed Agent session: ${actorId}`);
    }
    const previousInstanceId = previous.session.instanceId;
    const resumeNativeSessionId = previous.session.nativeSessionId;
    await this.#stopManaged(previous);
    const managed = await this.#startAgent(previous.agentId, resumeNativeSessionId);
    return { actorId, previousInstanceId, session: managed.session };
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (this.#state === "closed") return Promise.resolve();
    this.#state = "closing";
    this.#closePromise = (async () => {
      const managed = [...this.#sessions.values()].reverse();
      const results = await Promise.allSettled(
        managed.map(async (session) => this.#stopManaged(session))
      );
      this.#state = "closed";
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (failures.length > 0) {
        throw new AggregateError(failures, "One or more Agent sessions failed to close cleanly");
      }
    })();
    return this.#closePromise;
  }

  async #startAgent(
    agentId: ManagedAgentId,
    resumeNativeSessionId: string | undefined
  ): Promise<ManagedSession> {
    const adapter = this.#adapters.get(agentId);
    const configured = this.#config.agents[agentId];
    const instanceId = this.#idFactory("instance", agentId);
    const bindingId = this.#idFactory("binding", agentId);
    const protocol = this.#protocolFor(agentId, this.#config.transport);
    let session: NativeSession | undefined;
    let bindingCreated = false;
    let mcpRegistered = false;
    const effectiveResumeNativeSessionId = resumeNativeSessionId;
    let assertedResumeNativeSessionId = effectiveResumeNativeSessionId;
    let continuity:
      | "new_session"
      | "resumed"
      | "new_session_after_resume_failure" =
      effectiveResumeNativeSessionId === undefined ? "new_session" : "resumed";

    try {
      this.#store.createAgentInstance({
        instanceId,
        actorId: adapter.actorId,
        adapterId: adapter.adapterId,
        transport: this.#config.transport,
        status: "starting"
      });
      this.#store.createSessionBinding({
        bindingId,
        instanceId,
        actorId: adapter.actorId,
        protocol,
        transport: this.#config.transport,
        status: "starting",
        capabilities: {
          transport: this.#config.transport,
          transportLifecycle: TRANSPORT_LIFECYCLE[this.#config.transport],
          access: "unrestricted",
          currentTurnMcp: this.#config.transport === "structured",
          cwd: configured.cwd
        }
      });
      bindingCreated = true;

      if (this.#config.transport === "structured") {
        this.#mcpBindings!.register({ bindingId, actorId: adapter.actorId, instanceId });
        mcpRegistered = true;
      }

      const profile = this.#launchProfile(agentId, instanceId, bindingId);
      if (effectiveResumeNativeSessionId !== undefined) {
        try {
          session = await adapter.resume({
            ...profile,
            nativeSessionId: effectiveResumeNativeSessionId
          });
        } catch (error) {
          if (!canStartFreshAfterResumeFailure(error)) throw error;
          // A native session hint can become stale independently of the
          // durable GroupX transcript (for example, an empty Codex thread is
          // not persisted by the CLI). Starting a fresh session stays within
          // the selected transport and never replays an already-dispatched
          // Turn, so it is the safe recovery path for future work.
          continuity = "new_session_after_resume_failure";
          assertedResumeNativeSessionId = undefined;
          session = await adapter.start(profile);
        }
      } else {
        session = await adapter.start(profile);
      }
      this.#assertSession(
        adapter,
        session,
        instanceId,
        bindingId,
        assertedResumeNativeSessionId
      );

      this.#store.markSessionBindingReady(bindingId, {
        ...(session.nativeSessionId === undefined
          ? {}
          : { nativeSessionId: session.nativeSessionId }),
        capabilities: {
          transport: this.#config.transport,
          transportLifecycle: TRANSPORT_LIFECYCLE[this.#config.transport],
          access: "unrestricted",
          currentTurnMcp: this.#config.transport === "structured",
          cwd: configured.cwd,
          continuity
        }
      });
      if (mcpRegistered) {
        this.#mcpBindings!.markReady(bindingId, session.nativeSessionId);
      }
      const managed: ManagedSession = { agentId, adapter, session, mcpRegistered };
      this.#sessions.set(adapter.actorId, managed);
      this.#sessionsByBinding.set(session.bindingId, managed);
      return managed;
    } catch (error) {
      if (session !== undefined) {
        await this.#closeAdapterBounded(adapter, session).catch(() => undefined);
      }
      if (mcpRegistered) {
        try {
          this.#mcpBindings!.close(bindingId);
        } catch {
          // The persistent lifecycle records below remain authoritative.
        }
      }
      if (bindingCreated) {
        try {
          this.#store.markSessionBindingFailed(bindingId);
        } catch {
          // Preserve the original Adapter failure.
        }
      }
      try {
        this.#store.finishAgentInstance(instanceId, { status: "failed" });
      } catch {
        // Preserve the original Adapter failure.
      }
      throw toGroupXError(error, "ADAPTER_START_FAILED");
    }
  }

  #launchProfile(
    agentId: ManagedAgentId,
    instanceId: string,
    bindingId: string
  ): LaunchProfile {
    const configured = this.#config.agents[agentId];
    return {
      command: configured.command.executable,
      prefixArgs: configured.command.prefixArgs,
      cwd: configured.cwd,
      instanceId,
      bindingId,
      ...(this.#config.transport === "structured"
        ? {
            brokerUrl: this.#mcpUrl!,
            mcp: { transport: "streamable-http" as const, url: this.#mcpUrl! }
          }
        : {})
    };
  }

  async #stopManaged(managed: ManagedSession): Promise<void> {
    if (this.#sessions.get(managed.adapter.actorId) === managed) {
      this.#sessions.delete(managed.adapter.actorId);
    }
    if (this.#sessionsByBinding.get(managed.session.bindingId) === managed) {
      this.#sessionsByBinding.delete(managed.session.bindingId);
    }
    let clean = false;
    let closeError: unknown;
    try {
      clean = await this.#closeAdapterBounded(managed.adapter, managed.session);
      if (!clean) {
        closeError = new GroupXError(
          "TURN_INTERRUPTED",
          `Adapter close timed out for ${managed.adapter.actorId}`
        );
      }
    } catch (error) {
      closeError = error;
    }

    if (managed.mcpRegistered) {
      try {
        this.#mcpBindings!.close(managed.session.bindingId);
      } catch (error) {
        closeError ??= error;
      }
    }

    try {
      if (clean) {
        this.#store.closeSessionBinding(managed.session.bindingId);
      } else {
        this.#store.markSessionBindingFailed(managed.session.bindingId, {
          status: "interrupted"
        });
      }
    } catch (error) {
      closeError ??= error;
    }
    try {
      this.#store.finishAgentInstance(managed.session.instanceId, {
        status: clean ? "stopped" : "interrupted"
      });
    } catch (error) {
      closeError ??= error;
    }
    if (closeError !== undefined) throw closeError;
  }

  async #closeAdapterBounded(adapter: CliAdapter, session: NativeSession): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), this.#closeTimeoutMs);
    });
    try {
      return await Promise.race([
        adapter.close(session).then(() => true),
        deadline
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  #assertStructuredMcpReady(): void {
    if (this.#config.transport !== "structured") return;
    if (!this.#mcpBindings || !this.#mcpUrl) {
      throw new GroupXError(
        "SESSION_NOT_AVAILABLE",
        "Structured transport requires the loopback GroupX MCP endpoint before Agent startup"
      );
    }
  }

  #assertSession(
    adapter: CliAdapter,
    session: NativeSession,
    instanceId: string,
    bindingId: string,
    resumedNativeSessionId: string | undefined
  ): void {
    if (
      session.adapterId !== adapter.adapterId ||
      session.actorId !== adapter.actorId ||
      session.instanceId !== instanceId ||
      session.bindingId !== bindingId ||
      session.protocol.length === 0
    ) {
      throw new GroupXError(
        "MCP_BINDING_MISMATCH",
        "Adapter returned a session outside its preallocated GroupX binding"
      );
    }
    if (
      resumedNativeSessionId !== undefined &&
      session.nativeSessionId !== resumedNativeSessionId
    ) {
      throw new GroupXError(
        "MCP_BINDING_MISMATCH",
        "Adapter resume returned a different native session"
      );
    }
  }
}

function canStartFreshAfterResumeFailure(error: unknown): boolean {
  const code = toGroupXError(error, "ADAPTER_START_FAILED").code;
  return (
    code === "ADAPTER_START_FAILED" ||
    code === "NATIVE_RESUME_UNSUPPORTED" ||
    code === "SESSION_NOT_AVAILABLE"
  );
}
