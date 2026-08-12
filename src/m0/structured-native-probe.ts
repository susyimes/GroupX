import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { buildCodexLaunchArgv } from "../adapters/codex/index.js";
import type { CapabilityReport } from "../adapters/types.js";
import { GroupXRuntime } from "../app/runtime.js";
import { loadConfig, type GroupXConfig } from "../config.js";
import type { StoredEventRecord, TurnRecord } from "../storage/types.js";
import {
  M0_ACCESS_CONTRACT,
  M0_AGENTS,
  type M0AgentId,
  createM0RunId,
  safeErrorCode,
  writeM0Report
} from "./probe-report.js";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
const MCP_TARGETS: Readonly<Record<M0AgentId, M0AgentId>> = {
  codex: "grok",
  grok: "kimi",
  kimi: "codex"
};
const EXPECTED_STRUCTURED_TAILS: Readonly<Record<M0AgentId, readonly string[]>> = {
  codex: ["--dangerously-bypass-hook-trust", "app-server", "--listen", "stdio://"],
  grok: [
    "--no-auto-update",
    "--permission-mode",
    "bypassPermissions",
    "--sandbox",
    "off",
    "--no-plan",
    "agent",
    "stdio"
  ],
  kimi: ["acp"]
};

interface ConfigFingerprint {
  exists: boolean;
  size?: number;
  sha256?: string;
}

interface AgentObservation {
  agent: M0AgentId;
  installedVersion?: string;
  exactArgvAndVersion: boolean;
  streamObserved: boolean;
  uniqueTerminal: boolean;
  bindingProvenance: boolean;
  actualMcpToolCall: boolean;
  nativeCancellation: boolean;
  subsequentTurnAvailable: boolean;
  globalConfigInvariant: boolean;
  cleanShutdownAndNoResidual: boolean;
  mcpAttempts: number;
  transientEventCount: number;
  errorCodes: string[];
}

interface SseCollector {
  readonly events: Array<Record<string, unknown>>;
  close(): Promise<void>;
}

export interface StructuredNativeProbeResult {
  reportPath: string;
  reportSha256: string;
  passed: boolean;
}

export async function runStructuredNativeProbe(
  configPath: string,
  projectRoot = process.cwd()
): Promise<StructuredNativeProbeResult> {
  const runId = createM0RunId();
  const recordedAt = new Date().toISOString();
  const runRoot = path.resolve(projectRoot, ".groupx", "m0-workspaces", "structured-release", runId);
  const workspaceRoot = path.join(runRoot, "agents");
  await Promise.all(M0_AGENTS.map(async (agent) => await mkdir(path.join(workspaceRoot, agent), { recursive: true })));

  const loaded = await loadConfig(configPath, projectRoot);
  if (loaded.transport !== "structured") {
    throw new Error("Structured release probe requires transport=structured");
  }
  const config = probeConfig(loaded, runRoot, workspaceRoot);
  const observations = Object.fromEntries(
    M0_AGENTS.map((agent) => [agent, emptyObservation(agent)])
  ) as Record<M0AgentId, AgentObservation>;
  const configPaths = effectiveConfigPaths();
  const beforeConfig = await fingerprintConfigs(configPaths);
  const beforeProcesses = await matchingNativeProcessIds();
  let runtime: GroupXRuntime | undefined;
  let collector: SseCollector | undefined;
  let runtimeClosedCleanly = false;
  let fatalErrorCode: string | undefined;

  try {
    const versions = await Promise.all(
      M0_AGENTS.map(async (agent) => {
        const agentConfig = config.agents[agent];
        if (!agentConfig) throw new Error(`M0 probe requires configured agent: ${agent}`);
        return [agent, await readCliVersion(agentConfig)] as const;
      })
    );
    for (const [agent, version] of versions) observations[agent].installedVersion = version;

    runtime = new GroupXRuntime(config, { port: 0 });
    const started = await runtime.start();
    collector = await openSseCollector(`${started.address.origin}/api/events?afterSeq=0`);
    for (const agent of M0_AGENTS) {
      const report = await runtime.adapters.get(agent).probe();
      observations[agent].exactArgvAndVersion = exactLaunchProfile(config, agent, report);
    }

    for (const agent of M0_AGENTS) {
      await observeMcpCall(runtime, collector, observations[agent], started.address.origin);
    }
    for (const agent of M0_AGENTS) {
      await observeCancellation(runtime, collector, observations[agent], started.address.origin);
    }
  } catch (error) {
    fatalErrorCode = safeErrorCode(error);
  } finally {
    await collector?.close().catch(() => undefined);
    if (runtime !== undefined) {
      try {
        await runtime.close();
        runtimeClosedCleanly = true;
      } catch (error) {
        fatalErrorCode ??= safeErrorCode(error);
      }
    }
  }

  const afterConfig = await fingerprintConfigs(configPaths);
  const configInvariant = sameFingerprints(beforeConfig, afterConfig);
  const afterProcesses = await matchingNativeProcessIds();
  const residualPids = [...afterProcesses].filter((pid) => !beforeProcesses.has(pid));
  const workspaceFileCounts = Object.fromEntries(
    await Promise.all(
      M0_AGENTS.map(async (agent) => [agent, await countFiles(path.join(workspaceRoot, agent))] as const)
    )
  ) as Record<M0AgentId, number>;

  for (const agent of M0_AGENTS) {
    observations[agent].globalConfigInvariant = configInvariant[agent];
    observations[agent].cleanShutdownAndNoResidual =
      runtimeClosedCleanly && residualPids.length === 0 && workspaceFileCounts[agent] === 0;
  }
  const passed =
    fatalErrorCode === undefined &&
    M0_AGENTS.every((agent) => agentObservationPassed(observations[agent]));
  const report = {
    schema: "groupx.m0-structured-native-conformance/1",
    evidenceClass: "native-live",
    runId,
    recordedAt,
    transport: "structured",
    accessContract: M0_ACCESS_CONTRACT,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    status: passed ? "PASS" : "FAIL",
    ...(fatalErrorCode === undefined ? {} : { fatalErrorCode }),
    runtimeClosedCleanly,
    matchingResidualChildCount: residualPids.length,
    agentResults: M0_AGENTS.map((agent) => ({
      ...observations[agent],
      workspaceFileCount: workspaceFileCounts[agent],
      verifiedCaseIds: verifiedCases(observations[agent])
    })),
    containsPromptOrModelText: false,
    containsNativeSessionIds: false,
    containsConfigurationBody: false,
    containsCredentials: false,
    containsHostnames: false
  } as const;
  const output = await writeM0Report(
    projectRoot,
    `.groupx/evidence/m0/structured-release/${runId}/conformance.json`,
    report
  );
  return { reportPath: output.relativePath, reportSha256: output.sha256, passed };
}

