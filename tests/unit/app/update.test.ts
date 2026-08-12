import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  compareStableVersions,
  resolveNpmInvocation,
  runGroupXUpdate,
  type GroupXUpdateDependencies
} from "../../../src/app/update.js";

function updateDependencies(latest = "0.1.3"): GroupXUpdateDependencies & {
  readonly installVersion: ReturnType<typeof vi.fn<(version: string) => Promise<void>>>;
  readonly stdout: ReturnType<typeof vi.fn<(line: string) => void>>;
} {
  return {
    latestVersion: () => Promise.resolve(latest),
    installVersion: vi.fn(() => Promise.resolve()),
    stdout: vi.fn()
  };
}

describe("GroupX updater", () => {
  it("compares stable versions without a semver runtime dependency", () => {
    expect(compareStableVersions("0.1.2", "0.1.3")).toBe(-1);
    expect(compareStableVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareStableVersions("2.0.0", "1.99.99")).toBe(1);
    expect(() => compareStableVersions("latest", "1.0.0")).toThrow("无法解析");
  });

  it("does not install when current, newer, or check-only", async () => {
    const current = updateDependencies("0.1.2");
    await expect(runGroupXUpdate({ currentVersion: "0.1.2" }, current)).resolves.toBe("current");
    expect(current.installVersion).not.toHaveBeenCalled();

    const newer = updateDependencies("0.1.2");
    await expect(runGroupXUpdate({ currentVersion: "0.2.0" }, newer)).resolves.toBe("newer");
    expect(newer.installVersion).not.toHaveBeenCalled();

    const checkOnly = updateDependencies("0.1.3");
    await expect(runGroupXUpdate({ currentVersion: "0.1.2", checkOnly: true }, checkOnly)).resolves.toBe("available");
    expect(checkOnly.installVersion).not.toHaveBeenCalled();
  });

  it("pins installation to the exact version observed from the registry", async () => {
    const dependencies = updateDependencies("0.1.3");

    await expect(runGroupXUpdate({ currentVersion: "0.1.2" }, dependencies)).resolves.toBe("updated");

    expect(dependencies.installVersion).toHaveBeenCalledOnce();
    expect(dependencies.installVersion).toHaveBeenCalledWith("0.1.3");
    expect(dependencies.stdout).toHaveBeenLastCalledWith("GroupX 已更新到 0.1.3。请重新运行 groupx start。");
  });

  it("uses npm-cli.js through node on Windows instead of a shell shim", async () => {
    const npmCli = path.win32.normalize("C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js");
    const invocation = await resolveNpmInvocation({
      platform: "win32",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      env: { PATH: "C:\\Program Files\\nodejs" },
      canExecute: (candidate) => Promise.resolve(path.win32.normalize(candidate) === npmCli)
    });

    expect(invocation).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      prefixArgs: [npmCli]
    });
  });

  it("uses an executable npm shim directly on macOS/Linux without a shell", async () => {
    const invocation = await resolveNpmInvocation({
      platform: "darwin",
      execPath: "/opt/homebrew/bin/node",
      env: { PATH: "/usr/local/bin:/opt/homebrew/bin" },
      canExecute: (candidate) => Promise.resolve(candidate === "/opt/homebrew/bin/npm")
    });

    expect(invocation).toEqual({ command: "/opt/homebrew/bin/npm", prefixArgs: [] });
  });

  it("fails clearly when npm cannot be resolved", async () => {
    await expect(resolveNpmInvocation({
      platform: "win32",
      execPath: "C:\\Node\\node.exe",
      env: {},
      canExecute: () => Promise.resolve(false)
    })).rejects.toThrow("找不到可安全调用的 npm");
  });
});
