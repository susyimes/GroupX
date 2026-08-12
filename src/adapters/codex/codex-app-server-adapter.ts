import { randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";

import {
  JsonLineRpcClient,
  JsonRpcRequestTimeoutError,
  JsonRpcServerError,
  type JsonRpcNotification,
  type JsonRpcServerRequest
} from "../jsonline-rpc.js";
import type {
  AdapterHealth,
  CancelResult,
  CapabilityReport,
  CliAdapter,
  LaunchProfile,
  McpBindingLaunchSpec,
  NativeEvent,
  NativeSession,
  PromptInput
} from "../types.js";
import { GroupXError } from "../../core/errors.js";
import { boundDiagnosticText, projectDiagnosticValue } from "../../observability/diagnostics.js";
import { AsyncQueue } from "../../utils/async-queue.js";

export interface CodexAdapterTimeouts {
  handshakeMs: number;
  requestMs: number;
  firstEventMs: number;
  idleMs: number;
  cancelMs: number;
  closeMs: number;
}

export interface CodexAppServerAdapterOptions {
  timeouts?: Partial<CodexAdapterTimeouts>;
  clientVersion?: string;
  targetCliVersion?: string;
  now?: () => Date;
  createInstanceId?: () => string;
  createBindingId?: () => string;
  /** Room-local agent key; defaults to the builtin `codex`. */
  agentId?: string;
}

export interface CodexMcpServerConfig {
  command?: string;
  args?: string[];
  url?: string;
  http_headers?: Record<string, string>;
}

export interface CodexThreadConfigOverride {
  "mcp_servers.groupx": CodexMcpServerConfig;
}

const DEFAULT_TIMEOUTS: CodexAdapterTimeouts = {
  handshakeMs: 15_000,
  requestMs: 10_000,
  firstEventMs: 90_000,
  idleMs: 120_000,
  cancelMs: 10_000,
  closeMs: 5_000
};

const CODEX_HOOK_TRUST_FLAG = "--dangerously-bypass-hook-trust";
const CODEX_UNRESTRICTED_THREAD_POLICY = {
  approvalPolicy: "never",
  sandbox: "danger-full-access"
} as const;

type NativeInteractionKind =
  | "command_execution"
  | "file_change"
  | "permissions"
  | "user_input"
  | "mcp_elicitation";

const NATIVE_INTERACTION_METHODS = new Map<string, NativeInteractionKind>([
  ["item/commandExecution/requestApproval", "command_execution"],
  ["item/fileChange/requestApproval", "file_change"],
  ["item/permissions/requestApproval", "permissions"],
  ["item/tool/requestUserInput", "user_input"],
  ["tool/requestUserInput", "user_input"],
  ["mcpServer/elicitation/request", "mcp_elicitation"]
]);

const TOOL_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
  "collabToolCall",
  "webSearch",
  "imageGeneration",
  "subAgentActivity"
]);

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface TurnContext {
  groupxTurnId: string;
  correlationId: string;
  queue: AsyncQueue<NativeEvent>;
  terminalDone: Deferred<void>;
  nativeTurnId: string | undefined;
  startedEmitted: boolean;
  notificationObserved: boolean;
  terminal: boolean;
  nativeTerminalObserved: boolean;
  cancelRequested: boolean;
  chunkIndex: number;
  seenAgentMessageItems: Set<string>;
  firstEventTimer: NodeJS.Timeout | undefined;
  idleTimer: NodeJS.Timeout | undefined;
  cancelTimer: NodeJS.Timeout | undefined;
  abortSignal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
  interruptPromise: Promise<void> | undefined;
}

interface CodexRuntime {
  profile: LaunchProfile;
  rpc: JsonLineRpcClient;
  session: NativeSession;
  retiredTurnIds: Set<string>;
  disposers: Array<() => void>;
  active: TurnContext | undefined;
  closing: boolean;
  poisoned: boolean;
  teardownPromise: Promise<void> | undefined;
}

/**
 * Stable process argv for Codex 0.147 App Server. The configured cwd belongs to
 * the OS child process and is deliberately not repeated as a thread override.
 */
export function buildCodexLaunchArgv(
  command: string,
  prefixArgs: readonly string[] = []
): readonly [string, ...string[]] {
  requireNonEmpty(command, "command");
  const prefix = prefixArgs.map((argument, index) => requireNonEmpty(argument, `prefixArgs[${index}]`));
  return [command, ...prefix, CODEX_HOOK_TRUST_FLAG, "app-server", "--listen", "stdio://"];
}

/**
 * Build the one GroupX-owned Codex config fragment. A binding id is a source
 * correlation handle, not an authentication token or permission grant.
 */
