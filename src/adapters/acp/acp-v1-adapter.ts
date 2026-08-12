import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import { GroupXError, type GroupXErrorCode } from "../../core/errors.js";
import { boundDiagnosticText } from "../../observability/diagnostics.js";
import { AsyncQueue } from "../../utils/async-queue.js";
import {
  JsonLineRpcClient,
  JsonRpcRemoteError,
  JsonRpcServerError,
  type JsonRpcServerRequest
} from "../jsonline-rpc.js";
import type {
  AdapterHealth,
  CancelResult,
  CapabilityFinding,
  CapabilityReport,
  CliAdapter,
  LaunchProfile,
  NativeEvent,
  NativeSession,
  PromptInput
} from "../types.js";
import {
  ACP_PROTOCOL_VERSION,
  buildMcpServers,
  buildPromptBlocks,
  isRecord,
  launchProfileFields,
  normalizeSessionUpdate,
  parseInitializeResult,
  parseNewSessionResult,
  parsePromptResult,
  parseSessionUpdate,
  type AcpAgentCapabilities,
  type AcpImplementationInfo,
  type AcpSessionUpdate
} from "./protocol.js";

export interface AcpV1AdapterOptions {
  handshakeTimeoutMs?: number;
  closeGraceMs?: number;
  killGraceMs?: number;
  now?: () => Date;
  idFactory?: (kind: "instance" | "binding") => string;
}

type AcpAdapterId = string;

type FatalNativeErrorCode = Extract<
  GroupXErrorCode,
  "UNEXPECTED_NATIVE_INTERACTION" | "NATIVE_POLICY_BLOCKED"
>;

interface FatalNativeError {
  errorCode: FatalNativeErrorCode;
  message: string;
}

interface ActiveTurn {
  turnId: string;
  correlationId: string;
  queue: AsyncQueue<NativeEvent>;
  cancelRequested: boolean;
  cancelDispatched: boolean;
  interactionFailurePending: boolean;
  terminalObserved: boolean;
  removeAbortListener?: () => void;
}

interface AcpRuntime {
  client: JsonLineRpcClient;
  profile: Pick<LaunchProfile, "command" | "prefixArgs" | "cwd" | "instanceId" | "bindingId" | "mcp">;
  instanceId: string;
  bindingId: string;
  capabilities: AcpAgentCapabilities;
  nativeSessionId?: string;
  session?: NativeSession;
  activeTurn?: ActiveTurn;
  fatalNativeError?: FatalNativeError;
  fatalCancelDispatched: boolean;
  loadReplay: AcpSessionUpdate[];
  loadingSession: boolean;
  disposers: Array<() => void>;
  closing: boolean;
}

interface MutableHealth {
  status: AdapterHealth["status"];
  instanceId?: string;
  nativeSessionAvailable: boolean;
  lastError?: string;
  updatedAt: string;
}

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_CLOSE_GRACE_MS = 5_000;
const DEFAULT_KILL_GRACE_MS = 2_000;

/**
 * ACP v1 client kernel shared by the Grok and Kimi adapters.
 *
 * GroupX v0.1 requires the native CLI to run unrestricted. This kernel never
 * exposes or resolves an approval flow: an unexpected native interaction is
 * cancelled at the wire boundary and fails the current turn.
 */
export abstract class AcpV1Adapter implements CliAdapter {
  readonly adapterId: AcpAdapterId;
  readonly actorId: string;

  readonly #argvTail: readonly string[];
  readonly #handshakeTimeoutMs: number;
  readonly #closeGraceMs: number;
  readonly #killGraceMs: number;
  readonly #now: () => Date;
  readonly #idFactory: (kind: "instance" | "binding") => string;
  readonly #observed = new Set<string>();

  #runtime: AcpRuntime | undefined;
  #lastCapabilities: AcpAgentCapabilities | undefined;
  #lastAgentInfo: AcpImplementationInfo | undefined;
  #lastCommand: string | undefined;
  #lastPrefixArgs: readonly string[] = [];
  #health: MutableHealth;

