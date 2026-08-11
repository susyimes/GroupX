import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { GrokAcpAdapter, KimiAcpAdapter } from "../../../../src/adapters/acp/index.js";
import type { NativeEvent, NativeSession } from "../../../../src/adapters/types.js";
import { GroupXError } from "../../../../src/core/errors.js";

const FIXTURE_SOURCE = fileURLToPath(new URL("../../../fixtures/acp", import.meta.url));
const workspaces: string[] = [];
const liveSessions: Array<{
  adapter: GrokAcpAdapter | KimiAcpAdapter;
  session: NativeSession;
}> = [];

afterEach(async () => {
  for (const { adapter, session } of liveSessions.splice(0)) {
    await adapter.close(session).catch(() => undefined);
  }
  for (const workspace of workspaces.splice(0)) {
    await rm(workspace, { recursive: true, force: true });
  }
});

describe("ACP v1 adapter kernel", () => {
  it("starts Grok with fixed argv, performs initialize without initialized, and attaches stdio MCP", async () => {
    const workspace = await fixtureWorkspace();
    const adapter = grokAdapter();
    const session = await adapter.start({
      command: process.execPath,
      prefixArgs: fixturePrefixArgs(workspace),
      cwd: workspace,
      brokerUrl: "http://ignored.invalid",
      instanceId: "instance:grok:prebound",
      bindingId: "binding:grok:test",
      mcp: {
        transport: "stdio",
        command: process.execPath,
        args: ["groupx-mcp.mjs"]
      }
    });
    liveSessions.push({ adapter, session });

    expect(session).toMatchObject({
      adapterId: "grok",
      actorId: "agent:grok",
      instanceId: "instance:grok:prebound",
      bindingId: "binding:grok:test",
      nativeSessionId: "fixture-session-1",
      protocol: "acp"
    });
    expect(adapter.health()).toMatchObject({ status: "ready", nativeSessionAvailable: true });
    expect((await adapter.probe()).launchArgvShape).toEqual([
      process.execPath,
      ...fixturePrefixArgs(workspace),
      "--no-auto-update",
      "--permission-mode",
      "bypassPermissions",
      "--sandbox",
      "off",
      "--no-plan",
      "agent",
      "stdio"
    ]);

    await adapter.close(session);
    liveSessions.pop();
    const entries = await wireLog(workspace);
    expect(entries.find((entry) => entry.event === "startup")).toMatchObject({
      script: "fixture-agent.mjs",
      argv: [
        "--no-auto-update",
        "--permission-mode",
        "bypassPermissions",
        "--sandbox",
        "off",
        "--no-plan",
        "agent",
        "stdio"
      ]
    });

    const inbound = incomingFrames(entries);
    expect(inbound.map((frame) => frame.method)).toEqual([
      "initialize",
      "session/new",
      "session/close"
    ]);
    expect(inbound.some((frame) => frame.method === "initialized")).toBe(false);
    expect(inbound[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "groupx", title: "GroupX", version: "0.1.0" }
      }
    });
    expect(inbound[1]).toMatchObject({
      method: "session/new",
      params: {
        cwd: workspace,
        mcpServers: [
          {
            name: "groupx",
            command: process.execPath,
            args: ["groupx-mcp.mjs", "--binding", "binding:grok:test"],
            env: []
          }
        ]
      }
    });
    expect(JSON.stringify(inbound)).not.toContain("ignored.invalid");
  });

  it("starts Kimi with fixed argv and gates HTTP MCP on the negotiated capability", async () => {
    const workspace = await fixtureWorkspace({
      agentCapabilities: { loadSession: false, mcpCapabilities: { http: true }, sessionCapabilities: {} }
    });
    const adapter = kimiAdapter();
    const session = await adapter.start({
      command: process.execPath,
      prefixArgs: fixturePrefixArgs(workspace),
      cwd: workspace,
      instanceId: "instance:kimi:http",
      bindingId: "binding:kimi:http",
      mcp: { transport: "streamable-http", url: "http://127.0.0.1:4310/mcp/kimi" }
    });
    liveSessions.push({ adapter, session });
    await adapter.close(session);
    liveSessions.pop();

    const entries = await wireLog(workspace);
    expect(entries.find((entry) => entry.event === "startup")).toMatchObject({
      script: "fixture-agent.mjs",
      argv: ["acp"]
    });
    expect(incomingFrames(entries).map((frame) => frame.method)).toEqual([
      "initialize",
      "session/new",
      "session/set_mode"
    ]);
    expect(incomingFrames(entries).find((frame) => frame.method === "session/set_mode")).toMatchObject({
      params: { sessionId: session.nativeSessionId, modeId: "auto" }
    });
    expect(incomingFrames(entries).find((frame) => frame.method === "session/new")).toMatchObject({
      params: {
        mcpServers: [
          {
            type: "http",
            name: "groupx",
            url: "http://127.0.0.1:4310/mcp/kimi",
            headers: [{ name: "X-GroupX-Binding", value: "binding:kimi:http" }]
          }
        ]
      }
    });

    const unsupportedWorkspace = await fixtureWorkspace({ agentCapabilities: {} });
    const unsupported = kimiAdapter();
    await expect(
      unsupported.start({
        command: process.execPath,
        prefixArgs: fixturePrefixArgs(unsupportedWorkspace),
        cwd: unsupportedWorkspace,
        instanceId: "instance:kimi:http-unsupported",
        bindingId: "binding:kimi:http-unsupported",
        mcp: { transport: "streamable-http", url: "http://127.0.0.1:4310/mcp/kimi" }
      })
    ).rejects.toMatchObject({ code: "ADAPTER_START_FAILED" });
    expect(unsupported.health()).toMatchObject({ status: "failed", nativeSessionAvailable: false });
    expect(incomingFrames(await wireLog(unsupportedWorkspace)).map((frame) => frame.method)).toEqual([
      "initialize"
    ]);
  });

  it("fails Kimi config preflight before spawning the ACP process", async () => {
    const workspace = await fixtureWorkspace();
    const adapter = new KimiAcpAdapter({
      handshakeTimeoutMs: 1_000,
      closeGraceMs: 250,
      killGraceMs: 250,
      configPreflight: async () => {
        throw new GroupXError(
          "ADAPTER_START_FAILED",
          "Kimi unrestricted preflight requires default_plan_mode to be false"
        );
      }
    });

    await expect(
      adapter.start({
        command: process.execPath,
        prefixArgs: fixturePrefixArgs(workspace),
        cwd: workspace,
        instanceId: "instance:kimi:preflight",
        bindingId: "binding:kimi:preflight"
      })
    ).rejects.toMatchObject({
      code: "ADAPTER_START_FAILED",
      message: "Kimi unrestricted preflight requires default_plan_mode to be false"
    });
    expect(adapter.health()).toMatchObject({
      status: "failed",
      nativeSessionAvailable: false
    });
    await expect(readFile(join(workspace, "wire-log.jsonl"), "utf8")).rejects.toMatchObject({
      code: "ENOENT"
    });
  });

  it("uses session/load only when loadSession was advertised", async () => {
    const workspace = await fixtureWorkspace({
      replayOnLoad: true,
      agentCapabilities: { loadSession: true, mcpCapabilities: {}, sessionCapabilities: {} }
    });
    const adapter = grokAdapter();
    const session = await adapter.resume({
      command: process.execPath,
      prefixArgs: fixturePrefixArgs(workspace),
      cwd: workspace,
      instanceId: "instance:grok:resume",
      bindingId: "binding:grok:resume",
      nativeSessionId: "existing-session",
      mcp: { transport: "stdio", command: process.execPath, args: ["groupx-mcp.mjs"] }
    });
    liveSessions.push({ adapter, session });
    expect(session.nativeSessionId).toBe("existing-session");
    expect(adapter.takeLoadReplay(session)).toEqual([
      {
        sessionId: "existing-session",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "replay-message",
          content: { type: "text", text: "replayed history" }
        }
      }
    ]);
    expect(adapter.takeLoadReplay(session)).toEqual([]);
    expect((await adapter.probe()).findings).toContainEqual(
      expect.objectContaining({ capability: "session.load", level: "verified" })
    );
    await adapter.close(session);
    liveSessions.pop();

    expect(incomingFrames(await wireLog(workspace)).find((frame) => frame.method === "session/load")).toMatchObject({
      params: {
        sessionId: "existing-session",
        cwd: workspace,
        mcpServers: [expect.objectContaining({ name: "groupx" })]
      }
    });

    const unsupportedWorkspace = await fixtureWorkspace({ agentCapabilities: { loadSession: false } });
    const unsupported = grokAdapter();
    await expect(
      unsupported.resume({
        command: process.execPath,
        prefixArgs: fixturePrefixArgs(unsupportedWorkspace),
        cwd: unsupportedWorkspace,
        nativeSessionId: "existing-session"
      })
    ).rejects.toMatchObject({ code: "NATIVE_RESUME_UNSUPPORTED" });
    expect(incomingFrames(await wireLog(unsupportedWorkspace)).some((frame) => frame.method === "session/load")).toBe(
      false
    );
  });

  it("reapplies Kimi auto mode after session/load and waits for its matching response", async () => {
    const workspace = await fixtureWorkspace({
      replayOnLoad: true,
      setMode: { emitUpdates: true },
      agentCapabilities: { loadSession: true, mcpCapabilities: {}, sessionCapabilities: {} }
    });
    const adapter = kimiAdapter();
    const session = await adapter.resume({
      command: process.execPath,
      prefixArgs: fixturePrefixArgs(workspace),
      cwd: workspace,
      nativeSessionId: "existing-kimi-session"
    });
    liveSessions.push({ adapter, session });

    expect(adapter.takeLoadReplay(session)).toEqual([
      expect.objectContaining({
        sessionId: "existing-kimi-session",
        update: expect.objectContaining({ messageId: "replay-message" })
      })
    ]);
    await adapter.close(session);
    liveSessions.pop();

    const incoming = incomingFrames(await wireLog(workspace));
    expect(incoming.map((frame) => frame.method)).toEqual([
      "initialize",
      "session/load",
      "session/set_mode"
    ]);
    expect(incoming[2]).toMatchObject({
      method: "session/set_mode",
      params: { sessionId: "existing-kimi-session", modeId: "auto" }
    });
    expect(incoming.some((frame) => frame.method === "session/prompt")).toBe(false);
  });

  it("fails Kimi startup when auto mode cannot be established and classifies only explicit policy blocks", async () => {
    const genericWorkspace = await fixtureWorkspace({
      setMode: { error: { code: -32000, message: "Forbidden", data: { reason: "forbidden" } } }
    });
    const generic = kimiAdapter();
    await expect(
      generic.start({
        command: process.execPath,
        prefixArgs: fixturePrefixArgs(genericWorkspace),
        cwd: genericWorkspace
      })
    ).rejects.toMatchObject({ code: "ADAPTER_START_FAILED" });
    expect(incomingFrames(await wireLog(genericWorkspace)).some((frame) => frame.method === "session/prompt")).toBe(
      false
    );

    const policyWorkspace = await fixtureWorkspace({
      setMode: {
        error: { code: -32000, message: "Mode locked by policy", data: { reason: "policy_locked" } }
      }
    });
    const policy = kimiAdapter();
    await expect(
      policy.start({
        command: process.execPath,
        prefixArgs: fixturePrefixArgs(policyWorkspace),
        cwd: policyWorkspace
      })
    ).rejects.toMatchObject({ code: "NATIVE_POLICY_BLOCKED" });
  });

  it("settles and cancels a Kimi permission request raised during session/set_mode", async () => {
    const workspace = await fixtureWorkspace({ setMode: { permission: true } });
    const adapter = kimiAdapter();
    await expect(
      adapter.start({
        command: process.execPath,
        prefixArgs: fixturePrefixArgs(workspace),
        cwd: workspace
      })
    ).rejects.toMatchObject({ code: "UNEXPECTED_NATIVE_INTERACTION" });

    const entries = await wireLog(workspace);
    const request = outgoingFrames(entries).find((frame) => frame.method === "session/request_permission");
    const incoming = incomingFrames(entries);
    const permissionResponse = incoming.find(
      (frame) => frame.id === request?.id && frame.result !== undefined
    );
    const cancellation = incoming.find((frame) => frame.method === "session/cancel");
    const responseWireIndex = entries.findIndex(
      (entry) => entry.direction === "in" && entry.frame?.id === request?.id && entry.frame?.result !== undefined
    );
    const cancelWireIndex = entries.findIndex(
      (entry) => entry.direction === "in" && entry.frame?.method === "session/cancel"
    );
    expect(request).toBeDefined();
    expect(permissionResponse).toEqual({
      jsonrpc: "2.0",
      id: request?.id,
      result: { outcome: { outcome: "cancelled" } }
    });
    expect(cancellation).toMatchObject({
      jsonrpc: "2.0",
      params: { sessionId: "fixture-session-1" }
    });
    expect(Object.hasOwn(cancellation ?? {}, "id")).toBe(false);
    expect(responseWireIndex).toBeGreaterThanOrEqual(0);
    expect(cancelWireIndex).toBeGreaterThan(responseWireIndex);
    expect(incoming.some((frame) => frame.method === "session/prompt")).toBe(false);
  });

  it("maps a Grok managed-policy stderr marker to NATIVE_POLICY_BLOCKED before session/new", async () => {
    const workspace = await fixtureWorkspace({
      stderrAfterInitialize: "always-approve enable blocked by managed policy\n"
    });
    const adapter = grokAdapter();
    await expect(
      adapter.start({
        command: process.execPath,
        prefixArgs: fixturePrefixArgs(workspace),
        cwd: workspace
      })
    ).rejects.toMatchObject({ code: "NATIVE_POLICY_BLOCKED" });
    expect(incomingFrames(await wireLog(workspace)).map((frame) => frame.method)).toEqual(["initialize"]);
  });

  it("does not send prompt or cancel for an already-aborted prompt", async () => {
    const workspace = await fixtureWorkspace();
    const adapter = grokAdapter();
    const session = await start(adapter, workspace, "binding:grok:pre-aborted");
    const controller = new AbortController();
    controller.abort();

    const events = await collect(
      adapter.prompt(session, {
        turnId: "turn-pre-aborted",
        content: "never dispatch",
        correlationId: "corr-pre-aborted",
        signal: controller.signal
      })
    );

    expect(events.map((event) => event.type)).toEqual(["turn.started", "turn.cancelled"]);
    expect(events.at(-1)?.payload).toMatchObject({ dispatched: false });
    const incoming = incomingFrames(await wireLog(workspace));
    expect(incoming.some((frame) => frame.method === "session/prompt")).toBe(false);
    expect(incoming.some((frame) => frame.method === "session/cancel")).toBe(false);
  });

  it("normalizes streaming updates and waits for the matching prompt response as the only terminal", async () => {
    const workspace = await fixtureWorkspace({
      prompt: {
        emitUpdates: true,
        idleBeforeTerminal: true,
        orphanResponse: true,
        terminalDelayMs: 25
      }
    });
    const adapter = kimiAdapter();
    const session = await start(adapter, workspace, "binding:kimi:stream");

    const events = await collect(
      adapter.prompt(session, {
        turnId: "turn-stream",
        content: "current content",
        contextPacket: "[group_context]\nprior content",
        correlationId: "corr-stream"
      })
    );

    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "content.delta",
      "reasoning.delta",
      "tool.started",
      "tool.completed",
      "turn.completed"
    ]);
    expect(events.filter((event) => event.type.startsWith("turn.") && event.type !== "turn.started")).toHaveLength(1);
    expect(events[1]?.payload).toEqual({ text: "fixture answer", messageId: "message-1" });
    expect(events[3]?.payload).not.toHaveProperty("rawInput");
    expect(events[4]?.payload).not.toHaveProperty("rawOutput");
    expect(events.at(-1)?.payload).toMatchObject({ stopReason: "end_turn" });

    const prompt = incomingFrames(await wireLog(workspace)).find((frame) => frame.method === "session/prompt");
    expect(prompt).toMatchObject({
      params: {
        sessionId: session.nativeSessionId,
        prompt: [{ type: "text", text: "[group_context]\nprior content\n\n[current_message]\ncurrent content" }]
      }
    });
  });

  it("settles an unexpected native permission request without exposing or choosing an option", async () => {
    const workspace = await fixtureWorkspace({
      prompt: {
        permission: true,
        permissionSessionId: "mismatched-native-session",
        emitUpdates: false,
        terminalDelayMs: 5
      }
    });
    const adapter = grokAdapter();
    const session = await start(adapter, workspace, "binding:grok:permission");
    const events = await collect(
      adapter.prompt(session, {
        turnId: "turn-permission",
        content: "request a native decision",
        correlationId: "corr-permission"
      })
    );

    expect(events.map((event) => event.type)).toEqual(["turn.started", "transport.error", "turn.failed"]);
    expect(events.filter((event) => ["turn.completed", "turn.cancelled", "turn.failed"].includes(event.type))).toHaveLength(1);
    expect(events.at(-1)?.payload).toMatchObject({ errorCode: "UNEXPECTED_NATIVE_INTERACTION" });
    expect(events.map((event) => String(event.type))).not.toContain("approval.requested");
    expect(JSON.stringify(events)).not.toContain("allow-once");

    await waitForWire(workspace, (entries) => {
      const request = outgoingFrames(entries).find((frame) => frame.method === "session/request_permission");
      const incoming = incomingFrames(entries);
      return (
        request !== undefined &&
        incoming.some((frame) => frame.id === request.id && frame.result !== undefined) &&
        incoming.some((frame) => frame.method === "session/cancel")
      );
    });
    const entries = await wireLog(workspace);
    const permissionRequest = outgoingFrames(entries).find((frame) => frame.method === "session/request_permission");
    const permissionResponse = incomingFrames(entries).find(
      (frame) => frame.id === permissionRequest?.id && frame.result !== undefined
    );
    expect(permissionResponse).toEqual({
      jsonrpc: "2.0",
      id: permissionRequest?.id,
      result: { outcome: { outcome: "cancelled" } }
    });
    const cancellation = incomingFrames(entries).find((frame) => frame.method === "session/cancel");
    expect(cancellation).toMatchObject({ jsonrpc: "2.0", params: { sessionId: session.nativeSessionId } });
    expect(Object.hasOwn(cancellation ?? {}, "id")).toBe(false);
    const responseWireIndex = entries.findIndex(
      (entry) => entry.direction === "in" && entry.frame?.id === permissionRequest?.id && entry.frame?.result !== undefined
    );
    const cancelWireIndex = entries.findIndex(
      (entry) => entry.direction === "in" && entry.frame?.method === "session/cancel"
    );
    expect(responseWireIndex).toBeGreaterThanOrEqual(0);
    expect(cancelWireIndex).toBeGreaterThan(responseWireIndex);
  });

  it("does not deadlock or re-pend when permission arrives after cancellation", async () => {
    const workspace = await fixtureWorkspace({
      prompt: { permissionAfterCancel: true, emitUpdates: false, holdUntilCancel: true }
    });
    const adapter = kimiAdapter();
    const session = await start(adapter, workspace, "binding:kimi:cancel");
    const iterator = adapter
      .prompt(session, {
        turnId: "turn-cancel",
        content: "hold",
        correlationId: "corr-cancel"
      })
      [Symbol.asyncIterator]();

    expect((await iterator.next()).value?.type).toBe("turn.started");
    const result = await adapter.cancel(session, "turn-cancel");
    expect(result).toMatchObject({ requested: true, supported: true });
    const remaining = await collectIterator(iterator);
    expect(remaining.map((event) => event.type)).toEqual(["transport.error", "turn.failed"]);
    expect(remaining.at(-1)?.payload).toMatchObject({ errorCode: "UNEXPECTED_NATIVE_INTERACTION" });

    await waitForWire(workspace, (entries) => {
      const request = outgoingFrames(entries).find((frame) => frame.method === "session/request_permission");
      return (
        request !== undefined &&
        incomingFrames(entries).some((frame) => frame.id === request.id && frame.result !== undefined)
      );
    });
    const entries = await wireLog(workspace);
    const permissionRequest = outgoingFrames(entries).find((frame) => frame.method === "session/request_permission");
    const incoming = incomingFrames(await wireLog(workspace));
    const permissionResponse = incoming.find(
      (frame) => frame.id === permissionRequest?.id && frame.result !== undefined
    );
    expect(permissionResponse).toMatchObject({ result: { outcome: { outcome: "cancelled" } } });
    const cancellations = incoming.filter((frame) => frame.method === "session/cancel");
    expect(cancellations).toHaveLength(1);
    const cancellation = cancellations[0];
    expect(cancellation).toMatchObject({ jsonrpc: "2.0", params: { sessionId: session.nativeSessionId } });
    expect(Object.hasOwn(cancellation ?? {}, "id")).toBe(false);
  });

  it("treats policy-looking fields inside permission payloads as unexpected interaction only", async () => {
    const workspace = await fixtureWorkspace({
      prompt: { permission: true, permissionPolicyBlock: true, emitUpdates: false }
    });
    const adapter = grokAdapter();
    const session = await start(adapter, workspace, "binding:grok:policy-permission");
    const events = await collect(
      adapter.prompt(session, {
        turnId: "turn-policy-permission",
        content: "policy blocked",
        correlationId: "corr-policy-permission"
      })
    );

    expect(events.map((event) => event.type)).toEqual(["turn.started", "transport.error", "turn.failed"]);
    expect(events.at(-1)?.payload).toMatchObject({ errorCode: "UNEXPECTED_NATIVE_INTERACTION" });
    expect(adapter.health()).toMatchObject({ status: "failed", nativeSessionAvailable: false });
  });

  it("turns malformed protocol stdout into isolated transport and turn failures", async () => {
    const workspace = await fixtureWorkspace({
      prompt: { emitUpdates: false, malformedAfterUpdate: true }
    });
    const adapter = grokAdapter();
    const session = await start(adapter, workspace, "binding:grok:malformed");
    const events = await collect(
      adapter.prompt(session, {
        turnId: "turn-malformed",
        content: "malformed",
        correlationId: "corr-malformed"
      })
    );

    expect(events.map((event) => event.type)).toEqual(["turn.started", "transport.error", "turn.failed"]);
    expect(adapter.health()).toMatchObject({ status: "failed", nativeSessionAvailable: false });
    const liveIndex = liveSessions.findIndex((entry) => entry.session === session);
    expect(liveIndex).toBeGreaterThanOrEqual(0);
    liveSessions.splice(liveIndex, 1);

    // Stream completion is the Adapter's process-release barrier. Immediate
    // deletion must succeed on Windows without retrying an EBUSY directory.
    await rm(workspace, { recursive: true, force: true });
    const workspaceIndex = workspaces.indexOf(workspace);
    expect(workspaceIndex).toBeGreaterThanOrEqual(0);
    workspaces.splice(workspaceIndex, 1);
  });

  it("keeps one active prompt per native session", async () => {
    const workspace = await fixtureWorkspace({ prompt: { emitUpdates: false, holdUntilCancel: true } });
    const adapter = grokAdapter();
    const session = await start(adapter, workspace, "binding:grok:single-flight");
    const first = adapter
      .prompt(session, { turnId: "turn-1", content: "first", correlationId: "corr-1" })
      [Symbol.asyncIterator]();
    expect((await first.next()).value?.type).toBe("turn.started");

    const second = adapter
      .prompt(session, { turnId: "turn-2", content: "second", correlationId: "corr-2" })
      [Symbol.asyncIterator]();
    await expect(second.next()).rejects.toMatchObject({ code: "SESSION_NOT_AVAILABLE" });

    await adapter.cancel(session, "turn-1");
    expect((await collectIterator(first)).at(-1)?.type).toBe("turn.cancelled");
  });

  it("closes within bounded grace when a native prompt does not acknowledge cancellation", async () => {
    const workspace = await fixtureWorkspace({
      prompt: { emitUpdates: false, holdUntilCancel: true, cancelDelayMs: 5_000 }
    });
    const adapter = grokAdapter();
    const session = await start(adapter, workspace, "binding:grok:bounded-close");
    const iterator = adapter
      .prompt(session, { turnId: "turn-close", content: "hold", correlationId: "corr-close" })
      [Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe("turn.started");

    const startedAt = Date.now();
    await adapter.close(session);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    liveSessions.splice(
      liveSessions.findIndex((entry) => entry.session === session),
      1
    );
    const remaining = await collectIterator(iterator);
    expect(remaining.at(-1)?.type).toBe("turn.failed");
    expect(remaining.at(-1)?.payload).toMatchObject({ errorCode: "TURN_INTERRUPTED" });
  });
});

