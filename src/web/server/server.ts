import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import {
  AgentActorIdSchema,
  ReferenceIdSchema,
  httpStatusForErrorCode,
  parseBootstrapResponse,
  parseCancelTurnRequest,
  parseCancelTurnResult,
  parseContractOutput,
  parseCreateMessageAccepted,
  parseCreateMessageRequest,
  parseEventsQuery,
  parseIdentityPage,
  parseIdentityQuery,
  parseMemoryPage,
  parseMemoryQuery,
  parseRememberIdentityAccepted,
  parseRememberIdentityRequest,
  parseRememberMemoryAccepted,
  parseRememberMemoryRequest,
  parseRestartAgentAccepted,
  parseRestartAgentRequest,
  parseSetupSaveRequest,
  parseSetupSaveResponse,
  parseSetupSnapshot,
  parseRetractIdentityRequest,
  parseRetractMemoryRequest,
  parseSupersedeIdentityRequest,
  parseSupersedeMemoryRequest,
  resolveEventCursor,
  toSafeErrorBody
} from "../../contracts/index.js";
import { GroupXError } from "../../core/errors.js";
import type { SseConnection, SseSink } from "../sse/index.js";
import type {
  GroupXHttpServerAddress,
  GroupXHttpServerOptions,
  McpHttpHandler
} from "./types.js";

const LOOPBACK_HOST = "127.0.0.1" as const;
const DEFAULT_PORT = 4_310;
const DEFAULT_BODY_LIMIT = 256 * 1_024;
const DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS = 5_000;

interface StaticAsset {
  readonly fileName:
    | "index.html"
    | "app.js"
    | "pagination.js"
    | "rich-text.js"
    | "tool-progress.js"
    | "styles.css"
    | "setup.html"
    | "setup.js"
    | "setup.css";
  readonly contentType: string;
}

const STATIC_ASSETS = new Map<string, StaticAsset>([
  ["/", { fileName: "index.html", contentType: "text/html; charset=utf-8" }],
  ["/app.js", { fileName: "app.js", contentType: "application/javascript; charset=utf-8" }],
  ["/pagination.js", { fileName: "pagination.js", contentType: "application/javascript; charset=utf-8" }],
  ["/rich-text.js", { fileName: "rich-text.js", contentType: "application/javascript; charset=utf-8" }],
  ["/tool-progress.js", { fileName: "tool-progress.js", contentType: "application/javascript; charset=utf-8" }],
  ["/styles.css", { fileName: "styles.css", contentType: "text/css; charset=utf-8" }],
  ["/setup", { fileName: "setup.html", contentType: "text/html; charset=utf-8" }],
  ["/setup.html", { fileName: "setup.html", contentType: "text/html; charset=utf-8" }],
  ["/setup.js", { fileName: "setup.js", contentType: "application/javascript; charset=utf-8" }],
  ["/setup.css", { fileName: "setup.css", contentType: "text/css; charset=utf-8" }]
]);

class HttpStatusError extends GroupXError {
  readonly status: number;

  constructor(status: number, code: GroupXError["code"]) {
    super(code, code);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function listenPort(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 65_535) {
    throw new RangeError("port must be an integer between 0 and 65535");
  }
  return value;
}

function requestUrl(request: IncomingMessage): URL {
  try {
    return new URL(request.url ?? "/", "http://127.0.0.1");
  } catch {
    throw new HttpStatusError(400, "INVALID_ENVELOPE");
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(payload));
  response.end(payload);
}

const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
  "img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; " +
  "form-action 'self'";

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
}

function writeProblem(
  response: ServerResponse,
  status: number,
  _message: string
): void {
  writeJson(response, status, toSafeErrorBody(new GroupXError("INVALID_ENVELOPE", "invalid path")));
}

function writeError(response: ServerResponse, error: unknown): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  if (response.headersSent) {
    response.end();
    return;
  }

  const status =
    error instanceof HttpStatusError
      ? error.status
      : error instanceof GroupXError
        ? httpStatusForErrorCode(error.code)
        : 500;
  writeJson(response, status, toSafeErrorBody(error));
}