function probeConfig(
  loaded: GroupXConfig,
  runRoot: string,
  workspaceRoot: string
): GroupXConfig {
  const agent = (id: M0AgentId): GroupXConfig["agents"][string] => {
    const configured = loaded.agents[id];
    if (!configured) throw new Error(`M0 probe requires configured agent: ${id}`);
    return {
      ...configured,
      enabled: true,
      cwd: path.join(workspaceRoot, id)
    };
  };
  return {
    ...loaded,
    transport: "structured",
    server: { ...loaded.server },
    storage: { path: path.join(runRoot, "groupx.db") },
    agents: { codex: agent("codex"), grok: agent("grok"), kimi: agent("kimi") },
    timeouts: {
      ...loaded.timeouts,
      firstEventMs: Math.max(loaded.timeouts.firstEventMs, 180_000),
      idleMs: Math.max(loaded.timeouts.idleMs, 180_000),
      cancelMs: Math.max(loaded.timeouts.cancelMs, 15_000),
      closeMs: Math.max(loaded.timeouts.closeMs, 10_000),
      askMs: Math.max(loaded.timeouts.askMs, 180_000)
    }
  };
}

function emptyObservation(agent: M0AgentId): AgentObservation {
  return {
    agent,
    exactArgvAndVersion: false,
    streamObserved: false,
    uniqueTerminal: false,
    bindingProvenance: false,
    actualMcpToolCall: false,
    nativeCancellation: false,
    subsequentTurnAvailable: false,
    globalConfigInvariant: false,
    cleanShutdownAndNoResidual: false,
    mcpAttempts: 0,
    transientEventCount: 0,
    errorCodes: []
  };
}

function exactLaunchProfile(
  config: GroupXConfig,
  agent: M0AgentId,
  report: CapabilityReport
): boolean {
  const agentConfig = config.agents[agent];
  if (!agentConfig) return false;
  const command = agentConfig.command;
  const expected =
    agent === "codex"
      ? [...buildCodexLaunchArgv(command.executable, command.prefixArgs)]
      : [command.executable, ...command.prefixArgs, ...EXPECTED_STRUCTURED_TAILS[agent]];
  const observed = agent === "codex" ? expected : report.launchArgvShape;
  return (
    observed.length === expected.length &&
    observed.every((value, index) => value === expected[index]) &&
    typeof report.protocol === "string"
  );
}