async function start(
  adapter: GrokAcpAdapter | KimiAcpAdapter,
  workspace: string,
  bindingId: string
): Promise<NativeSession> {
  const session = await adapter.start({
    command: process.execPath,
    prefixArgs: fixturePrefixArgs(workspace),
    cwd: workspace,
    bindingId
  });
  liveSessions.push({ adapter, session });
  return session;
}

function grokAdapter(): GrokAcpAdapter {
  return new GrokAcpAdapter({
    handshakeTimeoutMs: 1_000,
    closeGraceMs: 250,
    killGraceMs: 250
  });
}

function kimiAdapter(): KimiAcpAdapter {
  return new KimiAcpAdapter({
    handshakeTimeoutMs: 1_000,
    closeGraceMs: 250,
    killGraceMs: 250,
    configPreflight: async () => ({
      permissionMode: "yolo",
      planMode: false,
      source: "default-home"
    })
  });
}

async function fixtureWorkspace(config: Record<string, unknown> = {}): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "groupx-acp-fixture-"));
  workspaces.push(workspace);
  await Promise.all([
    copyFile(join(FIXTURE_SOURCE, "fixture-agent.mjs"), join(workspace, "fixture-agent.mjs")),
    writeFile(join(workspace, "fixture-config.json"), JSON.stringify(config), "utf8")
  ]);
  return workspace;
}