  protected constructor(
    adapterId: AcpAdapterId,
    actorId: string,
    argvTail: readonly string[],
    options: AcpV1AdapterOptions = {}
  ) {
    this.adapterId = adapterId;
    this.actorId = actorId;
    this.#argvTail = [...argvTail];
    this.#handshakeTimeoutMs = positiveDuration(options.handshakeTimeoutMs, DEFAULT_HANDSHAKE_TIMEOUT_MS);
    this.#closeGraceMs = positiveDuration(options.closeGraceMs, DEFAULT_CLOSE_GRACE_MS);
    this.#killGraceMs = positiveDuration(options.killGraceMs, DEFAULT_KILL_GRACE_MS);
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? ((kind) => `${kind}:${adapterId}:${randomUUID()}`);
    this.#health = {
      status: "stopped",
      nativeSessionAvailable: false,
      updatedAt: this.#now().toISOString()
    };
  }

  /** Adapter-specific session configuration that must succeed before start/resume returns. */
  protected configureSession(
    _client: JsonLineRpcClient,
    _nativeSessionId: string,
    _timeoutMs: number
  ): Promise<void> {
    return Promise.resolve();
  }

  /** Adapter-specific read-only checks that must pass before spawning. */
  protected preflightLaunch(_input: LaunchProfile): Promise<void> {
    return Promise.resolve();
  }

  /** Narrow classifier for explicit native/managed policy blocks. */
  protected isNativePolicyBlock(error: unknown): boolean {
    return isStructuredPolicyBlock(error);
  }

  async probe(): Promise<CapabilityReport> {
    const capabilities = this.#lastCapabilities;
    const findings: CapabilityFinding[] = [
      finding("initialize", this.#observed.has("initialize") ? "verified" : "documented", "ACP v1 initialize"),
      finding("session.new", this.#observed.has("session.new") ? "verified" : "documented", "ACP v1 session/new"),
      finding(
        "session.prompt",
        this.#observed.has("session.prompt") ? "verified" : "documented",
        "Terminal state is the matching session/prompt response"
      ),
      finding(
        "session.cancel",
        this.#observed.has("session.cancel") ? "verified" : "documented",
        "ACP v1 session/cancel notification"
      ),
      finding(
        "session.load",
        this.#observed.has("session.load")
          ? "verified"
          : capabilities?.loadSession === true
            ? "advertised"
            : "unsupported",
        "Capability-gated by agentCapabilities.loadSession"
      ),
      finding(
        "mcp.stdio",
        this.#observed.has("mcp.stdio.descriptor") ? "probed" : "documented",
        "ACP v1 baseline MCP descriptor accepted by session setup; tool invocation is verified separately"
      ),
      finding(
        "mcp.http",
        this.#observed.has("mcp.http.descriptor")
          ? "probed"
          : capabilities?.mcpCapabilities?.http === true
            ? "advertised"
            : "unsupported",
        "Capability-gated by agentCapabilities.mcpCapabilities.http"
      ),
      finding(
        "access.unrestricted",
        this.#observed.has("access.unrestricted") ? "probed" : "documented",
        "Native unrestricted mode is mandatory; GroupX has no approval or permission decision flow"
      )
    ];

    return {
      adapterId: this.adapterId,
      ...(this.#lastCommand === undefined ? {} : { executablePath: this.#lastCommand }),
      ...(this.#lastAgentInfo?.version === undefined ? {} : { version: this.#lastAgentInfo.version }),
      protocol: "acp",
      protocolVersion: String(ACP_PROTOCOL_VERSION),
      launchArgvShape: [this.#lastCommand ?? "<command>", ...this.#lastPrefixArgs, ...this.#argvTail],
      findings,
      generatedAt: this.#now().toISOString()
    };
  }

  async start(input: LaunchProfile): Promise<NativeSession> {
    return await this.#launch(input, undefined);
  }

  async resume(input: LaunchProfile & { nativeSessionId: string }): Promise<NativeSession> {
    if (input.nativeSessionId.length === 0) {
      throw new GroupXError("SESSION_NOT_AVAILABLE", "nativeSessionId must be non-empty");
    }
    return await this.#launch(input, input.nativeSessionId);
  }

  async *prompt(session: NativeSession, input: PromptInput): AsyncIterable<NativeEvent> {
    const runtime = this.#requireSession(session);
    if (runtime.activeTurn !== undefined) {
      throw new GroupXError(
        "SESSION_NOT_AVAILABLE",
        `${this.adapterId} ACP session already has an active prompt turn`
      );
    }

    const turn: ActiveTurn = {
      turnId: input.turnId,
      correlationId: input.correlationId,
      queue: new AsyncQueue<NativeEvent>(),
      cancelRequested: false,
      cancelDispatched: false,
      interactionFailurePending: false,
      terminalObserved: false
    };
    runtime.activeTurn = turn;
    turn.queue.push(
      this.#event(runtime, turn, "turn.started", {
        turnId: input.turnId,
        correlationId: input.correlationId
      })
    );

    if (input.signal?.aborted === true) {
      turn.cancelRequested = true;
      turn.terminalObserved = true;
      turn.queue.push(
        this.#event(runtime, turn, "turn.cancelled", {
          stopReason: "cancelled",
          dispatched: false
        })
      );
      delete runtime.activeTurn;
      turn.queue.end();
      for await (const event of turn.queue) {
        yield event;
      }
      return;
    }

    if (runtime.fatalNativeError !== undefined) {
      this.#failTurn(runtime, turn, runtime.fatalNativeError, false);
      for await (const event of turn.queue) {
        yield event;
      }
      return;
    }

    // Start the request before wiring a racing abort into session/cancel. JSONL
    // writes are ordered, so a later cancel notification cannot overtake the
    // prompt it is intended to cancel.
    void this.#runPrompt(runtime, turn, input);

    if (input.signal !== undefined) {
      const abort = (): void => {
        void this.cancel(session, input.turnId).catch(() => undefined);
      };
      input.signal.addEventListener("abort", abort, { once: true });
      turn.removeAbortListener = () => input.signal?.removeEventListener("abort", abort);
      if (input.signal.aborted) {
        abort();
      }
    }

    try {
      for await (const event of turn.queue) {
        yield event;
      }
    } finally {
      if (!turn.terminalObserved && runtime.activeTurn === turn && !turn.cancelRequested) {
        void this.cancel(session, input.turnId).catch(() => undefined);
      }
    }
  }

  async cancel(session: NativeSession, nativeTurnId: string): Promise<CancelResult> {
    const runtime = this.#requireSession(session);
    const turn = runtime.activeTurn;
    if (turn === undefined || turn.turnId !== nativeTurnId) {
      return {
        requested: false,
        supported: true,
        terminalObserved: false,
        detail: "No matching active ACP prompt"
      };
    }
    if (turn.cancelRequested) {
      return {
        requested: true,
        supported: true,
        terminalObserved: turn.terminalObserved,
        detail: "Cancellation was already requested"
      };
    }

    turn.cancelRequested = true;
    await this.#notifyCancel(runtime, turn);
    return {
      requested: true,
      supported: true,
      terminalObserved: turn.terminalObserved
    };
  }

  /** Returns and clears protocol replay notifications observed during the last session/load. */
  takeLoadReplay(session: NativeSession): AcpSessionUpdate[] {
    const runtime = this.#requireSession(session);
    const replay = structuredClone(runtime.loadReplay);
    runtime.loadReplay.splice(0);
    return replay;
  }

  async close(session: NativeSession): Promise<void> {
    const runtime = this.#requireSession(session);
    runtime.closing = true;

    const activeTurn = runtime.activeTurn;
    if (activeTurn !== undefined) {
      await settleWithin(
        this.cancel(session, activeTurn.turnId),
        this.#handshakeTimeoutMs
      );
      if (activeTurn.interactionFailurePending) {
        await waitForInteractionSettlement(activeTurn, this.#handshakeTimeoutMs);
      }
    }

    if (isRecord(runtime.capabilities.sessionCapabilities?.close) && runtime.nativeSessionId !== undefined) {
      await runtime.client
        .request("session/close", { sessionId: runtime.nativeSessionId }, { timeoutMs: this.#handshakeTimeoutMs })
        .then(() => this.#observed.add("session.close"))
        .catch(() => undefined);
    }

    runtime.client.setServerRequestHandler(undefined);
    await runtime.client.close();
    this.#disposeRuntime(runtime);
    if (this.#runtime === runtime) {
      this.#runtime = undefined;
    }
    this.#setHealth("stopped");
  }

  health(): AdapterHealth {
    return {
      adapterId: this.adapterId,
      status: this.#health.status,
      ...(this.#health.instanceId === undefined ? {} : { instanceId: this.#health.instanceId }),
      nativeSessionAvailable: this.#health.nativeSessionAvailable,
      ...(this.#health.lastError === undefined ? {} : { lastError: this.#health.lastError }),
      updatedAt: this.#health.updatedAt
    };
  }

  async #launch(input: LaunchProfile, nativeSessionId: string | undefined): Promise<NativeSession> {
    if (this.#runtime !== undefined) {
      throw new GroupXError("SESSION_NOT_AVAILABLE", `${this.adapterId} ACP adapter is already running`);
    }
    validateLaunchProfile(input);

    const instanceId = input.instanceId ?? this.#idFactory("instance");
    const bindingId = input.bindingId ?? this.#idFactory("binding");
    this.#setHealth("starting", instanceId);
    this.#lastCommand = input.command;
    this.#lastPrefixArgs = [...(input.prefixArgs ?? [])];

    try {
      await this.preflightLaunch(input);
    } catch (error) {
      const groupXError =
        error instanceof GroupXError
          ? error
          : new GroupXError(
              "ADAPTER_START_FAILED",
              `${this.adapterId} unrestricted config preflight failed`,
              undefined,
              error instanceof Error ? { cause: error } : undefined
            );
      this.#setHealth("failed", instanceId, groupXError.message);
      throw groupXError;
    }

    const argv = [input.command, ...(input.prefixArgs ?? []), ...this.#argvTail] as [string, ...string[]];
    const client = JsonLineRpcClient.spawn(
      {
        argv,
        cwd: input.cwd,
        closeGraceMs: this.#closeGraceMs,
        killGraceMs: this.#killGraceMs
      },
      {
        dialect: "acp",
        defaultRequestTimeoutMs: this.#handshakeTimeoutMs,
        idPrefix: `${this.adapterId}:`
      }
    );
    const runtime: AcpRuntime = {
      client,
      profile: launchProfileFields(input),
      instanceId,
      bindingId,
      capabilities: {},
      fatalCancelDispatched: false,
      loadReplay: [],
      loadingSession: false,
      disposers: [],
      closing: false
    };
    this.#runtime = runtime;
    client.setServerRequestHandler((request) => this.#handleServerRequest(runtime, request));
    runtime.disposers.push(
      client.onNotification((notification) => this.#handleNotification(runtime, notification.method, notification.params)),
      client.onStderr(() => this.#handleStderr(runtime)),
      client.onProtocolError((error) => {
        if (this.#runtime === runtime && !runtime.closing) {
          this.#setHealth("failed", runtime.instanceId, error.message);
        }
      }),
      client.onExit((exit) => {
        if (this.#runtime !== runtime) {
          return;
        }
        if (runtime.closing || (exit.expected && client.state !== "failed")) {
          this.#setHealth("stopped");
          return;
        }
        this.#runtime = undefined;
        this.#setHealth(
          "failed",
          runtime.instanceId,
          runtime.fatalNativeError?.message ??
            exit.error ??
            exit.stderr ??
            `ACP process exited with code ${String(exit.code)}`
        );
      })
    );
    this.#handleStderr(runtime);

    try {
      const initialized = parseInitializeResult(
        await client.request(
          "initialize",
          {
            protocolVersion: ACP_PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: {
              name: "groupx",
              title: "GroupX",
              version: "0.1.0"
            }
          },
          { timeoutMs: this.#handshakeTimeoutMs }
        )
      );
      runtime.capabilities = initialized.agentCapabilities;
      this.#lastCapabilities = structuredClone(initialized.agentCapabilities);
      this.#lastAgentInfo = initialized.agentInfo;
      this.#observed.add("initialize");
      await this.#throwIfFatal(runtime);

      const mcpServers = buildMcpServers(input.mcp, runtime.capabilities, runtime.bindingId);

      if (nativeSessionId === undefined) {
        runtime.nativeSessionId = parseNewSessionResult(
          await client.request(
            "session/new",
            { cwd: input.cwd, mcpServers },
            { timeoutMs: this.#handshakeTimeoutMs }
          )
        );
        this.#observed.add("session.new");
      } else {
        if (runtime.capabilities.loadSession !== true) {
          throw new GroupXError(
            "NATIVE_RESUME_UNSUPPORTED",
            `${this.adapterId} ACP agent did not advertise agentCapabilities.loadSession`
          );
        }
        runtime.nativeSessionId = nativeSessionId;
        runtime.loadingSession = true;
        try {
          await client.request(
            "session/load",
            { sessionId: nativeSessionId, cwd: input.cwd, mcpServers },
            { timeoutMs: this.#handshakeTimeoutMs }
          );
        } catch (error) {
          delete runtime.nativeSessionId;
          throw error;
        } finally {
          runtime.loadingSession = false;
        }
        this.#observed.add("session.load");
      }

      await this.#throwIfFatal(runtime);
      await this.configureSession(client, runtime.nativeSessionId, this.#handshakeTimeoutMs);
      await this.#throwIfFatal(runtime);
      this.#observed.add("access.unrestricted");

      if (input.mcp?.transport === "stdio") {
        this.#observed.add("mcp.stdio.descriptor");
      } else if (input.mcp?.transport === "streamable-http") {
        this.#observed.add("mcp.http.descriptor");
      }

      const session: NativeSession = {
        adapterId: this.adapterId,
        instanceId,
        bindingId,
        actorId: this.actorId,
        nativeSessionId: runtime.nativeSessionId,
        protocol: "acp",
        startedAt: this.#now().toISOString()
      };
      runtime.session = session;
      this.#setHealth("ready", instanceId);
      return { ...session };
    } catch (error) {
      runtime.closing = true;
      client.setServerRequestHandler(undefined);
      await client.close().catch(() => undefined);
      this.#disposeRuntime(runtime);
      if (this.#runtime === runtime) {
        this.#runtime = undefined;
      }
      const groupXError =
        runtime.fatalNativeError !== undefined
          ? new GroupXError(
              runtime.fatalNativeError.errorCode,
              runtime.fatalNativeError.message,
              undefined,
              error instanceof Error ? { cause: error } : undefined
            )
          : error instanceof GroupXError
          ? error
          : this.isNativePolicyBlock(error)
            ? new GroupXError(
                "NATIVE_POLICY_BLOCKED",
                "Native policy blocked the required unrestricted ACP mode",
                undefined,
                error instanceof Error ? { cause: error } : undefined
              )
            : new GroupXError(
                nativeSessionId === undefined ? "ADAPTER_START_FAILED" : "SESSION_NOT_AVAILABLE",
                boundDiagnosticText(errorMessage(error), 1_024),
                undefined,
                error instanceof Error ? { cause: error } : undefined
              );
      this.#setHealth("failed", instanceId, groupXError.message);
      throw groupXError;
    }
  }

  async #runPrompt(runtime: AcpRuntime, turn: ActiveTurn, input: PromptInput): Promise<void> {
    try {
      const response = parsePromptResult(
        await runtime.client.request(
          "session/prompt",
          {
            sessionId: runtime.nativeSessionId,
            prompt: buildPromptBlocks(input)
          },
          { timeoutMs: false }
        )
      );
      if (turn.terminalObserved || turn.interactionFailurePending) {
        return;
      }
      turn.terminalObserved = true;
      this.#observed.add("session.prompt");
      turn.queue.push(
        this.#event(runtime, turn, response.stopReason === "cancelled" ? "turn.cancelled" : "turn.completed", {
          stopReason: response.stopReason,
          ...(response.userMessageId === undefined ? {} : { userMessageId: response.userMessageId }),
          ...(response.usage === undefined ? {} : { usage: response.usage })
        })
      );
    } catch (error) {
      if (turn.terminalObserved || turn.interactionFailurePending) {
        return;
      }
      const message = boundDiagnosticText(errorMessage(error), 1_024);
      const errorCode = runtime.closing
          ? "TURN_INTERRUPTED"
        : error instanceof GroupXError
          ? error.code
          : "PROTOCOL_INVALID_MESSAGE";
      if (runtime.client.state === "failed") {
        await runtime.client.close().catch(() => undefined);
        this.#disposeRuntime(runtime);
        if (this.#runtime === runtime) {
          this.#runtime = undefined;
        }
      }
      this.#failTurn(runtime, turn, { errorCode, message }, false, false);
      if (runtime.client.state === "failed" && this.#runtime === runtime) {
        this.#setHealth("failed", runtime.instanceId, message);
      }
    } finally {
      if (!turn.interactionFailurePending) {
        turn.removeAbortListener?.();
        if (runtime.activeTurn === turn) {
          delete runtime.activeTurn;
        }
        turn.queue.end();
      }
    }
  }

  #handleNotification(runtime: AcpRuntime, method: string, params: unknown): void {
    if (method !== "session/update" || runtime.nativeSessionId === undefined) {
      return;
    }
    const parsed = parseSessionUpdate(params);
    if (parsed !== undefined && runtime.loadingSession && parsed.sessionId === runtime.nativeSessionId) {
      runtime.loadReplay.push(parsed);
      return;
    }
    const turn = runtime.activeTurn;
    if (
      parsed === undefined ||
      turn === undefined ||
      turn.terminalObserved ||
      turn.interactionFailurePending ||
      parsed.sessionId !== runtime.nativeSessionId
    ) {
      return;
    }
    const event = normalizeSessionUpdate(
      this.adapterId,
      runtime.instanceId,
      runtime.nativeSessionId,
      turn.turnId,
      this.#now().toISOString(),
      parsed.update
    );
    if (event !== undefined) {
      turn.queue.push(event);
    }
  }

  #handleServerRequest(runtime: AcpRuntime, request: JsonRpcServerRequest): Promise<unknown> {
    if (request.method !== "session/request_permission") {
      throw new JsonRpcServerError(-32601, `Method not found: ${request.method}`);
    }

    this.#observed.add("native.interaction");
    const failure: FatalNativeError = {
      errorCode: "UNEXPECTED_NATIVE_INTERACTION",
      message:
        "Native ACP requested an interactive permission decision while GroupX requires unrestricted CLI execution"
    };
    const turn = runtime.activeTurn;
    if (turn !== undefined && !turn.terminalObserved) {
      if (!turn.interactionFailurePending) {
        turn.interactionFailurePending = true;
        turn.cancelRequested = true;
        setTimeout(() => {
          void this.#failAfterPermissionSettlement(runtime, turn);
        }, 0);
      }
    } else if (!runtime.closing) {
      this.#recordFatalNativeError(runtime, failure);
      setTimeout(() => {
        void this.#notifyFatalSessionCancel(runtime).catch(() => undefined);
      }, 0);
    }

    // ACP cancellation is a protocol settlement, not a GroupX permission
    // choice. Returning immediately guarantees the native request cannot stay
    // pending even when cancellation raced with the request.
    return Promise.resolve({ outcome: { outcome: "cancelled" } });
  }

  #failTurn(
    runtime: AcpRuntime,
    turn: ActiveTurn,
    failure: { errorCode: GroupXErrorCode; message: string },
    cancelNative: boolean,
    markRuntimeFatal = true
  ): void {
    if (turn.terminalObserved) {
      return;
    }
    turn.interactionFailurePending = false;
    if (markRuntimeFatal) {
      this.#recordFatalNativeError(runtime, {
        errorCode:
          failure.errorCode === "NATIVE_POLICY_BLOCKED"
            ? "NATIVE_POLICY_BLOCKED"
            : "UNEXPECTED_NATIVE_INTERACTION",
        message: failure.message
      });
    }
    turn.terminalObserved = true;
    if (cancelNative) {
      turn.cancelRequested = true;
    }
    turn.queue.push(
      this.#event(runtime, turn, "transport.error", {
        errorCode: failure.errorCode,
        message: failure.message
      })
    );
    turn.queue.push(
      this.#event(runtime, turn, "turn.failed", {
        errorCode: failure.errorCode,
        message: failure.message
      })
    );
    turn.removeAbortListener?.();
    if (runtime.activeTurn === turn) {
      delete runtime.activeTurn;
    }
    turn.queue.end();

    if (cancelNative) {
      setTimeout(() => {
        void this.#notifyCancel(runtime, turn).catch(() => undefined);
      }, 0);
    }
  }

  async #notifyCancel(runtime: AcpRuntime, turn: ActiveTurn): Promise<void> {
    if (turn.cancelDispatched || runtime.nativeSessionId === undefined || runtime.client.state !== "running") {
      return;
    }
    turn.cancelDispatched = true;
    await runtime.client.notify("session/cancel", { sessionId: runtime.nativeSessionId });
    this.#observed.add("session.cancel");
  }

  async #failAfterPermissionSettlement(
    runtime: AcpRuntime,
    turn: ActiveTurn
  ): Promise<void> {
    await this.#notifyCancel(runtime, turn).catch(() => undefined);
    const failure: FatalNativeError = {
      errorCode: "UNEXPECTED_NATIVE_INTERACTION",
      message:
        "Native ACP requested an interactive permission decision while GroupX requires unrestricted CLI execution"
    };
    this.#failTurn(runtime, turn, failure, false, true);
  }

  async #notifyFatalSessionCancel(runtime: AcpRuntime): Promise<void> {
    if (
      runtime.fatalCancelDispatched ||
      runtime.nativeSessionId === undefined ||
      runtime.client.state !== "running"
    ) {
      return;
    }
    runtime.fatalCancelDispatched = true;
    await runtime.client.notify("session/cancel", { sessionId: runtime.nativeSessionId });
    this.#observed.add("session.cancel");
  }

  #handleStderr(runtime: AcpRuntime): void {
    if (runtime.closing || !this.isNativePolicyBlock(runtime.client.stderr)) {
      return;
    }
    const failure: FatalNativeError = {
      errorCode: "NATIVE_POLICY_BLOCKED",
      message: "Native managed policy blocked the required unrestricted ACP execution mode"
    };
    const turn = runtime.activeTurn;
    if (turn === undefined) {
      this.#recordFatalNativeError(runtime, failure);
      return;
    }
    this.#failTurn(runtime, turn, failure, true, true);
  }

  #recordFatalNativeError(runtime: AcpRuntime, failure: FatalNativeError): void {
    if (
      runtime.fatalNativeError === undefined ||
      (runtime.fatalNativeError.errorCode !== "NATIVE_POLICY_BLOCKED" &&
        failure.errorCode === "NATIVE_POLICY_BLOCKED")
    ) {
      runtime.fatalNativeError = failure;
    }
    if (!runtime.closing && this.#runtime === runtime) {
      this.#setHealth("failed", runtime.instanceId, runtime.fatalNativeError.message);
    }
  }

  async #throwIfFatal(runtime: AcpRuntime): Promise<void> {
    if (runtime.fatalNativeError !== undefined) {
      await this.#notifyFatalSessionCancel(runtime).catch(() => undefined);
      throw new GroupXError(runtime.fatalNativeError.errorCode, runtime.fatalNativeError.message);
    }
  }

  #requireSession(session: NativeSession): AcpRuntime {
    const runtime = this.#runtime;
    if (
      runtime === undefined ||
      runtime.session === undefined ||
      session.adapterId !== this.adapterId ||
      session.actorId !== this.actorId ||
      session.instanceId !== runtime.instanceId ||
      session.bindingId !== runtime.bindingId ||
      session.nativeSessionId !== runtime.nativeSessionId
    ) {
      throw new GroupXError("SESSION_NOT_AVAILABLE", `No matching active ${this.adapterId} ACP session`);
    }
    return runtime;
  }

  #event(
    runtime: AcpRuntime,
    turn: ActiveTurn,
    type: NativeEvent["type"],
    payload: unknown
  ): NativeEvent {
    return {
      adapterId: this.adapterId,
      instanceId: runtime.instanceId,
      ...(runtime.nativeSessionId === undefined ? {} : { nativeSessionId: runtime.nativeSessionId }),
      nativeTurnId: turn.turnId,
      type,
      payload,
      occurredAt: this.#now().toISOString()
    };
  }

  #disposeRuntime(runtime: AcpRuntime): void {
    for (const dispose of runtime.disposers.splice(0)) {
      dispose();
    }
  }

  #setHealth(
    status: AdapterHealth["status"],
    instanceId?: string,
    lastError?: string
  ): void {
    this.#health = {
      status,
      ...(instanceId === undefined ? {} : { instanceId }),
      nativeSessionAvailable: status === "ready" && this.#runtime?.nativeSessionId !== undefined,
      ...(lastError === undefined ? {} : { lastError: boundDiagnosticText(lastError, 1_024) }),
      updatedAt: this.#now().toISOString()
    };
  }
}

