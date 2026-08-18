import { statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  parseSetupSaveRequest,
  parseSetupSaveResponse,
  parseSetupSnapshot,
  parseSetupConfigDraft,
  type SetupAgentDraft,
  type SetupAgentDriver,
  type SetupAssistantDraft,
  type SetupConfigDraft,
  type SetupSaveRequest,
  type SetupSaveResponse,
  type SetupSnapshot
} from "../contracts/index.js";
import {
  parseConfigDocument,
  resolveConfigDocument,
  upgradeLegacyGeneratedDefaults,
  type GroupXConfig
} from "../config.js";
import {
  BUILTIN_AGENT_IDS,
  resolveAgentCommand,
  systemCommandResolverDependencies,
  type AgentDriver,
  type CommandResolverDependencies
} from "../launch/index.js";

export interface ConfigSetupDependencies {
  readonly commandDependencies: CommandResolverDependencies;
  fileExists(candidate: string): boolean;
  readConfigFile(configPath: string): Promise<string>;
  writeConfigFile(configPath: string, content: string): Promise<void>;
}

export const systemConfigSetupDependencies: ConfigSetupDependencies = {
  commandDependencies: systemCommandResolverDependencies,
  fileExists(candidate) {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  },
  readConfigFile: (configPath) => readFile(configPath, "utf8"),
  writeConfigFile: async (configPath, content) => {
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, content, "utf8");
  }
};

export interface ConfigSetupApi {
  snapshot(signal: AbortSignal): Promise<SetupSnapshot>;
  save(request: SetupSaveRequest, signal: AbortSignal): Promise<SetupSaveResponse>;
}

export interface GroupXConfigSetupServiceOptions {
  readonly configPath: string;
  readonly runtimeActive?: boolean;
  readonly dependencies?: ConfigSetupDependencies;
}

function detectedDrivers(
  baseDirectory: string,
  dependencies: CommandResolverDependencies
): Map<AgentDriver, boolean> {
  const result = new Map<AgentDriver, boolean>();
  for (const driver of BUILTIN_AGENT_IDS) {
    try {
      resolveAgentCommand(driver, driver, { executable: driver, prefixArgs: [] }, baseDirectory, dependencies);
      result.set(driver, true);
    } catch {
      result.set(driver, false);
    }
  }
  return result;
}

function setupAgent(
  id: string,
  driver: SetupAgentDriver,
  enabled: boolean
): SetupAgentDraft {
  return {
    id,
    driver,
    name: "",
    identity: "",
    command: { executable: driver, prefixArgs: [] },
    cwd: ".",
    enabled
  };
}

function firstDetectedDriver(detected: ReadonlyMap<AgentDriver, boolean>): SetupAgentDriver {
  return BUILTIN_AGENT_IDS.find((driver) => detected.get(driver) === true) ?? "codex";
}

function assistantDraft(
  detected: ReadonlyMap<AgentDriver, boolean>,
  enabled: boolean,
  existing?: GroupXConfig["assistant"]
): SetupAssistantDraft {
  const driver = existing?.brain.driver ?? firstDetectedDriver(detected);
  return {
    enabled,
    name: existing?.name ?? "房间助理",
    brain: {
      driver,
      command: existing
        ? {
            executable: existing.brain.command.executable,
            prefixArgs: [...existing.brain.command.prefixArgs]
          }
        : { executable: driver, prefixArgs: [] },
      cwd: existing?.brain.cwd ?? "."
    },
    ...(existing?.extraInstructions === undefined || existing.extraInstructions.trim().length === 0
      ? {}
      : { extraInstructions: existing.extraInstructions })
  };
}

function starterDraft(detected: ReadonlyMap<AgentDriver, boolean>): SetupConfigDraft {
  const agents = BUILTIN_AGENT_IDS.map((driver) => setupAgent(driver, driver, detected.get(driver) === true));
  return {
    serverPort: 4_310,
    storagePath: ".groupx/groupx.db",
    agents,
    assistant: assistantDraft(detected, true)
  };
}

function configToDraft(
  config: GroupXConfig,
  detected: ReadonlyMap<AgentDriver, boolean>
): SetupConfigDraft {
  return {
    serverPort: config.server.port,
    storagePath: config.storage.path,
    agents: Object.entries(config.agents).map(([id, agent]) => ({
      id,
      driver: agent.driver,
      name: agent.name ?? "",
      identity: agent.identity ?? "",
      command: {
        executable: agent.command.executable,
        prefixArgs: [...agent.command.prefixArgs]
      },
      cwd: agent.cwd,
      enabled: agent.enabled
    })),
    assistant: assistantDraft(detected, config.assistant?.enabled === true, config.assistant)
  };
}

