import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import { GroupXError, type GroupXErrorCode } from "../../core/errors.js";
import { boundDiagnosticText } from "../../observability/diagnostics.js";
import type {
  AdapterHealth,
  AdapterId,
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
  DirectJsonlProcess,
  DirectJsonlProtocolError,
  type DirectJsonlProcessExit
} from "./process.js";
import {
  classifyNativePolicyDiagnostic,
  classifyStructuredInteraction,
  diagnosticFields,
  type DirectProjection,
  type DirectTerminalStatus
} from "./protocol.js";

export interface DirectTurnLaunch {
  argv: readonly [string, ...string[]];
  /** Exact raw stdin. Undefined means close stdin without writing. */
  stdinText?: string;
}

export interface DirectCliAdapterOptions {
  version?: string;
  firstEventMs?: number;
  idleMs?: number;
  cancelMs?: number;
  killGraceMs?: number;
  maxStdoutLineBytes?: number;
  maxStderrChars?: number;
  maxQueuedMessages?: number;
  maxArgvCharacters?: number;
  maxStdinCharacters?: number;
  now?: () => Date;
  idFactory?: (kind: "instance" | "binding") => string;
}

interface DirectRuntime {
  profile: DirectProfile;
  session: NativeSession;
  active?: DirectActiveTurn;
  closed: boolean;
  quarantined: boolean;
}

type DirectProfile = Pick<
  LaunchProfile,
  "command" | "prefixArgs" | "cwd" | "instanceId" | "bindingId"
>;

interface DirectActiveTurn {
  turnId: string;
  process: DirectJsonlProcess;
  cancelRequested: boolean;
  terminal: Deferred<void>;
  exitConfirmed: boolean;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

interface TerminalMarker {
  status: DirectTerminalStatus;
  payload?: unknown;
}

const DEFAULT_FIRST_EVENT_MS = 90_000;
const DEFAULT_IDLE_MS = 120_000;
const DEFAULT_CANCEL_MS = 10_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_MAX_ARGV_CHARACTERS = 30_000;
const DEFAULT_MAX_STDIN_CHARACTERS = 1_000_000;

/** Shared one-process-per-turn kernel for native Direct CLI transports. */
export abstract class DirectCliAdapter implements CliAdapter {
  readonly adapterId: AdapterId;
  readonly actorId: string;

  readonly #version: string | undefined;
  readonly #firstEventMs: number;
  readonly #idleMs: number;
  readonly #cancelMs: number;
  readonly #killGraceMs: number;
  readonly #maxStdoutLineBytes: number | undefined;
  readonly #maxStderrChars: number | undefined;
  readonly #maxQueuedMessages: number | undefined;
  readonly #maxArgvCharacters: number;
  readonly #maxStdinCharacters: number;
  readonly #now: () => Date;
  readonly #idFactory: (kind: "instance" | "binding") => string;

  #runtime: DirectRuntime | undefined;
  #health: AdapterHealth;
  #lastExecutable: string | undefined;