function validateLaunchProfile(input: LaunchProfile): void {
  if (typeof input.command !== "string" || input.command.length === 0) {
    throw new TypeError("LaunchProfile.command must be non-empty");
  }
  if (
    input.prefixArgs !== undefined &&
    (!Array.isArray(input.prefixArgs) || input.prefixArgs.some((argument) => typeof argument !== "string"))
  ) {
    throw new TypeError("LaunchProfile.prefixArgs must contain only strings");
  }
  if (typeof input.cwd !== "string" || !isAbsolute(input.cwd)) {
    throw new TypeError("LaunchProfile.cwd must be an absolute path");
  }
  if (input.bindingId !== undefined && input.bindingId.length === 0) {
    throw new TypeError("LaunchProfile.bindingId must be non-empty when provided");
  }
  if (input.instanceId !== undefined && input.instanceId.length === 0) {
    throw new TypeError("LaunchProfile.instanceId must be non-empty when provided");
  }
  if (input.mcp !== undefined && (input.instanceId === undefined || input.bindingId === undefined)) {
    throw new GroupXError(
      "MCP_BINDING_MISMATCH",
      "MCP-enabled ACP sessions require Broker-preassigned instanceId and bindingId provenance"
    );
  }
}

function positiveDuration(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isFinite(selected) || selected <= 0) {
    throw new TypeError("ACP adapter timeouts must be positive finite numbers");
  }
  return selected;
}