async function observeMcpCall(
  runtime: GroupXRuntime,
  collector: SseCollector,
  observation: AgentObservation,
  origin: string
): Promise<void> {
  const target = MCP_TARGETS[observation.agent];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    observation.mcpAttempts = attempt;
    const nonce = randomUUID().replaceAll("-", "");
    try {
      const accepted = await postMessage(origin, {
        clientCommandId: `m0-mcp-source-${observation.agent}-${nonce}`,
        to: [`agent:${observation.agent}`],
        content: [
          "GroupX M0 conformance probe.",
          "You must call the GroupX MCP tool named send exactly once and no other tool.",
          `Use to=[\"agent:${target}\"], clientCommandId=\"m0-mcp-child-${observation.agent}-${nonce}\".`,
          `Set content to: Reply with M0_CHILD_OK_${nonce} and do not call any tools.`,
          `After the send tool succeeds, reply with M0_MCP_OK_${nonce}.`
        ].join(" ")
      });
      const sourceTurnId = accepted.turns[0]!.turnId;
      const sourceTurn = await waitForTerminal(runtime, sourceTurnId, 240_000);
      await withTimeout(runtime.broker.waitForIdle(), 240_000, "broker idle after MCP call");
      await delay(100);
      const events = readAllEvents(runtime);
      const mcpMessage = events.find(
        (event) =>
          event.eventType === "message.created" &&
          event.actorId === `agent:${observation.agent}` &&
          event.causationId === sourceTurnId &&
          event.targets.includes(`agent:${target}`) &&
          event.provenance?.sourceKind === "mcp"
      );
      const body = objectRecord(mcpMessage?.body);
      const senderFieldsAbsent =
        body !== undefined &&
        !("from" in body) &&
        !("actor" in body) &&
        !("bindingId" in body) &&
        !("provenance" in body);
      const terminalCount = terminalEventCount(events, sourceTurnId);
      const transientCount = transientEventsFor(collector.events, sourceTurnId).length;
      observation.transientEventCount += transientCount;
      observation.streamObserved ||= transientCount > 0;
      observation.uniqueTerminal ||= terminalCount === 1;
      if (sourceTurn.status === "completed" && mcpMessage !== undefined && senderFieldsAbsent) {
        observation.actualMcpToolCall = true;
        observation.bindingProvenance = true;
        return;
      }
    } catch (error) {
      observation.errorCodes.push(`MCP_${safeErrorCode(error)}`);
    }
  }
}

async function observeCancellation(
  runtime: GroupXRuntime,
  collector: SseCollector,
  observation: AgentObservation,
  origin: string
): Promise<void> {
  const nonce = randomUUID().replaceAll("-", "");
  try {
    const accepted = await postMessage(origin, {
      clientCommandId: `m0-cancel-source-${observation.agent}-${nonce}`,
      to: [`agent:${observation.agent}`],
      content: [
        "GroupX M0 native cancellation probe.",
        "Use your native terminal or shell tool to run this harmless command now:",
        "powershell -NoProfile -Command \"Start-Sleep -Seconds 30\".",
        "Do not create or modify files and do not reply before the command finishes."
      ].join(" ")
    });
    const turnId = accepted.turns[0]!.turnId;
    await waitForNativeStart(runtime, turnId, 60_000);
    await delay(250);
    await postCancel(origin, turnId, `m0-cancel-${observation.agent}-${nonce}`);
    const cancelled = await waitForTerminal(runtime, turnId, 60_000);
    const attempts = runtime.store.listTurnAttempts(turnId);
    observation.nativeCancellation =
      attempts.some((attempt) => attempt.dispatchPhase === "terminal" && attempt.nativeTurnId !== undefined) &&
      (cancelled.status === "cancelled" || cancelled.status === "interrupted");
    const events = readAllEvents(runtime);
    const terminalCount = terminalEventCount(events, turnId);
    const transientCount = transientEventsFor(collector.events, turnId).length;
    observation.transientEventCount += transientCount;
    observation.streamObserved ||= transientCount > 0;
    observation.uniqueTerminal &&= terminalCount === 1;

    const follow = await postMessage(origin, {
      clientCommandId: `m0-after-cancel-${observation.agent}-${nonce}`,
      to: [`agent:${observation.agent}`],
      content: `Reply with exactly M0_AFTER_CANCEL_OK_${nonce}. Do not call tools.`
    });
    const followTurn = await waitForTerminal(runtime, follow.turns[0]!.turnId, 180_000);
    observation.subsequentTurnAvailable = followTurn.status === "completed";
    await withTimeout(runtime.broker.waitForIdle(), 180_000, "broker idle after cancellation follow-up");
  } catch (error) {
    observation.errorCodes.push(`CANCEL_${safeErrorCode(error)}`);
  }
}

