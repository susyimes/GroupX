import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { boundDiagnosticText } from "../observability/diagnostics.js";

export type JsonLineProcessState = "running" | "closing" | "closed" | "failed";

export type JsonLineProtocolErrorKind =
  | "invalid_utf8"
  | "malformed_json"
  | "line_too_large"
  | "truncated_line"
  | "stdout_error";

export interface JsonLineProcessOptions {
  /** The executable followed by its arguments. This is never interpreted by a shell. */
  argv: readonly [string, ...string[]];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxStdoutLineBytes?: number;
  maxStderrChars?: number;
  closeGraceMs?: number;
  killGraceMs?: number;
}

export interface JsonLineCloseOptions {
  graceMs?: number;
  killGraceMs?: number;
}

export interface JsonLineProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  expected: boolean;
  forced: boolean;
  stderr: string;
  error?: string;
}

export class JsonLineProtocolError extends Error {
  readonly kind: JsonLineProtocolErrorKind;
  readonly lineSummary: string | undefined;

  constructor(kind: JsonLineProtocolErrorKind, message: string, lineSummary?: string) {
    super(message);
    this.name = "JsonLineProtocolError";
    this.kind = kind;
    this.lineSummary = lineSummary;
  }
}

export class JsonLineProcessClosedError extends Error {
  constructor(message = "The JSONL process is not accepting writes") {
    super(message);
    this.name = "JsonLineProcessClosedError";
  }
}

export class JsonLineProcessTerminationError extends Error {
  readonly pid: number | undefined;

  constructor(pid: number | undefined) {
    super(`JSONL process${pid === undefined ? "" : ` ${pid}`} did not close after bounded tree termination`);
    this.name = "JsonLineProcessTerminationError";
    this.pid = pid;
  }
}

type Listener<T> = (value: T) => void;

const DEFAULT_MAX_STDOUT_LINE_BYTES = 1_048_576;
const DEFAULT_MAX_STDERR_CHARS = 16_384;
const DEFAULT_CLOSE_GRACE_MS = 5_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const TRUNCATION_MARKER = "…[TRUNCATED]";
const ANSI_ESCAPE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/**
 * Owns one child process whose stdout is a UTF-8, newline-delimited JSON stream.
 * stderr is never parsed as protocol input and is only exposed as bounded diagnostic text.
 */
export class JsonLineProcess {
  readonly pid: number | undefined;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly maxStdoutLineBytes: number;
  private readonly maxStderrChars: number;
  private readonly defaultCloseGraceMs: number;
  private readonly defaultKillGraceMs: number;
  private readonly messages = new Set<Listener<unknown>>();
  private readonly protocolErrors = new Set<Listener<JsonLineProtocolError>>();
  private readonly stderrListeners = new Set<Listener<string>>();
  private readonly exitListeners = new Set<Listener<JsonLineProcessExit>>();

  private stdoutBuffer = Buffer.alloc(0);
  private stdoutBroken = false;
  private protocolErrorValue: JsonLineProtocolError | undefined;
  private readonly stderrDecoder = new StringDecoder("utf8");
  private stderrPending = "";
  private stderrCaptured = "";
  private stderrTruncated = false;
  private stateValue: JsonLineProcessState = "running";
  private expectedExit = false;
  private forcedExit = false;
  private failureObserved = false;
  private spawnError: string | undefined;
  private processExitValue: JsonLineProcessExit | undefined;
  private exitValue: JsonLineProcessExit | undefined;
  private readonly exitPromise: Promise<JsonLineProcessExit>;
  private resolveExit!: (exit: JsonLineProcessExit) => void;
  private closePromise: Promise<JsonLineProcessExit> | undefined;

