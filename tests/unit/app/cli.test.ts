import path from "node:path";
import { describe, expect, it } from "vitest";

import { collectDoctorReport, formatDoctorReport, nodeSatisfiesEngines, type DoctorDependencies } from "../../../src/app/doctor.js";
import { runInit, type InitDependencies } from "../../../src/app/init-config.js";
import { openBrowser } from "../../../src/utils/open-browser.js";
import type { CommandResolverDependencies, CommandSpec } from "../../../src/launch/index.js";

const nodeExecutable = "C:\\Program Files\\nodejs\\node.exe";
const codexEntrypoint = "C:\\Users\\groupx\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";

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

describe("groupx init", () => {
  function initDependencies(
    written: Map<string, string>,
    overrides: Partial<InitDependencies> = {}
  ): InitDependencies {
    return {
      commandDependencies: resolverWith([nodeExecutable, codexEntrypoint]),
      fileExists: (candidate) => written.has(candidate),
      writeConfigFile: (configPath, content) => {
        written.set(configPath, content);
        return Promise.resolve();
      },
      stdout: () => undefined,
      ...overrides
    };
  }

  it("writes a config with only detected CLIs enabled", async () => {
    const written = new Map<string, string>();
    const code = await runInit({ cwd: "C:\\workspace" }, initDependencies(written));

    expect(code).toBe(0);
    const target = path.resolve("C:\\workspace", "groupx.json");
    const config = JSON.parse(written.get(target) ?? "{}") as {
      agents: Record<string, { enabled: boolean }>;
    };
    expect(config.agents.codex?.enabled).toBe(true);
    expect(config.agents.grok?.enabled).toBe(false);
    expect(config.agents.kimi?.enabled).toBe(false);
  });

  it("refuses to overwrite an existing config without --force", async () => {
    const written = new Map<string, string>();
    const target = path.resolve("C:\\workspace", "groupx.json");
    written.set(target, "{}");

    const code = await runInit({ cwd: "C:\\workspace" }, initDependencies(written));
    expect(code).toBe(1);
    expect(written.get(target)).toBe("{}");

    const forced = await runInit({ cwd: "C:\\workspace", force: true }, initDependencies(written));
    expect(forced).toBe(0);
    expect(written.get(target)).not.toBe("{}");
  });
});

describe("openBrowser", () => {
  it("only accepts loopback http URLs", () => {
    expect(openBrowser("https://example.com")).toBe(false);
    expect(openBrowser("http://0.0.0.0:4310/")).toBe(false);
    expect(openBrowser("file:///etc/passwd")).toBe(false);
  });
});
