import type { AdapterId, CliAdapter, LaunchProfile, NativeSession } from "../adapters/types.js";
import { AdapterRegistry } from "../adapters/registry.js";
import { TRANSPORT_LIFECYCLE, type GroupXConfig, type TransportMode } from "../config.js";
import { createId } from "../core/envelope.js";
import { GroupXError, toGroupXError } from "../core/errors.js";
import { McpBindingRegistry } from "../mcp/binding-registry.js";
import type { GroupXStore, RuntimeRecoveryResult } from "../storage/types.js";

export type ManagedAgentId = string;

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
  /** Total attempts for transient native start/resume failures. */
  startAttempts?: number;
  retryBaseMs?: number;
  onProgress?: (progress: SessionProgress) => void | Promise<void>;
}

export type SessionProgress =
  | {
      phase: "starting";
      agentId: string;
      actorId: string;
      attempt: number;
      maxAttempts: number;
      continuity: "new_session" | "resume";
    }
  | {
      phase: "retrying";
      agentId: string;
      actorId: string;
      attempt: number;
      maxAttempts: number;
      continuity: "new_session" | "resume";
      nextDelayMs: number;
      errorCode: string;
    }
  | {
      phase: "ready";
      agentId: string;
      actorId: string;
      attempt: number;
      maxAttempts: number;
      continuity: "new_session" | "resumed" | "new_session_after_resume_failure";
    }
  | {
      phase: "failed";
      agentId: string;
      actorId: string;
      attempt: number;
      maxAttempts: number;
      continuity: "new_session" | "resume";
      errorCode: string;
    };

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function isRetryableSessionFailure(error: unknown): boolean {
  return new Set([
    "ADAPTER_START_FAILED",
    "PROTOCOL_HANDSHAKE_TIMEOUT",
    "PROTOCOL_INVALID_MESSAGE",
    "SESSION_NOT_AVAILABLE",
    "TURN_INTERRUPTED"
  ]).has(toGroupXError(error, "ADAPTER_START_FAILED").code);
}

interface ManagedSession {
  agentId: ManagedAgentId;
  adapter: CliAdapter;
  session: NativeSession;
  mcpRegistered: boolean;
}

function defaultIdFactory(kind: "instance" | "binding", agentId: ManagedAgentId): string {
  return createId(`${kind}_${agentId}`);
}

/** Owns one selected-transport runtime session for each enabled configured Agent. */
export class AgentSessionManager {
  readonly #config: SessionManagerOptions["config"];
  readonly #store: GroupXStore;
  readonly #adapters: AdapterRegistry;
  readonly #mcpBindings: McpBindingRegistry | undefined;
  readonly #idFactory: NonNullable<SessionManagerOptions["idFactory"]>;
  readonly #protocolFor: NonNullable<SessionManagerOptions["protocolFor"]>;
  readonly #closeTimeoutMs: number;
  readonly #startAttempts: number;
  readonly #retryBaseMs: number;
  readonly #onProgress: SessionManagerOptions["onProgress"];
  readonly #sessions = new Map<string, ManagedSession>();
  readonly #sessionsByBinding = new Map<string, ManagedSession>();
  readonly #restartFlights = new Map<string, Promise<RestartSessionResult>>();
  #mcpUrl: string | undefined;
  #state: SessionManagerState = "idle";
  #closePromise: Promise<void> | undefined;