export function buildCodexMcpOverride(
  mcp: McpBindingLaunchSpec | undefined,
  bindingId: string
): CodexThreadConfigOverride | undefined {
  if (mcp === undefined) {
    return undefined;
  }
  requireNonEmpty(bindingId, "bindingId");

  const groupx: CodexMcpServerConfig =
    mcp.transport === "stdio"
      ? {
          command: requireNonEmpty(mcp.command, "mcp.command"),
          args: [...mcp.args, "--binding-id", bindingId]
        }
      : {
          url: requireNonEmpty(mcp.url, "mcp.url"),
          http_headers: { "X-GroupX-Binding": bindingId }
        };

  return { "mcp_servers.groupx": groupx };
}

export function buildCodexThreadStartParams(profile: LaunchProfile, bindingId: string): Record<string, unknown> {
  const config = buildCodexMcpOverride(profile.mcp, bindingId);
  return {
    ...CODEX_UNRESTRICTED_THREAD_POLICY,
    ...(config === undefined ? {} : { config })
  };
}

export function buildCodexThreadResumeParams(
  profile: LaunchProfile,
  bindingId: string,
  nativeSessionId: string
): Record<string, unknown> {
  requireNonEmpty(nativeSessionId, "nativeSessionId");
  return { threadId: nativeSessionId, ...buildCodexThreadStartParams(profile, bindingId) };
}

export function buildCodexPromptText(input: Pick<PromptInput, "content" | "contextPacket">): string {
  if (input.contextPacket === undefined || input.contextPacket.length === 0) {
    return input.content;
  }
  return `${input.contextPacket}\n\n[groupx_current_message]\n${input.content}`;
}

export class CodexAppServerAdapter implements CliAdapter {
  readonly adapterId: string;
  readonly actorId: string;

  readonly #timeouts: CodexAdapterTimeouts;
  readonly #clientVersion: string;
  readonly #targetCliVersion: string;
  readonly #now: () => Date;
  readonly #createInstanceId: () => string;
  readonly #createBindingId: () => string;
  readonly #runtimes = new Map<string, CodexRuntime>();

  #starting = false;
  #lastInstanceId: string | undefined;
  #lastError: string | undefined;
  #updatedAt: string;

  constructor(options: CodexAppServerAdapterOptions = {}) {
    const agentId = options.agentId ?? "codex";
    this.adapterId = agentId;
    this.actorId = `agent:${agentId}`;
    this.#timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    validateTimeouts(this.#timeouts);
    this.#clientVersion = options.clientVersion ?? "0.1.0";
    this.#targetCliVersion = options.targetCliVersion ?? "0.147.0";
    this.#now = options.now ?? (() => new Date());
    this.#createInstanceId = options.createInstanceId ?? (() => `${agentId}/main@${randomUUID()}`);
    this.#createBindingId = options.createBindingId ?? (() => `binding:${agentId}:${randomUUID()}`);
    this.#updatedAt = this.#nowIso();
  }

  async probe(): Promise<CapabilityReport> {
    return {
      adapterId: this.adapterId,
      version: this.#targetCliVersion,
      protocol: "codex-app-server-stdio-jsonrpc",
      protocolVersion: "v2",
      launchArgvShape: [
        "<command>",
        "<prefixArgs...>",
        CODEX_HOOK_TRUST_FLAG,
        "app-server",
        "--listen",
        "stdio://"
      ],
      findings: [
        {
          capability: "initialize/initialized",
          level: "documented",
          detail: "One initialize request followed by initialized per stdio connection."
        },
        {
          capability: "thread/start and thread/resume",
          level: "documented",
          detail: "The adapter uses persistent native thread identifiers."
        },
        {
          capability: "turn/start stream and turn/interrupt",
          level: "documented",
          detail: "Turn notifications are normalized and interrupt remains a native Codex decision path."
        },
        {
          capability: "fixed unrestricted access",
          level: "documented",
          detail:
            "The process bypasses hook trust, checks native managed requirements, and requests never/danger-full-access per thread."
        },
        {
          capability: "unexpected native interactions",
          level: "documented",
          detail:
            "Approval, permission, elicitation, and user-input requests are cancelled or rejected and fail the Turn."
        },
        {
          capability: "live compatibility",
          level: "not_observed",
          detail: "probe() reports the adapter contract; live M0 evidence must establish verified status."
        }
      ],
      generatedAt: this.#nowIso()
    };
  }

  async start(input: LaunchProfile): Promise<NativeSession> {
    return await this.#open(input, "thread/start", buildCodexThreadStartParams);
  }

