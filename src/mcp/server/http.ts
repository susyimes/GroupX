import type { IncomingMessage, ServerResponse } from "node:http";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { toSafeErrorBody, type KnownTargetOptions } from "../../contracts/index.js";
import { McpBindingRegistry } from "../binding-registry.js";
import type { ToolBrokerApi } from "./broker-api.js";
import { createGroupXMcpServer } from "./tools.js";

export const GROUPX_MCP_BINDING_HEADER = "X-GroupX-Binding" as const;

interface ActiveRequest {
  readonly server: McpServer;
  readonly transport: StreamableHTTPServerTransport;
  closed: boolean;
}

export interface GroupXMcpHttpHandler {
  /**
   * The SDK server/transport pair is recreated per HTTP request. Binding is
   * therefore explicit on every request and MCP session IDs are not used.
   */
  readonly mode: "stateless-per-request";
  readonly activeRequestCount: number;
  handle(
    request: IncomingMessage,
    response: ServerResponse,
    parsedBody?: unknown
  ): Promise<void>;
  close(): Promise<void>;
}

export interface CreateGroupXMcpHttpHandlerOptions extends KnownTargetOptions {
  readonly broker: ToolBrokerApi;
  readonly bindings: McpBindingRegistry;
}

function readBindingId(request: IncomingMessage): string {
  const header = request.headers[GROUPX_MCP_BINDING_HEADER.toLowerCase()];
  if (typeof header !== "string" || header.trim().length === 0) {
    throw new Error("MCP binding header is missing");
  }
  return header.trim();
}

function writeJsonRpcError(
  response: ServerResponse,
  input: {
    readonly status: number;
    readonly rpcCode: number;
    readonly code: string;
    readonly message: string;
  }
): void {
  if (response.headersSent || response.writableEnded) {
    return;
  }
  const body = JSON.stringify({
    jsonrpc: "2.0",
    error: {
      code: input.rpcCode,
      message: input.message,
      data: { code: input.code }
    },
    id: null
  });
  response.writeHead(input.status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

/**
 * Creates the loopback HTTP MCP product handler.
 *
 * `X-GroupX-Binding` is a normal per-session provenance handle. Missing,
 * unknown and closed handles are protocol mismatches (HTTP 400), not
 * authentication failures, and this layer never returns 401/403 or evaluates
 * CLI permissions.
 */
export function createGroupXMcpHttpHandler(
  options: CreateGroupXMcpHttpHandlerOptions
): GroupXMcpHttpHandler {
  const activeRequests = new Set<ActiveRequest>();
  let closed = false;

  async function closeRequest(active: ActiveRequest): Promise<void> {
    if (active.closed) {
      return;
    }
    active.closed = true;
    activeRequests.delete(active);
    await active.server.close();
  }

  return {
    mode: "stateless-per-request",

    get activeRequestCount(): number {
      return activeRequests.size;
    },

    async handle(request, response, parsedBody): Promise<void> {
      if (closed) {
        writeJsonRpcError(response, {
          status: 503,
          rpcCode: -32603,
          code: "INTERNAL_ERROR",
          message: "GroupX MCP handler is closed."
        });
        return;
      }

      let binding;
      try {
        binding = options.bindings.require(readBindingId(request));
      } catch (error) {
        const safe = toSafeErrorBody(error);
        writeJsonRpcError(response, {
          status: 400,
          rpcCode: -32602,
          code: "MCP_BINDING_MISMATCH",
          message:
            safe.error.code === "MCP_BINDING_MISMATCH"
              ? safe.error.message
              : "The MCP caller binding is not valid for this request."
        });
        return;
      }

      const server = createGroupXMcpServer({
        broker: options.broker,
        binding,
        ...(options.knownTargets === undefined ? {} : { knownTargets: options.knownTargets })
      });
      const transport = new StreamableHTTPServerTransport({
        enableJsonResponse: true
      });
      const active: ActiveRequest = { server, transport, closed: false };
      activeRequests.add(active);

      const cleanup = (): void => {
        void closeRequest(active);
      };
      response.once("close", cleanup);

      try {
        // SDK 1.30's Node wrapper declaration is not exactOptionalPropertyTypes-safe.
        await server.connect(transport as Parameters<McpServer["connect"]>[0]);
        await transport.handleRequest(request, response, parsedBody);
      } catch {
        writeJsonRpcError(response, {
          status: 500,
          rpcCode: -32603,
          code: "INTERNAL_ERROR",
          message: "The GroupX MCP request could not be completed."
        });
      } finally {
        if (response.writableEnded || response.destroyed) {
          await closeRequest(active);
        }
      }
    },

    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await Promise.all([...activeRequests].map((active) => closeRequest(active)));
    }
  };
}
