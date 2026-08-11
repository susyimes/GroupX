import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  CodexAppServerAdapter,
  buildCodexLaunchArgv,
  buildCodexMcpOverride,
  buildCodexPromptText,
  buildCodexThreadResumeParams,
  buildCodexThreadStartParams
} from "../../../../src/adapters/codex/index.js";
import type { LaunchProfile, NativeEvent, NativeSession, PromptInput } from "../../../../src/adapters/types.js";

const fixtureCwd = fileURLToPath(new URL("../../../fixtures/codex/", import.meta.url));
const fixtureEntrypoint = fileURLToPath(new URL("../../../fixtures/codex/app-server", import.meta.url));

function profile(overrides: Partial<LaunchProfile> = {}): LaunchProfile {
  return {
    command: process.execPath,
    prefixArgs: [fixtureEntrypoint],
    cwd: fixtureCwd,
    bindingId: "binding:codex:test",
    ...overrides
  };
}

function promptInput(content: string, signal?: AbortSignal): PromptInput {
  return {
    turnId: `groupx-${content}`,
    content,
    correlationId: `corr-${content}`,
    ...(signal === undefined ? {} : { signal })
  };
}

function adapter(shortTimeouts = false): CodexAppServerAdapter {
  return new CodexAppServerAdapter({
    createInstanceId: () => `codex-fixture@${crypto.randomUUID()}`,
    ...(shortTimeouts
      ? {
          timeouts: {
            handshakeMs: 1_000,
            requestMs: 500,
            firstEventMs: 80,
            idleMs: 80,
            cancelMs: 100,
            closeMs: 200
          }
        }
      : {})
  });
}

