import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  JsonLineRpcClient,
  JsonRpcProcessExitedError,
  JsonRpcProtocolError,
  JsonRpcRemoteError,
  JsonRpcRequestTimeoutError,
  type JsonRpcDialect
} from "../../../src/adapters/jsonline-rpc.js";
import { JsonLineProcess } from "../../../src/supervisor/jsonline-process.js";

const fixturePath = fileURLToPath(new URL("../../fixtures/rpc/fixture-child.mjs", import.meta.url));
const activeClients = new Set<JsonLineRpcClient>();

afterEach(async () => {
  await Promise.all(
    [...activeClients].map(async (client) => {
      try {
        await client.close();
      } finally {
        activeClients.delete(client);
      }
    })
  );
});

describe("JsonLineRpcClient", () => {
  it("performs ACP and Codex handshakes with their respective wire headers", async () => {
    const acp = fixtureClient("acp").client;
    const codex = fixtureClient("codex").client;

    await expect(acp.request("initialize", { client: "groupx" })).resolves.toMatchObject({
      fixture: true,
      receivedJsonrpc: "2.0"
    });
    await acp.notify("initialized");
    await expect(acp.request("fixture/state")).resolves.toMatchObject({ initialized: true });

    await expect(codex.request("initialize", { client: "groupx" })).resolves.toMatchObject({
      fixture: true,
      receivedJsonrpc: null
    });
    await codex.notify("initialized");
    await expect(codex.request("fixture/state")).resolves.toMatchObject({ initialized: true });
  });

  it("correlates concurrent responses by id when they arrive out of order", async () => {
    const client = fixtureClient("acp").client;

    const slow = client.request("fixture/delay", { ms: 60, value: "slow" });
    const fast = client.request("fixture/delay", { ms: 5, value: "fast" });
    const middle = client.request("fixture/delay", { ms: 30, value: "middle" });

    await expect(Promise.all([slow, fast, middle])).resolves.toEqual(["slow", "fast", "middle"]);
    expect(client.pendingRequestCount).toBe(0);
  });

  it.each([0, ""])("handles a server-initiated request with id %j and returns exactly one response", async (id) => {
    const client = fixtureClient("acp").client;
    const observed: Array<string | number> = [];
    const before = (await client.request("fixture/state")) as { responseCount: number };
    client.setServerRequestHandler(async (request) => {
      observed.push(request.id);
      expect(request.method).toBe("fixture/permission");
      expect(request.signal.aborted).toBe(false);
      await delay(5);
      return { decision: "fixture-approved" };
    });

    await expect(client.request("fixture/serverRequest", { id })).resolves.toEqual({
      serverResult: { decision: "fixture-approved" }
    });
    const after = (await client.request("fixture/state")) as { responseCount: number };
    expect(observed).toEqual([id]);
    expect(after.responseCount - before.responseCount).toBe(1);
  });

  it("returns method-not-found for an unhandled server request without inventing an approval", async () => {
    const client = fixtureClient("acp").client;

    await expect(client.request("fixture/serverRequest", { id: "unhandled" })).resolves.toEqual({
      serverError: {
        code: -32601,
        message: "Method not found: fixture/permission"
      }
    });
  });

  it("delivers notifications and ignores well-formed unknown/orphan messages without desynchronizing", async () => {
    const client = fixtureClient("acp").client;
    const notifications: unknown[] = [];
    const unknown: Array<{ reason: string }> = [];
    client.onNotification((notification) => notifications.push(notification));
    client.onUnknownMessage((message) => unknown.push(message));

    await expect(client.request("fixture/notification")).resolves.toBe(true);
    await expect(client.request("fixture/unknown")).resolves.toBe(true);
    await expect(client.request("fixture/orphanResponse")).resolves.toBe(true);
    await expect(client.request("fixture/echo", { still: "ready" })).resolves.toEqual({ still: "ready" });

    expect(notifications).toContainEqual({ method: "fixture/progress", params: { text: "halfway" } });
    expect(unknown.map((entry) => entry.reason)).toEqual(["unknown_message", "orphan_response"]);
  });

  it("isolates remote request errors and remains usable", async () => {
    const client = fixtureClient("acp").client;

    const error = await client.request("fixture/not-found").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JsonRpcRemoteError);
    expect((error as JsonRpcRemoteError).code).toBe(-32601);
    await expect(client.request("fixture/echo", { ok: true })).resolves.toEqual({ ok: true });
  });

  it("times out or aborts only local waits, accepts timeout=false, and stays reusable", async () => {
    const client = fixtureClient("acp", { defaultRequestTimeoutMs: 20 }).client;
    const unknown: Array<{ reason: string }> = [];
    client.onUnknownMessage((message) => unknown.push(message));

    await expect(client.request("fixture/delay", { ms: 50, value: "late-timeout" })).rejects.toBeInstanceOf(
      JsonRpcRequestTimeoutError
    );
    await expect(
      client.request("fixture/delay", { ms: 35, value: "no-timeout" }, { timeoutMs: false })
    ).resolves.toBe("no-timeout");

    const controller = new AbortController();
    const delayed = client.request("fixture/delay", { ms: 50, value: "late" }, { signal: controller.signal });
    await delay(5);
    controller.abort(new Error("test abort"));
    await expect(delayed).rejects.toMatchObject({ name: "AbortError" });
    await delay(60);

    expect(unknown.map((entry) => entry.reason)).toContain("late_response");
    await expect(client.request("fixture/echo", { after: "abort" })).resolves.toEqual({ after: "abort" });
  });

  it("does not write a request when its AbortSignal is already aborted", async () => {
    const client = fixtureClient("acp").client;
    const before = (await client.request("fixture/state")) as { requestCount: number };
    const controller = new AbortController();
    controller.abort();

    await expect(client.request("fixture/echo", { hidden: true }, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError"
    });
    const after = (await client.request("fixture/state")) as { requestCount: number };

    expect(after.requestCount).toBe(before.requestCount + 1);
  });

  it("supports explicit local cancellation without manufacturing a native cancel method", async () => {
    const client = fixtureClient("codex").client;
    const unknown: Array<{ reason: string }> = [];
    client.onUnknownMessage((message) => unknown.push(message));
    const request = client.beginRequest("fixture/delay", { ms: 35, value: "late-after-cancel" }, { timeoutMs: false });

    expect(request.cancel("fixture local cancel")).toBe(true);
    expect(request.cancel()).toBe(false);
    await expect(request.promise).rejects.toMatchObject({ name: "AbortError" });
    await waitFor(() => unknown.some((entry) => entry.reason === "late_response"));

    expect(unknown.map((entry) => entry.reason)).toContain("late_response");
    await expect(client.request("fixture/echo", { still: "usable" })).resolves.toEqual({ still: "usable" });
  });

  it("turns malformed stdout into a transport-fatal protocol error", async () => {
    const { client } = fixtureClient("acp");
    const protocolErrors: JsonRpcProtocolError[] = [];
    client.onProtocolError((error) => protocolErrors.push(error));

    const pending = client.request("fixture/malformed", { kind: "syntax" }, { timeoutMs: false });

    await expect(pending).rejects.toBeInstanceOf(JsonRpcProtocolError);
    expect(protocolErrors).toHaveLength(1);
    expect(client.state).toBe("failed");
    await expect(client.request("fixture/echo")).rejects.toThrow(/malformed JSON|failed/i);
    await client.close();
    expect(client.state).toBe("failed");
  });

  it.each(["bothResultAndError", "missingId", "badMethod"])(
    "rejects a well-formed JSON frame with invalid RPC shape: %s",
    async (kind) => {
      const client = fixtureClient("acp").client;
      const pending = client.request("fixture/raw", { kind }, { timeoutMs: false });

      await expect(pending).rejects.toBeInstanceOf(JsonRpcProtocolError);
      expect(client.state).toBe("failed");
      expect(client.pendingRequestCount).toBe(0);
    }
  );

  it("rejects missing ACP and invalid Codex JSON-RPC headers", async () => {
    const headerlessAcp = fixtureClient("acp", {}, "codex").client;
    await expect(headerlessAcp.request("initialize", {}, { timeoutMs: false })).rejects.toBeInstanceOf(
      JsonRpcProtocolError
    );

    const invalidCodex = fixtureClient("codex").client;
    await expect(invalidCodex.request("fixture/raw", { kind: "invalidHeader" }, { timeoutMs: false })).rejects.toBeInstanceOf(
      JsonRpcProtocolError
    );
  });

  it("rejects pending requests on unexpected exit while another process remains healthy", async () => {
    const firstFixture = fixtureClient("acp");
    const first = firstFixture.client;
    const second = fixtureClient("acp").client;
    const pending = first.request("fixture/hang", undefined, { timeoutMs: false });

    await first.notify("fixture/exitNow", { code: 23 });

    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JsonRpcProcessExitedError);
    expect((error as JsonRpcProcessExitedError).exit.code).toBe(23);
    expect(first.state).toBe("failed");
    expect(first.pendingRequestCount).toBe(0);
    expect(pidAlive(firstFixture.process.pid as number)).toBe(false);
    await expect(second.request("fixture/echo", { isolated: true })).resolves.toEqual({ isolated: true });
  });

  it("closes with pending work, rejects new requests, and leaves no process behind", async () => {
    const { client, process: child } = fixtureClient("codex");
    const pid = child.pid;
    const pending = client.request("fixture/hang", undefined, { timeoutMs: false });

    const firstClose = client.close();
    const secondClose = client.close();
    expect(secondClose).toBe(firstClose);
    await expect(pending).rejects.toThrow(/closed/i);
    await expect(client.request("fixture/echo")).rejects.toThrow(/closing|closed/i);
    const exit = await firstClose;

    expect(exit.expected).toBe(true);
    expect(client.pendingRequestCount).toBe(0);
    expect(pid).toEqual(expect.any(Number));
    expect(pidAlive(pid as number)).toBe(false);
  });
});

function fixtureClient(
  dialect: JsonRpcDialect,
  options: { defaultRequestTimeoutMs?: number | false } = {},
  fixtureDialect: JsonRpcDialect = dialect
): { client: JsonLineRpcClient; process: JsonLineProcess } {
  const child = JsonLineProcess.spawn({
    argv: [process.execPath, fixturePath, `--dialect=${fixtureDialect}`],
    cwd: process.cwd(),
    closeGraceMs: 500,
    killGraceMs: 1_000
  });
  const client = new JsonLineRpcClient(child, { dialect, ...options });
  activeClients.add(client);
  return { client, process: child };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for RPC fixture state");
    }
    await delay(5);
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