  constructor(options: SessionManagerOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#adapters = options.adapters;
    this.#mcpBindings = options.mcpBindings;
    this.#idFactory = options.idFactory ?? defaultIdFactory;
    this.#protocolFor =
      options.protocolFor ??
      ((agentId, transport) => {
        if (transport === "direct") return "direct-jsonl";
        return this.#config.agents[agentId]?.driver === "codex"
          ? "codex-app-server-stdio-jsonrpc-v2"
          : "acp";
      });
    this.#closeTimeoutMs = options.closeTimeoutMs ?? options.config.timeouts.closeMs;
    this.#startAttempts = options.startAttempts ?? 3;
    this.#retryBaseMs = options.retryBaseMs ?? 400;
    this.#onProgress = options.onProgress;
    if (!Number.isSafeInteger(this.#closeTimeoutMs) || this.#closeTimeoutMs < 1) {
      throw new RangeError("closeTimeoutMs must be a positive integer");
    }
    if (!Number.isSafeInteger(this.#startAttempts) || this.#startAttempts < 1) {
      throw new RangeError("startAttempts must be a positive integer");
    }
    if (!Number.isSafeInteger(this.#retryBaseMs) || this.#retryBaseMs < 1) {
      throw new RangeError("retryBaseMs must be a positive integer");
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
      const configured = adapter ? this.#config.agents[adapter.adapterId] : undefined;
      if (
        !binding?.nativeSessionId ||
        binding.transport !== this.#config.transport ||
        !adapter ||
        configured === undefined ||
        nativeSessionIds[adapter.adapterId] !== undefined ||
        binding.capabilities.cwd !== configured.cwd
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
      for (const [agentId, agent] of Object.entries(this.#config.agents)) {
        if (!agent.enabled) continue;
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

  restart(actorId: string): Promise<RestartSessionResult> {
    const existing = this.#restartFlights.get(actorId);
    if (existing) return existing;

    let flight!: Promise<RestartSessionResult>;
    flight = this.#performRestart(actorId).finally(() => {
      if (this.#restartFlights.get(actorId) === flight) {
        this.#restartFlights.delete(actorId);
      }
    });
    this.#restartFlights.set(actorId, flight);
    return flight;
  }

  async #performRestart(actorId: string): Promise<RestartSessionResult> {
    if (this.#state !== "ready") {
      throw new GroupXError("SESSION_NOT_AVAILABLE", "Agent sessions are not ready");
    }
    const previous = this.#sessions.get(actorId);
    const adapter = previous?.adapter ?? this.#adapters.getByActor(actorId);
    const agentId = previous?.agentId ?? String(adapter.adapterId);
    const previousInstanceId = previous?.session.instanceId;
    const resumeNativeSessionId = previous?.session.nativeSessionId;
    if (previous) await this.#stopManaged(previous);
    const managed = await this.#startAgent(agentId, resumeNativeSessionId);
    return {
      actorId,
      ...(previousInstanceId === undefined ? {} : { previousInstanceId }),
      session: managed.session
    };
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (this.#state === "closed") return Promise.resolve();
    this.#state = "closing";
    this.#closePromise = (async () => {
      await Promise.allSettled([...this.#restartFlights.values()]);
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
    if (configured === undefined) {
      throw new GroupXError("ADAPTER_NOT_FOUND", `No configured agent: ${agentId}`);
    }
    const instanceId = this.#idFactory("instance", agentId);
    const bindingId = this.#idFactory("binding", agentId);
    const protocol = this.#protocolFor(agentId, this.#config.transport);
    let session: NativeSession | undefined;
    let readyAttempt = 1;
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
          const resumed = await this.#openWithRetry({
            agentId,
            adapter,
            continuity: "resume",
            open: async () =>
              await adapter.resume({ ...profile, nativeSessionId: effectiveResumeNativeSessionId })
          });
          session = resumed.session;
          readyAttempt = resumed.attempt;
        } catch (error) {
          if (!canStartFreshAfterResumeFailure(error)) throw error;
          // A failed resume is never retried as a prompt. Once bounded resume
          // attempts are exhausted, only future work gets a fresh session.
          continuity = "new_session_after_resume_failure";
          assertedResumeNativeSessionId = undefined;
          const fresh = await this.#openWithRetry({
            agentId,
            adapter,
            continuity: "new_session",
            open: async () => await adapter.start(profile)
          });
          session = fresh.session;
          readyAttempt = fresh.attempt;
        }
      } else {
        const fresh = await this.#openWithRetry({
          agentId,
          adapter,
          continuity: "new_session",
          open: async () => await adapter.start(profile)
        });
        session = fresh.session;
        readyAttempt = fresh.attempt;
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
      await this.#emitProgress({
        phase: "ready",
        agentId,
        actorId: adapter.actorId,
        attempt: readyAttempt,
        maxAttempts: this.#startAttempts,
        continuity
      });
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

  async #openWithRetry(input: {
    agentId: string;
    adapter: CliAdapter;
    continuity: "new_session" | "resume";
    open: () => Promise<NativeSession>;
  }): Promise<{ session: NativeSession; attempt: number }> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#startAttempts; attempt += 1) {
      await this.#emitProgress({
        phase: "starting",
        agentId: input.agentId,
        actorId: input.adapter.actorId,
        attempt,
        maxAttempts: this.#startAttempts,
        continuity: input.continuity
      });
      try {
        return { session: await input.open(), attempt };
      } catch (error) {
        lastError = error;
        const normalized = toGroupXError(error, "ADAPTER_START_FAILED");
        if (attempt >= this.#startAttempts || !isRetryableSessionFailure(error)) {
          await this.#emitProgress({
            phase: "failed",
            agentId: input.agentId,
            actorId: input.adapter.actorId,
            attempt,
            maxAttempts: this.#startAttempts,
            continuity: input.continuity,
            errorCode: normalized.code
          });
          break;
        }
        const nextDelayMs = this.#retryBaseMs * 2 ** (attempt - 1);
        await this.#emitProgress({
          phase: "retrying",
          agentId: input.agentId,
          actorId: input.adapter.actorId,
          attempt,
          maxAttempts: this.#startAttempts,
          continuity: input.continuity,
          nextDelayMs,
          errorCode: normalized.code
        });
        await waitForRetry(nextDelayMs);
      }
    }
    throw toGroupXError(lastError, "ADAPTER_START_FAILED");
  }

  async #emitProgress(progress: SessionProgress): Promise<void> {
    try {
      await this.#onProgress?.(progress);
    } catch {
      // Session progress is advisory and must not decide session readiness.
    }
  }

  #launchProfile(
    agentId: ManagedAgentId,
    instanceId: string,
    bindingId: string
  ): LaunchProfile {
    const configured = this.#config.agents[agentId];
    if (configured === undefined) {
      throw new GroupXError("ADAPTER_NOT_FOUND", `No configured agent: ${agentId}`);
    }
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
      const health = managed.adapter.health();
      const normalized = toGroupXError(error, "TURN_INTERRUPTED");
      const alreadyDetachedAfterFailure =
        normalized.code === "SESSION_NOT_AVAILABLE" &&
        health.status === "failed" &&
        health.instanceId === managed.session.instanceId &&
        !health.nativeSessionAvailable;
      if (!alreadyDetachedAfterFailure) closeError = error;
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
    code === "PROTOCOL_INVALID_MESSAGE" ||
    code === "SESSION_NOT_AVAILABLE"
  );
}
