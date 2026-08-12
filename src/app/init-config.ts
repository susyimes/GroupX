import path from "node:path";
import { statSync } from "node:fs";
import { writeFile } from "node:fs/promises";

import {
  BUILTIN_AGENT_IDS,
  resolveAgentCommand,
  systemCommandResolverDependencies,
  type AgentDriver,
  type CommandResolverDependencies
} from "../launch/index.js";

export interface InitDependencies {
  commandDependencies: CommandResolverDependencies;
  fileExists(candidate: string): boolean;
  writeConfigFile(configPath: string, content: string): Promise<void>;
  stdout(line: string): void;
}

export function systemInitDependencies(
  stdout: (line: string) => void = (line) => process.stdout.write(`${line}\n`)
): InitDependencies {
  return {
    commandDependencies: systemCommandResolverDependencies,
    fileExists(candidate) {
      try {
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    },
    writeConfigFile: (configPath, content) => writeFile(configPath, content, "utf8"),
    stdout
  };
}

function detectDrivers(cwd: string, dependencies: CommandResolverDependencies): Map<AgentDriver, boolean> {
  const detected = new Map<AgentDriver, boolean>();
  for (const driver of BUILTIN_AGENT_IDS) {
    try {
      resolveAgentCommand(driver, driver, { executable: driver, prefixArgs: [] }, cwd, dependencies);
      detected.set(driver, true);
    } catch {
      detected.set(driver, false);
    }
  }
  return detected;
}

/** Write a starter groupx.json with every detected CLI enabled. */
export async function runInit(
  options: { cwd: string; configPath?: string; force?: boolean },
  dependencies: InitDependencies = systemInitDependencies()
): Promise<number> {
  const configPath = path.resolve(options.cwd, options.configPath ?? "groupx.json");
  if (dependencies.fileExists(configPath) && options.force !== true) {
    dependencies.stdout(`已存在: ${configPath}(使用 --force 覆盖)`);
    return 1;
  }

  const detected = detectDrivers(options.cwd, dependencies.commandDependencies);
  const agents = Object.fromEntries(
    BUILTIN_AGENT_IDS.map((driver) => [
      driver,
      { command: driver, cwd: ".", enabled: detected.get(driver) === true }
    ])
  );
  const config = {
    transport: "structured",
    server: { host: "127.0.0.1", port: 4_310 },
    storage: { path: ".groupx/groupx.db" },
    agents
  };
  await dependencies.writeConfigFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  const found = [...detected.values()].filter(Boolean).length;
  dependencies.stdout(`已写入 ${configPath}`);
  for (const driver of BUILTIN_AGENT_IDS) {
    dependencies.stdout(`  ${detected.get(driver) ? "●" : "○"} ${driver}${detected.get(driver) ? "" : "(未检测到,已禁用)"}`);
  }
  if (found === 0) {
    dependencies.stdout("警告: 未检测到任何 CLI,启动前请先安装 codex / grok / kimi。");
  }
  dependencies.stdout("下一步: groupx start");
  return 0;
}
