import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { boundDiagnosticText } from "../../observability/diagnostics.js";
import { AsyncQueue } from "../../utils/async-queue.js";

export type DirectJsonlProtocolErrorKind =
  | "invalid_utf8"
  | "malformed_json"
  | "line_too_large"
  | "truncated_line"
  | "stdout_error"
  | "queue_overflow";

export interface DirectJsonlProcessOptions {
  argv: readonly [string, ...string[]];
  cwd: string;
  maxStdoutLineBytes?: number;
  maxStderrChars?: number;
  maxQueuedMessages?: number;
  killGraceMs?: number;
}

export interface DirectJsonlProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  forced: boolean;
  stderr: string;
  error?: string;
}

export class DirectJsonlProtocolError extends Error {
  readonly kind: DirectJsonlProtocolErrorKind;
  readonly lineSummary: string | undefined;

  constructor(kind: DirectJsonlProtocolErrorKind, message: string, lineSummary?: string) {
    super(message);
    this.name = "DirectJsonlProtocolError";
    this.kind = kind;
    this.lineSummary = lineSummary;
  }
}

export class DirectJsonlTerminationError extends Error {
  readonly pid: number | undefined;

  constructor(pid: number | undefined) {
    super(`Direct JSONL process${pid === undefined ? "" : ` ${pid}`} did not terminate within the bounded grace period`);
    this.name = "DirectJsonlTerminationError";
    this.pid = pid;
  }
}

const DEFAULT_MAX_STDOUT_LINE_BYTES = 1_048_576;
const DEFAULT_MAX_STDERR_CHARS = 16_384;
const DEFAULT_MAX_QUEUED_MESSAGES = 2_048;
const DEFAULT_KILL_GRACE_MS = 2_000;
const TRUNCATION_MARKER = "…[TRUNCATED]";
const ANSI_ESCAPE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

/** One-shot, shell-free JSONL process used by Direct adapters. */
export class DirectJsonlProcess {
  readonly pid: number | undefined;

  readonly #child: ChildProcessWithoutNullStreams;
  readonly #messages = new AsyncQueue<unknown>();
  readonly #maxStdoutLineBytes: number;
  readonly #maxStderrChars: number;
  readonly #maxQueuedMessages: number;
  readonly #killGraceMs: number;
  readonly #stderrDecoder = new StringDecoder("utf8");
  readonly #exitPromise: Promise<DirectJsonlProcessExit>;
  #resolveExit!: (exit: DirectJsonlProcessExit) => void;
  #stdoutBuffer = Buffer.alloc(0);
  #stderrPending = "";
  #stderrCaptured = "";
  #stderrTruncated = false;
  #spawnError: string | undefined;
  #protocolError: DirectJsonlProtocolError | undefined;
  #exit: DirectJsonlProcessExit | undefined;
  #forced = false;
  #termination: Promise<DirectJsonlProcessExit> | undefined;