async function collect(iterable: AsyncIterable<NativeEvent>): Promise<NativeEvent[]> {
  const events: NativeEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

async function collectIterator(
  iterator: AsyncIterator<NativeEvent>,
  initial: NativeEvent[] = []
): Promise<NativeEvent[]> {
  const events = [...initial];
  while (true) {
    const next = await iterator.next();
    if (next.done) {
      return events;
    }
    events.push(next.value);
  }
}

async function closeQuietly(instance: CodexAppServerAdapter, session: NativeSession | undefined): Promise<void> {
  if (session !== undefined) {
    await instance.close(session).catch(() => undefined);
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("condition was not met before timeout");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe("Codex App Server request construction", () => {
  it("places launcher prefix args before the fixed global unrestricted flag and app-server subcommand", () => {
    expect(buildCodexLaunchArgv("node", ["codex.js"])).toEqual([
      "node",
      "codex.js",
      "--dangerously-bypass-hook-trust",
      "app-server",
      "--listen",
      "stdio://"
    ]);
  });

  it("fixes native unrestricted access while omitting cwd and unrelated policy overrides", () => {
    const params = buildCodexThreadStartParams(profile(), "binding:codex:plain");
    expect(params).toEqual({ approvalPolicy: "never", sandbox: "danger-full-access" });
    for (const forbidden of [
      "cwd",
      "model",
      "modelProvider",
      "sandboxPolicy",
      "approvalsReviewer",
      "permissions",
      "dynamicTools"
    ]) {
      expect(params).not.toHaveProperty(forbidden);
    }
  });

  it("derives a stdio MCP config only from the launch spec and provenance binding", () => {
    const launch = profile({
      bindingId: "binding:codex:stdio",
      mcp: { transport: "stdio", command: "groupx-mcp", args: ["serve"] }
    });
    expect(buildCodexThreadStartParams(launch, launch.bindingId!)).toEqual({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      config: {
        "mcp_servers.groupx": {
          command: "groupx-mcp",
          args: ["serve", "--binding-id", "binding:codex:stdio"]
        }
      }
    });
  });

  it("derives a streamable HTTP MCP config with a non-secret binding header", () => {
    expect(
      buildCodexMcpOverride(
        { transport: "streamable-http", url: "http://127.0.0.1:4310/mcp" },
        "binding:codex:http"
      )
    ).toEqual({
      "mcp_servers.groupx": {
        url: "http://127.0.0.1:4310/mcp",
        http_headers: { "X-GroupX-Binding": "binding:codex:http" }
      }
    });
  });

  it("adds only threadId and the stable MCP fragment on resume", () => {
    const launch = profile({
      mcp: { transport: "stdio", command: "groupx-mcp", args: [] }
    });
    const params = buildCodexThreadResumeParams(launch, "binding:resume", "thread-existing");
    expect(params).toEqual({
      threadId: "thread-existing",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      config: {
        "mcp_servers.groupx": { command: "groupx-mcp", args: ["--binding-id", "binding:resume"] }
      }
    });
    expect(params).not.toHaveProperty("cwd");
  });

  it("keeps the prepared context separate from the current message marker", () => {
    expect(buildCodexPromptText({ contextPacket: "[group_memory]\nremember this", content: "hello" })).toBe(
      "[group_memory]\nremember this\n\n[groupx_current_message]\nhello"
    );
  });
});

describe("CodexAppServerAdapter", () => {
  it("reports documented capability without claiming a live verification", async () => {
    const instance = adapter();
    const report = await instance.probe();
    expect(report.adapterId).toBe("codex");
    expect(report.version).toBe("0.147.0");
    expect(report.launchArgvShape).toEqual([
      "<command>",
      "<prefixArgs...>",
      "--dangerously-bypass-hook-trust",
      "app-server",
      "--listen",
      "stdio://"
    ]);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ capability: "live compatibility", level: "not_observed" })
    );
  });

  it("handshakes, starts a persistent thread, streams, and emits one terminal event", async () => {
    const instance = adapter();
    let session: NativeSession | undefined;
    try {
      session = await instance.start(
        profile({
          instanceId: "codex/pre-registered",
          mcp: { transport: "streamable-http", url: "http://127.0.0.1:4310/mcp" }
        })
      );
      expect(session.nativeSessionId).toMatch(/^thread-/);
      expect(session.actorId).toBe("agent:codex");
      expect(session.instanceId).toBe("codex/pre-registered");
      expect(instance.health()).toMatchObject({ status: "ready", nativeSessionAvailable: true });

      const events = await collect(instance.prompt(session, promptInput("NORMAL")));
      expect(events.map((event) => event.type)).toEqual([
        "turn.started",
        "content.delta",
        "turn.completed"
      ]);
      expect(events[1]?.payload).toEqual(expect.objectContaining({ text: "fixture-ok", chunkIndex: 1 }));
      expect(events.filter((event) => event.type.startsWith("turn.") && event.type !== "turn.started")).toHaveLength(1);
      expect(events.every((event) => event.instanceId === session!.instanceId)).toBe(true);
    } finally {
      await closeQuietly(instance, session);
    }
  });

  it("resumes an existing thread on a fresh app-server process", async () => {
    const instance = adapter();
    let started: NativeSession | undefined;
    let resumed: NativeSession | undefined;
    try {
      started = await instance.start(profile({ bindingId: "binding:start" }));
      const nativeSessionId = started.nativeSessionId!;
      await instance.close(started);
      started = undefined;

      resumed = await instance.resume({
        ...profile({ bindingId: "binding:resume" }),
        nativeSessionId
      });
      expect(resumed.nativeSessionId).toBe(nativeSessionId);
      expect(await collect(instance.prompt(resumed, promptInput("RESUMED")))).toContainEqual(
        expect.objectContaining({ type: "turn.completed" })
      );
    } finally {
      await closeQuietly(instance, started);
      await closeQuietly(instance, resumed);
    }
  });

  it("runs two normal Turns in one session and ignores a late terminal from the retired Turn", async () => {
    const instance = adapter();
    let session: NativeSession | undefined;
    try {
      session = await instance.start(profile());
      const first = await collect(instance.prompt(session, promptInput("FIRST_NORMAL")));
      const firstNativeTurnId = first.find((event) => event.type === "turn.started")?.nativeTurnId;
      const second = await collect(instance.prompt(session, promptInput("MODE_LATE_OLD_EVENT")));
      const secondNativeTurnId = second.find((event) => event.type === "turn.started")?.nativeTurnId;

      expect(firstNativeTurnId).toMatch(/^turn-/);
      expect(secondNativeTurnId).toMatch(/^turn-/);
      expect(secondNativeTurnId).not.toBe(firstNativeTurnId);
      expect(second.filter((event) => ["turn.completed", "turn.cancelled", "turn.failed"].includes(event.type))).toHaveLength(1);
      expect(second).toContainEqual(expect.objectContaining({ type: "turn.completed", nativeTurnId: secondNativeTurnId }));
    } finally {
      await closeQuietly(instance, session);
    }
  });

  it.each([
    "MODE_COMMAND_INTERACTION",
    "MODE_FILE_INTERACTION",
    "MODE_PERMISSIONS_INTERACTION",
    "MODE_USER_INPUT_INTERACTION",
    "MODE_MCP_ELICITATION",
    "MODE_UNKNOWN_SERVER_REQUEST"
  ])("settles %s without exposing a GroupX approval surface and fails the Turn once", async (mode) => {
    const instance = adapter(true);
    let session: NativeSession | undefined;
    try {
      session = await instance.start(profile());
      const events = await collect(instance.prompt(session, promptInput(mode)));
      expect(events.map((event) => event.type)).toContain("transport.error");
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "turn.failed",
          payload: expect.objectContaining({ errorCode: "UNEXPECTED_NATIVE_INTERACTION" })
        })
      );
      expect(events.filter((event) => event.type === "turn.failed")).toHaveLength(1);
      expect(events.some((event) => String(event.type).includes("approval"))).toBe(false);
      expect("resolveApproval" in instance).toBe(false);
      await waitFor(() => !instance.health().nativeSessionAvailable);
    } finally {
      await closeQuietly(instance, session);
    }
  });

  it("does not upgrade a native request to policy-blocked from request payload fields", async () => {
    const instance = adapter(true);
    let session: NativeSession | undefined;
    try {
      session = await instance.start(profile());
      const events = await collect(instance.prompt(session, promptInput("MODE_NETWORK_CONTEXT_INTERACTION")));
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "turn.failed",
          payload: expect.objectContaining({ errorCode: "UNEXPECTED_NATIVE_INTERACTION" })
        })
      );
      expect(events.filter((event) => event.type === "turn.failed")).toHaveLength(1);
    } finally {
      await closeQuietly(instance, session);
    }
  });

  it("fails before thread creation when native requirements exclude unrestricted execution", async () => {
    const instance = adapter(true);
    await expect(
      instance.start(
        profile({
          bindingId: "binding:policy-blocked",
          prefixArgs: [fixtureEntrypoint, "--fixture-policy-blocked"]
        })
      )
    ).rejects.toMatchObject({ code: "NATIVE_POLICY_BLOCKED" });
    expect(instance.health()).toMatchObject({ status: "failed", nativeSessionAvailable: false });
  });

  it("accepts a valid granular approval requirement when never remains allowed", async () => {
    const instance = adapter(true);
    let session: NativeSession | undefined;
    try {
      session = await instance.start(
        profile({
          bindingId: "binding:granular-never",
          prefixArgs: [fixtureEntrypoint, "--fixture-granular-never"]
        })
      );
      expect(session.nativeSessionId).toMatch(/^thread-/);
    } finally {
      await closeQuietly(instance, session);
    }
  });

  it("rejects a native thread whose reported cwd differs from the child process cwd", async () => {
    const instance = adapter(true);
    await expect(
      instance.start(
        profile({
          bindingId: "binding:cwd-mismatch",
          prefixArgs: [fixtureEntrypoint, "--fixture-cwd-mismatch"]
        })
      )
    ).rejects.toMatchObject({ code: "ADAPTER_START_FAILED" });
  });

  it("deduplicates duplicate native turn/completed notifications", async () => {
    const instance = adapter();
    let session: NativeSession | undefined;
    try {
      session = await instance.start(profile());
      const events = await collect(instance.prompt(session, promptInput("MODE_DUPLICATE_TERMINAL")));
      expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
      expect(events.filter((event) => ["turn.completed", "turn.cancelled", "turn.failed"].includes(event.type))).toHaveLength(1);
    } finally {
      await closeQuietly(instance, session);
    }
  });

  it("uses final agentMessage text when no delta was emitted", async () => {
    const instance = adapter();
    let session: NativeSession | undefined;
    try {
      session = await instance.start(profile());
      const events = await collect(instance.prompt(session, promptInput("MODE_ITEM_FALLBACK")));
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "content.delta",
          payload: expect.objectContaining({ text: "fallback-text", finalItemFallback: true })
        })
      );
    } finally {
      await closeQuietly(instance, session);
    }
  });

  it("maps AbortSignal to native turn/interrupt and waits for the native terminal", async () => {
    const instance = adapter(true);
    let session: NativeSession | undefined;
    try {
      session = await instance.start(profile());
      const controller = new AbortController();
      const iterator = instance.prompt(session, promptInput("MODE_INTERRUPT", controller.signal))[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.value?.type).toBe("turn.started");
      controller.abort();
      const events = await collectIterator(iterator, [first.value!]);
      expect(events.filter((event) => event.type === "turn.cancelled")).toHaveLength(1);
      expect(events.filter((event) => ["turn.completed", "turn.cancelled", "turn.failed"].includes(event.type))).toHaveLength(1);
    } finally {
      await closeQuietly(instance, session);
    }
  });

  it("sends an explicit native interrupt from cancel() and reports the observed terminal", async () => {
    const instance = adapter(true);
    let session: NativeSession | undefined;
    try {
      session = await instance.start(profile());
      const iterator = instance.prompt(session, promptInput("MODE_INTERRUPT"))[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.value?.nativeTurnId).toMatch(/^turn-/);
      const cancelled = await instance.cancel(session, first.value!.nativeTurnId!);
      const events = await collectIterator(iterator, [first.value!]);
      expect(cancelled).toMatchObject({ requested: true, supported: true, terminalObserved: true });
      expect(events.filter((event) => event.type === "turn.cancelled")).toHaveLength(1);
    } finally {
      await closeQuietly(instance, session);
    }
  });

  it("fails and retires the session when cancellation is acknowledged without a native terminal", async () => {
    const instance = adapter(true);
    let session: NativeSession | undefined;
    try {
      session = await instance.start(profile());
      const iterator = instance.prompt(session, promptInput("MODE_CANCEL_TIMEOUT"))[Symbol.asyncIterator]();
      const first = await iterator.next();
      expect(first.value?.type).toBe("turn.started");

      const cancelled = await instance.cancel(session, first.value!.nativeTurnId!);
      const events = await collectIterator(iterator, [first.value!]);
      expect(cancelled).toMatchObject({ requested: true, supported: true, terminalObserved: false });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "turn.failed",
          payload: expect.objectContaining({ errorCode: "TURN_CANCEL_TIMEOUT" })
        })
      );
      expect(events.filter((event) => ["turn.completed", "turn.cancelled", "turn.failed"].includes(event.type))).toHaveLength(1);
      await expect(collect(instance.prompt(session, promptInput("MUST_NOT_REUSE")))).rejects.toMatchObject({
        code: "SESSION_NOT_AVAILABLE"
      });
    } finally {
      await closeQuietly(instance, session);
    }
  });

  it("interrupts an active turn before closing only its app-server process", async () => {
    const instance = adapter(true);
    const session = await instance.start(profile());
    const iterator = instance.prompt(session, promptInput("MODE_INTERRUPT"))[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.type).toBe("turn.started");
    await instance.close(session);
    const events = await collectIterator(iterator, [first.value!]);
    expect(events.filter((event) => ["turn.completed", "turn.cancelled", "turn.failed"].includes(event.type))).toHaveLength(1);
    expect(instance.health()).toMatchObject({ status: "stopped", nativeSessionAvailable: false });
  });

  it("turns an unexpected app-server exit into one bounded failed terminal", async () => {
    const instance = adapter(true);
    let session: NativeSession | undefined;
    try {
      session = await instance.start(profile());
      const events = await collect(instance.prompt(session, promptInput("MODE_EXIT")));
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "turn.failed",
          payload: expect.objectContaining({ errorCode: "TURN_INTERRUPTED" })
        })
      );
      expect(events.filter((event) => ["turn.completed", "turn.cancelled", "turn.failed"].includes(event.type))).toHaveLength(1);
    } finally {
      await closeQuietly(instance, session);
    }
  });

  it("fails with a bounded first-event timeout and one terminal", async () => {
    const instance = adapter(true);
    let session: NativeSession | undefined;
    try {
      session = await instance.start(profile());
      const events = await collect(instance.prompt(session, promptInput("MODE_FIRST_TIMEOUT")));
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "turn.failed",
          payload: expect.objectContaining({ errorCode: "TURN_FIRST_EVENT_TIMEOUT" })
        })
      );
      expect(events.filter((event) => ["turn.completed", "turn.cancelled", "turn.failed"].includes(event.type))).toHaveLength(1);
    } finally {
      await closeQuietly(instance, session);
    }
  });

  it("turns malformed stdout into one protocol failure and tears down the session", async () => {
    const instance = adapter(true);
    let session: NativeSession | undefined;
    try {
      session = await instance.start(profile());
      const events = await collect(instance.prompt(session, promptInput("MODE_MALFORMED")));
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "turn.failed",
          payload: expect.objectContaining({ errorCode: "PROTOCOL_INVALID_MESSAGE" })
        })
      );
      expect(events.filter((event) => ["turn.completed", "turn.cancelled", "turn.failed"].includes(event.type))).toHaveLength(1);
      await waitFor(() => !instance.health().nativeSessionAvailable);
    } finally {
      await closeQuietly(instance, session);
    }
  });

  it("bounds a native error notification and still emits one failed terminal", async () => {
    const instance = adapter();
    let session: NativeSession | undefined;
    try {
      session = await instance.start(profile());
      const events = await collect(instance.prompt(session, promptInput("MODE_ERROR_NOTIFICATION")));
      expect(events).toContainEqual(expect.objectContaining({ type: "transport.error" }));
      expect(events.filter((event) => ["turn.completed", "turn.cancelled", "turn.failed"].includes(event.type))).toHaveLength(1);
      expect(events).toContainEqual(expect.objectContaining({ type: "turn.failed" }));
    } finally {
      await closeQuietly(instance, session);
    }
  });

  it("rejects a session whose binding is paired with another process instance", async () => {
    const instance = adapter();
    let first: NativeSession | undefined;
    let second: NativeSession | undefined;
    try {
      first = await instance.start(profile({ bindingId: "binding:codex:first", instanceId: "codex/first" }));
      second = await instance.start(profile({ bindingId: "binding:codex:second", instanceId: "codex/second" }));
      const forged = { ...first, bindingId: second.bindingId };
      await expect(collect(instance.prompt(forged, promptInput("CROSS_SESSION")))).rejects.toMatchObject({
        code: "SESSION_NOT_AVAILABLE"
      });

      const [firstEvents, secondEvents] = await Promise.all([
        collect(instance.prompt(first, promptInput("FIRST_BOUND"))),
        collect(instance.prompt(second, promptInput("SECOND_BOUND")))
      ]);
      expect(firstEvents.every((event) => event.instanceId === "codex/first")).toBe(true);
      expect(secondEvents.every((event) => event.instanceId === "codex/second")).toBe(true);
    } finally {
      await closeQuietly(instance, first);
      await closeQuietly(instance, second);
    }
  });

  it("fails an inactive stream with an idle timeout and refuses unsafe process reuse", async () => {
    const instance = adapter(true);
    let session: NativeSession | undefined;
    try {
      session = await instance.start(profile());
      const timedOut = await collect(instance.prompt(session, promptInput("MODE_IDLE_TIMEOUT")));
      expect(timedOut).toContainEqual(
        expect.objectContaining({
          type: "turn.failed",
          payload: expect.objectContaining({ errorCode: "TURN_IDLE_TIMEOUT" })
        })
      );
      await expect(collect(instance.prompt(session, promptInput("AFTER_TIMEOUT")))).rejects.toMatchObject({
        code: "SESSION_NOT_AVAILABLE"
      });
    } finally {
      await closeQuietly(instance, session);
    }
  });
});
