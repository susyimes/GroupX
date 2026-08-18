import { randomUUID } from "node:crypto";
import { isAbsolute, resolve as resolvePath } from "node:path";

import { GroupXError, type GroupXErrorCode } from "../../core/errors.js";
import { boundDiagnosticText, projectDiagnosticValue } from "../../observability/diagnostics.js";
import { JsonLineProcess, type JsonLineProcessExit } from "../../supervisor/jsonline-process.js";
import { AsyncQueue } from "../../utils/async-queue.js";
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
  buildClaudeControlErrorResponse,
  buildClaudeDenyPermissionResponse,
  buildClaudeInitializeRequest,
  buildClaudeInterruptRequest,
  buildClaudeLaunchArgv,
  buildClaudeSetPermissionModeRequest,
  buildClaudeUserMessage,
  CLAUDE_BASE_ARGV,
  CLAUDE_PROTOCOL,
  CLAUDE_UNRESTRICTED_PERMISSION_MODE,
  isRecord,
  launchProfileFields,
  normalizeClaudeStreamEvent,
  parseClaudeControlRequest,
  parseClaudeControlResponse,
  parseClaudeHandshake,
  parseClaudeInit,
  parseClaudeResult,
  parseClaudeSetPermissionModeResult,
  readClaudeAssistantBlocks,
  readClaudeStreamMessageStart,
  readClaudeToolResults,
  type ClaudeControlResponse,
  type ClaudeHandshake,
  type ClaudeInit
} from "./protocol.js";

export interface ClaudeAdapterTimeouts {
  handshakeMs: number;
  requestMs: number;
  firstEventMs: number;
  idleMs: number;
  cancelMs: number;
  closeMs: number;
}

export interface ClaudeCliAdapterOptions {
  timeouts?: Partial<ClaudeAdapterTimeouts>;
  now?: () => Date;
  /** Room-local agent key; defaults to the builtin `claude`. */
  agentId?: string;
  targetCliVersion?: string;
  idFactory?: (kind: "instance" | "binding" | "session" | "control") => string;
}

const DEFAULT_TIMEOUTS: ClaudeAdapterTimeouts = {
  handshakeMs: 15_000,
  requestMs: 10_000,
  firstEventMs: 180_000,
  idleMs: 300_000,
  cancelMs: 10_000,
  closeMs: 5_000
};

const KILL_GRACE_CEILING_MS = 2_000;
const CLAUDE_MAX_STDOUT_LINE_BYTES = 8 * 1024 * 1024;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface ActiveTurn {
  turnId: string;
  correlationId: string;
  queue: AsyncQueue<NativeEvent>;
  terminalDone: Deferred<void>;
  terminal: boolean;
  nativeTerminalObserved: boolean;
  cancelRequested: boolean;
  cancelDispatched: boolean;
  activityObserved: boolean;
  chunkIndex: number;
  currentMessageId: string | undefined;
  streamedTextMessageIds: Set<string>;
  seenToolUseIds: Set<string>;
  toolNames: Map<string, string>;
  firstEventTimer: NodeJS.Timeout | undefined;
  idleTimer: NodeJS.Timeout | undefined;
  cancelTimer: NodeJS.Timeout | undefined;
  abortSignal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
}

interface ClaudeRuntime {
  process: JsonLineProcess;
  profile: Pick<LaunchProfile, "command" | "prefixArgs" | "cwd" | "instanceId" | "bindingId" | "mcp">;
  instanceId: string;
  bindingId: string;
  nativeSessionId: string | undefined;
  session: NativeSession | undefined;
  handshake: ClaudeHandshake | undefined;
  init: ClaudeInit | undefined;
  pendingControl: Map<string, Deferred<ClaudeControlResponse>>;
  /**
   * True between writing a user message and consuming its `result` frame. The
   * CLI can emit an extra `result` when an interrupt races a turn that was
   * already settling; without this, that stray frame would terminate the
   * *next* turn with the previous turn's outcome.
   */
  awaitingResult: boolean;
  /**
   * Deadline until which one extra `result` frame is expected and must be
   * absorbed. Armed only when an interrupt was dispatched but something else
   * settled the turn first: the CLI still answers that interrupt with its own
   * `result`, which would otherwise terminate whatever turn is running next.
   */
  strayResultDeadlineMs: number | undefined;
  activeTurn: ActiveTurn | undefined;
  controlSeq: number;
  disposers: Array<() => void>;
  closing: boolean;
  poisoned: boolean;
  teardownPromise: Promise<void> | undefined;
}

interface MutableHealth {
  status: AdapterHealth["status"];
  instanceId: string | undefined;
  nativeSessionAvailable: boolean;
  lastError: string | undefined;
  updatedAt: string;
}

/**
 * Adapter for Claude Code's first-party structured stdio surface:
 * `claude --print --input-format stream-json --output-format stream-json`.
 *
 * GroupX v0.1 requires the native CLI to run unrestricted. The adapter applies
 * that policy through process argv and establishes it with set_permission_mode.
 * initialize only observes current_permission_mode; the deferred native `init`
 * frame is a later identity/cwd/mode check. The adapter never writes the user's
 * Claude Code settings. It exposes no approval flow: an interactive native
 * request is denied at the wire boundary and fails the current Turn.
 */