function draftToDocument(
  draft: SetupConfigDraft,
  preserved?: Pick<GroupXConfig, "limits" | "timeouts" | "assistant">
): GroupXConfig {
  const agents = Object.fromEntries(
    draft.agents.map((agent) => [
      agent.id,
      {
        driver: agent.driver,
        ...(agent.name.trim().length === 0 ? {} : { name: agent.name.trim() }),
        ...(agent.identity?.trim().length ? { identity: agent.identity.trim() } : {}),
        command:
          agent.command.prefixArgs.length === 0
            ? agent.command.executable.trim()
            : {
                executable: agent.command.executable.trim(),
                prefixArgs: agent.command.prefixArgs.map((argument) => argument.trim())
              },
        cwd: agent.cwd.trim(),
        enabled: agent.enabled
      }
    ])
  );
  const assistant =
    draft.assistant === undefined
      ? undefined
      : {
          enabled: draft.assistant.enabled,
          name: draft.assistant.name.trim() || "房间助理",
          brain: {
            driver: draft.assistant.brain.driver,
            command:
              draft.assistant.brain.command.prefixArgs.length === 0
                ? draft.assistant.brain.command.executable.trim()
                : {
                    executable: draft.assistant.brain.command.executable.trim(),
                    prefixArgs: draft.assistant.brain.command.prefixArgs.map((argument) =>
                      argument.trim()
                    )
                  },
            cwd: draft.assistant.brain.cwd.trim()
          },
          ...(draft.assistant.extraInstructions?.trim().length
            ? { extraInstructions: draft.assistant.extraInstructions.trim() }
            : {})
        };
  return parseConfigDocument({
    transport: "structured",
    server: { host: "127.0.0.1", port: draft.serverPort },
    storage: { path: draft.storagePath.trim() },
    agents,
    ...(assistant === undefined ? {} : { assistant }),
    ...(preserved === undefined
      ? {}
      : {
          limits: preserved.limits,
          timeouts: preserved.timeouts,
          ...(assistant === undefined && preserved.assistant !== undefined
            ? { assistant: preserved.assistant }
            : {})
        })
  });
}

/** Local config editor used by both the standalone init wizard and the running UI. */
export class GroupXConfigSetupService implements ConfigSetupApi {
  readonly #configPath: string;
  readonly #runtimeActive: boolean;
  readonly #dependencies: ConfigSetupDependencies;
  #saveTail: Promise<void> = Promise.resolve();

  constructor(options: GroupXConfigSetupServiceOptions) {
    this.#configPath = path.resolve(options.configPath);
    this.#runtimeActive = options.runtimeActive === true;
    this.#dependencies = options.dependencies ?? systemConfigSetupDependencies;
  }

  async snapshot(signal: AbortSignal): Promise<SetupSnapshot> {
    signal.throwIfAborted();
    const baseDirectory = path.dirname(this.#configPath);
    const detected = detectedDrivers(baseDirectory, this.#dependencies.commandDependencies);
    const existing = this.#dependencies.fileExists(this.#configPath);
    let config = starterDraft(detected);
    let existingConfigError: string | undefined;
    if (existing) {
      try {
        const raw: unknown = JSON.parse(await this.#dependencies.readConfigFile(this.#configPath));
        config = parseSetupConfigDraft(
          configToDraft(parseConfigDocument(raw), detected)
        );
      } catch {
        existingConfigError = "现有配置无法解析；保存前请核对页面中的替代配置。";
      }
    }
    signal.throwIfAborted();
    return parseSetupSnapshot({
      configPath: this.#configPath,
      existing,
      runtimeActive: this.#runtimeActive,
      drivers: BUILTIN_AGENT_IDS.map((driver) => ({ driver, found: detected.get(driver) === true })),
      config,
      ...(existingConfigError === undefined ? {} : { existingConfigError })
    });
  }

  save(request: SetupSaveRequest, signal: AbortSignal): Promise<SetupSaveResponse> {
    const parsed = parseSetupSaveRequest(request);
    let resolveResult!: (result: SetupSaveResponse) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<SetupSaveResponse>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const operation = this.#saveTail.then(async () => {
      signal.throwIfAborted();
      const preserved = await this.#readPreservedConfig();
      const document = draftToDocument(parsed.config, preserved);
      resolveConfigDocument(document, path.dirname(this.#configPath), this.#dependencies.commandDependencies);
      signal.throwIfAborted();
      await this.#dependencies.writeConfigFile(this.#configPath, `${JSON.stringify(document, null, 2)}\n`);
      resolveResult(
        parseSetupSaveResponse({
          saved: true,
          configPath: this.#configPath,
          agentCount: parsed.config.agents.length,
          enabledAgentCount: parsed.config.agents.filter((agent) => agent.enabled).length,
          restartRequired: this.#runtimeActive
        })
      );
    });
    this.#saveTail = operation.then(
      () => undefined,
      () => undefined
    );
    void operation.catch(rejectResult);
    return result;
  }

  async #readPreservedConfig(): Promise<
    Pick<GroupXConfig, "limits" | "timeouts" | "assistant"> | undefined
  > {
    if (!this.#dependencies.fileExists(this.#configPath)) return undefined;
    const contents = await this.#dependencies.readConfigFile(this.#configPath);
    try {
      const raw: unknown = JSON.parse(contents);
      const parsed = parseConfigDocument(raw);
      upgradeLegacyGeneratedDefaults(parsed);
      return {
        limits: parsed.limits,
        timeouts: parsed.timeouts,
        ...(parsed.assistant === undefined ? {} : { assistant: parsed.assistant })
      };
    } catch {
      return undefined;
    }
  }
}