function finding(
  capability: string,
  level: CapabilityFinding["level"],
  detail: string
): CapabilityFinding {
  return { capability, level, detail };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isStructuredPolicyBlock(error: unknown): boolean {
  if (error instanceof GroupXError) {
    return error.code === "NATIVE_POLICY_BLOCKED";
  }
  if (error instanceof JsonRpcRemoteError) {
    return hasExplicitPolicyBlock(error.data) || explicitPolicyText(error.message);
  }
  return hasExplicitPolicyBlock(error);
}

function hasExplicitPolicyBlock(value: unknown, depth = 0): boolean {
  if (!isRecord(value) || depth > 4) {
    return false;
  }

  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
    if (
      entry === true &&
      [
        "policyblocked",
        "blockedbypolicy",
        "policylocked",
        "managedpolicyblocked",
        "forbiddenbypolicy"
      ].includes(normalizedKey)
    ) {
      return true;
    }
    if (
      typeof entry === "string" &&
      ["code", "reason", "type", "kind", "status", "message", "policy", "policystate", "policyreason"].includes(
        normalizedKey
      ) &&
      explicitPolicyText(entry)
    ) {
      return true;
    }
    if (
      depth < 4 &&
      isRecord(entry) &&
      (["data", "error", "meta", "policy", "restriction", "constraints"].includes(normalizedKey) ||
        normalizedKey.startsWith("policy")) &&
      hasExplicitPolicyBlock(entry, depth + 1)
    ) {
      return true;
    }
  }
  return false;
}

function explicitPolicyText(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[\s-]+/gu, "_");
  if (
    [
      "native_policy_blocked",
      "policy_blocked",
      "policy_locked",
      "managed_policy",
      "managed_policy_blocked",
      "forbidden_by_policy",
      "locked_by_policy"
    ].includes(normalized)
  ) {
    return true;
  }
  const text = value.toLowerCase();
  return (
    /\b(?:managed|enterprise|admin(?:istrator)?|native)\s+policy\b.*\b(?:blocked|disabled|locked|forbidden|denied)\b/u.test(
      text
    ) ||
    /\b(?:blocked|disabled|locked|forbidden|denied)\b.*\b(?:managed\s+)?policy\b/u.test(text)
  );
}

async function settleWithin(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    void promise.then(finish, finish);
  });
}

async function waitForInteractionSettlement(turn: ActiveTurn, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (turn.interactionFailurePending && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}
