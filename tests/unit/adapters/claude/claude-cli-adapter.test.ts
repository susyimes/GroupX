import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ClaudeCliAdapter } from "../../../../src/adapters/claude/index.js";
import {
  buildClaudeLaunchArgv,
  buildClaudeMcpConfig,
  buildClaudeUserMessage,
  parseClaudeResult
} from "../../../../src/adapters/claude/protocol.js";
import type { NativeEvent, NativeSession } from "../../../../src/adapters/types.js";
import { GroupXError } from "../../../../src/core/errors.js";

const FIXTURE_SOURCE = fileURLToPath(new URL("../../../fixtures/claude", import.meta.url));
const workspaces: string[] = [];
const liveSessions: Array<{ adapter: ClaudeCliAdapter; session: NativeSession }> = [];

afterEach(async () => {
  for (const { adapter, session } of liveSessions.splice(0)) {
    await adapter.close(session).catch(() => undefined);
  }
  for (const workspace of workspaces.splice(0)) {
    await rm(workspace, { recursive: true, force: true });
  }
});

describe("Claude Code stream-json adapter", () => {
  it("builds a fixed unrestricted argv and rejects an unbound MCP descriptor", () => {
    expect(buildClaudeLaunchArgv("claude", [], { sessionId: "11111111-2222-4333-8444-555555555555" })).toEqual([
      "claude",
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "bypassPermissions",
      "--session-id",
      "11111111-2222-4333-8444-555555555555"
    ]);

    expect(
      buildClaudeLaunchArgv("claude", [], { resumeSessionId: "11111111-2222-4333-8444-555555555555" })
    ).toContain("--resume");

    expect(() => buildClaudeLaunchArgv("claude", [], { sessionId: "not-a-uuid" })).toThrowError(TypeError);
    expect(() =>
      buildClaudeLaunchArgv("claude", [], {
        sessionId: "11111111-2222-4333-8444-555555555555",
        resumeSessionId: "11111111-2222-4333-8444-555555555555"
      })
    ).toThrowError(TypeError);

    expect(() =>
      buildClaudeMcpConfig({ transport: "streamable-http", url: "http://127.0.0.1:4310/mcp" }, undefined)
    ).toThrowError(expect.objectContaining({ code: "MCP_BINDING_MISMATCH" }));
    expect(
      buildClaudeMcpConfig({ transport: "streamable-http", url: "http://127.0.0.1:4310/mcp" }, "binding:claude:1")
    ).toEqual({
      mcpServers: {
        groupx: {
          type: "http",
          url: "http://127.0.0.1:4310/mcp",
          headers: { "X-GroupX-Binding": "binding:claude:1" }
        }
      }
    });
  });

  it("carries the room context packet in the native user frame", () => {
    expect(buildClaudeUserMessage({ content: "hello" })).toEqual({
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "hello" }] }
    });
    expect(buildClaudeUserMessage({ content: "hello", contextPacket: "packet" })).toMatchObject({
      message: { content: [{ type: "text", text: "packet\n\n[current_message]\nhello" }] }
    });
  });

  it("classifies an aborted stream as cancellation and a failed result as failure", () => {
    expect(parseClaudeResult({ type: "result", subtype: "success", is_error: false, terminal_reason: "completed" }).kind).toBe(
      "completed"
    );
    expect(
      parseClaudeResult({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        terminal_reason: "aborted_streaming"
      }).kind
    ).toBe("cancelled");
    expect(parseClaudeResult({ type: "result", subtype: "error_max_turns", is_error: true }).kind).toBe("failed");
  });

  it("starts with the fixed argv, verifies the unrestricted init frame, and attaches an HTTP MCP binding", async () => {
    const workspace = await fixtureWorkspace();
    const adapter = claudeAdapter();
    const session = await adapter.start({
      command: process.execPath,
      prefixArgs: fixturePrefixArgs(workspace),
      cwd: workspace,
      instanceId: "instance:claude:prebound",
      bindingId: "binding:claude:test",
      mcp: { transport: "streamable-http", url: "http://127.0.0.1:4310/mcp" }
    });
    liveSessions.push({ adapter, session });

    expect(session).toMatchObject({
      adapterId: "claude",
      actorId: "agent:claude",
      instanceId: "instance:claude:prebound",
      bindingId: "binding:claude:test",
      protocol: "claude-cli-stream-json-v1"
    });
    expect(adapter.health()).toMatchObject({ status: "ready", nativeSessionAvailable: true });

    const report = await adapter.probe();
    expect(report.launchArgvShape).toEqual([
      process.execPath,
      ...fixturePrefixArgs(workspace),
      "--print",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "bypassPermissions"
    ]);
    expect(report.findings.find((entry) => entry.capability === "access.unrestricted")).toMatchObject({
      level: "probed"
    });
    expect(report.findings.find((entry) => entry.capability === "control.initialize")).toMatchObject({
      level: "verified"
    });
    expect(report.findings.find((entry) => entry.capability === "mcp.http")).toMatchObject({ level: "probed" });

    // Invariant 11: the initialize payload also carries account, organization,
    // model, and command inventories that GroupX must never collect.
    const projected = JSON.stringify([report, adapter.health()]);
    expect(projected).not.toContain("fixture@example.invalid");
    expect(projected).not.toContain("fixture-org");

    const startup = (await wireLog(workspace)).find((entry) => entry.event === "startup");
    expect(startup?.script).toBe("fixture-claude.mjs");
    const argv = startup?.argv as string[];
    expect(argv).toContain("--permission-mode");
    expect(argv[argv.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
    expect(argv[argv.indexOf("--session-id") + 1]).toBe(session.nativeSessionId);
    expect(JSON.parse(argv[argv.indexOf("--mcp-config") + 1] ?? "{}")).toEqual({
      mcpServers: {
        groupx: {
          type: "http",
          url: "http://127.0.0.1:4310/mcp",
          headers: { "X-GroupX-Binding": "binding:claude:test" }
        }
      }
    });
  });

  it("normalizes one turn without duplicating streamed assistant text", async () => {
    const workspace = await fixtureWorkspace();
    const adapter = claudeAdapter();
    const session = await startFixture(adapter, workspace);

    const events = await collect(adapter.prompt(session, promptInput()));

    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "reasoning.delta",
      "content.delta",
      "tool.started",
      "tool.completed",
      "turn.completed"
    ]);
    expect(events[2]?.payload).toMatchObject({ text: "fixture answer", chunkIndex: expect.any(Number) });
    expect(events[3]?.payload).toMatchObject({ toolUseId: "toolu_1", toolName: "Bash" });
    expect(events[4]?.payload).toMatchObject({ toolUseId: "toolu_1", toolName: "Bash", status: "completed" });
    expect(events.at(-1)?.payload).toMatchObject({ subtype: "success", terminalReason: "completed" });
    expect(events.every((event) => event.nativeSessionId === session.nativeSessionId)).toBe(true);
  });

  it("falls back to the complete assistant message when no delta streamed it", async () => {
    const workspace = await fixtureWorkspace({ prompt: { emitEvents: false, unstreamedAssistant: true } });
    const adapter = claudeAdapter();
    const session = await startFixture(adapter, workspace);

    const events = await collect(adapter.prompt(session, promptInput()));
    const content = events.filter((event) => event.type === "content.delta");
    expect(content).toHaveLength(1);
    expect(content[0]?.payload).toMatchObject({ text: "fallback text", finalMessageFallback: true });
  });

  it("ignores frames addressed to a different native session", async () => {
    const workspace = await fixtureWorkspace({ prompt: { emitEvents: false, foreignSession: true } });
    const adapter = claudeAdapter();
    const session = await startFixture(adapter, workspace);

    const events = await collect(adapter.prompt(session, promptInput()));
    expect(events.some((event) => JSON.stringify(event.payload).includes("other room"))).toBe(false);
    expect(events.at(-1)?.type).toBe("turn.completed");
  });

  it("cancels an in-flight turn through a native interrupt control request", async () => {
    const workspace = await fixtureWorkspace({ prompt: { holdUntilCancel: true } });
    const adapter = claudeAdapter();
    const session = await startFixture(adapter, workspace);

    const controller = new AbortController();
    const stream = adapter.prompt(session, promptInput({ signal: controller.signal }));
    const events: NativeEvent[] = [];
    for await (const event of stream) {
      events.push(event);
      if (event.type === "tool.completed") {
        controller.abort();
      }
    }

    expect(events.at(-1)).toMatchObject({
      type: "turn.cancelled",
      payload: { terminalReason: "aborted_streaming" }
    });
    const interrupt = (await wireLog(workspace)).find(
      (entry) => entry.direction === "in" && entry.frame?.request?.subtype === "interrupt"
    );
    expect(interrupt).toBeDefined();
    expect((await adapter.probe()).findings.find((entry) => entry.capability === "session.cancel")).toMatchObject({
      level: "verified"
    });
  });

  it("fails the turn when the native process never settles a cancellation", async () => {
    const workspace = await fixtureWorkspace({ prompt: { holdUntilCancel: true, ignoreInterrupt: true } });
    const adapter = claudeAdapter({ cancelMs: 200 });
    const session = await startFixture(adapter, workspace);

    const controller = new AbortController();
    const stream = adapter.prompt(session, promptInput({ signal: controller.signal }));
    const events: NativeEvent[] = [];
    for await (const event of stream) {
      events.push(event);
      if (event.type === "tool.completed") {
        controller.abort();
      }
    }

    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      payload: { errorCode: "TURN_CANCEL_TIMEOUT" }
    });
  });

  it("fails the turn when no native frame arrives in time", async () => {
    const workspace = await fixtureWorkspace({ prompt: { emitEvents: false, holdUntilCancel: true } });
    const adapter = claudeAdapter({ firstEventMs: 200 });
    const session = await startFixture(adapter, workspace);

    const events = await collect(adapter.prompt(session, promptInput()));
    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      payload: { errorCode: "TURN_FIRST_EVENT_TIMEOUT" }
    });
    expect(adapter.health()).toMatchObject({ status: "failed" });
  });

  it("fails the turn when the native stream becomes idle", async () => {
    const workspace = await fixtureWorkspace({ prompt: { holdUntilCancel: true } });
    const adapter = claudeAdapter({ idleMs: 250, firstEventMs: 5_000 });
    const session = await startFixture(adapter, workspace);

    const events = await collect(adapter.prompt(session, promptInput()));
    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      payload: { errorCode: "TURN_IDLE_TIMEOUT" }
    });
  });

  it("denies an unexpected permission request at the wire boundary and fails the turn", async () => {
    const workspace = await fixtureWorkspace({ prompt: { permission: true } });
    const adapter = claudeAdapter();
    const session = await startFixture(adapter, workspace);

    const events = await collect(adapter.prompt(session, promptInput()));

    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      payload: { errorCode: "UNEXPECTED_NATIVE_INTERACTION" }
    });
    await expect(waitForWireEntry(workspace, isDenial)).resolves.toBeDefined();
    expect((await adapter.probe()).findings.find((entry) => entry.capability === "native.interaction")).toMatchObject({
      level: "probed"
    });
  });

  it("fails the turn on a request_user_dialog control request", async () => {
    // `request_user_dialog` is the CLI's real interactive subtype; treating it
    // as an ordinary control request would let an approval prompt pass silently.
    const workspace = await fixtureWorkspace({ prompt: { userDialog: true } });
    const adapter = claudeAdapter();
    const session = await startFixture(adapter, workspace);

    const events = await collect(adapter.prompt(session, promptInput()));
    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      payload: { errorCode: "UNEXPECTED_NATIVE_INTERACTION" }
    });
    await expect(waitForWireEntry(workspace, isDenial)).resolves.toBeDefined();
  });

  it("treats an interrupt during tool execution as a cancellation", async () => {
    // Cancelling mid-tool settles as `aborted_tools`, not `aborted_streaming`.
    const workspace = await fixtureWorkspace({
      prompt: { holdUntilCancel: true, cancelTerminalReason: "aborted_tools" }
    });
    const adapter = claudeAdapter();
    const session = await startFixture(adapter, workspace);

    const controller = new AbortController();
    const events: NativeEvent[] = [];
    for await (const event of adapter.prompt(session, promptInput({ signal: controller.signal }))) {
      events.push(event);
      if (event.type === "tool.completed") {
        controller.abort();
      }
    }

    expect(events.at(-1)).toMatchObject({
      type: "turn.cancelled",
      payload: { terminalReason: "aborted_tools" }
    });
    expect(events.some((event) => event.type === "turn.failed")).toBe(false);
  });

  it("keeps the native api error status on a failed result", async () => {
    const workspace = await fixtureWorkspace({
      prompt: { subtype: "success", isError: true, terminalReason: "api_error", apiErrorStatus: 529 }
    });
    const adapter = claudeAdapter();
    const session = await startFixture(adapter, workspace);

    const events = await collect(adapter.prompt(session, promptInput()));
    expect(events.find((event) => event.type === "transport.error")?.payload).toMatchObject({
      apiErrorStatus: 529
    });
  });

  it("keeps the failure diagnostic after the teardown it scheduled", async () => {
    const workspace = await fixtureWorkspace({ prompt: { emitEvents: false, holdUntilCancel: true } });
    const adapter = claudeAdapter({ firstEventMs: 150 });
    const session = await startFixture(adapter, workspace);

    await collect(adapter.prompt(session, promptInput()));
    const atFailure = adapter.health();
    expect(atFailure).toMatchObject({ status: "failed" });
    expect(atFailure.lastError).toContain("no streamed frame");

    // The scheduled teardown must not erase what explains the failure.
    await adapter.close(session).catch(() => undefined);
    expect(adapter.health().lastError).toBe(atFailure.lastError);
  });

  it("closes silently once a failed turn already tore the runtime down", async () => {
    const workspace = await fixtureWorkspace({ prompt: { malformedAfterEvents: true } });
    const adapter = claudeAdapter();
    const session = await startFixture(adapter, workspace);

    await collect(adapter.prompt(session, promptInput()));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await expect(adapter.close(session)).resolves.toBeUndefined();
  });

  it("rejects an init frame it cannot verify and one that downgrades the mode", async () => {
    const malformed = await fixtureWorkspace({ malformedInit: true });
    const first = claudeAdapter();
    const malformedSession = await startFixture(first, malformed);
    expect((await collect(first.prompt(malformedSession, promptInput()))).at(-1)).toMatchObject({
      type: "turn.failed",
      payload: { errorCode: "PROTOCOL_INVALID_MESSAGE" }
    });

    const downgraded = await fixtureWorkspace({ initPermissionMode: "acceptEdits" });
    const second = claudeAdapter();
    const downgradedSession = await startFixture(second, downgraded);
    expect((await collect(second.prompt(downgradedSession, promptInput()))).at(-1)).toMatchObject({
      type: "turn.failed",
      payload: { errorCode: "NATIVE_POLICY_BLOCKED" }
    });
  });

  it("absorbs the interrupt answer owed by a turn that finished first", async () => {
    // The interrupt loses the race, so the turn settles as completed and the
    // CLI's answer to it arrives while the NEXT turn is already streaming.
    const workspace = await fixtureWorkspace({
      prompt: { holdUntilCancel: true, holdFirstTurnOnly: true, completeOnInterrupt: true }
    });
    const adapter = claudeAdapter();
    const session = await startFixture(adapter, workspace);

    const controller = new AbortController();
    const first: NativeEvent[] = [];
    for await (const event of adapter.prompt(session, promptInput({ signal: controller.signal }))) {
      first.push(event);
      if (event.type === "tool.completed") {
        controller.abort();
      }
    }
    expect(first.at(-1)?.type).toBe("turn.completed");

    const second = await collect(adapter.prompt(session, promptInput({ turnId: "turn-2" })));
    expect(second.at(-1)).toMatchObject({ type: "turn.completed", nativeTurnId: "turn-2" });
    expect(second.filter((event) => event.type.startsWith("turn.") && event.type !== "turn.started")).toHaveLength(1);
    expect(second.some((event) => event.type === "content.delta")).toBe(true);
  });

  it("does not duplicate text or tool starts when native ids are missing", async () => {
    const workspace = await fixtureWorkspace({
      prompt: { messageStartWithoutId: true, toolUseWithoutId: true }
    });
    const adapter = claudeAdapter();
    const session = await startFixture(adapter, workspace);

    const events = await collect(adapter.prompt(session, promptInput()));
    const texts = events.filter((event) => event.type === "content.delta").map((event) => event.payload);
    expect(texts).toEqual([
      expect.objectContaining({ text: "fixture answer" }),
      expect.objectContaining({ text: "second message" })
    ]);
    expect(events.filter((event) => event.type === "tool.started")).toHaveLength(1);
  });

  it("answers an unsupported control request with a protocol error without failing the turn", async () => {
    const workspace = await fixtureWorkspace({ prompt: { unknownControlRequest: true } });
    const adapter = claudeAdapter();
    const session = await startFixture(adapter, workspace);

    const events = await collect(adapter.prompt(session, promptInput()));
    expect(events.at(-1)?.type).toBe("turn.completed");
    const errorResponse = (await wireLog(workspace)).find(
      (entry) => entry.direction === "in" && entry.frame?.response?.subtype === "error"
    );
    expect(errorResponse).toBeDefined();
  });

  it("treats initialize permission mode as observational and establishes unrestricted with set_permission_mode", async () => {
    const workspace = await fixtureWorkspace({ permissionMode: "default" });
    const adapter = claudeAdapter();
    const session = await startFixture(adapter, workspace);

    expect(session.protocol).toBe("claude-cli-stream-json-v1");
    expect(adapter.health()).toMatchObject({ status: "ready", nativeSessionAvailable: true });
    const setMode = (await wireLog(workspace)).find(
      (entry) => entry.direction === "in" && entry.frame?.request?.subtype === "set_permission_mode"
    );
    expect(setMode?.frame?.request?.mode).toBe("bypassPermissions");
  });

  it("refuses to start when initialize omits current_permission_mode", async () => {
    const workspace = await fixtureWorkspace({ omitInitializePermissionMode: true });
    await expect(
      claudeAdapter().start({ command: process.execPath, prefixArgs: fixturePrefixArgs(workspace), cwd: workspace })
    ).rejects.toMatchObject({ code: "PROTOCOL_INVALID_MESSAGE" });
  });

  it("refuses to start when the native process will not establish the unrestricted mode", async () => {
    const workspace = await fixtureWorkspace({ setModeError: "disabled by managed policy" });
    await expect(
      claudeAdapter().start({ command: process.execPath, prefixArgs: fixturePrefixArgs(workspace), cwd: workspace })
    ).rejects.toMatchObject({ code: "NATIVE_POLICY_BLOCKED" });

    const downgraded = await fixtureWorkspace({ setModeResult: "acceptEdits" });
    await expect(
      claudeAdapter().start({ command: process.execPath, prefixArgs: fixturePrefixArgs(downgraded), cwd: downgraded })
    ).rejects.toMatchObject({ code: "NATIVE_POLICY_BLOCKED" });
  });

  it("fails the turn when the deferred init frame does not match the launched session", async () => {
    const workspace = await fixtureWorkspace({ sessionId: "99999999-9999-4999-8999-999999999999" });
    const adapter = claudeAdapter();
    const session = await startFixture(adapter, workspace);

    const events = await collect(adapter.prompt(session, promptInput()));
    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      payload: { errorCode: "SESSION_NOT_AVAILABLE" }
    });
  });

  it("fails the turn when the deferred init frame reports a foreign cwd", async () => {
    const workspace = await fixtureWorkspace({ cwd: join(tmpdir(), "groupx-not-the-workspace") });
    const adapter = claudeAdapter();
    const session = await startFixture(adapter, workspace);

    const events = await collect(adapter.prompt(session, promptInput()));
    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      payload: { errorCode: "SESSION_NOT_AVAILABLE" }
    });
  });

  it("times out the handshake when the native process never answers the control request", async () => {
    const workspace = await fixtureWorkspace({ noHandshakeResponse: true });
    const adapter = claudeAdapter({ handshakeMs: 250 });

    await expect(
      adapter.start({ command: process.execPath, prefixArgs: fixturePrefixArgs(workspace), cwd: workspace })
    ).rejects.toMatchObject({ code: "PROTOCOL_HANDSHAKE_TIMEOUT" });
    expect(adapter.health()).toMatchObject({ status: "failed" });
  });

  it("surfaces bounded native stderr when the process exits before the handshake", async () => {
    const workspace = await fixtureWorkspace({
      exitBeforeHandshake: true,
      exitCode: 9,
      stderrBeforeExit: "fixture refused to start\n"
    });
    const adapter = claudeAdapter({ handshakeMs: 2_000 });

    await expect(
      adapter.start({ command: process.execPath, prefixArgs: fixturePrefixArgs(workspace), cwd: workspace })
    ).rejects.toBeInstanceOf(GroupXError);
    expect(adapter.health().lastError).toContain("fixture refused to start");
  });

  it("fails the turn on a malformed native frame", async () => {
    const workspace = await fixtureWorkspace({ prompt: { malformedAfterEvents: true } });
    const adapter = claudeAdapter();
    const session = await startFixture(adapter, workspace);

    const events = await collect(adapter.prompt(session, promptInput()));
    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      payload: { errorCode: "PROTOCOL_INVALID_MESSAGE" }
    });
  });

  it("fails the turn when the native process exits mid-stream", async () => {
    const workspace = await fixtureWorkspace({ prompt: { exitAfterEvents: true, exitCode: 7 } });
    const adapter = claudeAdapter();
    const session = await startFixture(adapter, workspace);

    const events = await collect(adapter.prompt(session, promptInput()));
    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      payload: { errorCode: "TURN_INTERRUPTED" }
    });
    expect(adapter.health()).toMatchObject({ status: "failed" });
  });

  it("keeps a native failure result usable for the next turn", async () => {
    const workspace = await fixtureWorkspace({
      prompt: { subtype: "error_max_turns", isError: true, terminalReason: "max_turns" }
    });
    const adapter = claudeAdapter();
    const session = await startFixture(adapter, workspace);

    const failed = await collect(adapter.prompt(session, promptInput()));
    expect(failed.map((event) => event.type)).toContain("transport.error");
    expect(failed.at(-1)).toMatchObject({ type: "turn.failed" });

    const next = await collect(adapter.prompt(session, promptInput({ turnId: "turn-2" })));
    expect(next.at(-1)?.type).toBe("turn.failed");
    expect(next.at(0)).toMatchObject({ type: "turn.started", nativeTurnId: "turn-2" });
  });

  it("resumes an existing native session and restarts after close", async () => {
    const workspace = await fixtureWorkspace();
    const first = claudeAdapter();
    const session = await startFixture(first, workspace);
    const nativeSessionId = session.nativeSessionId ?? "";
    await first.close(session);
    liveSessions.pop();
    expect(first.health()).toMatchObject({ status: "stopped" });

    const second = claudeAdapter();
    const resumed = await second.resume({
      command: process.execPath,
      prefixArgs: fixturePrefixArgs(workspace),
      cwd: workspace,
      nativeSessionId
    });
    liveSessions.push({ adapter: second, session: resumed });

    expect(resumed.nativeSessionId).toBe(nativeSessionId);
    expect((await second.probe()).findings.find((entry) => entry.capability === "session.resume")).toMatchObject({
      level: "verified"
    });
    const startups = (await wireLog(workspace)).filter((entry) => entry.event === "startup");
    const resumeArgv = startups.at(-1)?.argv as string[];
    expect(resumeArgv[resumeArgv.indexOf("--resume") + 1]).toBe(nativeSessionId);
    expect(resumeArgv).not.toContain("--session-id");
  });

  it("rejects a second concurrent turn and a session that is not its own", async () => {
    const workspace = await fixtureWorkspace({ prompt: { holdUntilCancel: true } });
    const adapter = claudeAdapter();
    const session = await startFixture(adapter, workspace);

    const stream = adapter.prompt(session, promptInput());
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();

    await expect(
      adapter.prompt(session, promptInput({ turnId: "turn-2" }))[Symbol.asyncIterator]().next()
    ).rejects.toMatchObject({ code: "SESSION_NOT_AVAILABLE" });
    await expect(adapter.close({ ...session, bindingId: "binding:other" })).rejects.toMatchObject({
      code: "SESSION_NOT_AVAILABLE"
    });

    await iterator.return?.();
  });

  it("refuses an MCP-enabled launch without Broker-assigned provenance", async () => {
    const workspace = await fixtureWorkspace();
    await expect(
      claudeAdapter().start({
        command: process.execPath,
        prefixArgs: fixturePrefixArgs(workspace),
        cwd: workspace,
        mcp: { transport: "streamable-http", url: "http://127.0.0.1:4310/mcp" }
      })
    ).rejects.toMatchObject({ code: "MCP_BINDING_MISMATCH" });
  });
});