  async resume(input: LaunchProfile & { nativeSessionId: string }): Promise<NativeSession> {
    return await this.#open(input, "thread/resume", (profile, bindingId) =>
      buildCodexThreadResumeParams(profile, bindingId, input.nativeSessionId)
    );
  }

  async *prompt(session: NativeSession, input: PromptInput): AsyncIterable<NativeEvent> {
    const runtime = this.#requireRuntime(session);
    if (runtime.poisoned) {
      throw new GroupXError("SESSION_NOT_AVAILABLE", "Codex native session requires restart after a transport failure");
    }
    if (runtime.active !== undefined) {
      throw new GroupXError("SESSION_NOT_AVAILABLE", "Codex native session already has an active turn");
    }
    requireNonEmpty(input.turnId, "turnId");
    requireNonEmpty(input.correlationId, "correlationId");

    const context: TurnContext = {
      groupxTurnId: input.turnId,
      correlationId: input.correlationId,
      queue: new AsyncQueue<NativeEvent>(),
      terminalDone: deferred<void>(),
      nativeTurnId: undefined,
      startedEmitted: false,
      notificationObserved: false,
      terminal: false,
      nativeTerminalObserved: false,
      cancelRequested: input.signal?.aborted === true,
      chunkIndex: 0,
      seenAgentMessageItems: new Set<string>(),
      firstEventTimer: undefined,
      idleTimer: undefined,
      cancelTimer: undefined,
      abortSignal: input.signal,
      abortListener: undefined,
      interruptPromise: undefined
    };
    runtime.active = context;

    if (input.signal !== undefined) {
      context.abortListener = () => {
        context.cancelRequested = true;
        if (context.nativeTurnId !== undefined) {
          void this.#interrupt(runtime, context);
        }
      };
      input.signal.addEventListener("abort", context.abortListener, { once: true });
    }

    if (context.cancelRequested) {
      this.#emitTerminal(runtime, context, "turn.cancelled", {
        status: "cancelled",
        reason: "Prompt was aborted before native dispatch"
      });
    } else {
      void this.#startTurn(runtime, context, input);
    }

    try {
      for await (const event of context.queue) {
        yield event;
      }
    } finally {
      if (!context.terminal) {
        context.cancelRequested = true;
        if (context.nativeTurnId !== undefined) {
          void this.#interrupt(runtime, context);
        }
      }
    }
  }

  async cancel(session: NativeSession, nativeTurnId: string): Promise<CancelResult> {
    const runtime = this.#requireRuntime(session);
    requireNonEmpty(nativeTurnId, "nativeTurnId");
    const context = runtime.active;

    if (context === undefined || context.nativeTurnId !== nativeTurnId || context.terminal) {
      try {
        await runtime.rpc.request(
          "turn/interrupt",
          { threadId: session.nativeSessionId, turnId: nativeTurnId },
          { timeoutMs: this.#timeouts.cancelMs }
        );
        return {
          requested: true,
          supported: true,
          terminalObserved: false,
          detail: "Interrupt accepted; this adapter was not streaming the requested turn."
        };
      } catch (error) {
        return {
          requested: true,
          supported: true,
          terminalObserved: false,
          detail: errorMessage(error)
        };
      }
    }

    context.cancelRequested = true;
    void this.#interrupt(runtime, context);
    await Promise.race([context.terminalDone.promise, delay(this.#timeouts.cancelMs + 25)]);
    return {
      requested: true,
      supported: true,
      terminalObserved: context.nativeTerminalObserved,
      ...(context.nativeTerminalObserved
        ? {}
        : { detail: "Codex did not emit a native terminal event within the cancellation window." })
    };
  }

  async close(session: NativeSession): Promise<void> {
    if (session.adapterId !== this.adapterId || session.actorId !== this.actorId) {
      throw new GroupXError("MCP_BINDING_MISMATCH", "Session does not belong to the Codex adapter");
    }
    const runtime = this.#runtimes.get(session.bindingId);
    if (runtime === undefined) {
      return;
    }
    if (
      runtime.session.instanceId !== session.instanceId ||
      runtime.session.nativeSessionId !== session.nativeSessionId
    ) {
      throw new GroupXError("SESSION_NOT_AVAILABLE", "Codex session is not active");
    }
    if (runtime.teardownPromise === undefined) {
      runtime.teardownPromise = this.#shutdownRuntime(runtime, true);
    }
    await runtime.teardownPromise;
  }

  health(): AdapterHealth {
    const ready = this.#runtimes.size > 0;
    const status = this.#lastError !== undefined ? "failed" : this.#starting ? "starting" : ready ? "ready" : "stopped";
    return {
      adapterId: this.adapterId,
      status,
      ...(this.#lastInstanceId === undefined ? {} : { instanceId: this.#lastInstanceId }),
      nativeSessionAvailable: ready,
      ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
      updatedAt: this.#updatedAt
    };
  }

  async #open(
    input: LaunchProfile,
    method: "thread/start" | "thread/resume",
    buildParams: (profile: LaunchProfile, bindingId: string) => Record<string, unknown>
  ): Promise<NativeSession> {
    requireNonEmpty(input.command, "command");
    requireNonEmpty(input.cwd, "cwd");
    const bindingId = input.bindingId === undefined ? this.#createBindingId() : requireNonEmpty(input.bindingId, "bindingId");
    if (this.#runtimes.has(bindingId)) {
      throw new GroupXError("MCP_BINDING_MISMATCH", `Codex binding is already active: ${bindingId}`);
    }

    this.#starting = true;
    this.#lastError = undefined;
    this.#touch();
    const instanceId =
      input.instanceId === undefined ? this.#createInstanceId() : requireNonEmpty(input.instanceId, "instanceId");
    this.#lastInstanceId = instanceId;

    let runtime: CodexRuntime | undefined;
    const rpc = JsonLineRpcClient.spawn(
      {
        argv: buildCodexLaunchArgv(input.command, input.prefixArgs),
        cwd: input.cwd,
        closeGraceMs: this.#timeouts.closeMs,
        killGraceMs: Math.min(this.#timeouts.closeMs, 2_000)
      },
      {
        dialect: "codex",
        defaultRequestTimeoutMs: this.#timeouts.requestMs,
        idPrefix: "groupx-",
        serverRequestHandler: async (request) => {
          if (runtime === undefined) {
            throw new JsonRpcServerError(-32002, "Codex session is not ready");
          }
          return await this.#handleServerRequest(runtime, request);
        }
      }
    );

    const provisionalSession: NativeSession = {
      adapterId: this.adapterId,
      instanceId,
      bindingId,
      actorId: this.actorId,
      protocol: "codex-app-server-stdio-jsonrpc-v2",
      startedAt: this.#nowIso()
    };
    runtime = {
      profile: input,
      rpc,
      session: provisionalSession,
      retiredTurnIds: new Set<string>(),
      disposers: [],
      active: undefined,
      closing: false,
      poisoned: false,
      teardownPromise: undefined
    };
    this.#attachRuntimeListeners(runtime);

    try {
      const initializeResult = await rpc.request<unknown>(
        "initialize",
        {
          clientInfo: {
            name: "groupx",
            title: "GroupX",
            version: this.#clientVersion
          }
        },
        { timeoutMs: this.#timeouts.handshakeMs }
      );
      if (!isRecord(initializeResult)) {
        throw new GroupXError("PROTOCOL_INVALID_MESSAGE", "Codex initialize response must be an object");
      }
      await rpc.notify("initialized", {});

      const requirements = await rpc.request<unknown>("configRequirements/read", {}, {
        timeoutMs: this.#timeouts.handshakeMs
      });
      assertCodexUnrestrictedRequirements(requirements);

      const result = await rpc.request<unknown>(method, buildParams(input, bindingId), {
        timeoutMs: this.#timeouts.handshakeMs
      });
      const nativeSessionId = readThreadId(result, input.cwd);
      if (runtime.poisoned) {
        throw new GroupXError(
          "UNEXPECTED_NATIVE_INTERACTION",
          "Codex requested client interaction while establishing the native session"
        );
      }
      const session: NativeSession = { ...provisionalSession, nativeSessionId };
      runtime.session = session;
      this.#runtimes.set(bindingId, runtime);
      this.#starting = false;
      this.#lastError = undefined;
      this.#touch();
      return session;
    } catch (error) {
      this.#starting = false;
      this.#lastError = boundDiagnosticText(errorMessage(error), 1_024);
      this.#touch();
      for (const dispose of runtime.disposers.splice(0)) {
        dispose();
      }
      await rpc.close().catch(() => undefined);
      if (error instanceof GroupXError) {
        throw error;
      }
      const code = error instanceof JsonRpcRequestTimeoutError ? "PROTOCOL_HANDSHAKE_TIMEOUT" : "ADAPTER_START_FAILED";
      throw new GroupXError(code, `Unable to ${method} Codex App Server: ${errorMessage(error)}`, undefined, {
        cause: error instanceof Error ? error : undefined
      });
    }
  }

  #attachRuntimeListeners(runtime: CodexRuntime): void {
    runtime.disposers.push(
      runtime.rpc.onNotification((notification) => this.#handleNotification(runtime, notification)),
      runtime.rpc.onProtocolError((error) => {
        this.#failRuntime(runtime, "PROTOCOL_INVALID_MESSAGE", error.message);
      }),
      runtime.rpc.onExit((exit) => {
        if (!runtime.closing && !exit.expected) {
          this.#failRuntime(runtime, "TURN_INTERRUPTED", "Codex App Server exited unexpectedly");
        }
      })
    );
  }

  async #startTurn(runtime: CodexRuntime, context: TurnContext, input: PromptInput): Promise<void> {
    try {
      const result = await runtime.rpc.request<unknown>(
        "turn/start",
        {
          threadId: runtime.session.nativeSessionId,
          input: [{ type: "text", text: buildCodexPromptText(input) }]
        },
        { timeoutMs: this.#timeouts.requestMs }
      );
      if (context.terminal) {
        return;
      }
      const turn = readTurn(result);
      context.nativeTurnId ??= turn.id;
      this.#emitStarted(runtime, context);

      if (turn.status === "completed" || turn.status === "interrupted" || turn.status === "failed") {
        this.#finishFromNativeStatus(runtime, context, turn.status, turn.error);
        return;
      }

      if (context.cancelRequested) {
        void this.#interrupt(runtime, context);
        return;
      }

      if (context.notificationObserved) {
        this.#resetIdleTimer(runtime, context);
      } else {
        context.firstEventTimer = setTimeout(() => {
          this.#failTurn(runtime, context, "TURN_FIRST_EVENT_TIMEOUT", "Codex emitted no streamed event in time");
        }, this.#timeouts.firstEventMs);
        context.firstEventTimer.unref();
      }

    } catch (error) {
      this.#failTurn(
        runtime,
        context,
        error instanceof JsonRpcRequestTimeoutError ? "TURN_FIRST_EVENT_TIMEOUT" : "TURN_INTERRUPTED",
        `Codex turn/start failed: ${errorMessage(error)}`
      );
    }
  }

  #handleNotification(runtime: CodexRuntime, notification: JsonRpcNotification): void {
    const context = runtime.active;
    if (context === undefined || context.terminal) {
      return;
    }
    const params = isRecord(notification.params) ? notification.params : {};
    const threadId = optionalString(params.threadId);
    if (threadId !== undefined && threadId !== runtime.session.nativeSessionId) {
      return;
    }
    const turnId = optionalString(params.turnId) ?? readNestedTurnId(params.turn);
    if (turnId !== undefined) {
      if (runtime.retiredTurnIds.has(turnId)) {
        return;
      }
      if (context.nativeTurnId !== undefined && context.nativeTurnId !== turnId) {
        return;
      }
      context.nativeTurnId ??= turnId;
    }

    switch (notification.method) {
      case "turn/started": {
        this.#observeActivity(runtime, context);
        this.#emitStarted(runtime, context);
        if (context.cancelRequested) {
          void this.#interrupt(runtime, context);
        }
        return;
      }
      case "item/agentMessage/delta": {
        const delta = optionalString(params.delta);
        if (delta === undefined) {
          return;
        }
        this.#observeActivity(runtime, context);
        const itemId = optionalString(params.itemId);
        if (itemId !== undefined) {
          context.seenAgentMessageItems.add(itemId);
        }
        context.chunkIndex += 1;
        this.#emit(runtime, context, "content.delta", {
          text: delta,
          chunkIndex: context.chunkIndex
        }, itemId);
        return;
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const delta = optionalString(params.delta);
        if (delta === undefined) {
          return;
        }
        this.#observeActivity(runtime, context);
        context.chunkIndex += 1;
        this.#emit(runtime, context, "reasoning.delta", {
          text: delta,
          chunkIndex: context.chunkIndex
        }, optionalString(params.itemId));
        return;
      }
      case "item/started": {
        this.#observeActivity(runtime, context);
        this.#emitToolItem(runtime, context, params, false);
        return;
      }
      case "item/completed": {
        this.#observeActivity(runtime, context);
        this.#emitAgentMessageFallback(runtime, context, params);
        this.#emitToolItem(runtime, context, params, true);
        return;
      }
      case "turn/completed": {
        this.#observeActivity(runtime, context);
        const turn = isRecord(params.turn) ? params.turn : {};
        const status = optionalString(turn.status);
        context.nativeTerminalObserved = true;
        this.#finishFromNativeStatus(runtime, context, status, turn.error);
        return;
      }
      case "error": {
        this.#observeActivity(runtime, context);
        this.#emit(runtime, context, "transport.error", {
          errorCode: "TURN_INTERRUPTED",
          nativeShape: projectDiagnosticValue(params)
        });
        return;
      }
      default:
        return;
    }
  }

  async #handleServerRequest(runtime: CodexRuntime, request: JsonRpcServerRequest): Promise<unknown> {
    const interactionKind = NATIVE_INTERACTION_METHODS.get(request.method);
    const params = isRecord(request.params) ? request.params : {};
    const turnId = optionalString(params.turnId);
    const threadId = optionalString(params.threadId);
    const context = runtime.active;
    const belongsToRuntime = threadId === undefined || threadId === runtime.session.nativeSessionId;
    const belongsToActiveTurn =
      context !== undefined &&
      !context.terminal &&
      belongsToRuntime &&
      (turnId === undefined ||
        (!runtime.retiredTurnIds.has(turnId) &&
          (context.nativeTurnId === undefined || context.nativeTurnId === turnId)));

    if (belongsToActiveTurn) {
      context.nativeTurnId ??= turnId;
      this.#observeActivity(runtime, context);
      this.#failTurn(
        runtime,
        context,
        "UNEXPECTED_NATIVE_INTERACTION",
        `Codex App Server unexpectedly requested client interaction: ${request.method}`
      );
    } else if (context === undefined && !runtime.closing) {
      runtime.poisoned = true;
      this.#lastError = boundDiagnosticText(
        `Codex App Server requested client interaction without an active Turn: ${request.method}`,
        1_024
      );
      this.#touch();
      this.#scheduleRuntimeTeardown(runtime);
    }

    if (interactionKind === undefined) {
      throw new JsonRpcServerError(-32601, `Unsupported Codex server request: ${request.method}`);
    }
    return nativeCancellationResponse(interactionKind);
  }

  #emitToolItem(runtime: CodexRuntime, context: TurnContext, params: Record<string, unknown>, completed: boolean): void {
    const item = isRecord(params.item) ? params.item : undefined;
    const itemType = item === undefined ? undefined : optionalString(item.type);
    if (item === undefined || itemType === undefined || !TOOL_ITEM_TYPES.has(itemType)) {
      return;
    }
    this.#emit(runtime, context, completed ? "tool.completed" : "tool.started", {
      itemId: optionalString(item.id),
      itemType,
      status: optionalString(item.status)
    }, optionalString(item.id));
  }

  #emitAgentMessageFallback(runtime: CodexRuntime, context: TurnContext, params: Record<string, unknown>): void {
    const item = isRecord(params.item) ? params.item : undefined;
    if (item === undefined || item.type !== "agentMessage") {
      return;
    }
    const itemId = optionalString(item.id);
    if (itemId !== undefined && context.seenAgentMessageItems.has(itemId)) {
      return;
    }
    const text = optionalString(item.text);
    if (text === undefined || text.length === 0) {
      return;
    }
    context.chunkIndex += 1;
    this.#emit(runtime, context, "content.delta", { text, chunkIndex: context.chunkIndex, finalItemFallback: true }, itemId);
  }

  #observeActivity(runtime: CodexRuntime, context: TurnContext): void {
    context.notificationObserved = true;
    clearTimer(context.firstEventTimer);
    context.firstEventTimer = undefined;
    this.#resetIdleTimer(runtime, context);
  }

  #resetIdleTimer(runtime: CodexRuntime, context: TurnContext): void {
    clearTimer(context.idleTimer);
    if (context.terminal || context.cancelRequested) {
      return;
    }
    context.idleTimer = setTimeout(() => {
      this.#failTurn(runtime, context, "TURN_IDLE_TIMEOUT", "Codex turn stream became idle");
    }, this.#timeouts.idleMs);
    context.idleTimer.unref();
  }

  async #interrupt(runtime: CodexRuntime, context: TurnContext): Promise<void> {
    if (context.terminal || context.nativeTurnId === undefined) {
      return;
    }
    if (context.interruptPromise !== undefined) {
      return await context.interruptPromise;
    }

    clearTimer(context.firstEventTimer);
    clearTimer(context.idleTimer);
    context.firstEventTimer = undefined;
    context.idleTimer = undefined;
    context.cancelTimer = setTimeout(() => {
      this.#failTurn(runtime, context, "TURN_CANCEL_TIMEOUT", "Codex did not confirm cancellation in time");
    }, this.#timeouts.cancelMs);
    context.cancelTimer.unref();

    context.interruptPromise = runtime.rpc
      .request(
        "turn/interrupt",
        { threadId: runtime.session.nativeSessionId, turnId: context.nativeTurnId },
        { timeoutMs: this.#timeouts.cancelMs }
      )
      .then(() => undefined)
      .catch((error: unknown) => {
        this.#failTurn(runtime, context, "TURN_CANCEL_TIMEOUT", `Codex interrupt failed: ${errorMessage(error)}`);
      });
    return await context.interruptPromise;
  }

  #finishFromNativeStatus(runtime: CodexRuntime, context: TurnContext, status: unknown, error: unknown): void {
    if (status === "completed") {
      this.#emitTerminal(runtime, context, "turn.completed", { status: "completed" });
      return;
    }
    if (status === "interrupted") {
      this.#emitTerminal(runtime, context, "turn.cancelled", { status: "interrupted" });
      return;
    }
    this.#emitTerminal(runtime, context, "turn.failed", {
      status: "failed",
      errorCode: "TURN_INTERRUPTED",
      nativeErrorShape: projectDiagnosticValue(error)
    });
  }

  #emitStarted(runtime: CodexRuntime, context: TurnContext): void {
    if (context.startedEmitted || context.terminal) {
      return;
    }
    context.startedEmitted = true;
    this.#emit(runtime, context, "turn.started", { status: "inProgress" });
  }

  #failTurn(runtime: CodexRuntime, context: TurnContext, errorCode: string, message: string): void {
    if (context.terminal) {
      return;
    }
    runtime.poisoned = true;
    this.#lastError = boundDiagnosticText(message, 1_024);
    this.#touch();
    if (context.nativeTurnId !== undefined && !context.cancelRequested) {
      context.cancelRequested = true;
      void runtime.rpc
        .request(
          "turn/interrupt",
          { threadId: runtime.session.nativeSessionId, turnId: context.nativeTurnId },
          { timeoutMs: this.#timeouts.cancelMs }
        )
        .catch(() => undefined);
    }
    this.#emit(runtime, context, "transport.error", {
      errorCode,
      message: boundDiagnosticText(message, 1_024)
    });
    this.#emitTerminal(runtime, context, "turn.failed", {
      status: "failed",
      errorCode,
      message: boundDiagnosticText(message, 1_024)
    });
    this.#scheduleRuntimeTeardown(runtime);
  }

  #failRuntime(runtime: CodexRuntime, errorCode: string, message: string): void {
    runtime.poisoned = true;
    this.#lastError = boundDiagnosticText(message, 1_024);
    this.#touch();
    const context = runtime.active;
    if (context !== undefined && !context.terminal) {
      this.#failTurn(runtime, context, errorCode, message);
    } else {
      this.#scheduleRuntimeTeardown(runtime);
    }
  }

  #scheduleRuntimeTeardown(runtime: CodexRuntime): void {
    runtime.poisoned = true;
    if (runtime.teardownPromise !== undefined) {
      return;
    }
    runtime.teardownPromise = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        void this.#shutdownRuntime(runtime, false).then(resolve, resolve);
      }, 0);
      timer.unref();
    });
  }

  async #shutdownRuntime(runtime: CodexRuntime, graceful: boolean): Promise<void> {
    if (runtime.closing) {
      return;
    }
    runtime.closing = true;

    const active = runtime.active;
    if (graceful && active !== undefined && !active.terminal && active.nativeTurnId !== undefined) {
      active.cancelRequested = true;
      void this.#interrupt(runtime, active);
      await Promise.race([active.terminalDone.promise, delay(this.#timeouts.cancelMs)]);
    }

    try {
      await runtime.rpc.close();
    } finally {
      for (const dispose of runtime.disposers.splice(0)) {
        dispose();
      }
      if (this.#runtimes.get(runtime.session.bindingId) === runtime) {
        this.#runtimes.delete(runtime.session.bindingId);
      }
      if (active !== undefined && !active.terminal) {
        this.#emitTerminal(runtime, active, "turn.failed", {
          status: "failed",
          errorCode: "TURN_INTERRUPTED",
          message: "Codex App Server closed before a native terminal event."
        });
      }
      this.#touch();
    }
  }

  #emit(
    runtime: CodexRuntime,
    context: TurnContext,
    type: NativeEvent["type"],
    payload: unknown,
    nativeEventId?: string
  ): void {
    if (context.terminal) {
      return;
    }
    context.queue.push({
      adapterId: this.adapterId,
      instanceId: runtime.session.instanceId,
      ...(runtime.session.nativeSessionId === undefined ? {} : { nativeSessionId: runtime.session.nativeSessionId }),
      ...(context.nativeTurnId === undefined ? {} : { nativeTurnId: context.nativeTurnId }),
      ...(nativeEventId === undefined ? {} : { nativeEventId }),
      type,
      payload,
      occurredAt: this.#nowIso()
    });
  }

  #emitTerminal(
    runtime: CodexRuntime,
    context: TurnContext,
    type: "turn.completed" | "turn.cancelled" | "turn.failed",
    payload: unknown
  ): void {
    if (context.terminal) {
      return;
    }
    clearTurnTimers(context);
    context.terminal = true;
    if (context.nativeTurnId !== undefined) {
      runtime.retiredTurnIds.add(context.nativeTurnId);
      if (runtime.retiredTurnIds.size > 256) {
        const oldest = runtime.retiredTurnIds.values().next().value as string | undefined;
        if (oldest !== undefined) {
          runtime.retiredTurnIds.delete(oldest);
        }
      }
    }
    this.#emitAfterTerminalFlag(runtime, context, type, payload);
    context.queue.end();
    context.terminalDone.resolve();
    if (context.abortSignal !== undefined && context.abortListener !== undefined) {
      context.abortSignal.removeEventListener("abort", context.abortListener);
    }
    if (runtime.active === context) {
      runtime.active = undefined;
    }
  }

  #emitAfterTerminalFlag(
    runtime: CodexRuntime,
    context: TurnContext,
    type: "turn.completed" | "turn.cancelled" | "turn.failed",
    payload: unknown
  ): void {
    context.queue.push({
      adapterId: this.adapterId,
      instanceId: runtime.session.instanceId,
      ...(runtime.session.nativeSessionId === undefined ? {} : { nativeSessionId: runtime.session.nativeSessionId }),
      ...(context.nativeTurnId === undefined ? {} : { nativeTurnId: context.nativeTurnId }),
      type,
      payload,
      occurredAt: this.#nowIso()
    });
  }

  #requireRuntime(session: NativeSession): CodexRuntime {
    if (session.adapterId !== this.adapterId || session.actorId !== this.actorId) {
      throw new GroupXError("MCP_BINDING_MISMATCH", "Session does not belong to the Codex adapter");
    }
    const runtime = this.#runtimes.get(session.bindingId);
    if (
      runtime === undefined ||
      runtime.session.instanceId !== session.instanceId ||
      runtime.session.nativeSessionId !== session.nativeSessionId
    ) {
      throw new GroupXError("SESSION_NOT_AVAILABLE", "Codex session is not active");
    }
    return runtime;
  }

  #nowIso(): string {
    return this.#now().toISOString();
  }

  #touch(): void {
    this.#updatedAt = this.#nowIso();
  }
}

