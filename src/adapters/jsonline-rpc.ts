import { boundDiagnosticText } from "../observability/diagnostics.js";
import {
  JsonLineProcess,
  JsonLineProtocolError,
  type JsonLineProcessExit,
  type JsonLineProcessOptions
} from "../supervisor/jsonline-process.js";

export type JsonRpcDialect = "acp" | "codex";
export type JsonRpcId = string | number;
export type JsonLineRpcState = "running" | "closing" | "closed" | "failed";

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number | false;
}

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface JsonRpcServerRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
  signal: AbortSignal;
}

export type JsonRpcServerRequestHandler = (request: JsonRpcServerRequest) => unknown | Promise<unknown>;

export interface JsonRpcUnknownMessage {
  reason: "unknown_message" | "orphan_response" | "late_response";
  message: unknown;
}

export interface JsonLineRpcClientOptions {
  dialect: JsonRpcDialect;
  defaultRequestTimeoutMs?: number | false;
  idPrefix?: string;
  serverRequestHandler?: JsonRpcServerRequestHandler;
}

export interface JsonRpcRequestHandle<TResult> {
  readonly id: JsonRpcId;
  readonly promise: Promise<TResult>;
  cancel(message?: string): boolean;
}

export class JsonRpcProtocolError extends Error {
  readonly causeError: Error | undefined;

  constructor(message: string, causeError?: Error) {
    super(message, causeError === undefined ? undefined : { cause: causeError });
    this.name = "JsonRpcProtocolError";
    this.causeError = causeError;
  }
}

export class JsonRpcTransportClosedError extends Error {
  constructor(message = "The JSON-RPC transport is closed") {
    super(message);
    this.name = "JsonRpcTransportClosedError";
  }
}

export class JsonRpcRequestTimeoutError extends Error {
  readonly id: JsonRpcId;
  readonly method: string;
  readonly timeoutMs: number;

  constructor(id: JsonRpcId, method: string, timeoutMs: number) {
    super(`JSON-RPC request ${method} timed out after ${timeoutMs} ms`);
    this.name = "JsonRpcRequestTimeoutError";
    this.id = id;
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

export class JsonRpcRequestAbortedError extends Error {
  readonly id: JsonRpcId;
  readonly method: string;

  constructor(id: JsonRpcId, method: string, message = "JSON-RPC request was aborted") {
    super(message);
    this.name = "AbortError";
    this.id = id;
    this.method = method;
  }
}

export class JsonRpcRemoteError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly requestId: JsonRpcId;

  constructor(requestId: JsonRpcId, error: JsonRpcErrorObject) {
    super(boundDiagnosticText(error.message, 1_024));
    this.name = "JsonRpcRemoteError";
    this.code = error.code;
    this.data = error.data;
    this.requestId = requestId;
  }
}

export class JsonRpcProcessExitedError extends Error {
  readonly exit: JsonLineProcessExit;

  constructor(exit: JsonLineProcessExit) {
    const detail = exit.error ?? exit.stderr;
    super(
      `JSON-RPC process exited (code=${String(exit.code)}, signal=${String(exit.signal)})${
        detail.length === 0 ? "" : `: ${boundDiagnosticText(detail, 512)}`
      }`
    );
    this.name = "JsonRpcProcessExitedError";
    this.exit = exit;
  }
}

/** Throw this from a server-request handler to return a deliberate JSON-RPC error. */
export class JsonRpcServerError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "JsonRpcServerError";
    this.code = code;
    this.data = data;
  }
}

interface PendingRequest {
  id: JsonRpcId;
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | undefined;
  signal: AbortSignal | undefined;
  abortListener: (() => void) | undefined;
}