  private constructor(options: JsonLineProcessOptions) {
    validateOptions(options);

    this.maxStdoutLineBytes = options.maxStdoutLineBytes ?? DEFAULT_MAX_STDOUT_LINE_BYTES;
    this.maxStderrChars = options.maxStderrChars ?? DEFAULT_MAX_STDERR_CHARS;
    this.defaultCloseGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    this.defaultKillGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.exitPromise = new Promise<JsonLineProcessExit>((resolve) => {
      this.resolveExit = resolve;
    });

    const [command, ...args] = options.argv;
    this.child = spawn(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.pid = this.child.pid;

    this.child.stdout.on("data", (chunk: Buffer) => {
      this.consumeStdout(chunk);
    });
    this.child.stdout.on("error", (error: Error) => {
      this.breakStdout(
        new JsonLineProtocolError(
          "stdout_error",
          `Protocol stdout failed: ${boundDiagnosticText(error.message, 512)}`
        )
      );
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.consumeStderr(this.stderrDecoder.write(chunk));
    });
    this.child.stderr.on("error", () => {
      // stderr is diagnostics only. A read error must not be promoted to protocol input.
    });
    this.child.stdin.on("error", () => {
      // Individual send() callbacks and the child close event carry write/exit failures.
    });
    this.child.once("error", (error: Error) => {
      this.spawnError = boundDiagnosticText(error.message, 1_024);
    });
    this.child.once("exit", (code, signal) => {
      this.observeProcessExit(code, signal);
    });
    this.child.once("close", (code, signal) => {
      this.finish(code, signal);
    });
  }

  static spawn(options: JsonLineProcessOptions): JsonLineProcess {
    return new JsonLineProcess(options);
  }

  get state(): JsonLineProcessState {
    return this.stateValue;
  }

  get stderr(): string {
    return this.stderrCaptured;
  }

  onMessage(listener: Listener<unknown>): () => void {
    return addListener(this.messages, listener);
  }

  onProtocolError(listener: Listener<JsonLineProtocolError>): () => void {
    if (this.protocolErrorValue !== undefined) {
      listener(this.protocolErrorValue);
      return () => undefined;
    }
    return addListener(this.protocolErrors, listener);
  }

  onStderr(listener: Listener<string>): () => void {
    return addListener(this.stderrListeners, listener);
  }

  onExit(listener: Listener<JsonLineProcessExit>): () => void {
    if (this.processExitValue !== undefined) {
      listener(this.processExitValue);
      return () => undefined;
    }
    return addListener(this.exitListeners, listener);
  }

  async send(value: unknown, signal?: AbortSignal): Promise<void> {
    if (this.stateValue !== "running" || this.child.stdin.destroyed || !this.child.stdin.writable) {
      throw new JsonLineProcessClosedError();
    }
    if (signal?.aborted === true) {
      throw abortReason(signal);
    }

    let serialized: string;
    try {
      serialized = `${JSON.stringify(value)}\n`;
    } catch (error) {
      throw new TypeError(`Unable to serialize JSONL message: ${errorMessage(error)}`);
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        if (error !== undefined && error !== null) {
          reject(new JsonLineProcessClosedError(boundDiagnosticText(error.message, 512)));
        } else {
          resolve();
        }
      };
      const onAbort = (): void => {
        finish(abortReason(signal));
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted === true) {
        finish(abortReason(signal));
        return;
      }

      try {
        this.child.stdin.write(serialized, "utf8", (error?: Error | null) => {
          finish(error);
        });
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  waitForExit(): Promise<JsonLineProcessExit> {
    return this.exitPromise;
  }

  close(options: JsonLineCloseOptions = {}): Promise<JsonLineProcessExit> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    if (this.exitValue !== undefined) {
      return Promise.resolve(this.exitValue);
    }

    this.expectedExit = true;
    if (!this.failureObserved) {
      this.stateValue = "closing";
    }
    this.closePromise = this.closeInternal(
      options.graceMs ?? this.defaultCloseGraceMs,
      options.killGraceMs ?? this.defaultKillGraceMs,
      false
    );
    return this.closePromise;
  }

  terminate(options: Omit<JsonLineCloseOptions, "graceMs"> = {}): Promise<JsonLineProcessExit> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }
    if (this.exitValue !== undefined) {
      return Promise.resolve(this.exitValue);
    }

    this.expectedExit = true;
    this.forcedExit = true;
    if (!this.failureObserved) {
      this.stateValue = "closing";
    }
    this.closePromise = this.closeInternal(0, options.killGraceMs ?? this.defaultKillGraceMs, true);
    return this.closePromise;
  }