  protected constructor(adapterId: AdapterId, actorId: string, options: DirectCliAdapterOptions = {}) {
    this.adapterId = adapterId;
    this.actorId = actorId;
    this.#version = options.version;
    this.#firstEventMs = positiveDuration(options.firstEventMs, DEFAULT_FIRST_EVENT_MS, "firstEventMs");
    this.#idleMs = positiveDuration(options.idleMs, DEFAULT_IDLE_MS, "idleMs");
    this.#cancelMs = positiveDuration(options.cancelMs, DEFAULT_CANCEL_MS, "cancelMs");
    this.#killGraceMs = positiveDuration(options.killGraceMs, DEFAULT_KILL_GRACE_MS, "killGraceMs");
    this.#maxStdoutLineBytes = optionalPositive(options.maxStdoutLineBytes, "maxStdoutLineBytes");
    this.#maxStderrChars = optionalPositive(options.maxStderrChars, "maxStderrChars");
    this.#maxQueuedMessages = optionalPositive(options.maxQueuedMessages, "maxQueuedMessages");
    this.#maxArgvCharacters = positiveDuration(
      options.maxArgvCharacters,
      DEFAULT_MAX_ARGV_CHARACTERS,
      "maxArgvCharacters"
    );
    this.#maxStdinCharacters = positiveDuration(
      options.maxStdinCharacters,
      DEFAULT_MAX_STDIN_CHARACTERS,
      "maxStdinCharacters"
    );
    this.#now = options.now ?? (() => new Date());
    this.#idFactory =
      options.idFactory ?? ((kind) => `${kind}:${String(adapterId)}:direct:${randomUUID()}`);
    this.#health = {
      adapterId,
      status: "stopped",
      nativeSessionAvailable: false,
      updatedAt: this.#now().toISOString()
    };
  }

  protected abstract launchArgvShape(resume: boolean): string[];
  protected abstract capabilityFindings(): CapabilityFinding[];
  protected abstract buildTurnLaunch(input: {
    profile: DirectProfile;
    promptText: string;
    nativeSessionId?: string;
  }): DirectTurnLaunch;
  protected abstract projectMessage(value: unknown): DirectProjection[];

  /** Adapter-specific read-only check run immediately before each one-shot spawn. */
  protected preflightTurn(
    _session: NativeSession,
    _input: PromptInput
  ): Promise<void> {
    return Promise.resolve();
  }

  protected operationalHealth(): {
    status: Extract<AdapterHealth["status"], "ready" | "degraded">;
    lastError?: string;
  } {
    return { status: "ready" };
  }

  protected rejectAdapterStart(input: LaunchProfile, message: string): never {
    this.#lastExecutable = input.command;
    this.#setHealth(
      "failed",
      input.instanceId,
      `ADAPTER_START_FAILED: ${boundDiagnosticText(message, 768)}`
    );
    throw new GroupXError("ADAPTER_START_FAILED", boundDiagnosticText(message, 768));
  }

  async probe(): Promise<CapabilityReport> {
    return {
      adapterId: this.adapterId,
      ...(this.#lastExecutable === undefined ? {} : { executablePath: this.#lastExecutable }),
      ...(this.#version === undefined ? {} : { version: this.#version }),
      protocol: "direct-jsonl",
      launchArgvShape: this.launchArgvShape(false),
      findings: this.capabilityFindings().map((finding) => structuredClone(finding)),
      generatedAt: this.#now().toISOString()
    };
  }

  async start(input: LaunchProfile): Promise<NativeSession> {
    return await this.#open(input, undefined);
  }

  async resume(input: LaunchProfile & { nativeSessionId: string }): Promise<NativeSession> {
    if (input.nativeSessionId.length === 0) {
      throw new TypeError("nativeSessionId must be non-empty");
    }
    return await this.#open(input, input.nativeSessionId);
  }

  async *prompt(session: NativeSession, input: PromptInput): AsyncIterable<NativeEvent> {
    const runtime = this.#requireSession(session);
    validatePrompt(input);
    if (runtime.active !== undefined) {
      throw new GroupXError("DUPLICATE_DISPATCH", `${this.adapterId} Direct transport already has an active turn`);
    }

    if (input.signal?.aborted === true) {
      yield this.#event(runtime, input.turnId, "turn.cancelled", { reason: "pre_aborted" });
      return;
    }

    try {
      await this.preflightTurn(session, input);
    } catch (error) {
      const groupXError = asGroupXError(error, "ADAPTER_START_FAILED");
      runtime.quarantined = true;
      this.#setRuntimeHealth(
        runtime,
        "failed",
        `${groupXError.code}: ${groupXError.message}`
      );
      yield this.#event(runtime, input.turnId, "turn.failed", errorPayload(groupXError));
      return;
    }

    const promptText = buildDirectPromptText(input);
    let launch: DirectTurnLaunch;
    try {
      launch = this.buildTurnLaunch({
        profile: runtime.profile,
        promptText,
        ...(runtime.session.nativeSessionId === undefined
          ? {}
          : { nativeSessionId: runtime.session.nativeSessionId })
      });
      validateLaunch(launch, this.#maxArgvCharacters, this.#maxStdinCharacters);
    } catch (error) {
      const groupXError = asGroupXError(error, "MESSAGE_TOO_LARGE");
      yield this.#event(runtime, input.turnId, "turn.failed", errorPayload(groupXError));
      return;
    }

    let process: DirectJsonlProcess;
    try {
      process = DirectJsonlProcess.spawn({
        argv: launch.argv,
        cwd: runtime.profile.cwd,
        killGraceMs: this.#killGraceMs,
        ...(this.#maxStdoutLineBytes === undefined
          ? {}
          : { maxStdoutLineBytes: this.#maxStdoutLineBytes }),
        ...(this.#maxStderrChars === undefined ? {} : { maxStderrChars: this.#maxStderrChars }),
        ...(this.#maxQueuedMessages === undefined
          ? {}
          : { maxQueuedMessages: this.#maxQueuedMessages })
      });
    } catch (error) {
      const groupXError = asGroupXError(error, "ADAPTER_START_FAILED");
      this.#setRuntimeHealth(runtime, "degraded", `${groupXError.code}: ${groupXError.message}`);
      yield this.#event(runtime, input.turnId, "turn.failed", errorPayload(groupXError));
      return;
    }
    const active: DirectActiveTurn = {
      turnId: input.turnId,
      process,
      cancelRequested: false,
      terminal: deferred<void>(),
      exitConfirmed: false
    };
    runtime.active = active;
    const abort = (): void => {
      active.cancelRequested = true;
      void process.terminate().catch(() => undefined);
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    if (isAborted(input.signal)) abort();

    let terminal: TerminalMarker | undefined;
    let candidateSessionId: string | undefined;
    let firstMessage = true;
    let fatal: GroupXError | undefined;
    try {
      yield this.#event(runtime, input.turnId, "turn.started", {
        transport: "direct",
        pid: process.pid
      });

      try {
        await promiseWithin(
          process.writeStdinAndClose(launch.stdinText ?? ""),
          this.#firstEventMs,
          new GroupXError(
            "TURN_FIRST_EVENT_TIMEOUT",
            `Direct stdin did not close within ${this.#firstEventMs}ms`
          )
        );
      } catch (error) {
        fatal =
          error instanceof GroupXError
            ? error
            : new GroupXError(
                "ADAPTER_START_FAILED",
                boundDiagnosticText(errorMessage(error), 512),
                undefined,
                { cause: error }
              );
        await process.terminate().catch(() => undefined);
      }

      const iterator = process.messages()[Symbol.asyncIterator]();
      while (fatal === undefined) {
        let next: IteratorResult<unknown>;
        try {
          next = await nextWithin(
            iterator,
            firstMessage ? this.#firstEventMs : this.#idleMs,
            firstMessage ? "TURN_FIRST_EVENT_TIMEOUT" : "TURN_IDLE_TIMEOUT"
          );
        } catch (error) {
          fatal = asGroupXError(error, firstMessage ? "TURN_FIRST_EVENT_TIMEOUT" : "TURN_IDLE_TIMEOUT");
          await process.terminate().catch(() => undefined);
          break;
        }
        if (next.done) {
          break;
        }
        firstMessage = false;
        if (terminal !== undefined) {
          fatal = new GroupXError(
            "PROTOCOL_INVALID_MESSAGE",
            `${this.adapterId} emitted JSONL after its terminal event`
          );
          await process.terminate().catch(() => undefined);
          break;
        }

        const interaction = classifyStructuredInteraction(next.value);
        const policy = classifyNativePolicyDiagnostic(diagnosticFields(next.value));
        const projected = this.projectMessage(next.value);
        const projectedInteractions = projected.filter(
          (projection): projection is Extract<DirectProjection, { kind: "native_interaction" }> =>
            projection.kind === "native_interaction"
        );
        const projectedPolicies = projected.filter(
          (projection): projection is Extract<DirectProjection, { kind: "native_policy_blocked" }> =>
            projection.kind === "native_policy_blocked"
        );
        const nonDiagnosticProjections = projected.filter(
          (projection) =>
            projection.kind !== "native_interaction" && projection.kind !== "native_policy_blocked"
        );
        const interactions = [
          ...(interaction === undefined ? [] : [interaction]),
          ...projectedInteractions
        ];
        const projections = [
          ...interactions,
          ...(interactions.length > 0 || policy === undefined ? [] : [policy]),
          ...(interactions.length > 0 ? [] : projectedPolicies),
          ...nonDiagnosticProjections
        ];

        for (const projection of projections) {
          if (projection.kind === "session") {
            const expectedSessionId = runtime.session.nativeSessionId ?? candidateSessionId;
            if (
              expectedSessionId !== undefined &&
              projection.nativeSessionId !== expectedSessionId
            ) {
              fatal = new GroupXError(
                "PROTOCOL_INVALID_MESSAGE",
                `${this.adapterId} Direct process changed native session id within a bound session`
              );
              await process.terminate().catch(() => undefined);
              break;
            }
            candidateSessionId = projection.nativeSessionId;
            continue;
          }
          if (projection.kind === "native_interaction") {
            fatal = new GroupXError("UNEXPECTED_NATIVE_INTERACTION", projection.detail);
            await process.terminate().catch(() => undefined);
            break;
          }
          if (projection.kind === "native_policy_blocked") {
            fatal = new GroupXError("NATIVE_POLICY_BLOCKED", projection.detail);
            await process.terminate().catch(() => undefined);
            break;
          }
          if (projection.kind === "terminal") {
            terminal = {
              status: projection.status,
              ...(projection.payload === undefined ? {} : { payload: projection.payload })
            };
            continue;
          }
          yield this.#event(runtime, input.turnId, projection.type, projection.payload, {
            ...(candidateSessionId === undefined ? {} : { nativeSessionId: candidateSessionId }),
            ...(projection.nativeEventId === undefined ? {} : { nativeEventId: projection.nativeEventId })
          });
        }
      }

      const exit = await valueWithin(process.waitForExit(), this.#killGraceMs * 2 + 2_000);
      if (exit === undefined) {
        runtime.quarantined = true;
        fatal ??= new GroupXError(
          "TURN_INTERRUPTED",
          "Direct process did not report exit after bounded termination"
        );
      } else {
        active.exitConfirmed = true;
        const stderrPolicy = classifyNativePolicyDiagnostic(exit.stderr);
        if (stderrPolicy !== undefined && fatal === undefined) {
          fatal = new GroupXError("NATIVE_POLICY_BLOCKED", stderrPolicy.detail);
        }
      }
      if (exit !== undefined && (active.cancelRequested || isAborted(input.signal))) {
        active.terminal.resolve();
        yield this.#event(runtime, input.turnId, "turn.cancelled", {
          reason: "direct_process_terminated"
        });
        return;
      }
      if (fatal === undefined && exit !== undefined) {
        fatal = exitFailure(exit);
      }
      if (fatal !== undefined) {
        this.#setRuntimeHealth(
          runtime,
          fatal.code === "NATIVE_POLICY_BLOCKED" || runtime.quarantined ? "failed" : "degraded",
          `${fatal.code}: ${fatal.message}`
        );
        active.terminal.resolve();
        yield this.#event(runtime, input.turnId, "turn.failed", errorPayload(fatal), {
          ...(candidateSessionId === undefined ? {} : { nativeSessionId: candidateSessionId })
        });
        return;
      }
      if (terminal === undefined) {
        const error = new GroupXError(
          "PROTOCOL_INVALID_MESSAGE",
          `${this.adapterId} Direct process exited without a terminal JSONL event`
        );
        this.#setRuntimeHealth(runtime, "degraded", `${error.code}: ${error.message}`);
        active.terminal.resolve();
        yield this.#event(runtime, input.turnId, "turn.failed", errorPayload(error), {
          ...(candidateSessionId === undefined ? {} : { nativeSessionId: candidateSessionId })
        });
        return;
      }
      if (terminal.status === "failed") {
        const error = new GroupXError("TURN_INTERRUPTED", terminalDiagnostic(terminal.payload));
        active.terminal.resolve();
        yield this.#event(runtime, input.turnId, "turn.failed", errorPayload(error), {
          ...(candidateSessionId === undefined ? {} : { nativeSessionId: candidateSessionId })
        });
        return;
      }
      if (terminal.status === "cancelled") {
        active.terminal.resolve();
        yield this.#event(runtime, input.turnId, "turn.cancelled", terminal.payload ?? {}, {
          ...(candidateSessionId === undefined ? {} : { nativeSessionId: candidateSessionId })
        });
        return;
      }

      if (candidateSessionId !== undefined) {
        runtime.session.nativeSessionId = candidateSessionId;
      }
      const operational = this.operationalHealth();
      this.#setRuntimeHealth(runtime, operational.status, operational.lastError);
      active.terminal.resolve();
      yield this.#event(runtime, input.turnId, "turn.completed", terminal.payload ?? {}, {
        ...(candidateSessionId === undefined ? {} : { nativeSessionId: candidateSessionId })
      });
    } catch (error) {
      const groupXError = asGroupXError(error, "PROTOCOL_INVALID_MESSAGE");
      await process.terminate().catch(() => undefined);
      this.#setRuntimeHealth(runtime, "degraded", `${groupXError.code}: ${groupXError.message}`);
      active.terminal.resolve();
      yield this.#event(runtime, input.turnId, "turn.failed", errorPayload(groupXError), {
        ...(candidateSessionId === undefined ? {} : { nativeSessionId: candidateSessionId })
      });
    } finally {
      input.signal?.removeEventListener("abort", abort);
      if (!active.exitConfirmed) {
        try {
          await process.terminate();
          active.exitConfirmed = true;
        } catch (error) {
          runtime.quarantined = true;
          this.#setRuntimeHealth(
            runtime,
            "failed",
            `TURN_INTERRUPTED: ${boundDiagnosticText(errorMessage(error), 512)}`
          );
        }
      }
      active.terminal.resolve();
      if (runtime.active === active && active.exitConfirmed && !runtime.quarantined) {
        delete runtime.active;
      }
    }
  }

  async cancel(session: NativeSession, nativeTurnId: string): Promise<CancelResult> {
    const runtime = this.#requireSession(session);
    const active = runtime.active;
    if (active === undefined || active.turnId !== nativeTurnId) {
      return {
        requested: false,
        supported: true,
        terminalObserved: active === undefined,
        detail: "No matching active Direct turn"
      };
    }
    if (!active.cancelRequested) {
      active.cancelRequested = true;
      void active.process.terminate().catch(() => undefined);
    }
    const terminalSettled = await settlesWithin(active.terminal.promise, this.#cancelMs);
    const terminalObserved = terminalSettled && active.exitConfirmed;
    return {
      requested: true,
      supported: true,
      terminalObserved,
      ...(terminalObserved ? {} : { detail: "Direct process cancellation did not settle before timeout" })
    };
  }

  async close(session: NativeSession): Promise<void> {
    const runtime = this.#runtime;
    if (runtime === undefined) {
      return;
    }
    if (
      session.adapterId !== this.adapterId ||
      session.instanceId !== runtime.session.instanceId ||
      session.bindingId !== runtime.session.bindingId
    ) {
      throw new GroupXError("SESSION_NOT_AVAILABLE", `No matching active ${this.adapterId} Direct session`);
    }
    if (runtime.closed) {
      return;
    }
    const active = runtime.active;
    let closeError: unknown;
    if (active !== undefined) {
      active.cancelRequested = true;
      try {
        await active.process.terminate();
        active.exitConfirmed = true;
        active.terminal.resolve();
      } catch (error) {
        closeError = error;
      }
      if (!(await settlesWithin(active.terminal.promise, this.#cancelMs)) && closeError === undefined) {
        closeError = new GroupXError(
          "TURN_CANCEL_TIMEOUT",
          `${this.adapterId} Direct turn did not settle during close`
        );
      }
    }
    if (closeError !== undefined) {
      runtime.quarantined = true;
      this.#setRuntimeHealth(
        runtime,
        "failed",
        `TURN_INTERRUPTED: ${boundDiagnosticText(errorMessage(closeError), 512)}`
      );
      throw asGroupXError(closeError, "TURN_INTERRUPTED");
    }
    runtime.closed = true;
    if (this.#runtime === runtime) {
      this.#runtime = undefined;
    }
    this.#setHealth("stopped");
  }

  health(): AdapterHealth {
    return structuredClone(this.#health);
  }

  async #open(input: LaunchProfile, nativeSessionId: string | undefined): Promise<NativeSession> {
    validateProfile(input);
    if (input.mcp !== undefined) {
      throw new GroupXError(
        "MCP_BINDING_MISMATCH",
        `${this.adapterId} Direct transport does not attach GroupX MCP; use structured transport`
      );
    }
    if (this.#runtime !== undefined) {
      throw new GroupXError("ADAPTER_START_FAILED", `${this.adapterId} Direct adapter is already started`);
    }
    const instanceId = input.instanceId ?? this.#idFactory("instance");
    const bindingId = input.bindingId ?? this.#idFactory("binding");
    const session: NativeSession = {
      adapterId: this.adapterId,
      instanceId,
      bindingId,
      actorId: this.actorId,
      ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
      protocol: "direct-jsonl",
      startedAt: this.#now().toISOString()
    };
    this.#lastExecutable = input.command;
    this.#runtime = {
      profile: {
        command: input.command,
        ...(input.prefixArgs === undefined ? {} : { prefixArgs: [...input.prefixArgs] }),
        cwd: input.cwd,
        ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId }),
        ...(input.bindingId === undefined ? {} : { bindingId: input.bindingId })
      },
      session,
      closed: false,
      quarantined: false
    };
    const operational = this.operationalHealth();
    this.#setHealth(operational.status, instanceId, operational.lastError);
    return session;
  }

  #requireSession(session: NativeSession): DirectRuntime {
    const runtime = this.#runtime;
    if (
      runtime === undefined ||
      runtime.closed ||
      runtime.quarantined ||
      session.adapterId !== this.adapterId ||
      session.actorId !== this.actorId ||
      session.instanceId !== runtime.session.instanceId ||
      session.bindingId !== runtime.session.bindingId ||
      session.nativeSessionId !== runtime.session.nativeSessionId
    ) {
      throw new GroupXError("SESSION_NOT_AVAILABLE", `No matching active ${this.adapterId} Direct session`);
    }
    return runtime;
  }

  #event(
    runtime: DirectRuntime,
    nativeTurnId: string,
    type: NativeEvent["type"],
    payload: unknown,
    overrides: { nativeSessionId?: string; nativeEventId?: string } = {}
  ): NativeEvent {
    const nativeSessionId = overrides.nativeSessionId ?? runtime.session.nativeSessionId;
    return {
      adapterId: this.adapterId,
      instanceId: runtime.session.instanceId,
      ...(nativeSessionId === undefined ? {} : { nativeSessionId }),
      nativeTurnId,
      ...(overrides.nativeEventId === undefined ? {} : { nativeEventId: overrides.nativeEventId }),
      type,
      payload,
      occurredAt: this.#now().toISOString()
    };
  }

  #setHealth(status: AdapterHealth["status"], instanceId?: string, lastError?: string): void {
    this.#health = {
      adapterId: this.adapterId,
      status,
      ...(instanceId === undefined ? {} : { instanceId }),
      nativeSessionAvailable:
        (status === "ready" || status === "degraded") &&
        this.#runtime?.session.nativeSessionId !== undefined,
      ...(lastError === undefined ? {} : { lastError: boundDiagnosticText(lastError, 1_024) }),
      updatedAt: this.#now().toISOString()
    };
  }

  #setRuntimeHealth(
    runtime: DirectRuntime,
    status: AdapterHealth["status"],
    lastError?: string
  ): void {
    if (this.#runtime !== runtime || runtime.closed) return;
    this.#setHealth(status, runtime.session.instanceId, lastError);
  }
}

