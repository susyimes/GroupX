import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import {
  httpStatusForErrorCode,
  parseSetupSaveRequest,
  parseSetupSaveResponse,
  parseSetupSnapshot,
  toSafeErrorBody,
  type SetupSaveResponse
} from "../../contracts/index.js";
import { GroupXError } from "../../core/errors.js";
import type { GroupXHttpServerAddress, SetupApi } from "../server/types.js";

const BODY_LIMIT = 256 * 1_024;
const STATIC_FILES = new Map<string, readonly [fileName: string, contentType: string]>([
  ["/", ["setup.html", "text/html; charset=utf-8"]],
  ["/setup", ["setup.html", "text/html; charset=utf-8"]],
  ["/setup.html", ["setup.html", "text/html; charset=utf-8"]],
  ["/setup.js", ["setup.js", "application/javascript; charset=utf-8"]],
  ["/setup.css", ["setup.css", "text/css; charset=utf-8"]]
]);

export interface GroupXSetupHttpServerOptions {
  readonly setupApi: SetupApi;
  readonly port?: number;
  readonly staticRoot?: string;
}

type SetupLaunchState =
  | { readonly status: "waiting" }
  | { readonly status: "ready"; readonly origin: string }
  | { readonly status: "failed"; readonly message: string };

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(payload));
  response.end(payload);
}

function setHeaders(response: ServerResponse): void {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
      "img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
}

function normalizeLoopbackOrigin(origin: string): string {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new GroupXError("INVALID_ENVELOPE", "Setup launch origin is invalid");
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.pathname !== "/" ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0 ||
    parsed.port.length === 0
  ) {
    throw new GroupXError("INVALID_ENVELOPE", "Setup launch origin must be a loopback HTTP origin");
  }
  return parsed.origin;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"];
  if (typeof contentType !== "string" || contentType.split(";", 1)[0]?.trim() !== "application/json") {
    throw new GroupXError("INVALID_ENVELOPE", "Setup requests require application/json");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += buffer.length;
    if (bytes > BODY_LIMIT) throw new GroupXError("MESSAGE_TOO_LARGE", "Setup request is too large");
    chunks.push(buffer);
  }
  if (bytes === 0) throw new GroupXError("INVALID_ENVELOPE", "Setup request is empty");
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")) as unknown;
  } catch {
    throw new GroupXError("INVALID_ENVELOPE", "Setup request is not valid JSON");
  }
}

export class GroupXSetupHttpServer {
  readonly #setupApi: SetupApi;
  readonly #port: number;
  readonly #staticRoot: string;
  readonly #server: Server;
  readonly #completed: Promise<SetupSaveResponse>;
  readonly #launchObserved: Promise<void>;
  #complete!: (result: SetupSaveResponse) => void;
  #observeLaunch!: () => void;
  #address: GroupXHttpServerAddress | undefined;
  #closePromise: Promise<void> | undefined;
  #saveState: "idle" | "saving" | "saved" = "idle";
  #launchState: SetupLaunchState = { status: "waiting" };

