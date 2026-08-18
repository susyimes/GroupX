import { createServer, type Server } from "node:http";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import type {
  ToolBrokerApi,
  ToolCallerContext
} from "../../../../src/mcp/server/broker-api.js";
import {
  GROUPX_MCP_BINDING_HEADER,
  createGroupXMcpHttpHandler,
  type GroupXMcpHttpHandler
} from "../../../../src/mcp/server/http.js";
import { McpBindingRegistry } from "../../../../src/mcp/binding-registry.js";

function createBroker(callers: ToolCallerContext[]): ToolBrokerApi {
  return {
    async send(caller, input) {
      callers.push(caller);
      return {
        messageEventId: `event-${caller.actorId}`,
        correlationId: `correlation-${caller.actorId}`,
        turns: input.to.map((target) => ({
          target,
          turnId: `turn-${caller.actorId}-${target}`,
          status: "queued" as const
        }))
      };
    },
    async ask() {
      throw new Error("unexpected ask");
    },
    async watch() {
      throw new Error("unexpected watch");
    },
    async steer() {
      throw new Error("unexpected steer");
    },
    async read() {
      throw new Error("unexpected read");
    },
    async memorySearch() {
      throw new Error("unexpected memorySearch");
    },
    async memoryRemember() {
      throw new Error("unexpected memoryRemember");
    },
    async coreMemoryRemember() {
      throw new Error("unexpected coreMemoryRemember");
    },
    async identityRead() {
      throw new Error("unexpected identityRead");
    },
    async identityRemember() {
      throw new Error("unexpected identityRemember");
    }
  };
}

async function listen(handler: GroupXMcpHttpHandler): Promise<{
  server: Server;
  url: URL;
}> {
  const server = createServer((request, response) => {
    void handler.handle(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("HTTP test server did not expose a TCP address");
  }
  return { server, url: new URL(`http://127.0.0.1:${address.port}/mcp`) };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).reverse().map((close) => close()));
});

describe("GroupX MCP Streamable HTTP handler", () => {
  it("maps the binding header to the actor on every stateless request", async () => {
    const callers: ToolCallerContext[] = [];
    const bindings = new McpBindingRegistry();
    bindings.register({
      bindingId: "binding-codex",
      actorId: "agent:codex",
      instanceId: "instance-codex"
    });
    bindings.register({
      bindingId: "binding-grok",
      actorId: "agent:grok",
      instanceId: "instance-grok"
    });
    const handler = createGroupXMcpHttpHandler({ broker: createBroker(callers), bindings });
    const http = await listen(handler);
    cleanup.push(async () => closeServer(http.server));
    cleanup.push(async () => handler.close());

    const clients = await Promise.all(
      ["binding-codex", "binding-grok"].map(async (bindingId) => {
        const client = new Client({ name: `client-${bindingId}`, version: "0.1.0" });
        const transport = new StreamableHTTPClientTransport(http.url, {
          requestInit: { headers: { [GROUPX_MCP_BINDING_HEADER]: bindingId } }
        });
        // SDK 1.30's HTTP transport declaration is not exactOptionalPropertyTypes-safe.
        await client.connect(transport as Parameters<Client["connect"]>[0]);
        return client;
      })
    );
    cleanup.push(...clients.map((client) => async () => client.close()));

    await Promise.all(
      clients.map((client, index) =>
        client.callTool({
          name: "send",
          arguments: {
            to: [index === 0 ? "agent:grok" : "agent:codex"],
            content: "hello",
            clientCommandId: `command-${index}`
          }
        })
      )
    );

    expect(handler.mode).toBe("stateless-per-request");
    expect(callers.map((caller) => caller.actorId).sort()).toEqual([
      "agent:codex",
      "agent:grok"
    ]);
    expect(callers.map((caller) => caller.bindingId).sort()).toEqual([
      "binding-codex",
      "binding-grok"
    ]);
  });

  it("reports missing and unknown binding handles as protocol mismatches, not auth", async () => {
    const bindings = new McpBindingRegistry();
    const handler = createGroupXMcpHttpHandler({ broker: createBroker([]), bindings });
    const http = await listen(handler);
    cleanup.push(async () => closeServer(http.server));
    cleanup.push(async () => handler.close());

    for (const headers of [
      { "content-type": "application/json" },
      {
        "content-type": "application/json",
        [GROUPX_MCP_BINDING_HEADER]: "unknown-binding"
      }
    ]) {
      const response = await fetch(http.url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "raw-test", version: "0.1.0" }
          }
        })
      });
      expect(response.status).toBe(400);
      expect(response.status).not.toBe(401);
      expect(response.status).not.toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: -32602, data: { code: "MCP_BINDING_MISMATCH" } },
        id: null
      });
    }
  });

  it("delegates GET and DELETE lifecycle handling to the stateless SDK transport", async () => {
    const bindings = new McpBindingRegistry();
    bindings.register({
      bindingId: "binding-kimi",
      actorId: "agent:kimi",
      instanceId: "instance-kimi"
    });
    const handler = createGroupXMcpHttpHandler({ broker: createBroker([]), bindings });
    const http = await listen(handler);
    cleanup.push(async () => closeServer(http.server));
    cleanup.push(async () => handler.close());

    const getAbort = new AbortController();
    const getResponse = await fetch(http.url, {
      headers: {
        accept: "text/event-stream",
        [GROUPX_MCP_BINDING_HEADER]: "binding-kimi"
      },
      signal: getAbort.signal
    });
    expect(getResponse.status).toBe(200);
    expect(getResponse.headers.get("content-type")).toContain("text/event-stream");
    getAbort.abort();
    await getResponse.body?.cancel().catch(() => undefined);

    const deleteResponse = await fetch(http.url, {
      method: "DELETE",
      headers: { [GROUPX_MCP_BINDING_HEADER]: "binding-kimi" }
    });
    expect(deleteResponse.status).toBe(200);
  });
});