  private async closeInternal(graceMs: number, killGraceMs: number, force: boolean): Promise<JsonLineProcessExit> {
    if (!force && !this.child.stdin.destroyed) {
      this.child.stdin.end();
    }

    if (!force && (await this.waitWithin(graceMs))) {
      return this.exitPromise;
    }

    this.forcedExit = true;
    if (!this.child.stdin.destroyed) {
      this.child.stdin.destroy();
    }
    await this.terminateTree("SIGTERM");
    if (await this.waitWithin(killGraceMs)) {
      return this.exitPromise;
    }

    await this.terminateTree("SIGKILL");
    if (await this.waitWithin(killGraceMs)) {
      return this.exitPromise;
    }

    this.failureObserved = true;
    this.stateValue = "failed";
    throw new JsonLineProcessTerminationError(this.child.pid);
  }

  private async terminateTree(signal: "SIGTERM" | "SIGKILL"): Promise<void> {
    const pid = this.child.pid;
    if (pid === undefined || this.exitValue !== undefined) {
      return;
    }

    if (process.platform === "win32") {
      await runTaskkill(pid);
      return;
    }

    try {
      process.kill(-pid, signal);
    } catch {
      try {
        this.child.kill(signal);
      } catch {
        // The process may have exited between the checks.
      }
    }
  }

  private waitWithin(milliseconds: number): Promise<boolean> {
    if (this.exitValue !== undefined) {
      return Promise.resolve(true);
    }
    if (milliseconds <= 0) {
      return Promise.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), milliseconds);
      timer.unref();
      void this.exitPromise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  private consumeStdout(chunk: Buffer): void {
    if (this.stdoutBroken || this.exitValue !== undefined) {
      return;
    }
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);