  constructor(options: GroupXSetupHttpServerOptions) {
    this.#setupApi = options.setupApi;
    this.#port = options.port ?? 0;
    this.#staticRoot = path.resolve(
      options.staticRoot ?? fileURLToPath(new URL("../../../web/", import.meta.url))
    );
    this.#completed = new Promise((resolve) => {
      this.#complete = resolve;
    });
    this.#launchObserved = new Promise((resolve) => {
      this.#observeLaunch = resolve;
    });
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        if (response.writableEnded || response.destroyed) return;
        const status = error instanceof GroupXError ? httpStatusForErrorCode(error.code) : 500;
        writeJson(response, status, toSafeErrorBody(error));
      });
    });
  }

  get address(): GroupXHttpServerAddress | undefined {
    return this.#address;
  }

  get completed(): Promise<SetupSaveResponse> {
    return this.#completed;
  }

  get launchObserved(): Promise<void> {
    return this.#launchObserved;
  }

  markLaunchReady(origin: string): void {
    if (this.#saveState !== "saved") {
      throw new GroupXError("CLIENT_COMMAND_CONFLICT", "Setup must be saved before launch readiness");
    }
    this.#launchState = { status: "ready", origin: normalizeLoopbackOrigin(origin) };
  }

  markLaunchFailed(): void {
    if (this.#saveState !== "saved") {
      throw new GroupXError("CLIENT_COMMAND_CONFLICT", "Setup must be saved before launch failure");
    }
    this.#launchState = {
      status: "failed",
      message: "GroupX 启动失败，请查看终端中的诊断信息。"
    };
  }

  async start(): Promise<GroupXHttpServerAddress> {
    if (this.#address) return this.#address;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.#server.removeListener("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.#server.removeListener("error", onError);
        resolve();
      };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen(this.#port, "127.0.0.1");
    });
    const address = this.#server.address() as AddressInfo;
    this.#address = {
      host: "127.0.0.1",
      port: address.port,
      origin: `http://127.0.0.1:${address.port}`
    };
    return this.#address;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    if (!this.#server.listening) return Promise.resolve();
    this.#closePromise = new Promise<void>((resolve, reject) => {
      this.#server.close((error) => (error ? reject(error) : resolve()));
      this.#server.closeIdleConnections?.();
    }).finally(() => {
      this.#address = undefined;
    });
    return this.#closePromise;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    setHeaders(response);
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";
    const abort = new AbortController();
    request.once("aborted", () => abort.abort());

    if (url.pathname === "/api/setup") {
      response.setHeader("Cache-Control", "no-store");
      if (method === "GET") {
        writeJson(response, 200, parseSetupSnapshot(await this.#setupApi.snapshot(abort.signal)));
        return;
      }
      if (method === "POST") {
        if (this.#saveState !== "idle") {
          throw new GroupXError("CLIENT_COMMAND_CONFLICT", "The setup configuration was already saved");
        }
        this.#saveState = "saving";
        let result: SetupSaveResponse;
        try {
          const requestBody = parseSetupSaveRequest(await readJson(request));
          result = parseSetupSaveResponse(await this.#setupApi.save(requestBody, abort.signal));
          this.#saveState = "saved";
        } catch (error) {
          this.#saveState = "idle";
          throw error;
        }
        writeJson(response, 200, result);
        this.#complete(result);
        return;
      }
      response.setHeader("Allow", "GET, POST");
      writeJson(response, 405, toSafeErrorBody(new GroupXError("INVALID_ENVELOPE", "method")));
      return;
    }

    if (url.pathname === "/api/setup/launch") {
      response.setHeader("Cache-Control", "no-store");
      if (method !== "GET") {
        response.setHeader("Allow", "GET");
        writeJson(response, 405, toSafeErrorBody(new GroupXError("INVALID_ENVELOPE", "method")));
        return;
      }
      writeJson(response, 200, this.#launchState);
      if (this.#launchState.status !== "waiting") this.#observeLaunch();
      return;
    }

    const asset = STATIC_FILES.get(url.pathname);
    if (!asset) {
      writeJson(response, 404, toSafeErrorBody(new GroupXError("INVALID_ENVELOPE", "path")));
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      writeJson(response, 405, toSafeErrorBody(new GroupXError("INVALID_ENVELOPE", "method")));
      return;
    }
    const [fileName, contentType] = asset;
    const contents = await readFile(path.join(this.#staticRoot, fileName));
    response.statusCode = 200;
    response.setHeader("Content-Type", contentType);
    response.setHeader("Content-Length", contents.length);
    response.setHeader("Cache-Control", "no-cache");
    if (method === "HEAD") response.end();
    else response.end(contents);
  }
}

export function createGroupXSetupHttpServer(
  options: GroupXSetupHttpServerOptions
): GroupXSetupHttpServer {
  return new GroupXSetupHttpServer(options);
}