function nativeCancellationResponse(interactionKind: NativeInteractionKind): Record<string, unknown> {
  switch (interactionKind) {
    case "command_execution":
    case "file_change":
      return { decision: "cancel" };
    case "permissions":
      return { permissions: {} };
    case "user_input":
      return { answers: {} };
    case "mcp_elicitation":
      return { action: "cancel", content: null };
  }
}

function assertCodexUnrestrictedRequirements(value: unknown): void {
  if (!isRecord(value) || !(value.requirements === null || isRecord(value.requirements))) {
    throw new GroupXError(
      "PROTOCOL_INVALID_MESSAGE",
      "Codex configRequirements/read response has an invalid requirements shape"
    );
  }
  if (value.requirements === null) {
    return;
  }

  const approvalAllowsNever = optionalApprovalAllowsNever(value.requirements.allowedApprovalPolicies);
  const sandboxModes = optionalStringArray(value.requirements.allowedSandboxModes);
  if (approvalAllowsNever === false) {
    throw new GroupXError(
      "NATIVE_POLICY_BLOCKED",
      "A native Codex policy does not allow the required never approval policy"
    );
  }
  if (sandboxModes !== undefined && !sandboxModes.includes("danger-full-access")) {
    throw new GroupXError(
      "NATIVE_POLICY_BLOCKED",
      "A native Codex policy does not allow the required danger-full-access sandbox mode"
    );
  }
}