export class ClaudeCliAdapter implements CliAdapter {
  readonly adapterId: string;
  readonly actorId: string;

  readonly #timeouts: ClaudeAdapterTimeouts;
  readonly #now: () => Date;
  readonly #idFactory: (kind: "instance" | "binding" | "session" | "control") => string;
  readonly #targetCliVersion: string;
  readonly #observed = new Set<string>();

  #runtime: ClaudeRuntime | undefined;
  #lastCommand: string | undefined;
  #lastPrefixArgs: readonly string[] = [];
  #lastInit: ClaudeInit | undefined;
  #health: MutableHealth;

  constructor(options: ClaudeCliAdapterOptions = {}) {
    const agentId = options.agentId ?? "claude";
    this.adapterId = agentId;
    this.actorId = `agent:${agentId}`;
    this.#timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    validateTimeouts(this.#timeouts);
    this.#now = options.now ?? (() => new Date());
    this.#targetCliVersion = options.targetCliVersion ?? "2.1.0";
    this.#idFactory =
      options.idFactory ??
      ((kind) => (kind === "session" ? randomUUID() : `${kind}:${agentId}:${randomUUID()}`));
    this.#health = {
      status: "stopped",
      instanceId: undefined,
      nativeSessionAvailable: false,
      lastError: undefined,
      updatedAt: this.#now().toISOString()
    };
  }

  async probe(): Promise<CapabilityReport> {
    const findings: CapabilityFinding[] = [
      finding(
        "control.initialize",
        this.#observed.has("control.initialize") ? "verified" : "documented",
        "SDK `control_request`/`initialize` proves the process is alive and reports current_permission_mode without a model turn"
      ),
      finding(
        "session.init",
        this.#observed.has("session.init") ? "verified" : "documented",
        "Claude Code defers its `system`/`init` frame until the first user message; it is verified against the launched session id and cwd"
      ),
      finding(
        "session.prompt",
        this.#observed.has("session.prompt") ? "verified" : "documented",
        "Terminal state is the matching `result` frame on the same stdio process"
      ),
      finding(
        "session.resume",
        this.#observed.has("session.resume") ? "verified" : "documented",
        "`--resume <session-id>` reopens a persisted native session"
      ),
      finding(
        "session.cancel",
        this.#observed.has("session.cancel") ? "verified" : "documented",
        "`control_request`/`interrupt` settles as a `result` with terminal_reason aborted_streaming"
      ),
      finding(
        "mcp.stdio",
        this.#observed.has("mcp.stdio.descriptor") ? "probed" : "documented",
        "`--mcp-config` accepts a stdio descriptor; tool invocation is verified separately"
      ),
      finding(
        "mcp.http",
        this.#observed.has("mcp.http.descriptor") ? "probed" : "documented",
        "`--mcp-config` accepts an http descriptor with a GroupX binding header"
      ),
      finding(
        "access.unrestricted",
        this.#observed.has("access.unrestricted") ? "probed" : "documented",
        `Launched with --permission-mode ${CLAUDE_UNRESTRICTED_PERMISSION_MODE}; unrestricted is established only by set_permission_mode`
      ),
      finding(
        "native.interaction",
        this.#observed.has("native.interaction") ? "probed" : "documented",
        "A can_use_tool control request is denied at the wire boundary and fails the Turn"
      )
    ];

    return {
      adapterId: this.adapterId,
      ...(this.#lastCommand === undefined ? {} : { executablePath: this.#lastCommand }),
      version: this.#lastInit?.version ?? this.#targetCliVersion,
      protocol: CLAUDE_PROTOCOL,
      protocolVersion: "stream-json",
      launchArgvShape: [this.#lastCommand ?? "<command>", ...this.#lastPrefixArgs, ...CLAUDE_BASE_ARGV],
      findings,
      generatedAt: this.#nowIso()
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
    const runtime = this.#requireRuntime(session);
    if (runtime.poisoned) {
      throw new GroupXError(
        "SESSION_NOT_AVAILABLE",
        "Claude native session requires restart after a transport failure"
      );
    }
    if (runtime.activeTurn !== undefined) {
      throw new GroupXError("SESSION_NOT_AVAILABLE", "Claude native session already has an active turn");
    }
    requireNonEmpty(input.turnId, "turnId");
    requireNonEmpty(input.correlationId, "correlationId");

    const turn: ActiveTurn = {
      turnId: input.turnId,
      correlationId: input.correlationId,
      queue: new AsyncQueue<NativeEvent>(),
      terminalDone: deferred<void>(),
      terminal: false,
      nativeTerminalObserved: false,
      cancelRequested: input.signal?.aborted === true,
      cancelDispatched: false,
      activityObserved: false,
      chunkIndex: 0,
      currentMessageId: undefined,
      streamedTextMessageIds: new Set<string>(),
      seenToolUseIds: new Set<string>(),
      toolNames: new Map<string, string>(),
      firstEventTimer: undefined,
      idleTimer: undefined,
      cancelTimer: undefined,
      abortSignal: input.signal,
      abortListener: undefined
    };
    runtime.activeTurn = turn;
    this.#emit(runtime, turn, "turn.started", {
      turnId: input.turnId,
      correlationId: input.correlationId
    });

    if (turn.cancelRequested) {
      this.#emitTerminal(runtime, turn, "turn.cancelled", {
        stopReason: "cancelled",
        dispatched: false,
        reason: "Prompt was aborted before native dispatch"
      });
    } else {
      if (input.signal !== undefined) {
        turn.abortListener = () => {
          void this.cancel(session, input.turnId).catch(() => undefined);
        };
        input.signal.addEventListener("abort", turn.abortListener, { once: true });
      }
      void this.#dispatchPrompt(runtime, turn, input);
    }

    try {
      for await (const event of turn.queue) {
        yield event;
      }
    } finally {
      if (!turn.terminal) {
        void this.cancel(session, input.turnId).catch(() => undefined);
      }
    }
  }

  async cancel(session: NativeSession, nativeTurnId: string): Promise<CancelResult> {
    const runtime = this.#requireRuntime(session);
    const turn = runtime.activeTurn;
    if (turn === undefined || turn.turnId !== nativeTurnId) {
      return {
        requested: false,
        supported: true,
        terminalObserved: false,
        detail: "No matching active Claude prompt"
      };
    }
    if (turn.cancelRequested) {
      return {
        requested: true,
        supported: true,
        terminalObserved: turn.nativeTerminalObserved,
        detail: "Cancellation was already requested"
      };
    }

    turn.cancelRequested = true;
    await this.#dispatchInterrupt(runtime, turn);
    await Promise.race([turn.terminalDone.promise, delay(this.#timeouts.cancelMs + 25)]);
    return {
      requested: true,
      supported: true,
      terminalObserved: turn.nativeTerminalObserved,
      ...(turn.nativeTerminalObserved
        ? {}
        : { detail: "Claude did not emit a native terminal frame within the cancellation window." })
    };
  }

  async close(session: NativeSession): Promise<void> {
    if (session.adapterId !== this.adapterId || session.actorId !== this.actorId) {
      throw new GroupXError("MCP_BINDING_MISMATCH", "Session does not belong to the Claude adapter");
    }
    const runtime = this.#runtime;
    if (runtime === undefined) {
      // A failed Turn tears the runtime down on its own; closing afterwards is
      // not an error and must not depend on which macrotask won.
      return;
    }
    if (
      runtime.instanceId !== session.instanceId ||
      runtime.bindingId !== session.bindingId ||
      runtime.nativeSessionId !== session.nativeSessionId
    ) {
      throw new GroupXError("SESSION_NOT_AVAILABLE", `No matching active ${this.adapterId} Claude session`);
    }
    if (runtime.teardownPromise === undefined) {
      runtime.teardownPromise = this.#shutdownRuntime(runtime, true);
    }
    await runtime.teardownPromise;
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

  async #launch(input: LaunchProfile, resumeSessionId: string | undefined): Promise<NativeSession> {
    if (this.#runtime !== undefined) {
      throw new GroupXError("SESSION_NOT_AVAILABLE", `${this.adapterId} Claude adapter is already running`);
    }
    validateLaunchProfile(input);

    const instanceId = input.instanceId ?? this.#idFactory("instance");
    const bindingId = input.bindingId ?? this.#idFactory("binding");
    const requestedSessionId = resumeSessionId ?? this.#idFactory("session");
    this.#lastCommand = input.command;
    this.#lastPrefixArgs = [...(input.prefixArgs ?? [])];
    this.#setHealth("starting", instanceId);

    let argv: readonly [string, ...string[]];
    try {
      argv = buildClaudeLaunchArgv(input.command, input.prefixArgs ?? [], {
        ...(resumeSessionId === undefined
          ? { sessionId: requestedSessionId }
          : { resumeSessionId: requestedSessionId }),
        mcp: input.mcp,
        bindingId
      });
    } catch (error) {
      const groupXError =
        error instanceof GroupXError
          ? error
          : new GroupXError("ADAPTER_START_FAILED", `Unable to build the Claude launch argv: ${errorMessage(error)}`);
      this.#setHealth("failed", instanceId, groupXError.message);
      throw groupXError;
    }

    const child = JsonLineProcess.spawn({
      argv,
      cwd: input.cwd,
      closeGraceMs: this.#timeouts.closeMs,
      killGraceMs: Math.min(this.#timeouts.closeMs, KILL_GRACE_CEILING_MS),
      maxStdoutLineBytes: CLAUDE_MAX_STDOUT_LINE_BYTES
    });

    const runtime: ClaudeRuntime = {
      process: child,
      profile: launchProfileFields(input),
      instanceId,
      bindingId,
      nativeSessionId: undefined,
      session: undefined,
      handshake: undefined,
      init: undefined,
      pendingControl: new Map<string, Deferred<ClaudeControlResponse>>(),
      awaitingResult: false,
      strayResultDeadlineMs: undefined,
      activeTurn: undefined,
      controlSeq: 0,
      disposers: [],
      closing: false,
      poisoned: false,
      teardownPromise: undefined
    };
    this.#runtime = runtime;
    this.#attachRuntimeListeners(runtime);

    try {
      // Claude Code emits its `system`/`init` frame only after the first user
      // message, so the SDK control handshake is the only exchange that can
      // prove the process is alive without a model turn. initialize reports
      // current_permission_mode as an observation — some CLIs echo the user's
      // settings default here even when argv requested bypassPermissions.
      // GroupX owns the session id through argv, so no id is negotiated.
      const handshake = parseClaudeHandshake(
        (await this.#control(runtime, buildClaudeInitializeRequest, "initialize")).payload
      );
      this.#observed.add("control.initialize");

      const established = parseClaudeSetPermissionModeResult(
        (await this.#control(runtime, buildClaudeSetPermissionModeRequest, "set_permission_mode")).payload
      );
      if (established !== CLAUDE_UNRESTRICTED_PERMISSION_MODE) {
        throw new GroupXError(
          "NATIVE_POLICY_BLOCKED",
          `Claude Code settled on permission mode ${established} instead of ${CLAUDE_UNRESTRICTED_PERMISSION_MODE}`
        );
      }

      if (runtime.poisoned) {
        throw new GroupXError(
          "UNEXPECTED_NATIVE_INTERACTION",
          "Claude Code requested client interaction while establishing the native session"
        );
      }

      runtime.handshake = handshake;
      runtime.nativeSessionId = requestedSessionId;
      this.#observed.add("access.unrestricted");
      if (resumeSessionId !== undefined) {
        this.#observed.add("session.resume");
      }
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
        nativeSessionId: requestedSessionId,
        protocol: CLAUDE_PROTOCOL,
        startedAt: this.#nowIso()
      };
      runtime.session = session;
      this.#setHealth("ready", instanceId);
      return { ...session };
    } catch (error) {
      runtime.closing = true;
      for (const dispose of runtime.disposers.splice(0)) {
        dispose();
      }
      await child.close().catch(() => undefined);
      if (this.#runtime === runtime) {
        this.#runtime = undefined;
      }

      const groupXError =
        error instanceof GroupXError
          ? error
          : new GroupXError(
              resumeSessionId === undefined ? "ADAPTER_START_FAILED" : "SESSION_NOT_AVAILABLE",
              boundDiagnosticText(
                `Unable to start Claude Code stream-json: ${errorMessage(error)}`,
                1_024
              ),
              undefined,
              error instanceof Error ? { cause: error } : undefined
            );
      this.#setHealth("failed", instanceId, groupXError.message);
      throw groupXError;
    }
  }

  /** Send one SDK control request and await its correlated response. */
  async #control(
    runtime: ClaudeRuntime,
    build: (requestId: string) => Record<string, unknown>,
    subtype: string
  ): Promise<ClaudeControlResponse> {
    runtime.controlSeq += 1;
    const requestId = `groupx-${subtype}-${String(runtime.controlSeq)}`;
    const pending = deferred<ClaudeControlResponse>();
    runtime.pendingControl.set(requestId, pending);
    try {
      await runtime.process.send(build(requestId));
      const response = await withTimeout(
        pending.promise,
        this.#timeouts.handshakeMs,
        () =>
          new GroupXError(
            "PROTOCOL_HANDSHAKE_TIMEOUT",
            `Claude Code did not answer the ${subtype} control request within the handshake window`
          )
      );
      if (!response.ok) {
        throw new GroupXError(
          subtype === "set_permission_mode" ? "NATIVE_POLICY_BLOCKED" : "ADAPTER_START_FAILED",
          boundDiagnosticText(
            `Claude Code refused the ${subtype} control request: ${response.error ?? "unknown error"}`,
            1_024
          )
        );
      }
      return response;
    } finally {
      runtime.pendingControl.delete(requestId);
    }
  }

  /**
   * Verify the deferred `system`/`init` frame against the session GroupX
   * launched. A mismatch means the native process is not the room's session.
   */
  #verifyInitFrame(runtime: ClaudeRuntime, value: unknown): void {
    let init: ClaudeInit;
    try {
      init = parseClaudeInit(value);
    } catch (error) {
      // An init frame GroupX cannot parse is an unverifiable session identity,
      // not something to skip: silently continuing would stream a possibly
      // foreign session's frames as this room's Turn.
      this.#rejectInitFrame(runtime, "PROTOCOL_INVALID_MESSAGE", errorMessage(error));
      return;
    }
    runtime.init = init;
    this.#lastInit = init;
    this.#observed.add("session.init");

    if (init.sessionId !== runtime.nativeSessionId) {
      this.#rejectInitFrame(
        runtime,
        "SESSION_NOT_AVAILABLE",
        "Claude Code reported a different session id than the one GroupX launched"
      );
      return;
    }
    if (!sameNativePath(init.cwd, runtime.profile.cwd)) {
      this.#rejectInitFrame(
        runtime,
        "SESSION_NOT_AVAILABLE",
        "Claude Code reported a cwd that does not match the child process cwd"
      );
      return;
    }
    if (init.permissionMode !== CLAUDE_UNRESTRICTED_PERMISSION_MODE) {
      // The handshake established the unrestricted mode; the session banner is
      // the one place a mid-session downgrade would become visible.
      this.#rejectInitFrame(
        runtime,
        "NATIVE_POLICY_BLOCKED",
        `Claude Code reported permission mode ${init.permissionMode} instead of ${CLAUDE_UNRESTRICTED_PERMISSION_MODE}`
      );
    }
  }

  #rejectInitFrame(runtime: ClaudeRuntime, errorCode: GroupXErrorCode, message: string): void {
    const turn = runtime.activeTurn;
    if (turn !== undefined && !turn.terminal) {
      this.#failTurn(runtime, turn, errorCode, message);
      return;
    }
    runtime.poisoned = true;
    this.#setHealth("failed", runtime.instanceId, message);
    this.#scheduleRuntimeTeardown(runtime);
  }

  #attachRuntimeListeners(runtime: ClaudeRuntime): void {
    runtime.disposers.push(
      runtime.process.onMessage((value) => {
        this.#handleMessage(runtime, value);
      }),
      runtime.process.onProtocolError((error) => {
        this.#failRuntime(runtime, "PROTOCOL_INVALID_MESSAGE", error.message);
      }),
      runtime.process.onExit((exit) => {
        this.#handleExit(runtime, exit);
      })
    );
  }

  #handleExit(runtime: ClaudeRuntime, exit: JsonLineProcessExit): void {
    if (runtime.pendingControl.size > 0) {
      this.#rejectPendingControl(runtime, exitError(exit));
      return;
    }
    if (runtime.closing || exit.expected) {
      return;
    }
    this.#failRuntime(
      runtime,
      "TURN_INTERRUPTED",
      exit.error ?? exit.stderr ?? `Claude Code exited unexpectedly with code ${String(exit.code)}`
    );
  }

  #handleMessage(runtime: ClaudeRuntime, value: unknown): void {
    if (!isRecord(value)) {
      return;
    }

    if (value.type === "system" && value.subtype === "init") {
      this.#verifyInitFrame(runtime, value);
      return;
    }

    if (value.type === "control_request") {
      this.#handleControlRequest(runtime, value);
      return;
    }

    if (value.type === "control_response") {
      const response = parseClaudeControlResponse(value);
      if (response !== undefined) {
        // An unmatched id is an interrupt acknowledgement; the turn terminal
        // still comes from the native result frame.
        runtime.pendingControl.get(response.requestId)?.resolve(response);
      }
      return;
    }

    // Frames carrying a session id must belong to this native session.
    const sessionId = typeof value.session_id === "string" ? value.session_id : undefined;
    if (sessionId !== undefined && runtime.nativeSessionId !== undefined && sessionId !== runtime.nativeSessionId) {
      return;
    }

    // Absorb the interrupt answer owed by an already-settled turn before it can
    // reach the next one. Checked outside the active-turn guard so it is also
    // consumed when it lands between turns.
    if (value.type === "result" && runtime.strayResultDeadlineMs !== undefined) {
      if (this.#now().getTime() <= runtime.strayResultDeadlineMs) {
        runtime.strayResultDeadlineMs = undefined;
        return;
      }
      runtime.strayResultDeadlineMs = undefined;
    }

    const turn = runtime.activeTurn;
    if (turn === undefined || turn.terminal) {
      return;
    }

    switch (value.type) {
      case "stream_event":
        this.#handleStreamEvent(runtime, turn, value);
        return;
      case "assistant":
        this.#handleAssistantMessage(runtime, turn, value);
        return;
      case "user":
        this.#handleToolResults(runtime, turn, value);
        return;
      case "result":
        this.#handleResult(runtime, turn, value);
        return;
      default:
        return;
    }
  }

  #handleStreamEvent(runtime: ClaudeRuntime, turn: ActiveTurn, value: Record<string, unknown>): void {
    this.#observeActivity(runtime, turn);

    const messageStart = readClaudeStreamMessageStart(value);
    if (messageStart !== undefined) {
      // Always reassign, including to undefined: a new message without an id
      // must not inherit the previous message's dedupe key.
      turn.currentMessageId = messageStart.messageId;
      return;
    }

    const projection = normalizeClaudeStreamEvent(value);
    if (projection === undefined) {
      return;
    }

    if (projection.type === "content.delta" && turn.currentMessageId !== undefined) {
      turn.streamedTextMessageIds.add(turn.currentMessageId);
    }
    if (projection.type === "tool.started") {
      const toolUseId = optionalString(projection.payload.toolUseId);
      if (toolUseId !== undefined) {
        if (turn.seenToolUseIds.has(toolUseId)) {
          return;
        }
        turn.seenToolUseIds.add(toolUseId);
        const toolName = optionalString(projection.payload.toolName);
        if (toolName !== undefined) {
          turn.toolNames.set(toolUseId, toolName);
        }
      }
    }

    turn.chunkIndex += 1;
    this.#emit(
      runtime,
      turn,
      projection.type,
      projection.type === "tool.started"
        ? projection.payload
        : { ...projection.payload, chunkIndex: turn.chunkIndex },
      projection.nativeEventId
    );
  }

  #handleAssistantMessage(runtime: ClaudeRuntime, turn: ActiveTurn, value: Record<string, unknown>): void {
    this.#observeActivity(runtime, turn);
    const blocks = readClaudeAssistantBlocks(value);
    if (blocks === undefined) {
      return;
    }

    // Partial-message deltas are authoritative. Emit the complete assistant
    // text only when this message produced no streamed delta.
    const streamed = blocks.messageId !== undefined && turn.streamedTextMessageIds.has(blocks.messageId);
    if (!streamed) {
      for (const text of blocks.text) {
        turn.chunkIndex += 1;
        this.#emit(
          runtime,
          turn,
          "content.delta",
          { text, chunkIndex: turn.chunkIndex, finalMessageFallback: true },
          blocks.messageId
        );
      }
    }

    for (const toolUse of blocks.toolUses) {
      if (turn.seenToolUseIds.has(toolUse.toolUseId)) {
        continue;
      }
      turn.seenToolUseIds.add(toolUse.toolUseId);
      if (toolUse.toolName !== undefined) {
        turn.toolNames.set(toolUse.toolUseId, toolUse.toolName);
      }
      this.#emit(
        runtime,
        turn,
        "tool.started",
        {
          toolUseId: toolUse.toolUseId,
          ...(toolUse.toolName === undefined ? {} : { toolName: toolUse.toolName })
        },
        toolUse.toolUseId
      );
    }
  }

  #handleToolResults(runtime: ClaudeRuntime, turn: ActiveTurn, value: Record<string, unknown>): void {
    const results = readClaudeToolResults(value);
    if (results.length === 0) {
      return;
    }
    this.#observeActivity(runtime, turn);
    for (const result of results) {
      const toolName = turn.toolNames.get(result.toolUseId);
      this.#emit(
        runtime,
        turn,
        "tool.completed",
        {
          toolUseId: result.toolUseId,
          ...(toolName === undefined ? {} : { toolName }),
          status: result.isError ? "failed" : "completed"
        },
        result.toolUseId
      );
    }
  }

  #handleResult(runtime: ClaudeRuntime, turn: ActiveTurn, value: Record<string, unknown>): void {
    if (!runtime.awaitingResult) {
      return;
    }

    runtime.awaitingResult = false;

    let result;
    try {
      result = parseClaudeResult(value);
    } catch (error) {
      this.#failTurn(runtime, turn, "PROTOCOL_INVALID_MESSAGE", errorMessage(error));
      return;
    }

    turn.nativeTerminalObserved = true;
    this.#observed.add("session.prompt");
    if (turn.cancelRequested) {
      this.#observed.add("session.cancel");
    }

    const payload: Record<string, unknown> = {
      subtype: result.subtype,
      ...(result.terminalReason === undefined ? {} : { terminalReason: result.terminalReason }),
      ...(result.stopReason === undefined ? {} : { stopReason: result.stopReason }),
      ...(result.numTurns === undefined ? {} : { numTurns: result.numTurns }),
      ...(result.usage === undefined ? {} : { usage: projectDiagnosticValue(result.usage) })
    };

    if (result.kind === "completed") {
      this.#emitTerminal(runtime, turn, "turn.completed", payload);
      return;
    }
    if (result.kind === "cancelled") {
      this.#emitTerminal(runtime, turn, "turn.cancelled", payload);
      return;
    }

    // A native failure settles the Turn without poisoning the session: Claude
    // Code keeps the stdio process usable for the next Turn.
    this.#emit(runtime, turn, "transport.error", {
      errorCode: "TURN_INTERRUPTED",
      ...(result.apiErrorStatus === undefined ? {} : { apiErrorStatus: result.apiErrorStatus }),
      nativeShape: payload
    });
    this.#emitTerminal(runtime, turn, "turn.failed", {
      ...payload,
      errorCode: "TURN_INTERRUPTED"
    });
  }

  #handleControlRequest(runtime: ClaudeRuntime, value: Record<string, unknown>): void {
    const request = parseClaudeControlRequest(value);
    if (request === undefined) {
      return;
    }

    if (!request.interactive) {
      // GroupX registers no client-side control surface. Answer with a protocol
      // error so the native process cannot stay blocked on a pending request.
      void runtime.process
        .send(buildClaudeControlErrorResponse(request.requestId, `Unsupported control request: ${request.subtype}`))
        .catch(() => undefined);
      return;
    }

    this.#observed.add("native.interaction");
    void runtime.process.send(buildClaudeDenyPermissionResponse(request.requestId)).catch(() => undefined);

    const message = `Claude Code unexpectedly requested an interactive permission decision (${request.subtype}) while GroupX requires unrestricted CLI execution`;
    const turn = runtime.activeTurn;
    if (turn !== undefined && !turn.terminal) {
      this.#failTurn(runtime, turn, "UNEXPECTED_NATIVE_INTERACTION", message);
      return;
    }
    if (!runtime.closing) {
      runtime.poisoned = true;
      this.#setHealth("failed", runtime.instanceId, message);
      this.#scheduleRuntimeTeardown(runtime);
    }
  }

  async #dispatchPrompt(runtime: ClaudeRuntime, turn: ActiveTurn, input: PromptInput): Promise<void> {
    try {
      runtime.awaitingResult = true;
      await runtime.process.send(
        buildClaudeUserMessage({
          content: input.content,
          ...(input.contextPacket === undefined ? {} : { contextPacket: input.contextPacket })
        })
      );
    } catch (error) {
      runtime.awaitingResult = false;
      this.#failTurn(runtime, turn, "TURN_INTERRUPTED", `Claude prompt write failed: ${errorMessage(error)}`);
      return;
    }

    if (turn.terminal) {
      return;
    }
    if (turn.cancelRequested) {
      await this.#dispatchInterrupt(runtime, turn);
      return;
    }
    if (turn.activityObserved) {
      // Frames already arrived while the prompt write was in flight; the idle
      // timer owns this turn and a first-event deadline would misreport it.
      return;
    }
    turn.firstEventTimer = unrefTimer(
      setTimeout(() => {
        this.#failTurn(runtime, turn, "TURN_FIRST_EVENT_TIMEOUT", "Claude emitted no streamed frame in time");
      }, this.#timeouts.firstEventMs)
    );
  }

  async #dispatchInterrupt(runtime: ClaudeRuntime, turn: ActiveTurn): Promise<void> {
    if (turn.cancelDispatched || turn.terminal || runtime.process.state !== "running") {
      return;
    }
    turn.cancelDispatched = true;
    clearTimer(turn.firstEventTimer);
    clearTimer(turn.idleTimer);
    turn.firstEventTimer = undefined;
    turn.idleTimer = undefined;
    turn.cancelTimer = unrefTimer(
      setTimeout(() => {
        this.#failTurn(runtime, turn, "TURN_CANCEL_TIMEOUT", "Claude did not confirm cancellation in time");
      }, this.#timeouts.cancelMs)
    );

    runtime.controlSeq += 1;
    const requestId = `groupx-interrupt-${String(runtime.controlSeq)}`;
    try {
      await runtime.process.send(buildClaudeInterruptRequest(requestId));
    } catch (error) {
      this.#failTurn(runtime, turn, "TURN_CANCEL_TIMEOUT", `Claude interrupt failed: ${errorMessage(error)}`);
    }
  }

  #observeActivity(runtime: ClaudeRuntime, turn: ActiveTurn): void {
    turn.activityObserved = true;
    clearTimer(turn.firstEventTimer);
    turn.firstEventTimer = undefined;
    clearTimer(turn.idleTimer);
    if (turn.terminal || turn.cancelRequested) {
      turn.idleTimer = undefined;
      return;
    }
    turn.idleTimer = unrefTimer(
      setTimeout(() => {
        this.#failTurn(runtime, turn, "TURN_IDLE_TIMEOUT", "Claude turn stream became idle");
      }, this.#timeouts.idleMs)
    );
  }

  #failTurn(runtime: ClaudeRuntime, turn: ActiveTurn, errorCode: GroupXErrorCode, message: string): void {
    if (turn.terminal) {
      return;
    }
    const bounded = boundDiagnosticText(message, 1_024);
    // The native turn never settled on the wire. Poison the session so the
    // Broker restarts instead of reusing a process with an unresolved turn.
    runtime.poisoned = true;
    this.#setHealth("failed", runtime.instanceId, bounded);
    this.#emit(runtime, turn, "transport.error", { errorCode, message: bounded });
    this.#emitTerminal(runtime, turn, "turn.failed", { errorCode, message: bounded });
    this.#scheduleRuntimeTeardown(runtime);
  }

  #failRuntime(runtime: ClaudeRuntime, errorCode: GroupXErrorCode, message: string): void {
    if (runtime.pendingControl.size > 0) {
      this.#rejectPendingControl(runtime, new GroupXError(errorCode, message));
      return;
    }
    const turn = runtime.activeTurn;
    if (turn !== undefined && !turn.terminal) {
      this.#failTurn(runtime, turn, errorCode, message);
      return;
    }
    runtime.poisoned = true;
    this.#setHealth("failed", runtime.instanceId, boundDiagnosticText(message, 1_024));
    this.#scheduleRuntimeTeardown(runtime);
  }

  #rejectPendingControl(runtime: ClaudeRuntime, error: unknown): void {
    for (const pending of [...runtime.pendingControl.values()]) {
      pending.reject(error);
    }
    runtime.pendingControl.clear();
  }

  #scheduleRuntimeTeardown(runtime: ClaudeRuntime): void {
    runtime.poisoned = true;
    if (runtime.teardownPromise !== undefined) {
      return;
    }
    runtime.teardownPromise = new Promise<void>((resolve) => {
      unrefTimer(
        setTimeout(() => {
          void this.#shutdownRuntime(runtime, false).then(resolve, resolve);
        }, 0)
      );
    });
  }

  async #shutdownRuntime(runtime: ClaudeRuntime, graceful: boolean): Promise<void> {
    if (runtime.closing) {
      return;
    }
    runtime.closing = true;

    const turn = runtime.activeTurn;
    if (graceful && turn !== undefined && !turn.terminal) {
      turn.cancelRequested = true;
      await this.#dispatchInterrupt(runtime, turn);
      await Promise.race([turn.terminalDone.promise, delay(this.#timeouts.cancelMs)]);
    }

    try {
      // A termination failure means an orphaned native process still holds the
      // workspace. It must propagate so the Broker records `interrupted`
      // instead of a clean stop.
      await runtime.process.close();
    } finally {
      for (const dispose of runtime.disposers.splice(0)) {
        dispose();
      }
      const pending = runtime.activeTurn;
      if (pending !== undefined && !pending.terminal) {
        this.#emitTerminal(runtime, pending, "turn.failed", {
          errorCode: "TURN_INTERRUPTED",
          message: "Claude Code closed before a native terminal frame."
        });
      }
      if (this.#runtime === runtime) {
        this.#runtime = undefined;
      }
      this.#setHealth(runtime.poisoned ? "failed" : "stopped");
    }
  }

  #emit(
    runtime: ClaudeRuntime,
    turn: ActiveTurn,
    type: NativeEvent["type"],
    payload: unknown,
    nativeEventId?: string
  ): void {
    if (turn.terminal) {
      return;
    }
    turn.queue.push(this.#event(runtime, turn, type, payload, nativeEventId));
  }

  #emitTerminal(
    runtime: ClaudeRuntime,
    turn: ActiveTurn,
    type: "turn.completed" | "turn.cancelled" | "turn.failed",
    payload: unknown
  ): void {
    if (turn.terminal) {
      return;
    }
    clearTurnTimers(turn);
    turn.terminal = true;
    // A turn that settled without its native result must not let a late frame
    // leak into the next one.
    runtime.awaitingResult = false;
    if (turn.cancelDispatched && type !== "turn.cancelled") {
      // The interrupt lost the race; the CLI still owes an answer for it.
      runtime.strayResultDeadlineMs = this.#now().getTime() + this.#timeouts.cancelMs;
    }
    turn.queue.push(this.#event(runtime, turn, type, payload));
    turn.queue.end();
    turn.terminalDone.resolve();
    if (turn.abortSignal !== undefined && turn.abortListener !== undefined) {
      turn.abortSignal.removeEventListener("abort", turn.abortListener);
    }
    if (runtime.activeTurn === turn) {
      runtime.activeTurn = undefined;
    }
  }

  #event(
    runtime: ClaudeRuntime,
    turn: ActiveTurn,
    type: NativeEvent["type"],
    payload: unknown,
    nativeEventId?: string
  ): NativeEvent {
    return {
      adapterId: this.adapterId,
      instanceId: runtime.instanceId,
      ...(runtime.nativeSessionId === undefined ? {} : { nativeSessionId: runtime.nativeSessionId }),
      nativeTurnId: turn.turnId,
      ...(nativeEventId === undefined ? {} : { nativeEventId }),
      type,
      payload,
      occurredAt: this.#nowIso()
    };
  }

  #requireRuntime(session: NativeSession): ClaudeRuntime {
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
      throw new GroupXError("SESSION_NOT_AVAILABLE", `No matching active ${this.adapterId} Claude session`);
    }
    return runtime;
  }

  /**
   * A recorded failure is sticky: the teardown a failure schedules must not
   * erase the diagnostic that explains it. Only a fresh start/ready transition
   * clears it.
   */
  #setHealth(status: AdapterHealth["status"], instanceId?: string, lastError?: string): void {
    const carriedError =
      lastError !== undefined
        ? boundDiagnosticText(lastError, 1_024)
        : status === "starting" || status === "ready"
          ? undefined
          : this.#health.lastError;
    this.#health = {
      status,
      instanceId: instanceId ?? (status === "stopped" ? undefined : this.#health.instanceId),
      nativeSessionAvailable: status === "ready" && this.#runtime?.nativeSessionId !== undefined,
      lastError: carriedError,
      updatedAt: this.#nowIso()
    };
  }

  #nowIso(): string {
    return this.#now().toISOString();
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
      "MCP-enabled Claude sessions require Broker-preassigned instanceId and bindingId provenance"
    );
  }
}

