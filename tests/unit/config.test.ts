import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultConfig, loadConfig, parseConfigPath } from "../../src/config.js";
import type { CommandResolverDependencies } from "../../src/launch/command-spec.js";

const windowsPaths = path.win32;
const nodeExecutable = windowsPaths.resolve("C:\\Program Files", "nodejs", "node.exe");
const appData = windowsPaths.resolve("C:\\Users", "groupx", "AppData", "Roaming");
const userProfile = windowsPaths.resolve("C:\\Users", "groupx");
const codexEntrypoint = windowsPaths.resolve(
  appData,
  "npm",
  "node_modules",
  "@openai",
  "codex",
  "bin",
  "codex.js"
);
const kimiEntrypoint = windowsPaths.resolve(
  appData,
  "npm",
  "node_modules",
  "@moonshot-ai",
  "kimi-code",
  "dist",
  "main.mjs"
);
const grokExecutable = windowsPaths.resolve(userProfile, ".grok", "bin", "grok.exe");

function commandDependencies(additionalFiles: readonly string[] = []): CommandResolverDependencies {
  const files = new Set(
    [nodeExecutable, codexEntrypoint, kimiEntrypoint, grokExecutable, ...additionalFiles].map((candidate) =>
      windowsPaths.normalize(candidate).toLowerCase()
    )
  );
  return {
    platform: "win32",
    env: {
      APPDATA: appData,
      USERPROFILE: userProfile,
      PATH: windowsPaths.resolve("C:\\Tools")
    },
    execPath: nodeExecutable,
    isFile: (candidate) => files.has(windowsPaths.normalize(candidate).toLowerCase())
  };
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

async function writeConfig(value: unknown): Promise<{ directory: string; configPath: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "groupx-config-"));
  temporaryDirectories.push(directory);
  const configPath = path.join(directory, "groupx.json");
  await writeFile(configPath, JSON.stringify(value), "utf8");
  return { directory, configPath };
}

function validConfig(): Record<string, unknown> {
  return {
    transport: "structured",
    server: { host: "127.0.0.1", port: 4_310 },
    storage: { path: ".groupx/groupx.db" },
    agents: {
      codex: { command: "codex", cwd: ".", enabled: true },
      grok: { command: "grok", cwd: ".", enabled: true },
      kimi: { command: "kimi", cwd: ".", enabled: true }
    }
  };
}