function claudeAdapter(timeouts: Partial<Record<string, number>> = {}): ClaudeCliAdapter {
  return new ClaudeCliAdapter({
    timeouts: {
      handshakeMs: 2_000,
      requestMs: 2_000,
      firstEventMs: 2_000,
      idleMs: 2_000,
      cancelMs: 2_000,
      closeMs: 250,
      ...timeouts
    }
  });
}

async function startFixture(adapter: ClaudeCliAdapter, workspace: string): Promise<NativeSession> {
  const session = await adapter.start({
    command: process.execPath,
    prefixArgs: fixturePrefixArgs(workspace),
    cwd: workspace
  });
  liveSessions.push({ adapter, session });
  return session;
}

function promptInput(overrides: Partial<{ turnId: string; signal: AbortSignal }> = {}): {
  turnId: string;
  content: string;
  correlationId: string;
  signal?: AbortSignal;
} {
  return {
    turnId: overrides.turnId ?? "turn-1",
    content: "hello",
    correlationId: "corr-1",
    ...(overrides.signal === undefined ? {} : { signal: overrides.signal })
  };
}

async function collect(stream: AsyncIterable<NativeEvent>): Promise<NativeEvent[]> {
  const events: NativeEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

async function fixtureWorkspace(config: Record<string, unknown> = {}): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "groupx-claude-fixture-"));
  workspaces.push(workspace);
  await Promise.all([
    copyFile(join(FIXTURE_SOURCE, "fixture-claude.mjs"), join(workspace, "fixture-claude.mjs")),
    writeFile(join(workspace, "fixture-config.json"), JSON.stringify(config), "utf8")
  ]);
  return workspace;
}

function fixturePrefixArgs(workspace: string): string[] {
  return [join(workspace, "fixture-claude.mjs")];
}

function isDenial(entry: Record<string, any>): boolean {
  return entry.direction === "in" && entry.frame?.response?.response?.behavior === "deny";
}

/**
 * The adapter writes its wire answer and fails the Turn in the same tick, so
 * the fixture may not have recorded the frame yet when the event stream ends.
 * Poll instead of sampling once.
 */
async function waitForWireEntry(
  workspace: string,
  predicate: (entry: Record<string, any>) => boolean,
  timeoutMs = 2_000
): Promise<Record<string, any> | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const match = (await wireLog(workspace).catch(() => [])).find(predicate);
    if (match !== undefined || Date.now() >= deadline) {
      return match;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function wireLog(workspace: string): Promise<Array<Record<string, any>>> {
  const text = await readFile(join(workspace, "wire-log.jsonl"), "utf8");
  return text
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, any>);
}