function sameNativePath(reported: string, expected: string): boolean {
  const left = resolvePath(reported);
  const right = resolvePath(expected);
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function validateTimeouts(timeouts: ClaudeAdapterTimeouts): void {
  for (const [name, value] of Object.entries(timeouts)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive finite number`);
    }
  }
}

function finding(capability: string, level: CapabilityFinding["level"], detail: string): CapabilityFinding {
  return { capability, level, detail };
}

function exitError(exit: JsonLineProcessExit): GroupXError {
  const detail = exit.error ?? exit.stderr;
  return new GroupXError(
    "ADAPTER_START_FAILED",
    boundDiagnosticText(
      `Claude Code exited with code ${String(exit.code)} before the init frame${
        detail === undefined || detail.length === 0 ? "" : `: ${detail}`
      }`,
      1_024
    )
  );
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = unrefTimer(
          setTimeout(() => {
            reject(onTimeout());
          }, timeoutMs)
        );
      })
    ]);
  } finally {
    clearTimer(timer);
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function clearTurnTimers(turn: ActiveTurn): void {
  clearTimer(turn.firstEventTimer);
  clearTimer(turn.idleTimer);
  clearTimer(turn.cancelTimer);
  turn.firstEventTimer = undefined;
  turn.idleTimer = undefined;
  turn.cancelTimer = undefined;
}

function clearTimer(timer: NodeJS.Timeout | undefined): void {
  if (timer !== undefined) {
    clearTimeout(timer);
  }
}

function unrefTimer(timer: NodeJS.Timeout): NodeJS.Timeout {
  timer.unref();
  return timer;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requireNonEmpty(value: string, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    unrefTimer(setTimeout(resolve, milliseconds));
  });
}