function fixturePrefixArgs(workspace: string): string[] {
  return [join(workspace, "fixture-agent.mjs")];
}

async function wireLog(workspace: string): Promise<Array<Record<string, any>>> {
  const text = await readFile(join(workspace, "wire-log.jsonl"), "utf8");
  return text
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, any>);
}

function incomingFrames(entries: Array<Record<string, any>>): Array<Record<string, any>> {
  return entries
    .filter((entry) => entry.direction === "in")
    .map((entry) => entry.frame as Record<string, any>);
}

function outgoingFrames(entries: Array<Record<string, any>>): Array<Record<string, any>> {
  return entries
    .filter((entry) => entry.direction === "out")
    .map((entry) => entry.frame as Record<string, any>);
}

async function waitForWire(
  workspace: string,
  predicate: (entries: Array<Record<string, any>>) => boolean,
  timeoutMs = 1_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (predicate(await wireLog(workspace))) {
        return;
      }
    } catch {
      // The fixture may not have created its log yet.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for ACP fixture wire evidence");
}

async function collect(iterable: AsyncIterable<NativeEvent>): Promise<NativeEvent[]> {
  return await collectIterator(iterable[Symbol.asyncIterator]());
}

async function collectIterator(iterator: AsyncIterator<NativeEvent>): Promise<NativeEvent[]> {
  const events: NativeEvent[] = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) {
      return events;
    }
    events.push(next.value);
  }
}