export function buildDirectPromptText(input: Pick<PromptInput, "content" | "contextPacket">): string {
  if (input.contextPacket === undefined || input.contextPacket.length === 0) {
    return input.content;
  }
  return `${input.contextPacket}\n\n[groupx_current_message]\n${input.content}`;
}

export function estimateWindowsCommandLineCharacters(argv: readonly string[]): number {
  return argv.reduce((total, argument, index) => {
    return total + (index === 0 ? 0 : 1) + windowsQuotedLength(argument);
  }, 0);
}

function windowsQuotedLength(argument: string): number {
  if (argument.length > 0 && !/[\s"]/.test(argument)) {
    return argument.length;
  }
  let length = 2;
  let slashes = 0;
  // Index by UTF-16 code unit because CreateProcessW's command-line limit is
  // measured in UTF-16 characters; `for...of` would undercount astral symbols.
  for (let index = 0; index < argument.length; index += 1) {
    const character = argument[index];
    if (character === "\\") {
      slashes += 1;
      continue;
    }
    if (character === '"') {
      length += slashes * 2 + 2;
      slashes = 0;
      continue;
    }
    length += slashes + 1;
    slashes = 0;
  }
  return length + slashes * 2;
}

function validateProfile(input: LaunchProfile): void {
  if (Object.hasOwn(input, "extraArgs") || Object.hasOwn(input, "env")) {
    throw new GroupXError(
      "ADAPTER_START_FAILED",
      "Direct LaunchProfile does not accept native extraArgs or environment overrides"
    );
  }
  if (typeof input.command !== "string" || input.command.length === 0) {
    throw new TypeError("LaunchProfile.command must be non-empty");
  }
  if (process.platform === "win32" && /\.(?:cmd|bat|ps1)$/i.test(input.command)) {
    throw new GroupXError(
      "ADAPTER_START_FAILED",
      "Windows command shims are not executable with shell:false; configure executable + prefixArgs"
    );
  }
  if (input.prefixArgs !== undefined && input.prefixArgs.some((value) => typeof value !== "string")) {
    throw new TypeError("LaunchProfile.prefixArgs must contain only strings");
  }
  if (
    input.prefixArgs !== undefined &&
    (input.prefixArgs.length > 1 ||
      (input.prefixArgs.length === 1 &&
        (!isAbsolute(input.prefixArgs[0]!) || !/\.(?:cjs|mjs|js)$/i.test(input.prefixArgs[0]!))))
  ) {
    throw new GroupXError(
      "ADAPTER_START_FAILED",
      "LaunchProfile.prefixArgs may contain only one absolute JavaScript launcher entry"
    );
  }
  if (typeof input.cwd !== "string" || !isAbsolute(input.cwd)) {
    throw new TypeError("LaunchProfile.cwd must be an absolute path");
  }
  if (input.instanceId !== undefined && input.instanceId.length === 0) {
    throw new TypeError("LaunchProfile.instanceId must be non-empty when provided");
  }
  if (input.bindingId !== undefined && input.bindingId.length === 0) {
    throw new TypeError("LaunchProfile.bindingId must be non-empty when provided");
  }
}

function validatePrompt(input: PromptInput): void {
  if (input.turnId.length === 0 || input.correlationId.length === 0 || input.content.length === 0) {
    throw new TypeError("PromptInput turnId, correlationId, and content must be non-empty");
  }
}

function validateLaunch(
  launch: DirectTurnLaunch,
  maxArgvCharacters: number,
  maxStdinCharacters: number
): void {
  if (launch.argv.length === 0 || launch.argv[0].length === 0) {
    throw new TypeError("Direct launch argv must contain a non-empty executable");
  }
  if (launch.argv.some((argument) => argument.includes("\0"))) {
    throw new GroupXError("INVALID_ENVELOPE", "Direct argv cannot contain NUL characters");
  }
  const argvCharacters = estimateWindowsCommandLineCharacters(launch.argv);
  if (argvCharacters > maxArgvCharacters) {
    throw new GroupXError(
      "MESSAGE_TOO_LARGE",
      `Direct argv requires ${argvCharacters} characters; configured boundary is ${maxArgvCharacters}`,
      { argvCharacters, maxArgvCharacters }
    );
  }
  if (launch.stdinText !== undefined && launch.stdinText.length > maxStdinCharacters) {
    throw new GroupXError(
      "MESSAGE_TOO_LARGE",
      `Direct stdin requires ${launch.stdinText.length} characters; configured boundary is ${maxStdinCharacters}`,
      { stdinCharacters: launch.stdinText.length, maxStdinCharacters }
    );
  }
}

async function nextWithin<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
  code: "TURN_FIRST_EVENT_TIMEOUT" | "TURN_IDLE_TIMEOUT"
): Promise<IteratorResult<T>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new GroupXError(code, `${code} after ${timeoutMs}ms`)), timeoutMs);
        timer.unref();
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function promiseWithin<T>(promise: Promise<T>, timeoutMs: number, error: Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(error), timeoutMs);
        timer.unref();
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function valueWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
        timer.unref();
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function exitFailure(exit: DirectJsonlProcessExit): GroupXError | undefined {
  if (exit.error !== undefined) {
    return new GroupXError("ADAPTER_START_FAILED", boundDiagnosticText(exit.error, 512));
  }
  if (exit.code === 0 && exit.signal === null) {
    return undefined;
  }
  const detail = exit.stderr.length === 0 ? "" : `: ${boundDiagnosticText(exit.stderr, 512)}`;
  return new GroupXError(
    "TURN_INTERRUPTED",
    `Direct process exited (code=${String(exit.code)}, signal=${String(exit.signal)})${detail}`
  );
}

function terminalDiagnostic(payload: unknown): string {
  const diagnostic = diagnosticFields(payload);
  return diagnostic.length === 0 ? "Native Direct turn failed" : diagnostic;
}

function errorPayload(error: GroupXError): Record<string, unknown> {
  return {
    errorCode: error.code,
    message: boundDiagnosticText(error.message, 512)
  };
}

function asGroupXError(error: unknown, fallback: GroupXErrorCode): GroupXError {
  if (error instanceof GroupXError) return error;
  if (error instanceof DirectJsonlProtocolError) {
    return new GroupXError("PROTOCOL_INVALID_MESSAGE", error.message, { kind: error.kind }, { cause: error });
  }
  return new GroupXError(fallback, boundDiagnosticText(errorMessage(error), 512), undefined, {
    cause: error
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

function positiveDuration(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isFinite(selected) || selected <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return selected;
}

function optionalPositive(value: number | undefined, name: string): number | undefined {
  if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return value;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    void promise.then(() => finish(true), () => finish(true));
  });
}