function validateBrokerOutput<T>(parser: (input: unknown) => T, input: unknown): T {
  try {
    return parser(input);
  } catch (error: unknown) {
    throw new Error("Broker response failed its GroupX output contract", { cause: error });
  }
}

function requireJsonContentType(request: IncomingMessage): void {
  const contentType = request.headers["content-type"];
  if (
    typeof contentType !== "string" ||
    contentType.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  ) {
    throw new HttpStatusError(415, "INVALID_ENVELOPE");
  }
}

function declaredContentLength(request: IncomingMessage): number | undefined {
  const value = request.headers["content-length"];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new HttpStatusError(400, "INVALID_ENVELOPE");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new HttpStatusError(413, "MESSAGE_TOO_LARGE");
  }
  return parsed;
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  requireJsonContentType(request);
  const contentLength = declaredContentLength(request);
  if (contentLength !== undefined && contentLength > maxBytes) {
    drainRequest(request);
    throw new HttpStatusError(413, "MESSAGE_TOO_LARGE");
  }

  const raw = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const cleanup = (): void => {
      request.removeListener("data", onData);
      request.removeListener("end", onEnd);
      request.removeListener("error", onError);
      request.removeListener("aborted", onAborted);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > maxBytes) {
        drainRequest(request);
        fail(new HttpStatusError(413, "MESSAGE_TOO_LARGE"));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, total));
    };
    const onError = (error: Error): void => fail(error);
    const onAborted = (): void => {
      const error = new Error("HTTP request aborted by client");
      error.name = "AbortError";
      fail(error);
    };

    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });

  if (raw.length === 0) {
    throw new HttpStatusError(400, "INVALID_ENVELOPE");
  }
  try {
    return JSON.parse(raw.toString("utf8")) as unknown;
  } catch {
    throw new HttpStatusError(400, "INVALID_ENVELOPE");
  }
}

function drainRequest(request: IncomingMessage): void {
  const cleanup = (): void => {
    request.removeListener("end", cleanup);
    request.removeListener("aborted", cleanup);
    request.removeListener("error", cleanup);
    request.removeListener("close", cleanup);
  };
  request.once("end", cleanup);
  request.once("aborted", cleanup);
  request.once("error", cleanup);
  request.once("close", cleanup);
  request.resume();
}

function rawQuery(searchParams: URLSearchParams): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of searchParams) {
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      result[key] = [result[key], value];
    } else {
      result[key] = value;
    }
  }
  return result;
}

function memoryQuery(searchParams: URLSearchParams): ReturnType<typeof parseMemoryQuery> {
  const input = rawQuery(searchParams);
  if (typeof input.limit === "string" && /^\d+$/u.test(input.limit)) {
    input.limit = Number(input.limit);
  }
  if (input.includeHistory === "true") input.includeHistory = true;
  if (input.includeHistory === "false") input.includeHistory = false;
  return parseMemoryQuery(input);
}

function identityQuery(searchParams: URLSearchParams): ReturnType<typeof parseIdentityQuery> {
  const input = rawQuery(searchParams);
  if (typeof input.limit === "string" && /^\d+$/u.test(input.limit)) {
    input.limit = Number(input.limit);
  }
  if (input.includeHistory === "true") input.includeHistory = true;
  if (input.includeHistory === "false") input.includeHistory = false;
  return parseIdentityQuery(input);
}

function decodePathId(encoded: string, actor = false): string {
  let value: string;
  try {
    value = decodeURIComponent(encoded);
  } catch {
    throw new HttpStatusError(400, "INVALID_ENVELOPE");
  }
  return parseContractOutput(actor ? AgentActorIdSchema : ReferenceIdSchema, value);
}

function methodNotAllowed(response: ServerResponse, allowed: readonly string[]): void {
  response.setHeader("Allow", allowed.join(", "));
  writeProblem(response, 405, "The method is not supported for this path.");
}

