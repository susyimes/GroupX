import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CodexDirectAdapter,
  GrokDirectAdapter,
  KimiDirectAdapter,
  buildKimiDirectLaunch,
  type DirectCliAdapter
} from "../../../../src/adapters/direct/index.js";
import type {
  LaunchProfile,
  NativeEvent,
  NativeSession,
  PromptInput
} from "../../../../src/adapters/types.js";
import { GroupXError } from "../../../../src/core/errors.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/direct", import.meta.url));
const workspaces: string[] = [];
const sessions: Array<{ adapter: DirectCliAdapter; session: NativeSession }> = [];

afterEach(async () => {
  for (const { adapter, session } of sessions.splice(0)) {
    await adapter.close(session).catch(() => undefined);
  }
  for (const workspace of workspaces.splice(0)) {
    await rm(workspace, { recursive: true, force: true });
  }
});

describe("Direct transport argv and sessions", () => {
  it("runs Codex through raw stdin with fixed unrestricted flags and explicit resume", async () => {
    const workspace = await fixtureWorkspace({ intermediateError: true });
    const first = new CodexDirectAdapter({ version: "test" });
    const firstSession = await first.start(profile("codex", workspace));
    sessions.push({ adapter: first, session: firstSession });

    const events = await collect(
      first.prompt(firstSession, prompt("codex-turn", "hello", "[group_context]\nprior"))
    );
    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "content.delta",
      "turn.completed"
    ]);
    expect(events[1]?.payload).toEqual({ text: "codex answer" });
    expect(firstSession.nativeSessionId).toBe("fixture-session");

    await first.close(firstSession);
    sessions.pop();
    const resumed = new CodexDirectAdapter({ version: "test" });
    const resumedSession = await resumed.resume({
      ...profile("codex", workspace),
      nativeSessionId: "fixture-session"
    });
    sessions.push({ adapter: resumed, session: resumedSession });
    await collect(resumed.prompt(resumedSession, prompt("codex-resume", "again")));

    const log = await wireLog(workspace);
    expect(log.filter((entry) => entry.event === "startup").map((entry) => entry.argv)).toEqual([
      ["--yolo", "--dangerously-bypass-hook-trust", "exec", "--json", "-"],
      [
        "--yolo",
        "--dangerously-bypass-hook-trust",
        "exec",
        "resume",
        "--json",
        "fixture-session",
        "-"
      ]
    ]);
    expect(log.find((entry) => entry.event === "stdin")?.text).toBe(
      "[group_context]\nprior\n\n[groupx_current_message]\nhello"
    );
  });

  it("runs Grok with fixed max-open flags, streaming-json, --single, and explicit resume", async () => {
    const workspace = await fixtureWorkspace();
    const adapter = new GrokDirectAdapter({ version: "test" });
    const session = await adapter.start(profile("grok", workspace));
    sessions.push({ adapter, session });

    const events = await collect(adapter.prompt(session, prompt("grok-turn", "hello grok")));
    expect(events.map((event) => event.type)).toEqual([
      "turn.started",
      "content.delta",
      "turn.completed"
    ]);
    expect(session.nativeSessionId).toBe("fixture-session");
    await collect(adapter.prompt(session, prompt("grok-resume", "second")));

    const startups = (await wireLog(workspace)).filter((entry) => entry.event === "startup");
    expect(startups[0]?.argv).toEqual([
      "--no-auto-update",
      "--permission-mode",
      "bypassPermissions",
      "--sandbox",
      "off",
      "--no-plan",
      "--output-format",
      "streaming-json",
      "--single",
      "hello grok"
    ]);
    expect(startups[1]?.argv).toEqual([
      "--no-auto-update",
      "--permission-mode",
      "bypassPermissions",
      "--sandbox",
      "off",
      "--no-plan",
      "--resume",
      "fixture-session",
      "--output-format",
      "streaming-json",
      "--single",
      "second"
    ]);
  });

  it("runs Kimi Direct after the bounded config preflight and uses native resume", async () => {
    const workspace = await fixtureWorkspace();
    const configPreflight = vi.fn(async () => ({
      permissionMode: "yolo" as const,
      planMode: false as const,
      source: "default-home" as const
    }));
    const adapter = new KimiDirectAdapter({ version: "test", configPreflight });
    const session = await adapter.start(profile("kimi", workspace));
    sessions.push({ adapter, session });

    const first = await collect(adapter.prompt(session, prompt("kimi-turn", "hello kimi")));
    expect(first.map((event) => event.type)).toEqual([
      "turn.started",
      "content.delta",
      "turn.completed"
    ]);
    expect(session.nativeSessionId).toBe("fixture-session");
    await collect(adapter.prompt(session, prompt("kimi-resume", "second")));

    const startups = (await wireLog(workspace)).filter((entry) => entry.event === "startup");
    expect(startups.map((entry) => entry.argv)).toEqual([
      ["--prompt", "hello kimi", "--output-format", "stream-json"],
      [
        "--session",
        "fixture-session",
        "--prompt",
        "second",
        "--output-format",
        "stream-json"
      ]
    ]);
    expect(configPreflight).toHaveBeenCalledTimes(3);
    expect(await adapter.probe()).toMatchObject({
      findings: expect.arrayContaining([
        expect.objectContaining({ capability: "access.plan_disabled", level: "probed" }),
        expect.objectContaining({ capability: "transport.direct", level: "deprecated" })
      ])
    });
  });

  it("fails Kimi Direct start and resume before spawning when config preflight fails", async () => {
    const workspace = await fixtureWorkspace();
    const configPreflight = vi.fn(async () => {
      throw new GroupXError(
        "ADAPTER_START_FAILED",
        "Kimi unrestricted preflight requires default_plan_mode to be false"
      );
    });
    const adapter = new KimiDirectAdapter({ version: "test", configPreflight });

    await expect(adapter.start(profile("kimi", workspace))).rejects.toMatchObject({
      code: "ADAPTER_START_FAILED",
      message: "Kimi unrestricted preflight requires default_plan_mode to be false"
    });
    await expect(
      adapter.resume({ ...profile("kimi", workspace), nativeSessionId: "fixture-session" })
    ).rejects.toMatchObject({
      code: "ADAPTER_START_FAILED",
      message: "Kimi unrestricted preflight requires default_plan_mode to be false"
    });
    expect(adapter.health()).toMatchObject({
      status: "failed",
      nativeSessionAvailable: false,
      lastError:
        "ADAPTER_START_FAILED: Kimi unrestricted preflight requires default_plan_mode to be false"
    });
    expect(configPreflight).toHaveBeenCalledTimes(2);
    await expect(readFile(join(workspace, "wire-log.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps Kimi Direct argv construction as a future transport helper without conflicting flags", () => {
    const launchProfile = {
      command: process.execPath,
      prefixArgs: [join(FIXTURES, "kimi.mjs")]
    };
    const first = buildKimiDirectLaunch(launchProfile, "hello kimi");
    const resumed = buildKimiDirectLaunch(launchProfile, "second", "fixture-session");

    expect(first.argv.slice(2)).toEqual([
      "--prompt",
      "hello kimi",
      "--output-format",
      "stream-json"
    ]);
    expect(resumed.argv.slice(2)).toEqual([
      "--session",
      "fixture-session",
      "--prompt",
      "second",
      "--output-format",
      "stream-json"
    ]);
    expect(JSON.stringify([first, resumed])).not.toMatch(/--auto|--yolo|--plan/);
  });
});

describe("Direct transport fail-closed behavior", () => {
  it("rejects overlong Grok argv without spawning or truncating the context", async () => {
    const workspace = await fixtureWorkspace();
    const adapter = new GrokDirectAdapter({ maxArgvCharacters: 320 });
    const session = await adapter.start(profile("grok", workspace));
    sessions.push({ adapter, session });
    const events = await collect(
      adapter.prompt(session, prompt("grok-large", "x".repeat(1_000), "context-must-not-be-truncated"))
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: "turn.failed",
        payload: expect.objectContaining({ errorCode: "MESSAGE_TOO_LARGE" })
      })
    ]);
    await expect(readFile(join(workspace, "wire-log.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("maps a managed Grok bypass-policy marker to NATIVE_POLICY_BLOCKED even with exit 0", async () => {
    const workspace = await fixtureWorkspace({
      policyStderr: "always-approve enable blocked by managed policy"
    });
    const adapter = new GrokDirectAdapter();
    const session = await adapter.start(profile("grok", workspace));
    sessions.push({ adapter, session });

    const events = await collect(adapter.prompt(session, prompt("grok-policy", "hello")));
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: "turn.failed",
        payload: expect.objectContaining({ errorCode: "NATIVE_POLICY_BLOCKED" })
      })
    );
    expect(session.nativeSessionId).toBeUndefined();
    expect(adapter.health()).toMatchObject({ status: "failed" });
  });

  it("maps a structured Grok session-start policy refusal to NATIVE_POLICY_BLOCKED", async () => {
    const workspace = await fixtureWorkspace({
      policyStdout:
        "Refusing to start session because managed policy disables the requested bypass permission mode"
    });
    const adapter = new GrokDirectAdapter();
    const session = await adapter.start(profile("grok", workspace));
    sessions.push({ adapter, session });

    const events = await collect(adapter.prompt(session, prompt("grok-policy-stdout", "hello")));
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: "turn.failed",
        payload: expect.objectContaining({ errorCode: "NATIVE_POLICY_BLOCKED" })
      })
    );
    expect(session.nativeSessionId).toBeUndefined();
    expect((await wireLog(workspace)).some((entry) => entry.event === "stdout")).toBe(true);
  });

  it("keeps an explicit native interaction terminal even when later stderr mentions managed policy", async () => {
    const workspace = await fixtureWorkspace({
      interaction: "permission_request",
      interactionDiagnostic: "always-approve enable blocked by managed policy",
      policyStderr: "always-approve disabled by managed policy"
    });
    const adapter = new GrokDirectAdapter({ killGraceMs: 1_000 });
    const session = await adapter.start(profile("grok", workspace));
    sessions.push({ adapter, session });

    const events = await collect(adapter.prompt(session, prompt("grok-policy-interaction", "hello")));
    expect(events.at(-1)?.payload).toEqual(
      expect.objectContaining({ errorCode: "UNEXPECTED_NATIVE_INTERACTION" })
    );
  });

  it("terminates an unexpected native interaction without producing an approval event", async () => {
    const workspace = await fixtureWorkspace({ interaction: "approval.requested" });
    const adapter = new CodexDirectAdapter({ killGraceMs: 1_000 });
    const session = await adapter.start(profile("codex", workspace));
    sessions.push({ adapter, session });

    const events = await collect(adapter.prompt(session, prompt("codex-interaction", "hello")));
    expect(events.map((event) => event.type)).toEqual(["turn.started", "turn.failed"]);
    expect(events.at(-1)?.payload).toEqual(
      expect.objectContaining({ errorCode: "UNEXPECTED_NATIVE_INTERACTION" })
    );
  });

  it("normalizes malformed JSONL to one protocol terminal", async () => {
    const workspace = await fixtureWorkspace({ malformed: true });
    const adapter = new GrokDirectAdapter();
    const session = await adapter.start(profile("grok", workspace));
    sessions.push({ adapter, session });

    const events = await collect(adapter.prompt(session, prompt("grok-malformed", "hello")));
    expect(events.filter((event) => event.type === "turn.failed")).toHaveLength(1);
    expect(events.at(-1)?.payload).toEqual(
      expect.objectContaining({ errorCode: "PROTOCOL_INVALID_MESSAGE" })
    );
  });

  it("does not advance a Grok session when JSONL is followed by non-zero exit", async () => {
    const workspace = await fixtureWorkspace({ exitCode: 7 });
    const adapter = new GrokDirectAdapter();
    const session = await adapter.start(profile("grok", workspace));
    sessions.push({ adapter, session });

    const events = await collect(adapter.prompt(session, prompt("grok-exit", "hello")));
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        type: "turn.failed",
        payload: expect.objectContaining({ errorCode: "TURN_INTERRUPTED" })
      })
    );
    expect(session.nativeSessionId).toBeUndefined();
  });

  it("bounds first-event and idle stalls with one failed terminal", async () => {
    const firstWorkspace = await fixtureWorkspace({ hold: true });
    const firstAdapter = new CodexDirectAdapter({ firstEventMs: 60, killGraceMs: 1_000 });
    const firstSession = await firstAdapter.start(profile("codex", firstWorkspace));
    sessions.push({ adapter: firstAdapter, session: firstSession });
    const firstEvents = await collect(firstAdapter.prompt(firstSession, prompt("codex-first-timeout", "hello")));
    expect(firstEvents.at(-1)?.payload).toEqual(
      expect.objectContaining({ errorCode: "TURN_FIRST_EVENT_TIMEOUT" })
    );

    const idleWorkspace = await fixtureWorkspace({ holdAfterFirst: true });
    const idleAdapter = new GrokDirectAdapter({ idleMs: 60, killGraceMs: 1_000 });
    const idleSession = await idleAdapter.start(profile("grok", idleWorkspace));
    sessions.push({ adapter: idleAdapter, session: idleSession });
    const idleEvents = await collect(idleAdapter.prompt(idleSession, prompt("grok-idle-timeout", "hello")));
    expect(idleEvents.map((event) => event.type)).toEqual([
      "turn.started",
      "content.delta",
      "turn.failed"
    ]);
    expect(idleEvents.at(-1)?.payload).toEqual(
      expect.objectContaining({ errorCode: "TURN_IDLE_TIMEOUT" })
    );
  });

  it("treats output after a native terminal as a protocol failure and does not advance session", async () => {
    const workspace = await fixtureWorkspace({ extraAfterTerminal: true });
    const adapter = new GrokDirectAdapter();
    const session = await adapter.start(profile("grok", workspace));
    sessions.push({ adapter, session });

    const events = await collect(adapter.prompt(session, prompt("grok-late", "hello")));
    expect(events.at(-1)?.payload).toEqual(
      expect.objectContaining({ errorCode: "PROTOCOL_INVALID_MESSAGE" })
    );
    expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(0);
    expect(session.nativeSessionId).toBeUndefined();
  });

  it("rejects a native session id change while resuming", async () => {
    const workspace = await fixtureWorkspace({ sessionId: "different-session" });
    const adapter = new CodexDirectAdapter();
    const session = await adapter.resume({
      ...profile("codex", workspace),
      nativeSessionId: "bound-session"
    });
    sessions.push({ adapter, session });

    const events = await collect(adapter.prompt(session, prompt("codex-session-mismatch", "hello")));
    expect(events.at(-1)?.payload).toEqual(
      expect.objectContaining({ errorCode: "PROTOCOL_INVALID_MESSAGE" })
    );
    expect(session.nativeSessionId).toBe("bound-session");
  });

  it("does not spawn a process for a pre-aborted prompt", async () => {
    const workspace = await fixtureWorkspace();
    const adapter = new GrokDirectAdapter();
    const session = await adapter.start(profile("grok", workspace));
    sessions.push({ adapter, session });
    const controller = new AbortController();
    controller.abort();

    expect(await collect(adapter.prompt(session, prompt("grok-pre-abort", "hello", undefined, controller.signal)))).toEqual([
      expect.objectContaining({ type: "turn.cancelled" })
    ]);
    await expect(readFile(join(workspace, "wire-log.jsonl"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("kills the exact active one-shot process on cancel and emits one cancelled terminal", async () => {
    const workspace = await fixtureWorkspace({ hold: true, spawnDescendant: true });
    const adapter = new GrokDirectAdapter({ cancelMs: 2_000, killGraceMs: 1_000 });
    const session = await adapter.start(profile("grok", workspace));
    sessions.push({ adapter, session });
    const iterator = adapter.prompt(session, prompt("grok-cancel", "hello"))[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value?.type).toBe("turn.started");
    const remainderPromise = collectIterator(iterator);
    await waitFor(async () => {
      try {
        return (await wireLog(workspace)).some((entry) => entry.event === "descendant");
      } catch {
        return false;
      }
    });
    const descendantEntry = (await wireLog(workspace)).find((entry) => entry.event === "descendant");
    const descendantPid = descendantEntry?.pid as number;
    expect(pidAlive(descendantPid)).toBe(true);

    try {
      const cancelled = await adapter.cancel(session, "grok-cancel");
      const remainder = await remainderPromise;
      expect(cancelled).toMatchObject({ requested: true, supported: true, terminalObserved: true });
      expect(remainder).toEqual([expect.objectContaining({ type: "turn.cancelled" })]);
      await waitFor(async () => !pidAlive(descendantPid));
    } finally {
      killExactPid(descendantPid);
    }
  });

  it("terminates the process tree when a consumer returns from the iterator early", async () => {
    const workspace = await fixtureWorkspace({ holdAfterFirst: true, spawnDescendant: true });
    const adapter = new GrokDirectAdapter({ killGraceMs: 1_000 });
    const session = await adapter.start(profile("grok", workspace));
    sessions.push({ adapter, session });
    const iterator = adapter.prompt(session, prompt("grok-early-return", "hello"))[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.type).toBe("turn.started");
    expect((await iterator.next()).value?.type).toBe("content.delta");
    await waitFor(async () => {
      try {
        return (await wireLog(workspace)).some((entry) => entry.event === "descendant");
      } catch {
        return false;
      }
    });
    const descendantPid = (await wireLog(workspace)).find((entry) => entry.event === "descendant")?.pid as number;
    try {
      await iterator.return?.();
      await waitFor(async () => !pidAlive(descendantPid));
      await writeFile(join(workspace, "fixture-config.json"), "{}", "utf8");
      expect((await collect(adapter.prompt(session, prompt("grok-after-return", "again")))).at(-1)?.type).toBe(
        "turn.completed"
      );
    } finally {
      killExactPid(descendantPid);
    }
  });

  it("rejects shell shims, arbitrary env/extraArgs, and MCP attachment", async () => {
    const workspace = await fixtureWorkspace();
    const adapter = new GrokDirectAdapter();
    if (process.platform === "win32") {
      await expect(adapter.start({ command: "grok.cmd", cwd: workspace })).rejects.toMatchObject({
        code: "ADAPTER_START_FAILED"
      });
    }
    await expect(
      adapter.start({
        ...profile("grok", workspace),
        extraArgs: ["--invented"],
        env: { INVENTED: "1" }
      } as LaunchProfile)
    ).rejects.toMatchObject({ code: "ADAPTER_START_FAILED" });
    await expect(
      adapter.start({
        ...profile("grok", workspace),
        mcp: { transport: "stdio", command: process.execPath, args: [] }
      })
    ).rejects.toMatchObject({ code: "MCP_BINDING_MISMATCH" });
  });

  it("rejects launcher-prefix flag injection and NUL argv as a single failed turn", async () => {
    const workspace = await fixtureWorkspace();
    const invalidPrefix = new GrokDirectAdapter();
    await expect(
      invalidPrefix.start({ command: process.execPath, prefixArgs: ["--plan"], cwd: workspace })
    ).rejects.toMatchObject({ code: "ADAPTER_START_FAILED" });

    const adapter = new GrokDirectAdapter();
    const session = await adapter.start(profile("grok", workspace));
    sessions.push({ adapter, session });
    const events = await collect(adapter.prompt(session, prompt("grok-nul", "before\0after")));
    expect(events).toEqual([
      expect.objectContaining({
        type: "turn.failed",
        payload: expect.objectContaining({ errorCode: "INVALID_ENVELOPE" })
      })
    ]);
  });
});

function profile(agent: "codex" | "grok" | "kimi", workspace: string): LaunchProfile {
  return {
    command: process.execPath,
    prefixArgs: [join(FIXTURES, `${agent}.mjs`)],
    cwd: workspace,
    instanceId: `instance:${agent}:direct-test`,
    bindingId: `binding:${agent}:direct-test`
  };
}

function prompt(
  turnId: string,
  content: string,
  contextPacket?: string,
  signal?: AbortSignal
): PromptInput {
  return {
    turnId,
    content,
    ...(contextPacket === undefined ? {} : { contextPacket }),
    correlationId: `correlation:${turnId}`,
    ...(signal === undefined ? {} : { signal })
  };
}

async function fixtureWorkspace(config: Record<string, unknown> = {}): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "groupx-direct-"));
  workspaces.push(workspace);
  await writeFile(join(workspace, "fixture-config.json"), JSON.stringify(config), "utf8");
  return workspace;
}

async function wireLog(workspace: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(workspace, "wire-log.jsonl"), "utf8");
  return text
    .trim()
    .split(/\r?\n/u)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function collect(iterable: AsyncIterable<NativeEvent>): Promise<NativeEvent[]> {
  const events: NativeEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

async function collectIterator(iterator: AsyncIterator<NativeEvent>): Promise<NativeEvent[]> {
  const events: NativeEvent[] = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) return events;
    events.push(next.value);
  }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Direct fixture state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killExactPid(pid: number): void {
  if (!pidAlive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The exact fixture descendant may have exited between checks.
  }
}
