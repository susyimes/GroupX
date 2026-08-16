import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { statSync } from "node:fs";

import { loadConfig, type GroupXConfig } from "../config.js";
import {
  BUILTIN_AGENT_IDS,
  resolveAgentCommand,
  systemCommandResolverDependencies,
  type AgentDriver,
  type CommandResolverDependencies,
  type CommandSpec
} from "../launch/index.js";

const ENGINES_RANGE = ">=24.14.1 <25";
const VERSION_PROBE_TIMEOUT_MS = 6_000;

export interface DriverProbe {
  driver: AgentDriver;
  found: boolean;
  command?: CommandSpec;
  version?: string;
  error?: string;
}

export interface DoctorReport {
  os: { platform: NodeJS.Platform; arch: string; release: string };
  node: { version: string; enginesOk: boolean; engines: string };
  drivers: DriverProbe[];
  config:
    | {
        path: string;
        agents: Array<{ agentId: string; driver: AgentDriver; name?: string; enabled: boolean }>;
      }
    | { path: string; error: string }
    | { skipped: string };
}

export interface DoctorDependencies {
  platform: NodeJS.Platform;
  arch: string;
  osRelease: string;
  nodeVersion: string;
  commandDependencies: CommandResolverDependencies;
  probeVersion(command: CommandSpec): Promise<string | undefined>;
  loadConfigFrom(configPath: string): Promise<GroupXConfig>;
  fileExists(candidate: string): boolean;
}

export function nodeSatisfiesEngines(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return major === 24 && (minor > 14 || (minor === 14 && patch >= 1));
}

export function extractCliVersion(output: string): string | undefined {
  return /(?:^|[^\d])v?(\d+\.\d+\.\d+)\b/u.exec(output)?.[1];
}

export async function collectDoctorReport(
  options: { cwd: string; configPath?: string },
  dependencies: DoctorDependencies
): Promise<DoctorReport> {
  const drivers: DriverProbe[] = [];
  for (const driver of BUILTIN_AGENT_IDS) {
    let command: CommandSpec | undefined;
    try {
      command = resolveAgentCommand(driver, driver, { executable: driver, prefixArgs: [] }, options.cwd, dependencies.commandDependencies);
    } catch (error) {
      drivers.push({ driver, found: false, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const version = await dependencies.probeVersion(command);
    drivers.push({ driver, found: true, command, ...(version === undefined ? {} : { version }) });
  }

  const explicitConfig = options.configPath !== undefined;
  const configPath = path.resolve(options.cwd, options.configPath ?? "groupx.json");
  let config: DoctorReport["config"];
  if (!explicitConfig && !dependencies.fileExists(configPath)) {
    config = { skipped: "未找到 groupx.json；运行 groupx init 打开 Agent 配置引导页" };
  } else {
    try {
      const loaded = await dependencies.loadConfigFrom(configPath);
      config = {
        path: configPath,
        agents: Object.entries(loaded.agents).map(([agentId, agent]) => ({
          agentId,
          driver: agent.driver,
          ...(agent.name === undefined ? {} : { name: agent.name }),
          enabled: agent.enabled
        }))
      };
    } catch (error) {
      config = { path: configPath, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    os: { platform: dependencies.platform, arch: dependencies.arch, release: dependencies.osRelease },
    node: {
      version: dependencies.nodeVersion,
      enginesOk: nodeSatisfiesEngines(dependencies.nodeVersion),
      engines: ENGINES_RANGE
    },
    drivers,
    config
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = ["GroupX doctor", ""];
  lines.push(`系统: ${report.os.platform} ${report.os.arch} (${report.os.release})`);
  lines.push(
    `Node: ${report.node.version} ${report.node.enginesOk ? "✓" : "✗ 不满足"} (需要 ${report.node.engines})`
  );
  lines.push("", "CLI 检测:");
  for (const probe of report.drivers) {
    if (!probe.found) {
      lines.push(`  ✗ ${probe.driver}  未找到可用命令`);
      continue;
    }
    const version = probe.version ?? "版本探测失败";
    lines.push(`  ✓ ${probe.driver}  ${version}  ${probe.command?.executable ?? ""}`);
  }
  lines.push("", "配置:");
  if ("skipped" in report.config) {
    lines.push(`  ${report.config.skipped}`);
  } else if ("error" in report.config) {
    lines.push(`  ✗ ${report.config.path}`, `    ${report.config.error}`);
  } else {
    const enabled = report.config.agents.filter((agent) => agent.enabled);
    lines.push(`  ${report.config.path}`);
    lines.push(`  ${report.config.agents.length} 个 agent,${enabled.length} 个启用:`);
    for (const agent of report.config.agents) {
      const label = agent.name ?? agent.agentId;
      lines.push(`    ${agent.enabled ? "●" : "○"} ${agent.agentId} (${label}, driver=${agent.driver})`);
    }
  }
  const found = report.drivers.filter((probe) => probe.found).length;
  lines.push(
    "",
    found === 0
      ? `结论: 未检测到任何 CLI,请先安装 ${BUILTIN_AGENT_IDS.join(" / ")}。`
      : `结论: 检测到 ${found} 个 CLI。`
  );
  return lines.join("\n");
}

function systemProbeVersion(command: CommandSpec): Promise<string | undefined> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const finish = (version: string | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(version);
    };
    let child;
    try {
      child = spawn(command.executable, [...command.prefixArgs, "--version"], { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      finish(undefined);
      return;
    }
    const timer = setTimeout(() => {
      child.kill();
      finish(undefined);
    }, VERSION_PROBE_TIMEOUT_MS);
    timer.unref();
    child.on("error", () => {
      clearTimeout(timer);
      finish(undefined);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8").slice(0, 65_536 - output.length);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8").slice(0, 65_536 - output.length);
    });
    child.on("close", () => {
      clearTimeout(timer);
      finish(extractCliVersion(output));
    });
  });
}

export function systemDoctorDependencies(): DoctorDependencies {
  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    nodeVersion: process.version,
    commandDependencies: systemCommandResolverDependencies,
    probeVersion: systemProbeVersion,
    loadConfigFrom: (configPath) => loadConfig(configPath),
    fileExists(candidate) {
      try {
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    }
  };
}

export async function runDoctor(
  options: { cwd: string; configPath?: string },
  dependencies: DoctorDependencies = systemDoctorDependencies(),
  stdout: (line: string) => void = (line) => process.stdout.write(`${line}\n`)
): Promise<number> {
  const report = await collectDoctorReport(options, dependencies);
  stdout(formatDoctorReport(report));
  return report.drivers.some((probe) => probe.found) ? 0 : 1;
}