type Listener<T> = (value: T) => void;

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const hasOwn = (value: object, key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(value, key);

/**
 * Bidirectional JSON-RPC over a JsonLineProcess. ACP uses the JSON-RPC 2.0 header;
 * Codex App Server uses the same shapes while omitting that header on the wire.
 */
export class JsonLineRpcClient {
  private readonly process: JsonLineProcess;
  private readonly dialect: JsonRpcDialect;
  private readonly defaultRequestTimeoutMs: number | false;
  private readonly idPrefix: string;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly inboundControllers = new Map<string, AbortController>();
  private readonly notifications = new Set<Listener<JsonRpcNotification>>();
  private readonly unknownMessages = new Set<Listener<JsonRpcUnknownMessage>>();
  private readonly protocolErrors = new Set<Listener<JsonRpcProtocolError>>();
  private readonly exits = new Set<Listener<JsonLineProcessExit>>();
  private readonly processDisposers: Array<() => void>;

  private nextRequestId = 1;
  private stateValue: JsonLineRpcState = "running";
  private serverRequestHandler: JsonRpcServerRequestHandler | undefined;
  private closePromise: Promise<JsonLineProcessExit> | undefined;
  private protocolFailure: JsonRpcProtocolError | undefined;

  constructor(process: JsonLineProcess, options: JsonLineRpcClientOptions) {
    validateClientOptions(options);
    this.process = process;
    this.dialect = options.dialect;
    this.defaultRequestTimeoutMs = options.defaultRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.idPrefix = options.idPrefix ?? "";
    this.serverRequestHandler = options.serverRequestHandler;
    this.processDisposers = [
      process.onMessage((message) => this.acceptMessage(message)),
      process.onProtocolError((error) => this.failProtocol(fromLineProtocolError(error))),
      process.onExit((exit) => this.handleExit(exit))
    ];
  }

  static spawn(processOptions: JsonLineProcessOptions, clientOptions: JsonLineRpcClientOptions): JsonLineRpcClient {
    return new JsonLineRpcClient(JsonLineProcess.spawn(processOptions), clientOptions);
  }

  get state(): JsonLineRpcState {
    return this.stateValue;
  }

  get pendingRequestCount(): number {
    return this.pending.size;
  }

  get pid(): number | undefined {
    return this.process.pid;
  }

  get stderr(): string {
    return this.process.stderr;
  }

  setServerRequestHandler(handler: JsonRpcServerRequestHandler | undefined): void {
    this.serverRequestHandler = handler;
  }

  onNotification(listener: Listener<JsonRpcNotification>): () => void {
    return addListener(this.notifications, listener);
  }

  onUnknownMessage(listener: Listener<JsonRpcUnknownMessage>): () => void {
    return addListener(this.unknownMessages, listener);
  }

  onProtocolError(listener: Listener<JsonRpcProtocolError>): () => void {
    if (this.protocolFailure !== undefined) {
      listener(this.protocolFailure);
      return () => undefined;
    }
    return addListener(this.protocolErrors, listener);
  }

  onExit(listener: Listener<JsonLineProcessExit>): () => void {
    return addListener(this.exits, listener);
  }

  onStderr(listener: Listener<string>): () => void {
    return this.process.onStderr(listener);
  }

  request<TResult = unknown>(
    method: string,
    params?: unknown,
    options: JsonRpcRequestOptions = {}
  ): Promise<TResult> {
    return this.beginRequest<TResult>(method, params, options).promise;
  }

  beginRequest<TResult = unknown>(
    method: string,
    params?: unknown,
    options: JsonRpcRequestOptions = {}
  ): JsonRpcRequestHandle<TResult> {
    validateMethod(method);
    const id = this.allocateId();
    if (this.stateValue !== "running") {
      return rejectedHandle(id, new JsonRpcTransportClosedError(this.closedMessage()));
    }
    if (options.signal?.aborted === true) {
      return rejectedHandle(id, new JsonRpcRequestAbortedError(id, method, abortMessage(options.signal)));
    }

    const timeoutMs = options.timeoutMs ?? this.defaultRequestTimeoutMs;
    validateTimeout(timeoutMs);

    let resolvePromise!: (value: TResult) => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<TResult>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const pending: PendingRequest = {
      id,
      method,
      resolve: (value) => resolvePromise(value as TResult),
      reject: rejectPromise,
      timer: undefined,
      signal: options.signal,
      abortListener: undefined
    };
    this.pending.set(idKey(id), pending);

    if (timeoutMs !== false) {
      pending.timer = setTimeout(() => {
        this.rejectPending(id, new JsonRpcRequestTimeoutError(id, method, timeoutMs), "late_response");
      }, timeoutMs);
      pending.timer.unref();
    }
    if (options.signal !== undefined) {
      pending.abortListener = () => {
        this.rejectPending(
          id,
          new JsonRpcRequestAbortedError(id, method, abortMessage(options.signal)),
          "late_response"
        );
      };
      options.signal.addEventListener("abort", pending.abortListener, { once: true });
    }

    const frame = this.frame({ id, method, ...(params === undefined ? {} : { params }) });
    void this.process.send(frame, options.signal).catch((error: unknown) => {
      this.rejectPending(id, toTransportError(error), "orphan_response");
    });

    return {
      id,
      promise,
      cancel: (message?: string) =>
        this.rejectPending(id, new JsonRpcRequestAbortedError(id, method, message), "late_response")
    };
  }

  async notify(method: string, params?: unknown, signal?: AbortSignal): Promise<void> {
    validateMethod(method);
    this.assertRunning();
    await this.process.send(this.frame({ method, ...(params === undefined ? {} : { params }) }), signal);
  }

  cancelPendingRequest(id: JsonRpcId, message?: string): boolean {
    const pending = this.pending.get(idKey(id));
    if (pending === undefined) {
      return false;
    }
    return this.rejectPending(
      id,
      new JsonRpcRequestAbortedError(id, pending.method, message),
      "late_response"
    );
  }

  close(): Promise<JsonLineProcessExit> {
    if (this.closePromise !== undefined) {
      return this.closePromise;
    }

    if (this.stateValue !== "failed") {
      this.stateValue = "closing";
    }
    this.rejectAll(new JsonRpcTransportClosedError());
    this.abortInbound(new JsonRpcTransportClosedError());
    this.closePromise = this.process.close().then((exit) => {
      if (this.stateValue !== "failed") {
        this.stateValue = "closed";
      }
      this.disposeProcessListeners();
      return exit;
    });
    return this.closePromise;
  }

  private acceptMessage(message: unknown): void {
    if (this.stateValue !== "running") {
      return;
    }
    if (!isRecord(message)) {
      this.failProtocol(new JsonRpcProtocolError("JSON-RPC message must be an object"));
      return;
    }
    if (!this.validDialectHeader(message)) {
      return;
    }

    const methodPresent = hasOwn(message, "method");
    const idPresent = hasOwn(message, "id");
    const resultPresent = hasOwn(message, "result");
    const errorPresent = hasOwn(message, "error");

    if (methodPresent) {
      if (typeof message.method !== "string" || message.method.length === 0 || resultPresent || errorPresent) {
        this.failProtocol(new JsonRpcProtocolError("Invalid JSON-RPC request or notification shape"));
        return;
      }
      if (idPresent) {
        if (!isJsonRpcId(message.id)) {
          this.failProtocol(new JsonRpcProtocolError("JSON-RPC request id must be a string or finite number"));
          return;
        }
        void this.handleServerRequest(
          message.id,
          message.method,
          hasOwn(message, "params") ? message.params : undefined
        ).catch((error: unknown) => this.failTransport(error));
        return;
      }
      emit(this.notifications, {
        method: message.method,
        ...(hasOwn(message, "params") ? { params: message.params } : {})
      });
      return;
    }

    if (idPresent) {
      if (!isJsonRpcId(message.id) || resultPresent === errorPresent) {
        this.failProtocol(new JsonRpcProtocolError("Invalid JSON-RPC response shape"));
        return;
      }
      if (errorPresent && !isErrorObject(message.error)) {
        this.failProtocol(new JsonRpcProtocolError("Invalid JSON-RPC error object"));
        return;
      }
      if (resultPresent) {
        this.handleResponse(message.id, { result: message.result });
      } else {
        this.handleResponse(message.id, { error: message.error as JsonRpcErrorObject });
      }
      return;
    }

    if (resultPresent || errorPresent) {
      this.failProtocol(new JsonRpcProtocolError("JSON-RPC response is missing an id"));
      return;
    }
    emit(this.unknownMessages, { reason: "unknown_message", message });
  }

  private validDialectHeader(message: Record<string, unknown>): boolean {
    const present = hasOwn(message, "jsonrpc");
    if (this.dialect === "acp" && (!present || message.jsonrpc !== "2.0")) {
      this.failProtocol(new JsonRpcProtocolError("ACP message must include jsonrpc: \"2.0\""));
      return false;
    }
    if (this.dialect === "codex" && present && message.jsonrpc !== "2.0") {
      this.failProtocol(new JsonRpcProtocolError("Codex JSON-RPC header, when present, must be \"2.0\""));
      return false;
    }
    return true;
  }

  private handleResponse(
    id: JsonRpcId,
    response: { result: unknown } | { error: JsonRpcErrorObject }
  ): void {
    const key = idKey(id);
    const pending = this.pending.get(key);
    if (pending === undefined) {
      const reason = this.lateResponseReasons.get(key) ?? "orphan_response";
      this.lateResponseReasons.delete(key);
      emit(this.unknownMessages, {
        reason,
        message: this.frame({ id, ...response })
      });
      return;
    }

    this.pending.delete(key);
    cleanupPending(pending);
    if ("error" in response) {
      pending.reject(new JsonRpcRemoteError(id, response.error));
    } else {
      pending.resolve(response.result);
    }
  }

  private async handleServerRequest(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const key = idKey(id);
    if (this.inboundControllers.has(key)) {
      await this.sendError(id, { code: -32600, message: "Duplicate active request id" });
      return;
    }

    const controller = new AbortController();
    this.inboundControllers.set(key, controller);
    const handler = this.serverRequestHandler;
    if (handler === undefined) {
      try {
        await this.sendError(id, {
          code: -32601,
          message: `Method not found: ${boundDiagnosticText(method, 256)}`
        });
      } finally {
        this.inboundControllers.delete(key);
      }
      return;
    }

    try {
      const result = await handler({
        id,
        method,
        ...(params === undefined ? {} : { params }),
        signal: controller.signal
      });
      if (this.stateValue === "running" && !controller.signal.aborted) {
        await this.process.send(this.frame({ id, result: result === undefined ? null : result }));
      }
    } catch (error) {
      if (this.stateValue === "running" && !controller.signal.aborted) {
        if (error instanceof JsonRpcServerError) {
          await this.sendError(id, {
            code: error.code,
            message: boundDiagnosticText(error.message, 1_024),
            ...(error.data === undefined ? {} : { data: error.data })
          });
        } else {
          await this.sendError(id, { code: -32603, message: "Internal error" });
        }
      }
    } finally {
      this.inboundControllers.delete(key);
    }
  }

  private async sendError(id: JsonRpcId, error: JsonRpcErrorObject): Promise<void> {
    if (this.stateValue !== "running") {
      return;
    }
    await this.process.send(this.frame({ id, error }));
  }

  private frame(message: Record<string, unknown>): Record<string, unknown> {
    return this.dialect === "acp" ? { jsonrpc: "2.0", ...message } : message;
  }

  private allocateId(): JsonRpcId {
    if (!Number.isSafeInteger(this.nextRequestId)) {
      throw new RangeError("JSON-RPC request id space exhausted");
    }
    const numeric = this.nextRequestId++;
    return this.idPrefix.length === 0 ? numeric : `${this.idPrefix}${numeric}`;
  }

  private rejectPending(id: JsonRpcId, error: Error, lateReason: JsonRpcUnknownMessage["reason"]): boolean {
    const key = idKey(id);
    const pending = this.pending.get(key);
    if (pending === undefined) {
      return false;
    }
    this.pending.delete(key);
    cleanupPending(pending);
    pending.reject(error);

    // Keep the reason associated with the removed id so a later response is diagnostic only.
    this.lateResponseReasons.set(key, lateReason);
    if (this.lateResponseReasons.size > 1_024) {
      const oldest = this.lateResponseReasons.keys().next().value as string | undefined;
      if (oldest !== undefined) {
        this.lateResponseReasons.delete(oldest);
      }
    }
    return true;
  }

  private readonly lateResponseReasons = new Map<string, JsonRpcUnknownMessage["reason"]>();

  private rejectAll(error: Error): void {
    for (const pending of [...this.pending.values()]) {
      this.pending.delete(idKey(pending.id));
      cleanupPending(pending);
      pending.reject(error);
    }
  }

  private abortInbound(reason: Error): void {
    for (const controller of this.inboundControllers.values()) {
      controller.abort(reason);
    }
    this.inboundControllers.clear();
  }

  private failProtocol(error: JsonRpcProtocolError): void {
    if (this.protocolFailure !== undefined || this.stateValue === "closed") {
      return;
    }
    this.protocolFailure = error;
    this.stateValue = "failed";
    this.rejectAll(error);
    this.abortInbound(error);
    emit(this.protocolErrors, error);
    void this.process.terminate();
  }

  private failTransport(error: unknown): void {
    if (this.stateValue !== "running") {
      return;
    }
    const transportError = toTransportError(error);
    this.stateValue = "failed";
    this.rejectAll(transportError);
    this.abortInbound(transportError);
    void this.process.terminate();
  }

  private handleExit(exit: JsonLineProcessExit): void {
    if (this.stateValue !== "closing" && this.stateValue !== "failed") {
      this.stateValue = "failed";
      this.rejectAll(new JsonRpcProcessExitedError(exit));
      this.abortInbound(new JsonRpcProcessExitedError(exit));
    } else if (this.stateValue === "closing") {
      this.stateValue = "closed";
    }
    emit(this.exits, exit);
  }

  private assertRunning(): void {
    if (this.stateValue !== "running") {
      throw new JsonRpcTransportClosedError(this.closedMessage());
    }
  }

  private closedMessage(): string {
    return this.protocolFailure?.message ?? `The JSON-RPC transport is ${this.stateValue}`;
  }

  private disposeProcessListeners(): void {
    for (const dispose of this.processDisposers.splice(0)) {
      dispose();
    }
  }
}

/** Backwards-friendly process-oriented name for adapter implementations. */
export { JsonLineRpcClient as JsonLineRpcProcess };

function validateClientOptions(options: JsonLineRpcClientOptions): void {
  if (options.dialect !== "acp" && options.dialect !== "codex") {
    throw new TypeError("dialect must be acp or codex");
  }
  validateTimeout(options.defaultRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
}

function validateTimeout(timeout: number | false): void {
  if (timeout !== false && (!Number.isFinite(timeout) || timeout <= 0)) {
    throw new TypeError("timeoutMs must be false or a positive finite number");
  }
}

function validateMethod(method: string): void {
  if (typeof method !== "string" || method.length === 0) {
    throw new TypeError("JSON-RPC method must be a non-empty string");
  }
}

function rejectedHandle<TResult>(id: JsonRpcId, error: Error): JsonRpcRequestHandle<TResult> {
  return {
    id,
    promise: Promise.reject(error),
    cancel: () => false
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

function isErrorObject(value: unknown): value is JsonRpcErrorObject {
  return (
    isRecord(value) &&
    typeof value.code === "number" &&
    Number.isFinite(value.code) &&
    typeof value.message === "string"
  );
}

function idKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function cleanupPending(pending: PendingRequest): void {
  if (pending.timer !== undefined) {
    clearTimeout(pending.timer);
  }
  if (pending.signal !== undefined && pending.abortListener !== undefined) {
    pending.signal.removeEventListener("abort", pending.abortListener);
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
      // Diagnostic observers cannot be allowed to corrupt protocol state.
    }
  }
}

function abortMessage(signal: AbortSignal | undefined): string {
  if (signal?.reason instanceof Error) {
    return boundDiagnosticText(signal.reason.message, 512);
  }
  return "JSON-RPC request was aborted";
}

function toTransportError(error: unknown): Error {
  if (error instanceof Error) {
    return new JsonRpcTransportClosedError(boundDiagnosticText(error.message, 512));
  }
  return new JsonRpcTransportClosedError();
}

function fromLineProtocolError(error: JsonLineProtocolError): JsonRpcProtocolError {
  return new JsonRpcProtocolError(error.message, error);
}