function readThreadId(value: unknown, expectedCwd: string): string {
  if (!isRecord(value) || !isRecord(value.thread)) {
    throw new GroupXError("PROTOCOL_INVALID_MESSAGE", "Codex thread response is missing thread");
  }
  const id = optionalString(value.thread.id);
  if (id === undefined) {
    throw new GroupXError("PROTOCOL_INVALID_MESSAGE", "Codex thread response is missing thread.id");
  }
  const cwd = optionalString(value.thread.cwd);
  if (cwd === undefined) {
    throw new GroupXError("PROTOCOL_INVALID_MESSAGE", "Codex thread response is missing thread.cwd");
  }
  if (!sameNativePath(cwd, expectedCwd)) {
    throw new GroupXError("ADAPTER_START_FAILED", "Codex thread cwd does not match the child process cwd");
  }
  return id;
}

function sameNativePath(left: string, right: string): boolean {
  const normalizedLeft = resolvePath(left);
  const normalizedRight = resolvePath(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function readTurn(value: unknown): { id: string; status: string | undefined; error: unknown } {
  if (!isRecord(value) || !isRecord(value.turn)) {
    throw new GroupXError("PROTOCOL_INVALID_MESSAGE", "Codex turn/start response is missing turn");
  }
  const id = optionalString(value.turn.id);
  if (id === undefined) {
    throw new GroupXError("PROTOCOL_INVALID_MESSAGE", "Codex turn/start response is missing turn.id");
  }
  return { id, status: optionalString(value.turn.status), error: value.turn.error };
}

function readNestedTurnId(value: unknown): string | undefined {
  return isRecord(value) ? optionalString(value.id) : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new GroupXError("PROTOCOL_INVALID_MESSAGE", "Codex native policy allowlist must be a string array");
  }
  return value;
}

function optionalApprovalAllowsNever(value: unknown): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new GroupXError("PROTOCOL_INVALID_MESSAGE", "Codex approval policy allowlist must be an array");
  }
  for (const entry of value) {
    if (typeof entry === "string") {
      continue;
    }
    if (!isRecord(entry) || !isRecord(entry.granular)) {
      throw new GroupXError("PROTOCOL_INVALID_MESSAGE", "Codex approval policy allowlist contains an invalid item");
    }
  }
  return value.some((entry) => entry === "never");
}

function requireNonEmpty(value: string, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTimeouts(timeouts: CodexAdapterTimeouts): void {
  for (const [name, value] of Object.entries(timeouts)) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new TypeError(`${name} must be a positive finite number`);
    }
  }
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function clearTurnTimers(context: TurnContext): void {
  clearTimer(context.firstEventTimer);
  clearTimer(context.idleTimer);
  clearTimer(context.cancelTimer);
  context.firstEventTimer = undefined;
  context.idleTimer = undefined;
  context.cancelTimer = undefined;
}

function clearTimer(timer: NodeJS.Timeout | undefined): void {
  if (timer !== undefined) {
    clearTimeout(timer);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}