function nodeResponseSink(response: ServerResponse): SseSink {
  return {
    async write(frame, signal) {
      if (signal.aborted || response.destroyed || response.writableEnded) {
        const error = new Error("SSE client is closed");
        error.name = "AbortError";
        throw error;
      }
      if (response.write(frame)) {
        return;
      }
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const cleanup = (): void => {
          response.removeListener("drain", onDrain);
          response.removeListener("error", onError);
          response.removeListener("close", onClose);
          signal.removeEventListener("abort", onAbort);
        };
        const finish = (error?: unknown): void => {
          if (settled) return;
          settled = true;
          cleanup();
          if (error === undefined) resolve();
          else reject(error);
        };
        const onDrain = (): void => finish();
        const onError = (error: Error): void => finish(error);
        const onClose = (): void => finish(new Error("SSE client closed"));
        const onAbort = (): void => {
          const error = new Error("SSE write aborted");
          error.name = "AbortError";
          finish(error);
        };
        response.once("drain", onDrain);
        response.once("error", onError);
        response.once("close", onClose);
        signal.addEventListener("abort", onAbort, { once: true });
      });
    },
    close() {
      if (!response.destroyed && !response.writableEnded) {
        response.end();
      }
    }
  };
}

function isMissingFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export class GroupXHttpServer {
  readonly #options: {
    readonly broker: GroupXHttpServerOptions["broker"];
    readonly sse: GroupXHttpServerOptions["sse"];
    readonly host: "127.0.0.1";
    readonly port: number;
    readonly staticRoot: string;
    readonly maxRequestBodyBytes: number;
    readonly gracefulCloseTimeoutMs: number;
    readonly mcpHandler?: McpHttpHandler;
    readonly setupApi?: GroupXHttpServerOptions["setupApi"];
  };
  readonly #server: Server;
  readonly #sseConnections = new Set<SseConnection>();
  readonly #requestControllers = new Set<AbortController>();

  #address: GroupXHttpServerAddress | undefined;
  #starting: Promise<GroupXHttpServerAddress> | undefined;
  #closing: Promise<void> | undefined;

  constructor(options: GroupXHttpServerOptions) {
    const host = options.host ?? LOOPBACK_HOST;
    if (host !== LOOPBACK_HOST) {
      throw new RangeError("GroupX M0-M2 HTTP server binds only to 127.0.0.1");
    }
    this.#options = {
      broker: options.broker,
      sse: options.sse,
      host,
      port: listenPort(options.port ?? DEFAULT_PORT),
      staticRoot: path.resolve(options.staticRoot ?? fileURLToPath(new URL("../../../web/", import.meta.url))),
      maxRequestBodyBytes: positiveSafeInteger(
        options.maxRequestBodyBytes ?? DEFAULT_BODY_LIMIT,
        "maxRequestBodyBytes"
      ),
      gracefulCloseTimeoutMs: positiveSafeInteger(
        options.gracefulCloseTimeoutMs ?? DEFAULT_GRACEFUL_CLOSE_TIMEOUT_MS,
        "gracefulCloseTimeoutMs"
      ),
      ...(options.mcpHandler === undefined ? {} : { mcpHandler: options.mcpHandler }),
      ...(options.setupApi === undefined ? {} : { setupApi: options.setupApi })
    };
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        writeError(response, error);
      });
    });
  }

  get address(): GroupXHttpServerAddress | undefined {
    return this.#address;
  }

  async start(): Promise<GroupXHttpServerAddress> {
    if (this.#address) return this.#address;
    if (this.#starting) return this.#starting;
    if (this.#closing) throw new Error("GroupX HTTP server is closing");

    this.#starting = new Promise<GroupXHttpServerAddress>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.#server.removeListener("listening", onListening);
        this.#starting = undefined;
        reject(error);
      };
      const onListening = (): void => {
        this.#server.removeListener("error", onError);
        const address = this.#server.address();
        if (address === null || typeof address === "string") {
          this.#starting = undefined;
          reject(new Error("GroupX HTTP server did not return a TCP address"));
          return;
        }
        const port = (address as AddressInfo).port;
        this.#address = {
          host: LOOPBACK_HOST,
          port,
          origin: `http://${LOOPBACK_HOST}:${port}`
        };
        this.#starting = undefined;
        resolve(this.#address);
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen(this.#options.port, LOOPBACK_HOST);
    });
    return this.#starting;
  }

  async close(): Promise<void> {
    if (this.#closing) return this.#closing;
    if (!this.#server.listening && !this.#starting) {
      this.#address = undefined;
      return;
    }

    const operation = (async () => {
      try {
        if (this.#starting) {
          await this.#starting.catch(() => undefined);
        }
        const closed = new Promise<void>((resolve, reject) => {
          this.#server.close((error?: Error) => {
            if (error) reject(error);
            else resolve();
          });
        });
        for (const connection of [...this.#sseConnections]) {
          connection.close("server_closed");
        }
        for (const controller of this.#requestControllers) {
          controller.abort();
        }
        this.#server.closeIdleConnections?.();
        const closeMcp = Promise.resolve()
          .then(async () => await this.#options.mcpHandler?.close?.())
          .finally(() => {
            // MCP clients can release their last active HTTP request while
            // handler.close() is running. Such a connection becomes idle
            // after the first closeIdleConnections() call, so sweep again
            // before waiting for server.close().
            this.#server.closeIdleConnections?.();
          });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            this.#server.closeAllConnections?.();
            reject(new Error("GroupX HTTP server graceful close timed out"));
          }, this.#options.gracefulCloseTimeoutMs);
        });
        const results = await Promise.allSettled([
          Promise.race([closed, deadline]),
          Promise.race([closeMcp, deadline])
        ]);
        if (timeout) clearTimeout(timeout);
        const failure = results.find(
          (result): result is PromiseRejectedResult => result.status === "rejected"
        );
        if (failure) throw failure.reason;
      } finally {
        this.#address = undefined;
        this.#requestControllers.clear();
        this.#sseConnections.clear();
      }
    })();
    this.#closing = operation;
    try {
      await operation;
    } finally {
      if (this.#closing === operation) {
        this.#closing = undefined;
      }
    }
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = requestUrl(request);
    const method = request.method ?? "GET";
    setSecurityHeaders(response);

    if (this.#closing) {
      writeJson(response, 503, toSafeErrorBody(new GroupXError("STORE_UNAVAILABLE", "closing")));
      return;
    }

    if (url.pathname === "/mcp" && this.#options.mcpHandler) {
      if (method !== "GET" && method !== "POST" && method !== "DELETE") {
        methodNotAllowed(response, ["GET", "POST", "DELETE"]);
        return;
      }
      await this.#options.mcpHandler.handle(request, response);
      return;
    }

    if (url.pathname === "/api/events") {
      if (method !== "GET") {
        methodNotAllowed(response, ["GET"]);
        return;
      }
      this.#openSse(request, response, url);
      return;
    }

    const abort = new AbortController();
    this.#requestControllers.add(abort);
    const onAborted = (): void => abort.abort();
    const onClosed = (): void => {
      if (!response.writableEnded) abort.abort();
    };
    request.once("aborted", onAborted);
    response.once("close", onClosed);
    try {
      if (url.pathname === "/api/health") {
        if (method !== "GET") return methodNotAllowed(response, ["GET"]);
        writeJson(response, 200, await this.#options.broker.health(abort.signal));
        return;
      }
      if (url.pathname === "/api/bootstrap") {
        if (method !== "GET") return methodNotAllowed(response, ["GET"]);
        writeJson(
          response,
          200,
          validateBrokerOutput(
            parseBootstrapResponse,
            await this.#options.broker.bootstrap(abort.signal)
          )
        );
        return;
      }
      if (url.pathname === "/api/setup") {
        if (!this.#options.setupApi) {
          writeProblem(response, 404, "The setup API is not available.");
          return;
        }
        if (method === "GET") {
          writeJson(
            response,
            200,
            validateBrokerOutput(parseSetupSnapshot, await this.#options.setupApi.snapshot(abort.signal))
          );
          return;
        }
        if (method === "POST") {
          const body = parseSetupSaveRequest(
            await readJsonBody(request, this.#options.maxRequestBodyBytes)
          );
          writeJson(
            response,
            200,
            validateBrokerOutput(
              parseSetupSaveResponse,
              await this.#options.setupApi.save(body, abort.signal)
            )
          );
          return;
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }
      if (url.pathname === "/api/messages") {
        if (method !== "POST") return methodNotAllowed(response, ["POST"]);
        const body = parseCreateMessageRequest(
          await readJsonBody(request, this.#options.maxRequestBodyBytes)
        );
        writeJson(
          response,
          202,
          validateBrokerOutput(
            parseCreateMessageAccepted,
            await this.#options.broker.createMessage(body, abort.signal)
          )
        );
        return;
      }
      if (url.pathname === "/api/memory") {
        if (method === "GET") {
          writeJson(response, 200, validateBrokerOutput(
            parseMemoryPage,
            await this.#options.broker.queryMemory(memoryQuery(url.searchParams), abort.signal)
          ));
          return;
        }
        if (method === "POST") {
          const body = parseRememberMemoryRequest(
            await readJsonBody(request, this.#options.maxRequestBodyBytes)
          );
          writeJson(response, 201, validateBrokerOutput(
            parseRememberMemoryAccepted,
            await this.#options.broker.rememberMemory(body, abort.signal)
          ));
          return;
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }
      if (url.pathname === "/api/identity") {
        if (method === "GET") {
          writeJson(response, 200, validateBrokerOutput(
            parseIdentityPage,
            await this.#options.broker.queryIdentity(identityQuery(url.searchParams), abort.signal)
          ));
          return;
        }
        if (method === "POST") {
          const body = parseRememberIdentityRequest(
            await readJsonBody(request, this.#options.maxRequestBodyBytes)
          );
          writeJson(response, 201, validateBrokerOutput(
            parseRememberIdentityAccepted,
            await this.#options.broker.rememberIdentity(body, abort.signal)
          ));
          return;
        }
        return methodNotAllowed(response, ["GET", "POST"]);
      }

      const cancelMatch = /^\/api\/turns\/([^/]+)\/cancel$/u.exec(url.pathname);
      if (cancelMatch?.[1]) {
        if (method !== "POST") return methodNotAllowed(response, ["POST"]);
        const turnId = decodePathId(cancelMatch[1]);
        const body = parseCancelTurnRequest(
          await readJsonBody(request, this.#options.maxRequestBodyBytes)
        );
        writeJson(response, 202, validateBrokerOutput(
          parseCancelTurnResult,
          await this.#options.broker.cancelTurn(turnId, body, abort.signal)
        ));
        return;
      }

      const supersedeMatch = /^\/api\/memory\/([^/]+)\/supersede$/u.exec(url.pathname);
      if (supersedeMatch?.[1]) {
        if (method !== "POST") return methodNotAllowed(response, ["POST"]);
        const memoryId = decodePathId(supersedeMatch[1]);
        const body = parseSupersedeMemoryRequest(
          await readJsonBody(request, this.#options.maxRequestBodyBytes)
        );
        writeJson(response, 201, validateBrokerOutput(
          parseRememberMemoryAccepted,
          await this.#options.broker.supersedeMemory(memoryId, body, abort.signal)
        ));
        return;
      }

      const retractMatch = /^\/api\/memory\/([^/]+)\/retract$/u.exec(url.pathname);
      if (retractMatch?.[1]) {
        if (method !== "POST") return methodNotAllowed(response, ["POST"]);
        const memoryId = decodePathId(retractMatch[1]);
        const body = parseRetractMemoryRequest(
          await readJsonBody(request, this.#options.maxRequestBodyBytes)
        );
        writeJson(response, 200, validateBrokerOutput(
          parseRememberMemoryAccepted,
          await this.#options.broker.retractMemory(memoryId, body, abort.signal)
        ));
        return;
      }

      const supersedeIdentityMatch = /^\/api\/identity\/([^/]+)\/supersede$/u.exec(
        url.pathname
      );
      if (supersedeIdentityMatch?.[1]) {
        if (method !== "POST") return methodNotAllowed(response, ["POST"]);
        const identityId = decodePathId(supersedeIdentityMatch[1]);
        const body = parseSupersedeIdentityRequest(
          await readJsonBody(request, this.#options.maxRequestBodyBytes)
        );
        writeJson(response, 201, validateBrokerOutput(
          parseRememberIdentityAccepted,
          await this.#options.broker.supersedeIdentity(identityId, body, abort.signal)
        ));
        return;
      }

      const retractIdentityMatch = /^\/api\/identity\/([^/]+)\/retract$/u.exec(url.pathname);
      if (retractIdentityMatch?.[1]) {
        if (method !== "POST") return methodNotAllowed(response, ["POST"]);
        const identityId = decodePathId(retractIdentityMatch[1]);
        const body = parseRetractIdentityRequest(
          await readJsonBody(request, this.#options.maxRequestBodyBytes)
        );
        writeJson(response, 200, validateBrokerOutput(
          parseRememberIdentityAccepted,
          await this.#options.broker.retractIdentity(identityId, body, abort.signal)
        ));
        return;
      }

      const restartMatch = /^\/api\/agents\/([^/]+)\/restart$/u.exec(url.pathname);
      if (restartMatch?.[1]) {
        if (method !== "POST") return methodNotAllowed(response, ["POST"]);
        const actorId = decodePathId(restartMatch[1], true);
        const body = parseRestartAgentRequest(
          await readJsonBody(request, this.#options.maxRequestBodyBytes)
        );
        writeJson(response, 202, validateBrokerOutput(
          parseRestartAgentAccepted,
          await this.#options.broker.restartAgent(actorId, body, abort.signal)
        ));
        return;
      }

      if (url.pathname.startsWith("/api/")) {
        writeProblem(response, 404, "The API path does not exist.");
        return;
      }

      await this.#serveStatic(method, url.pathname, response);
    } finally {
      this.#requestControllers.delete(abort);
      request.removeListener("aborted", onAborted);
      response.removeListener("close", onClosed);
    }
  }

  #openSse(request: IncomingMessage, response: ServerResponse, url: URL): void {
    const query = parseEventsQuery(rawQuery(url.searchParams));
    const afterSeq = resolveEventCursor({
      ...(query.afterSeq === undefined ? {} : { afterSeq: query.afterSeq }),
      lastEventId: request.headers["last-event-id"]
    });

    const clientAbort = new AbortController();
    const onClientClose = (): void => clientAbort.abort();
    request.once("aborted", onClientClose);
    response.once("close", onClientClose);
    if (request.aborted || request.destroyed || response.destroyed) {
      clientAbort.abort();
      throw new Error("SSE client disconnected before the stream opened");
    }

    response.statusCode = 200;
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();

    const connection = this.#options.sse.open({
      roomId: this.#options.broker.roomId,
      afterSeq,
      sink: nodeResponseSink(response),
      signal: clientAbort.signal
    });
    this.#sseConnections.add(connection);
    void connection.closed.finally(() => {
      request.removeListener("aborted", onClientClose);
      response.removeListener("close", onClientClose);
      this.#sseConnections.delete(connection);
    });
  }

  async #serveStatic(method: string, pathname: string, response: ServerResponse): Promise<void> {
    const asset = STATIC_ASSETS.get(pathname);
    if (!asset) {
      writeProblem(response, 404, "The static path does not exist.");
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      methodNotAllowed(response, ["GET", "HEAD"]);
      return;
    }

    let contents: Buffer;
    try {
      contents = await readFile(path.join(this.#options.staticRoot, asset.fileName));
    } catch (error: unknown) {
      if (isMissingFile(error)) {
        writeProblem(response, 404, "The static asset is not built.");
        return;
      }
      throw error;
    }

    response.statusCode = 200;
    response.setHeader("Content-Type", asset.contentType);
    response.setHeader("Content-Length", contents.length);
    response.setHeader("Cache-Control", "no-cache");
    if (method === "HEAD") response.end();
    else response.end(contents);
  }
}

export function createGroupXHttpServer(options: GroupXHttpServerOptions): GroupXHttpServer {
  return new GroupXHttpServer(options);
}