  private constructor(options: DirectJsonlProcessOptions) {
    validateOptions(options);
    this.#maxStdoutLineBytes = options.maxStdoutLineBytes ?? DEFAULT_MAX_STDOUT_LINE_BYTES;
    this.#maxStderrChars = options.maxStderrChars ?? DEFAULT_MAX_STDERR_CHARS;
    this.#maxQueuedMessages = options.maxQueuedMessages ?? DEFAULT_MAX_QUEUED_MESSAGES;
    this.#killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    this.#exitPromise = new Promise((resolve) => {
      this.#resolveExit = resolve;
    });

    const [command, ...args] = options.argv;
    this.#child = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.pid = this.#child.pid;

    this.#child.stdout.on("data", (chunk: Buffer) => this.#consumeStdout(chunk));
    this.#child.stdout.on("error", (error: Error) => {
      this.#breakProtocol(
        new DirectJsonlProtocolError(
          "stdout_error",
          `Direct stdout failed: ${boundDiagnosticText(error.message, 512)}`
        )
      );
    });
    this.#child.stderr.on("data", (chunk: Buffer) => this.#consumeStderr(this.#stderrDecoder.write(chunk)));
    this.#child.stderr.on("error", () => undefined);
    this.#child.stdin.on("error", () => undefined);
    this.#child.once("error", (error: Error) => {
      this.#spawnError = boundDiagnosticText(error.message, 1_024);
    });
    this.#child.once("close", (code, signal) => this.#finish(code, signal));
  }

  static spawn(options: DirectJsonlProcessOptions): DirectJsonlProcess {
    return new DirectJsonlProcess(options);
  }

  get stderr(): string {
    return this.#stderrCaptured;
  }

  get protocolError(): DirectJsonlProtocolError | undefined {
    return this.#protocolError;
  }

  messages(): AsyncIterable<unknown> {
    return this.#messages;
  }

  async writeStdinAndClose(text = ""): Promise<void> {
    if (this.#exit !== undefined || this.#child.stdin.destroyed || !this.#child.stdin.writable) {
      throw new Error("Direct JSONL process is not accepting stdin");
    }
    await new Promise<void>((resolve, reject) => {
      this.#child.stdin.end(text, "utf8", (error?: Error | null) => {
        if (error !== undefined && error !== null) {
          reject(new Error(boundDiagnosticText(error.message, 512)));
        } else {
          resolve();
        }
      });
    });
  }

  waitForExit(): Promise<DirectJsonlProcessExit> {
    return this.#exitPromise;
  }

  terminate(): Promise<DirectJsonlProcessExit> {
    if (this.#termination !== undefined) {
      return this.#termination;
    }
    if (this.#exit !== undefined) {
      return Promise.resolve(this.#exit);
    }
    this.#forced = true;
    if (!this.#child.stdin.destroyed) {
      this.#child.stdin.destroy();
    }
    this.#termination = this.#terminateInternal();
    return this.#termination;
  }

  async #terminateInternal(): Promise<DirectJsonlProcessExit> {
    const pid = this.#child.pid;
    const childExitObserved = this.#child.exitCode !== null || this.#child.signalCode !== null;
    if (pid !== undefined && !childExitObserved) {
      if (process.platform === "win32") {
        await runTaskkill(pid);
      } else {
        try {
          process.kill(-pid, "SIGTERM");
        } catch {
          try {
            this.#child.kill("SIGTERM");
          } catch {
            // It may have exited between the checks.
          }
        }
      }
    }
    if (await this.#waitWithin(this.#killGraceMs)) {
      return await this.#exitPromise;
    }
    if (process.platform !== "win32" && pid !== undefined) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          this.#child.kill("SIGKILL");
        } catch {
          // It may have exited between the checks.
        }
      }
    }
    if (await this.#waitWithin(this.#killGraceMs)) {
      return await this.#exitPromise;
    }
    throw new DirectJsonlTerminationError(pid);
  }

  #consumeStdout(chunk: Buffer): void {
    if (this.#protocolError !== undefined || this.#exit !== undefined) {
      return;
    }
    this.#stdoutBuffer = Buffer.concat([this.#stdoutBuffer, chunk]);
    while (this.#protocolError === undefined) {
      const newline = this.#stdoutBuffer.indexOf(0x0a);
      if (newline < 0) {
        if (this.#stdoutBuffer.length > this.#maxStdoutLineBytes) {
          this.#breakProtocol(
            new DirectJsonlProtocolError(
              "line_too_large",
              `Direct stdout line exceeded ${this.#maxStdoutLineBytes} bytes`
            )
          );
        }
        return;
      }
      let line = this.#stdoutBuffer.subarray(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.subarray(newline + 1);
      if (line.at(-1) === 0x0d) {
        line = line.subarray(0, line.length - 1);
      }
      if (line.length === 0) {
        continue;
      }
      if (line.length > this.#maxStdoutLineBytes) {
        this.#breakProtocol(
          new DirectJsonlProtocolError(
            "line_too_large",
            `Direct stdout line exceeded ${this.#maxStdoutLineBytes} bytes`
          )
        );
        return;
      }
      this.#parseLine(line);
    }
  }

  #parseLine(line: Buffer): void {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(line);
    } catch {
      this.#breakProtocol(new DirectJsonlProtocolError("invalid_utf8", "Direct stdout contained invalid UTF-8"));
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      this.#breakProtocol(
        new DirectJsonlProtocolError(
          "malformed_json",
          "Direct stdout contained malformed JSON",
          boundDiagnosticText(text, 256)
        )
      );
      return;
    }
    if (this.#messages.length >= this.#maxQueuedMessages) {
      this.#breakProtocol(
        new DirectJsonlProtocolError(
          "queue_overflow",
          `Direct stdout exceeded ${this.#maxQueuedMessages} queued messages`
        )
      );
      return;
    }
    this.#messages.push(value);
  }

  #breakProtocol(error: DirectJsonlProtocolError, terminate = true): void {
    if (this.#protocolError !== undefined) {
      return;
    }
    this.#protocolError = error;
    this.#stdoutBuffer = Buffer.alloc(0);
    this.#messages.fail(error);
    if (terminate) {
      void this.terminate().catch(() => undefined);
    }
  }

  #consumeStderr(text: string): void {
    if (this.#stderrTruncated || text.length === 0) {
      return;
    }
    this.#stderrPending += text;
    while (!this.#stderrTruncated) {
      const newline = this.#stderrPending.indexOf("\n");
      if (newline < 0) {
        if (this.#stderrPending.length > this.#maxStderrChars) {
          this.#captureStderr(this.#stderrPending);
          this.#stderrPending = "";
        }
        return;
      }
      const line = this.#stderrPending.slice(0, newline + 1);
      this.#stderrPending = this.#stderrPending.slice(newline + 1);
      this.#captureStderr(line);
    }
  }

  #captureStderr(raw: string): void {
    if (raw.length === 0 || this.#stderrTruncated) {
      return;
    }
    const remaining = this.#maxStderrChars - this.#stderrCaptured.length;
    if (remaining <= 0) {
      this.#stderrTruncated = true;
      return;
    }
    const safe = raw.replace(ANSI_ESCAPE, "");
    if (safe.length > remaining) {
      this.#stderrCaptured += truncateWithMarker(safe, remaining);
      this.#stderrTruncated = true;
    } else {
      this.#stderrCaptured += safe;
    }
  }

  #finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.#exit !== undefined) {
      return;
    }
    if (this.#protocolError === undefined && this.#stdoutBuffer.length > 0) {
      this.#breakProtocol(
        new DirectJsonlProtocolError("truncated_line", "Direct stdout ended with an incomplete JSONL frame"),
        false
      );
    }
    this.#consumeStderr(this.#stderrDecoder.end());
    if (this.#stderrPending.length > 0) {
      this.#captureStderr(this.#stderrPending);
      this.#stderrPending = "";
    }
    const exit: DirectJsonlProcessExit = {
      code,
      signal,
      forced: this.#forced,
      stderr: this.#stderrCaptured,
      ...(this.#spawnError === undefined ? {} : { error: this.#spawnError })
    };
    this.#exit = exit;
    if (this.#protocolError === undefined) {
      this.#messages.end();
    }
    this.#resolveExit(exit);
  }

  #waitWithin(milliseconds: number): Promise<boolean> {
    if (this.#exit !== undefined) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), milliseconds);
      timer.unref();
      void this.#exitPromise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }
}

function validateOptions(options: DirectJsonlProcessOptions): void {
  if (options.argv.length === 0 || options.argv[0].length === 0) {
    throw new TypeError("argv must contain a non-empty executable");
  }
  if (options.cwd.length === 0) {
    throw new TypeError("cwd must be non-empty");
  }
  for (const argument of options.argv) {
    if (typeof argument !== "string") {
      throw new TypeError("argv must contain only strings");
    }
  }
  for (const [name, value] of [
    ["maxStdoutLineBytes", options.maxStdoutLineBytes],
    ["maxStderrChars", options.maxStderrChars],
    ["maxQueuedMessages", options.maxQueuedMessages],
    ["killGraceMs", options.killGraceMs]
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new TypeError(`${name} must be a positive finite number`);
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

async function runTaskkill(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const killer = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      stdio: "ignore",
      windowsHide: true
    });
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      try {
        killer.kill();
      } catch {
        // Best-effort cleanup of the cleanup helper.
      }
      finish();
    }, 2_000);
    timer.unref();
    killer.once("error", finish);
    killer.once("close", finish);
  });
}