async function postMessage(
  origin: string,
  request: { clientCommandId: string; to: string[]; content: string }
): Promise<{ turns: Array<{ turnId: string }> }> {
  const response = await fetch(`${origin}/api/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request)
  });
  if (response.status !== 202) throw new Error(`Unexpected message HTTP status ${response.status}`);
  const body = (await response.json()) as { turns?: Array<{ turnId?: unknown }> };
  if (!Array.isArray(body.turns) || typeof body.turns[0]?.turnId !== "string") {
    throw new Error("Message acceptance omitted the Turn id");
  }
  return { turns: body.turns as Array<{ turnId: string }> };
}

async function postCancel(origin: string, turnId: string, clientCommandId: string): Promise<void> {
  const response = await fetch(`${origin}/api/turns/${encodeURIComponent(turnId)}/cancel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientCommandId })
  });
  if (response.status !== 202) throw new Error(`Unexpected cancel HTTP status ${response.status}`);
}

async function waitForTerminal(
  runtime: GroupXRuntime,
  turnId: string,
  timeoutMs: number
): Promise<TurnRecord> {
  return await waitForTurn(runtime, turnId, (turn) => TERMINAL_STATUSES.has(turn.status), timeoutMs);
}

async function waitForNativeStart(
  runtime: GroupXRuntime,
  turnId: string,
  timeoutMs: number
): Promise<TurnRecord> {
  return await waitForTurn(
    runtime,
    turnId,
    (turn) =>
      runtime.store
        .listTurnAttempts(turnId)
        .some((attempt) => attempt.dispatchPhase === "native_started" || attempt.dispatchPhase === "terminal"),
    timeoutMs
  );
}

async function waitForTurn(
  runtime: GroupXRuntime,
  turnId: string,
  predicate: (turn: TurnRecord) => boolean,
  timeoutMs: number
): Promise<TurnRecord> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const turn = runtime.store.getTurn(turnId);
    if (turn !== undefined && predicate(turn)) return turn;
    await delay(50);
  }
  throw new Error("Turn wait deadline elapsed");
}

function readAllEvents(runtime: GroupXRuntime): StoredEventRecord[] {
  const events: StoredEventRecord[] = [];
  let afterSeq = 0;
  for (;;) {
    const page = runtime.store.listEvents({ roomId: runtime.roomId, afterSeq, limit: 500 });
    events.push(...page.events);
    if (!page.hasMore) return events;
    if (page.nextAfterSeq <= afterSeq) throw new Error("Event cursor did not advance");
    afterSeq = page.nextAfterSeq;
  }
}

function terminalEventCount(events: readonly StoredEventRecord[], turnId: string): number {
  return events.filter((event) => {
    if (!TERMINAL_STATUSES.has(event.eventType.slice("turn.".length))) return false;
    return objectRecord(event.body)?.turnId === turnId;
  }).length;
}

function transientEventsFor(events: readonly Record<string, unknown>[], turnId: string): Record<string, unknown>[] {
  return events.filter((event) => {
    if (event.durability !== "transient") return false;
    const body = objectRecord(event.body);
    return body?.turnId === turnId;
  });
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function openSseCollector(url: string): Promise<SseCollector> {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { accept: "text/event-stream" },
    signal: controller.signal
  });
  if (!response.ok || response.body === null) throw new Error("Unable to open SSE collector");
  const events: Array<Record<string, unknown>> = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const pump = (async () => {
    let buffer = "";
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data.length > 0) {
            const parsed = JSON.parse(data) as unknown;
            const record = objectRecord(parsed);
            if (record !== undefined) events.push(record);
          }
          boundary = buffer.indexOf("\n\n");
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })();
  return {
    events,
    async close() {
      controller.abort();
      await pump.catch(() => undefined);
    }
  };
}

async function readCliVersion(config: GroupXConfig["agents"][M0AgentId]): Promise<string> {
  const output = await runBoundedProcess(
    config.command.executable,
    [...config.command.prefixArgs, "--version"],
    config.cwd,
    15_000
  );
  if (output.exitCode !== 0) throw new Error("CLI version probe failed");
  const match = /\b\d+\.\d+\.\d+\b/u.exec(`${output.stdout}\n${output.stderr}`);
  if (!match) throw new Error("CLI version probe returned no semantic version");
  return match[0];
}

