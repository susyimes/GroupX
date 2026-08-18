import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { collectDoctorReport, formatDoctorReport, nodeSatisfiesEngines, type DoctorDependencies } from "../../../src/app/doctor.js";
import {
  GroupXConfigSetupService,
  type ConfigSetupDependencies
} from "../../../src/app/init-config.js";
import { openBrowser } from "../../../src/utils/open-browser.js";
import type { CommandResolverDependencies, CommandSpec } from "../../../src/launch/index.js";
import type { SetupSaveRequest } from "../../../src/contracts/index.js";
import { isEntryModule } from "../../../src/cli.js";

const nodeExecutable = "C:\\Program Files\\nodejs\\node.exe";
const codexEntrypoint = "C:\\Users\\groupx\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";

describe("groupx CLI entry", () => {
  it("recognizes execution through an npm-style symbolic link", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "groupx-cli-"));
    const targetDirectory = path.resolve("src");
    const target = path.join(targetDirectory, "cli.ts");
    const linkedDirectory = path.join(directory, "linked-src");
    const linkedEntry = path.join(linkedDirectory, "cli.ts");

    try {
      await symlink(targetDirectory, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
      expect(isEntryModule(linkedEntry, pathToFileURL(target).href)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function resolverWith(files: readonly string[]): CommandResolverDependencies {
  const normalized = new Set(files.map((file) => path.win32.normalize(file).toLowerCase()));
  return {
    platform: "win32",
    env: {
      APPDATA: "C:\\Users\\groupx\\AppData\\Roaming",
      USERPROFILE: "C:\\Users\\groupx",
      PATH: "C:\\Tools"
    },
    execPath: nodeExecutable,
    isFile: (candidate) => normalized.has(path.win32.normalize(candidate).toLowerCase())
  };
}

function doctorDependencies(overrides: Partial<DoctorDependencies> = {}): DoctorDependencies {
  return {
    platform: "win32",
    arch: "x64",
    osRelease: "10.0.22631",
    nodeVersion: "v24.14.1",
    commandDependencies: resolverWith([nodeExecutable, codexEntrypoint]),
    probeVersion: (command: CommandSpec) =>
      Promise.resolve(command.prefixArgs.length > 0 ? "0.147.0" : undefined),
    loadConfigFrom: () => Promise.reject(new Error("no config in tests")),
    fileExists: () => false,
    ...overrides
  };
}

describe("groupx doctor", () => {
  it("checks the pinned Node range", () => {
    expect(nodeSatisfiesEngines("v24.14.1")).toBe(true);
    expect(nodeSatisfiesEngines("v24.15.0")).toBe(true);
    expect(nodeSatisfiesEngines("v24.14.0")).toBe(false);
    expect(nodeSatisfiesEngines("v25.0.0")).toBe(false);
    expect(nodeSatisfiesEngines("not-a-version")).toBe(false);
  });

  it("reports found and missing drivers with versions", async () => {
    const report = await collectDoctorReport({ cwd: "C:\\workspace" }, doctorDependencies());

    const codex = report.drivers.find((probe) => probe.driver === "codex");
    const grok = report.drivers.find((probe) => probe.driver === "grok");
    expect(codex).toMatchObject({ found: true, version: "0.147.0" });
    expect(grok).toMatchObject({ found: false });
    expect(report.node.enginesOk).toBe(true);
    expect("skipped" in report.config ? report.config.skipped : "").toContain("groupx.json");

    const text = formatDoctorReport(report);
    expect(text).toContain("✓ codex");
    expect(text).toContain("✗ grok");
    expect(text).toContain("检测到 1 个 CLI");
  });

  it("summarizes a loaded config with custom agent names", async () => {
    const report = await collectDoctorReport(
      { cwd: "C:\\workspace", configPath: "custom.json" },
      doctorDependencies({
        loadConfigFrom: () =>
          Promise.resolve({
            agents: {
              rex: { driver: "codex", name: "小R", command: { executable: nodeExecutable, prefixArgs: [] }, cwd: ".", enabled: true }
            }
          } as never)
      })
    );

    const text = formatDoctorReport(report);
    expect(text).toContain("rex (小R, driver=codex)");
    expect(text).toContain("1 个 agent,1 个启用");
  });
});

describe("GroupX browser setup service", () => {
  function setupDependencies(
    written: Map<string, string>,
    commandFiles: readonly string[] = [nodeExecutable, codexEntrypoint],
    overrides: Partial<ConfigSetupDependencies> = {}
  ): ConfigSetupDependencies {
    return {
      commandDependencies: resolverWith(commandFiles),
      fileExists: (candidate) => written.has(candidate),
      readConfigFile: (configPath) => Promise.resolve(written.get(configPath) ?? ""),
      writeConfigFile: (configPath, content) => {
        written.set(configPath, content);
        return Promise.resolve();
      },
      ...overrides
    };
  }

  function saveRequest(agents: SetupSaveRequest["config"]["agents"]): SetupSaveRequest {
    return {
      config: {
        serverPort: 4_310,
        storagePath: ".groupx/groupx.db",
        agents
      }
    };
  }

  it("builds a starter roster with only detected CLI families enabled", async () => {
    const written = new Map<string, string>();
    const target = path.resolve("C:\\workspace", "groupx.json");
    const service = new GroupXConfigSetupService({
      configPath: target,
      dependencies: setupDependencies(written)
    });

    const snapshot = await service.snapshot(new AbortController().signal);

    expect(snapshot.existing).toBe(false);
    expect(snapshot.config.agents).toMatchObject([
      { id: "codex", driver: "codex", enabled: true },
      { id: "grok", driver: "grok", enabled: false },
      { id: "kimi", driver: "kimi", enabled: false },
      { id: "hermes", driver: "hermes", enabled: false },
      { id: "claude", driver: "claude", enabled: false }
    ]);
    expect(snapshot.drivers).toMatchObject([
      { driver: "codex", found: true },
      { driver: "grok", found: false },
      { driver: "kimi", found: false },
      { driver: "hermes", found: false },
      { driver: "claude", found: false }
    ]);
    expect(snapshot.config.assistant).toMatchObject({
      enabled: true,
      name: "房间助理",
      brain: { driver: "codex" }
    });
  });

  it("still returns an editable starter when no default CLI command is detected", async () => {
    const written = new Map<string, string>();
    const target = path.resolve("C:\\workspace", "groupx.json");
    const service = new GroupXConfigSetupService({
      configPath: target,
      dependencies: setupDependencies(written, [])
    });

    const snapshot = await service.snapshot(new AbortController().signal);

    expect(snapshot.config.agents).toHaveLength(5);
    expect(snapshot.config.agents.every((agent) => agent.enabled === false)).toBe(true);
    expect(snapshot.drivers.every((probe) => probe.found === false)).toBe(true);
  });

  it("saves multiple Codex App Server instances with independent identities", async () => {
    const written = new Map<string, string>();
    const target = path.resolve("C:\\workspace", "groupx.json");
    const service = new GroupXConfigSetupService({
      configPath: target,
      dependencies: setupDependencies(written)
    });

    const result = await service.save(
      saveRequest([
        {
          id: "codex",
          driver: "codex",
          name: "Builder",
          identity: "负责实现并说明证据",
          command: { executable: "codex", prefixArgs: [] },
          cwd: ".",
          enabled: true
        },
        {
          id: "reviewer",
          driver: "codex",
          name: "Reviewer",
          identity: "负责独立评审与回归检查",
          command: { executable: "codex", prefixArgs: [] },
          cwd: "review-worktree",
          enabled: true
        }
      ]),
      new AbortController().signal
    );

    expect(result).toMatchObject({ agentCount: 2, enabledAgentCount: 2, restartRequired: false });
    const config = JSON.parse(written.get(target) ?? "{}") as {
      transport: string;
      agents: Record<string, { driver: string; name?: string; identity?: string; cwd: string }>;
    };
    expect(config.transport).toBe("structured");
    expect(config.agents.codex).toMatchObject({
      driver: "codex",
      name: "Builder",
      identity: "负责实现并说明证据",
      cwd: "."
    });
    expect(config.agents.reviewer).toMatchObject({
      driver: "codex",
      name: "Reviewer",
      identity: "负责独立评审与回归检查",
      cwd: "review-worktree"
    });

    const snapshot = await service.snapshot(new AbortController().signal);
    expect(snapshot.existing).toBe(true);
    expect(snapshot.config.agents.map(({ id, driver }) => ({ id, driver }))).toEqual([
      { id: "codex", driver: "codex" },
      { id: "reviewer", driver: "codex" }
    ]);
    expect(snapshot.config.agents.map(({ id, identity }) => ({ id, identity }))).toEqual([
      { id: "codex", identity: "负责实现并说明证据" },
      { id: "reviewer", identity: "负责独立评审与回归检查" }
    ]);
  });

  it("preserves advanced limits and timeouts when the UI edits the roster", async () => {
    const written = new Map<string, string>();
    const target = path.resolve("C:\\workspace", "groupx.json");
    written.set(target, JSON.stringify({
      agents: { codex: { command: "codex", cwd: ".", enabled: true } },
      limits: { queuePerAgent: 7 },
      timeouts: { askMs: 45_000 }
    }));
    const service = new GroupXConfigSetupService({
      configPath: target,
      runtimeActive: true,
      dependencies: setupDependencies(written)
    });

    const result = await service.save(
      saveRequest([{
        id: "codex",
        driver: "codex",
        name: "",
        command: { executable: "codex", prefixArgs: [] },
        cwd: ".",
        enabled: true
      }]),
      new AbortController().signal
    );

    const config = JSON.parse(written.get(target) ?? "{}") as {
      limits: { queuePerAgent: number };
      timeouts: { askMs: number };
    };
    expect(result.restartRequired).toBe(true);
    expect(config.limits.queuePerAgent).toBe(7);
    expect(config.timeouts.askMs).toBe(45_000);

    const snapshot = await service.snapshot(new AbortController().signal);
    expect(snapshot.config.assistant).toMatchObject({ enabled: false });
  });

  it("does not enable the assistant when an existing config omitted it", async () => {
    const written = new Map<string, string>();
    const target = path.resolve("C:\\workspace", "groupx.json");
    written.set(target, JSON.stringify({
      agents: { codex: { command: "codex", cwd: ".", enabled: true } }
    }));
    const service = new GroupXConfigSetupService({
      configPath: target,
      dependencies: setupDependencies(written)
    });

    const snapshot = await service.snapshot(new AbortController().signal);
    expect(snapshot.config.assistant).toMatchObject({ enabled: false });
  });

  it("preserves a stored assistant when the save draft omits the card", async () => {
    const written = new Map<string, string>();
    const target = path.resolve("C:\\workspace", "groupx.json");
    written.set(target, JSON.stringify({
      agents: { codex: { command: "codex", cwd: ".", enabled: true } },
      assistant: {
        enabled: true,
        name: "调度员",
        brain: { driver: "codex", command: "codex", cwd: "." }
      }
    }));
    const service = new GroupXConfigSetupService({
      configPath: target,
      runtimeActive: true,
      dependencies: setupDependencies(written)
    });

    await service.save(
      saveRequest([{
        id: "codex",
        driver: "codex",
        name: "",
        command: { executable: "codex", prefixArgs: [] },
        cwd: ".",
        enabled: true
      }]),
      new AbortController().signal
    );

    const config = JSON.parse(written.get(target) ?? "{}") as {
      assistant?: { enabled: boolean; name: string };
    };
    expect(config.assistant).toMatchObject({ enabled: true, name: "调度员" });
  });

  it("rejects reserved assistant roster ids", async () => {
    const written = new Map<string, string>();
    const target = path.resolve("C:\\workspace", "groupx.json");
    const service = new GroupXConfigSetupService({
      configPath: target,
      dependencies: setupDependencies(written)
    });

    expect(() => service.save(
      saveRequest([{
        id: "assistant",
        driver: "codex",
        name: "",
        command: { executable: "codex", prefixArgs: [] },
        cwd: ".",
        enabled: true
      }]),
      new AbortController().signal
    )).toThrowError(expect.objectContaining({ code: "INVALID_ENVELOPE" }));
  });

  it("falls back to a repairable starter snapshot when an existing command cannot be represented", async () => {
    const written = new Map<string, string>();
    const target = path.resolve("C:\\workspace", "groupx.json");
    written.set(target, JSON.stringify({
      agents: {
        codex: {
          command: {
            executable: nodeExecutable,
            prefixArgs: [codexEntrypoint, "unexpected-second-entrypoint.js"]
          },
          cwd: ".",
          enabled: true
        }
      }
    }));
    const service = new GroupXConfigSetupService({
      configPath: target,
      dependencies: setupDependencies(written)
    });

    const snapshot = await service.snapshot(new AbortController().signal);

    expect(snapshot.existing).toBe(true);
    expect(snapshot.existingConfigError).toBeDefined();
    expect(snapshot.config.agents.map(({ id }) => id)).toEqual(["codex", "grok", "kimi", "hermes", "claude"]);
  });

  it("does not overwrite an existing config when the preservation read fails", async () => {
    const written = new Map<string, string>();
    const target = path.resolve("C:\\workspace", "groupx.json");
    written.set(target, "existing");
    const writeConfigFile = vi.fn<ConfigSetupDependencies["writeConfigFile"]>();
    const service = new GroupXConfigSetupService({
      configPath: target,
      dependencies: setupDependencies(written, undefined, {
        readConfigFile: () => Promise.reject(new Error("sharing violation")),
        writeConfigFile
      })
    });

    await expect(service.save(
      saveRequest([{
        id: "codex",
        driver: "codex",
        name: "",
        command: { executable: "codex", prefixArgs: [] },
        cwd: ".",
        enabled: true
      }]),
      new AbortController().signal
    )).rejects.toThrow("sharing violation");
    expect(writeConfigFile).not.toHaveBeenCalled();
  });

  it("validates enabled commands but permits unavailable disabled entries", async () => {
    const written = new Map<string, string>();
    const target = path.resolve("C:\\workspace", "groupx.json");
    const service = new GroupXConfigSetupService({
      configPath: target,
      dependencies: setupDependencies(written)
    });
    const unavailable = {
      id: "offline",
      driver: "grok" as const,
      name: "",
      command: { executable: "missing-grok", prefixArgs: [] },
      cwd: "."
    };

    await expect(service.save(
      saveRequest([{
        id: "codex",
        driver: "codex",
        name: "",
        command: { executable: "codex", prefixArgs: [] },
        cwd: ".",
        enabled: true
      }, { ...unavailable, enabled: false }]),
      new AbortController().signal
    )).resolves.toMatchObject({ agentCount: 2, enabledAgentCount: 1 });

    await expect(service.save(
      saveRequest([{ ...unavailable, enabled: true }]),
      new AbortController().signal
    )).rejects.toMatchObject({ code: "INVALID_ENVELOPE" });
  });

  it("rejects duplicate identities and a roster with no enabled Agent", () => {
    const written = new Map<string, string>();
    const target = path.resolve("C:\\workspace", "groupx.json");
    const service = new GroupXConfigSetupService({
      configPath: target,
      dependencies: setupDependencies(written)
    });
    const agent = {
      id: "codex",
      driver: "codex" as const,
      name: "",
      command: { executable: "codex", prefixArgs: [] },
      cwd: ".",
      enabled: true
    };

    expect(() => service.save(
      saveRequest([agent, { ...agent }]),
      new AbortController().signal
    )).toThrowError(expect.objectContaining({ code: "INVALID_ENVELOPE" }));
    expect(() => service.save(
      saveRequest([{ ...agent, enabled: false }]),
      new AbortController().signal
    )).toThrowError(expect.objectContaining({ code: "INVALID_ENVELOPE" }));
  });
});

describe("openBrowser", () => {
  it("only accepts loopback http URLs", async () => {
    await expect(openBrowser("https://example.com")).resolves.toBe(false);
    await expect(openBrowser("http://0.0.0.0:4310/")).resolves.toBe(false);
    await expect(openBrowser("file:///etc/passwd")).resolves.toBe(false);
  });
});