describe("GroupX configuration", () => {
  it("uses loopback-only defaults and resolves local paths when loaded", async () => {
    const cwd = path.resolve("groupx-test-workspace");
    const dependencies = commandDependencies();
    const defaults = defaultConfig(cwd, dependencies);
    const config = await loadConfig(undefined, cwd, dependencies);

    expect(defaults.transport).toBe("structured");
    expect(defaults.server).toEqual({ host: "127.0.0.1", port: 4_310 });
    expect(defaults.storage.path).toBe(".groupx/groupx.db");
    expect(defaults.agents.codex!.command).toEqual({
      executable: nodeExecutable,
      prefixArgs: [codexEntrypoint]
    });
    expect(defaults.agents.grok!.command).toEqual({ executable: grokExecutable, prefixArgs: [] });
    expect(defaults.agents.kimi!.command).toEqual({
      executable: nodeExecutable,
      prefixArgs: [kimiEntrypoint]
    });
    expect(config.server).toEqual({ host: "127.0.0.1", port: 4_310 });
    expect(config.storage.path).toBe(path.join(cwd, ".groupx", "groupx.db"));
    expect(Object.values(config.agents).map((agent) => agent.cwd)).toEqual([cwd, cwd, cwd]);
  });

  it("loads a strict config and resolves paths relative to the config file", async () => {
    const { directory, configPath } = await writeConfig(validConfig());

    const config = await loadConfig(configPath, process.cwd(), commandDependencies());

    expect(config.transport).toBe("structured");
    expect(config.server.host).toBe("127.0.0.1");
    expect(config.storage.path).toBe(path.join(directory, ".groupx", "groupx.db"));
    expect(config.agents.codex!.cwd).toBe(directory);
    expect(config.agents.grok!.cwd).toBe(directory);
    expect(config.agents.kimi!.cwd).toBe(directory);
  });

  it("treats the agents map as the explicit room roster", async () => {
    const omitted = await writeConfig({});
    const omittedConfig = await loadConfig(omitted.configPath, process.cwd(), commandDependencies());

    expect(Object.values(omittedConfig.agents).map((agent) => agent.cwd)).toEqual([
      omitted.directory,
      omitted.directory,
      omitted.directory
    ]);

    const partial = await writeConfig({
      agents: {
        codex: { command: "codex", cwd: "codex-work", enabled: true }
      }
    });
    const partialConfig = await loadConfig(partial.configPath, process.cwd(), commandDependencies());

    expect(Object.keys(partialConfig.agents)).toEqual(["codex"]);
    expect(partialConfig.agents.codex!.cwd).toBe(path.join(partial.directory, "codex-work"));
  });

  it("rejects non-loopback hosts", async () => {
    const input = validConfig();
    input.server = { host: "0.0.0.0", port: 4_310 };
    const { configPath } = await writeConfig(input);

    await expect(loadConfig(configPath, process.cwd(), commandDependencies())).rejects.toMatchObject({
      code: "INVALID_ENVELOPE",
      details: {
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "server.host" })
        ])
      }
    });
  });

  it.each(["model", "sandbox", "approval", "yolo", "tools"])(
    "rejects the permission- or policy-type agent field %s",
    async (field) => {
      const input = validConfig();
      const agents = input.agents as Record<string, Record<string, unknown>>;
      agents.codex = { ...agents.codex, [field]: "forbidden-override" };
      const { configPath } = await writeConfig(input);

      await expect(loadConfig(configPath, process.cwd(), commandDependencies())).rejects.toMatchObject({
        code: "INVALID_ENVELOPE",
        details: {
          issues: expect.arrayContaining([
            expect.objectContaining({ path: "agents.codex" })
          ])
        }
      });
    }
  );

  it("rejects unknown fields at every strict object boundary", async () => {
    const input = validConfig();
    input.unexpected = true;
    input.storage = { path: ".groupx/groupx.db", unexpected: true };
    const { configPath } = await writeConfig(input);

    await expect(loadConfig(configPath, process.cwd(), commandDependencies())).rejects.toMatchObject({
      code: "INVALID_ENVELOPE"
    });
  });

  it("rejects the deprecated Direct runtime entry and defaults to structured", async () => {
    const direct = validConfig();
    direct.transport = "direct";
    const directFixture = await writeConfig(direct);

    await expect(loadConfig(directFixture.configPath, process.cwd(), commandDependencies())).rejects.toMatchObject({
      code: "INVALID_ENVELOPE",
      details: {
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: "transport",
            message: "Direct transport is deprecated and disabled; use structured"
          })
        ])
      }
    });

    const invalid = validConfig();
    invalid.transport = "mixed";
    const invalidFixture = await writeConfig(invalid);
    await expect(loadConfig(invalidFixture.configPath, process.cwd(), commandDependencies())).rejects.toMatchObject({
      code: "INVALID_ENVELOPE",
      details: {
        issues: expect.arrayContaining([expect.objectContaining({ path: "transport" })])
      }
    });
  });

  it("does not expose access or native policy configuration", async () => {
    const input = validConfig();
    input.access = "unrestricted";
    const { configPath } = await writeConfig(input);

    await expect(loadConfig(configPath, process.cwd(), commandDependencies())).rejects.toMatchObject({
      code: "INVALID_ENVELOPE",
      details: {
        issues: expect.arrayContaining([expect.objectContaining({ path: "" })])
      }
    });
  });

  it("keeps the configured message limit equal to the fixed REST and MCP wire bound", async () => {
    const input = validConfig();
    input.limits = { messageCharacters: 32_769 };
    const { configPath } = await writeConfig(input);

    await expect(loadConfig(configPath, process.cwd(), commandDependencies())).rejects.toMatchObject({
      code: "INVALID_ENVELOPE",
      details: {
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "limits.messageCharacters" })
        ])
      }
    });
  });

  it("normalizes the new command object while retaining legacy command strings", async () => {
    const input = validConfig();
    const agents = input.agents as Record<string, Record<string, unknown>>;
    agents.grok = {
      command: { executable: grokExecutable, prefixArgs: [] },
      cwd: ".",
      enabled: true
    };
    const { configPath } = await writeConfig(input);

    const config = await loadConfig(configPath, process.cwd(), commandDependencies());

    expect(config.agents.codex!.command).toEqual({ executable: nodeExecutable, prefixArgs: [codexEntrypoint] });
    expect(config.agents.grok!.command).toEqual({ executable: grokExecutable, prefixArgs: [] });
  });

  it("loads custom agents with an explicit driver and display name", async () => {
    const input = validConfig();
    const agents = input.agents as Record<string, Record<string, unknown>>;
    agents.rex = { driver: "codex", name: "小R", command: "codex", cwd: ".", enabled: true };
    agents["grok-2"] = { driver: "grok", command: "grok", cwd: ".", enabled: false };
    const { configPath } = await writeConfig(input);

    const config = await loadConfig(configPath, process.cwd(), commandDependencies());

    expect(config.agents.rex).toMatchObject({ driver: "codex", name: "小R", enabled: true });
    expect(config.agents.rex!.command).toEqual({ executable: nodeExecutable, prefixArgs: [codexEntrypoint] });
    expect(config.agents["grok-2"]).toMatchObject({ driver: "grok", enabled: false });
    expect(config.agents.codex).toMatchObject({ driver: "codex" });
  });

  it("rejects a custom agent without a driver", async () => {
    const input = validConfig();
    const agents = input.agents as Record<string, Record<string, unknown>>;
    agents.rex = { command: "codex", cwd: ".", enabled: true };
    const { configPath } = await writeConfig(input);

    await expect(loadConfig(configPath, process.cwd(), commandDependencies())).rejects.toMatchObject({
      code: "INVALID_ENVELOPE",
      details: {
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "agents.rex.driver" })
        ])
      }
    });
  });

  it("rejects invalid agent ids and an empty roster", async () => {
    const invalidId = validConfig();
    (invalidId.agents as Record<string, unknown>)["bad id"] = { driver: "kimi", command: "kimi", cwd: "." };
    const invalidFixture = await writeConfig(invalidId);
    await expect(loadConfig(invalidFixture.configPath, process.cwd(), commandDependencies())).rejects.toMatchObject({
      code: "INVALID_ENVELOPE"
    });

    const empty = await writeConfig({ agents: {} });
    await expect(loadConfig(empty.configPath, process.cwd(), commandDependencies())).rejects.toMatchObject({
      code: "INVALID_ENVELOPE",
      details: {
        issues: expect.arrayContaining([
          expect.objectContaining({ message: "At least one agent is required" })
        ])
      }
    });
  });

  it("parses both supported --config forms and rejects a missing path", () => {
    expect(parseConfigPath(["node", "groupx", "--config", "local.json"])).toBe("local.json");
    expect(parseConfigPath(["node", "groupx", "--config=other.json"])).toBe("other.json");
    expect(parseConfigPath(["node", "groupx"])).toBeUndefined();
    expect(() => parseConfigPath(["node", "groupx", "--config"])).toThrowError(
      expect.objectContaining({ code: "INVALID_ENVELOPE" })
    );
    expect(() => parseConfigPath(["node", "groupx", "--config="])).toThrowError(
      expect.objectContaining({ code: "INVALID_ENVELOPE" })
    );
  });

  it("does not treat an explicitly empty config path as the default configuration", async () => {
    await expect(loadConfig("", process.cwd(), commandDependencies())).rejects.toMatchObject({
      code: "INVALID_ENVELOPE"
    });
  });
});