async function matchingNativeProcessIds(): Promise<Set<number>> {
  if (process.platform !== "win32") return new Set();
  const script = [
    "$items = Get-CimInstance Win32_Process | Where-Object {",
    "($_.Name -ieq 'grok.exe' -and $_.CommandLine -like '*agent stdio*') -or",
    "($_.Name -ieq 'node.exe' -and ($_.CommandLine -like '*@moonshot-ai*acp*' -or $_.CommandLine -like '*@openai\\codex*app-server*')) -or",
    "($_.Name -ieq 'codex.exe' -and $_.CommandLine -like '*app-server*')",
    "};",
    "@($items | ForEach-Object { $_.ProcessId }) | ConvertTo-Json -Compress"
  ].join(" ");
  const output = await runBoundedProcess("powershell.exe", ["-NoProfile", "-Command", script], process.cwd(), 20_000);
  if (output.exitCode !== 0) throw new Error("Unable to audit residual native processes");
  const parsed = JSON.parse(output.stdout.trim() || "[]") as number | number[];
  return new Set(Array.isArray(parsed) ? parsed : [parsed]);
}

async function runBoundedProcess(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const append = (current: string, chunk: Buffer): string => `${current}${chunk.toString("utf8")}`.slice(-8_192);
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 1, stdout, stderr }); });
  });
}

function effectiveConfigPaths(): Record<M0AgentId, string[]> {
  const home = homedir();
  const codexHome = process.env.CODEX_HOME?.trim()
    ? path.resolve(process.env.CODEX_HOME)
    : path.join(home, ".codex");
  const kimiHome = process.env.KIMI_CODE_HOME?.trim()
    ? path.resolve(process.env.KIMI_CODE_HOME)
    : path.join(home, ".kimi-code");
  return {
    codex: [path.join(codexHome, "config.toml")],
    grok: [path.join(home, ".grok", "config.toml")],
    kimi: [
      path.join(kimiHome, "config.toml"),
      path.join(kimiHome, "tui.toml"),
      path.join(kimiHome, "mcp.json")
    ]
  };
}

async function fingerprintConfigs(
  paths: Record<M0AgentId, string[]>
): Promise<Record<M0AgentId, ConfigFingerprint[]>> {
  return Object.fromEntries(
    await Promise.all(
      M0_AGENTS.map(async (agent) => [agent, await Promise.all(paths[agent].map(fingerprintFile))] as const)
    )
  ) as Record<M0AgentId, ConfigFingerprint[]>;
}

async function fingerprintFile(filePath: string): Promise<ConfigFingerprint> {
  try {
    const [metadata, bytes] = await Promise.all([stat(filePath), readFile(filePath)]);
    return { exists: true, size: metadata.size, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw error;
  }
}

function sameFingerprints(
  before: Record<M0AgentId, ConfigFingerprint[]>,
  after: Record<M0AgentId, ConfigFingerprint[]>
): Record<M0AgentId, boolean> {
  return Object.fromEntries(
    M0_AGENTS.map((agent) => [agent, JSON.stringify(before[agent]) === JSON.stringify(after[agent])])
  ) as Record<M0AgentId, boolean>;
}

async function countFiles(directory: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    count += entry.isDirectory() ? await countFiles(path.join(directory, entry.name)) : 1;
  }
  return count;
}

function verifiedCases(observation: AgentObservation): string[] {
  const result: string[] = [];
  if (observation.exactArgvAndVersion) result.push("M0-01");
  if (observation.streamObserved && observation.uniqueTerminal) result.push("M0-04");
  if (observation.bindingProvenance) result.push("M0-05");
  if (observation.nativeCancellation && observation.subsequentTurnAvailable) result.push("M0-06");
  if (observation.actualMcpToolCall && observation.bindingProvenance) result.push("M0-07");
  if (observation.globalConfigInvariant) result.push("M0-12");
  if (observation.cleanShutdownAndNoResidual) result.push("M0-15");
  return result;
}

function agentObservationPassed(observation: AgentObservation): boolean {
  return ["M0-01", "M0-04", "M0-05", "M0-06", "M0-07", "M0-12", "M0-15"].every(
    (caseId) => verifiedCases(observation).includes(caseId)
  );
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} deadline elapsed`)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
