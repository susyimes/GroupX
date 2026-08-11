import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  JsonLineProcess,
  type JsonLineProcessOptions,
  type JsonLineProtocolError
} from "../../../src/supervisor/jsonline-process.js";

const fixturePath = fileURLToPath(new URL("../../fixtures/rpc/fixture-child.mjs", import.meta.url));
const activeProcesses = new Set<JsonLineProcess>();

afterEach(async () => {
  await Promise.all(
    [...activeProcesses].map(async (child) => {
      try {
        await child.close({ graceMs: 100, killGraceMs: 1_000 });
      } finally {
        activeProcesses.delete(child);
      }
    })
  );
});

describe("JsonLineProcess", () => {
  it("uses an explicit argv transport and frames split UTF-8 LF/CRLF messages", async () => {
    const child = fixtureProcess();
    const messages: unknown[] = [];
    child.onMessage((message) => messages.push(message));

    await child.send({ jsonrpc: "2.0", id: 1, method: "fixture/framing" });
    await waitFor(() => messages.length === 2);

    expect(messages[0]).toEqual({
      jsonrpc: "2.0",
      method: "fixture/chunk",
      params: { text: "你🙂" }
    });
    expect(messages[1]).toEqual({ jsonrpc: "2.0", id: 1, result: true });
  });

  it("keeps stderr out of the protocol stream and bounds diagnostics without classifying their text", async () => {
    const child = fixtureProcess({ maxStderrChars: 96 });
    const messages: unknown[] = [];
    const stderr: string[] = [];
    child.onMessage((message) => messages.push(message));
    child.onStderr((text) => stderr.push(text));

    await child.send({
      jsonrpc: "2.0",
      id: 2,
      method: "fixture/stderr",
      params: {
        text: '{"looks":"like protocol","api_key":"sk-abcdefghijklmno"}',
        repeat: 10
      }
    });
    await waitFor(() => messages.length === 1 && stderr.length > 0);

    expect(messages).toEqual([{ jsonrpc: "2.0", id: 2, result: true }]);
    expect(child.stderr.length).toBeLessThanOrEqual(96);
    expect(child.stderr).toContain("sk-abcdefghijklmno");
    expect(child.stderr).not.toContain("[REDACTED]");
  });

  it.each([
    ["syntax", "malformed_json"],
    ["badUtf8", "invalid_utf8"],
    ["overlong", "line_too_large"]
  ] as const)("reports %s stdout as one fatal framing error", async (kind, expectedKind) => {
    const child = fixtureProcess({ maxStdoutLineBytes: 128 });
    const errors: JsonLineProtocolError[] = [];
    const messages: unknown[] = [];
    child.onProtocolError((error) => errors.push(error));
    child.onMessage((message) => messages.push(message));

    await child.send({
      jsonrpc: "2.0",
      id: 3,
      method: "fixture/malformed",
      params: { kind, size: 512 }
    });
    await waitFor(() => errors.length === 1);
    await expect(
      child.send({ jsonrpc: "2.0", id: 4, method: "fixture/echo", params: { ignored: true } })
    ).rejects.toThrow(/not accepting writes/i);
    await delay(20);

    expect(errors[0]?.kind).toBe(expectedKind);
    expect(messages).toEqual([]);
  });

  it("closes gracefully, is idempotent, and leaves no child PID", async () => {
    const child = fixtureProcess();
    const pid = child.pid;
    expect(pid).toEqual(expect.any(Number));

    const first = child.close({ graceMs: 500 });
    const second = child.close({ graceMs: 500 });
    expect(second).toBe(first);
    const exit = await first;

    expect(exit.expected).toBe(true);
    expect(exit.forced).toBe(false);
    expect(exit.code).toBe(0);
    expect(pidAlive(pid as number)).toBe(false);
    await expect(child.send({ ignored: true })).rejects.toThrow(/not accepting writes/i);
  });

  it("forces an EOF-ignoring child down after the bounded close grace period", async () => {
    const child = fixtureProcess({
      fixtureArgs: ["--eof=ignore"],
      closeGraceMs: 30,
      killGraceMs: 1_000
    });
    const pid = child.pid;

    const exit = await child.close();

    expect(exit.expected).toBe(true);
    expect(exit.forced).toBe(true);
    expect(pid).toEqual(expect.any(Number));
    expect(pidAlive(pid as number)).toBe(false);
  });

  it("kills an exact descendant process with the supervised process tree", async () => {
    const child = fixtureProcess({
      fixtureArgs: ["--eof=ignore"],
      closeGraceMs: 30,
      killGraceMs: 1_000
    });
    const messages: unknown[] = [];
    child.onMessage((message) => messages.push(message));
    await child.send({ jsonrpc: "2.0", id: 20, method: "fixture/spawnDescendant" });
    await waitFor(() => messages.length === 1);

    const parentPid = child.pid as number;
    const descendantPid = (messages[0] as { result: { pid: number } }).result.pid;
    expect(pidAlive(parentPid)).toBe(true);
    expect(pidAlive(descendantPid)).toBe(true);

    try {
      const exit = await child.close();
      expect(exit.forced).toBe(true);
      await waitFor(() => !pidAlive(parentPid) && !pidAlive(descendantPid));
    } finally {
      killExactPid(descendantPid);
      killExactPid(parentPid);
    }
  });

  it("reports a non-newline-terminated frame when stdout closes", async () => {
    const child = fixtureProcess();
    const errors: JsonLineProtocolError[] = [];
    child.onProtocolError((error) => errors.push(error));

    await child.send({ jsonrpc: "2.0", id: 21, method: "fixture/truncatedExit" });
    const exit = await child.waitForExit();

    expect(exit.code).toBe(24);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.kind).toBe("truncated_line");
  });
});

interface FixtureOptions extends Omit<JsonLineProcessOptions, "argv"> {
  fixtureArgs?: string[];
}

function fixtureProcess(options: FixtureOptions = {}): JsonLineProcess {
  const { fixtureArgs = [], ...processOptions } = options;
  const child = JsonLineProcess.spawn({
    ...processOptions,
    argv: [process.execPath, fixturePath, "--dialect=acp", ...fixtureArgs],
    cwd: process.cwd()
  });
  activeProcesses.add(child);
  return child;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for fixture state");
    }
    await delay(5);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killExactPid(pid: number): void {
  if (!pidAlive(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The exact process may have exited between the liveness check and cleanup.
  }
}