    while (!this.stdoutBroken) {
      const newline = this.stdoutBuffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.stdoutBuffer.length > this.maxStdoutLineBytes) {
          this.breakStdout(
            new JsonLineProtocolError(
              "line_too_large",
              `Protocol stdout line exceeded ${this.maxStdoutLineBytes} bytes`
            )
          );
        }
        return;
      }

      let line = this.stdoutBuffer.subarray(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newline + 1);
      if (line.at(-1) === 0x0d) {
        line = line.subarray(0, line.length - 1);
      }
      if (line.length === 0) {
        continue;
      }
      if (line.length > this.maxStdoutLineBytes) {
        this.breakStdout(
          new JsonLineProtocolError("line_too_large", `Protocol stdout line exceeded ${this.maxStdoutLineBytes} bytes`)
        );
        return;
      }

      this.parseLine(line);
    }
  }

  private parseLine(line: Buffer): void {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(line);
    } catch {
      this.breakStdout(new JsonLineProtocolError("invalid_utf8", "Protocol stdout contained invalid UTF-8"));
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      this.breakStdout(
        new JsonLineProtocolError(
          "malformed_json",
          "Protocol stdout contained malformed JSON",
          boundDiagnosticText(text, 256)
        )
      );
      return;
    }

    emit(this.messages, value);
  }

  private breakStdout(error: JsonLineProtocolError): void {
    if (this.stdoutBroken) {
      return;
    }
    this.stdoutBroken = true;
    this.failureObserved = true;
    this.stateValue = "failed";
    this.protocolErrorValue = error;
    this.stdoutBuffer = Buffer.alloc(0);
    emit(this.protocolErrors, error);
  }

  private consumeStderr(text: string): void {
    if (this.stderrTruncated || text.length === 0) {
      return;
    }
    this.stderrPending += text;

    while (!this.stderrTruncated) {
      const newline = this.stderrPending.indexOf("\n");
      if (newline < 0) {
        if (this.stderrPending.length > this.maxStderrChars) {
          this.captureStderr(this.stderrPending);
          this.stderrPending = "";
        }
        return;
      }

      const line = this.stderrPending.slice(0, newline + 1);
      this.stderrPending = this.stderrPending.slice(newline + 1);
      this.captureStderr(line);
    }
  }

  private captureStderr(raw: string): void {
    if (this.stderrTruncated || raw.length === 0) {
      return;
    }
    const safe = boundDiagnosticText(raw.replace(ANSI_ESCAPE, ""), this.maxStderrChars);
    const remaining = this.maxStderrChars - this.stderrCaptured.length;
    if (remaining <= 0) {
      this.stderrTruncated = true;
      return;
    }

    let captured = safe;
    if (captured.length > remaining) {
      captured = truncateWithMarker(captured, remaining);
      this.stderrTruncated = true;
    }
    this.stderrCaptured += captured;
    emit(this.stderrListeners, captured);
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitValue !== undefined) {
      return;
    }
    if (!this.stdoutBroken && this.stdoutBuffer.length > 0) {
      this.breakStdout(
        new JsonLineProtocolError("truncated_line", "Protocol stdout ended with an incomplete JSONL frame")
      );
    }
    this.consumeStderr(this.stderrDecoder.end());
    if (this.stderrPending.length > 0) {
      this.captureStderr(this.stderrPending);
      this.stderrPending = "";
    }

    if (this.processExitValue === undefined) {
      this.observeProcessExit(code, signal);
    }

    const exit: JsonLineProcessExit = {
      code,
      signal,
      expected: this.processExitValue?.expected ?? this.expectedExit,
      forced: this.forcedExit,
      stderr: this.stderrCaptured,
      ...(this.spawnError === undefined ? {} : { error: this.spawnError })
    };
    this.exitValue = exit;
    this.stateValue = this.failureObserved || !exit.expected ? "failed" : "closed";
    this.resolveExit(exit);
    this.messages.clear();
    this.protocolErrors.clear();
    this.stderrListeners.clear();
    this.exitListeners.clear();
  }

  private observeProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.processExitValue !== undefined) {
      return;
    }
    if (!this.expectedExit) {
      this.failureObserved = true;
      this.stateValue = "failed";
    }
    const exit: JsonLineProcessExit = {
      code,
      signal,
      expected: this.expectedExit,
      forced: this.forcedExit,
      stderr: this.stderrCaptured,
      ...(this.spawnError === undefined ? {} : { error: this.spawnError })
    };
    this.processExitValue = exit;
    emit(this.exitListeners, exit);
  }
}

function validateOptions(options: JsonLineProcessOptions): void {
  if (options.argv.length === 0 || options.argv[0].length === 0) {
    throw new TypeError("argv must contain a non-empty executable");
  }
  for (const value of options.argv) {
    if (typeof value !== "string") {
      throw new TypeError("argv must contain only strings");
    }
  }
  for (const [name, value] of [
    ["maxStdoutLineBytes", options.maxStdoutLineBytes],
    ["maxStderrChars", options.maxStderrChars],
    ["closeGraceMs", options.closeGraceMs],
    ["killGraceMs", options.killGraceMs]
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new TypeError(`${name} must be a positive finite number`);
    }
  }
}

function addListener<T>(listeners: Set<Listener<T>>, listener: Listener<T>): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit<T>(listeners: ReadonlySet<Listener<T>>, value: T): void {
  for (const listener of [...listeners]) {
    try {
      listener(value);
    } catch {
      // Transport lifecycle must not be broken by a diagnostic observer.
    }
  }
}

function truncateWithMarker(value: string, maximum: number): string {
  if (value.length <= maximum) {
    return value;
  }
  if (maximum <= TRUNCATION_MARKER.length) {
    return TRUNCATION_MARKER.slice(0, maximum);
  }
  return `${value.slice(0, maximum - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function abortReason(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  return new DOMException("The operation was aborted", "AbortError");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runTaskkill(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true
    });
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        killer.kill();
      } catch {
        // Best effort cleanup of the cleanup helper.
      }
      finish();
    }, 2_000);
    timer.unref();
    killer.once("error", finish);
    killer.once("close", finish);
  });
}
