import { describe, expect, it, vi } from "vitest";

import {
  restartConfiguredRuntime,
  startConfiguredRuntime,
  stopConfiguredRuntime,
  type RestartConfiguredRuntimeDependencies,
  type StartConfiguredRuntimeDependencies
} from "../../../src/cli.js";
import type {
  GroupXRuntimeLaunchDescriptor,
  GroupXRuntimeProbe
} from "../../../src/app/runtime-instance.js";
import type { GroupXRuntime } from "../../../src/app/runtime.js";
import { createGroupXRuntimeIdentity } from "../../../src/core/runtime-instance.js";

const runtimeScopeMaterial = { configPath: "C:\\workspace\\groupx.json" };
const identity = createGroupXRuntimeIdentity({ fixture: "same" }, runtimeScopeMaterial);
const descriptor: GroupXRuntimeLaunchDescriptor = {
  configPath: "C:\\workspace\\groupx.json",
  host: "127.0.0.1",
  port: 4_310,
  origin: "http://127.0.0.1:4310",
  closeTimeoutMs: 100,
  identity
};

function runtime(): GroupXRuntime {
  return { address: { host: "127.0.0.1", port: 4_310, origin: descriptor.origin } } as GroupXRuntime;
}

function restartDependencies(probes: readonly GroupXRuntimeProbe[]) {
  const fixture = dependencies(probes);
  const requestShutdown = vi.fn<
    RestartConfiguredRuntimeDependencies["requestShutdown"]
  >(() => Promise.resolve());
  return {
    ...fixture,
    requestShutdown,
    resolved: { ...fixture.resolved, requestShutdown }
  };
}

function dependencies(
  probes: readonly GroupXRuntimeProbe[],
  startRuntime: StartConfiguredRuntimeDependencies["startRuntime"] = () => Promise.resolve(runtime())
) {
  const queue = [...probes];
  const writeLine = vi.fn<(line: string) => void>();
  const open = vi.fn<(url: string) => Promise<boolean>>(() => Promise.resolve(true));
  const start = vi.fn(startRuntime);
  const delay = vi.fn<(milliseconds: number) => Promise<void>>(() => Promise.resolve());
  const resolved: StartConfiguredRuntimeDependencies = {
    describeLaunch: () => Promise.resolve(descriptor),
    probe: () => Promise.resolve(queue.shift() ?? { kind: "unreachable" }),
    startRuntime: start,
    open,
    writeLine,
    delay
  };
  return { resolved, writeLine, open, start, delay };
}

describe("idempotent groupx start", () => {
  it("reuses the same running GroupX and opens its existing page", async () => {
    const fixture = dependencies([{ kind: "same", identity }]);

    await expect(
      startConfiguredRuntime(descriptor.configPath, false, fixture.resolved)
    ).resolves.toEqual({ kind: "reused", origin: descriptor.origin });

    expect(fixture.start).not.toHaveBeenCalled();
    expect(fixture.open).toHaveBeenCalledWith(`${descriptor.origin}/`);
    expect(fixture.writeLine).toHaveBeenCalledWith(`GroupX 已在运行: ${descriptor.origin}/`);
  });

  it("does not open a browser when --no-open reuses an instance", async () => {
    const fixture = dependencies([{ kind: "same", identity }]);
    await startConfiguredRuntime(descriptor.configPath, true, fixture.resolved);
    expect(fixture.open).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "different-config", identity: createGroupXRuntimeIdentity({ other: true }) }, "其他配置"],
    [{ kind: "legacy-groupx" }, "旧版 GroupX"],
    [{ kind: "incompatible-groupx" }, "不兼容"],
    [{ kind: "occupied" }, "其他程序占用"]
  ] as const)("rejects a conflicting listener: %s", async (probe, expected) => {
    const fixture = dependencies([probe]);
    await expect(
      startConfiguredRuntime(descriptor.configPath, false, fixture.resolved)
    ).rejects.toThrow(expected);
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it("re-probes a bind race and reuses the winner without replaying startup", async () => {
    const bindError = Object.assign(new Error("occupied"), { code: "EADDRINUSE" });
    const fixture = dependencies(
      [{ kind: "unreachable" }, { kind: "unreachable" }, { kind: "same", identity }],
      () => Promise.reject(bindError)
    );

    await expect(
      startConfiguredRuntime(descriptor.configPath, false, fixture.resolved)
    ).resolves.toEqual({ kind: "reused", origin: descriptor.origin });
    expect(fixture.start).toHaveBeenCalledTimes(1);
    expect(fixture.delay).toHaveBeenCalledTimes(1);
  });

  it("turns an unidentifiable EADDRINUSE into a bounded user-facing error", async () => {
    const bindError = Object.assign(new Error("occupied"), { code: "EADDRINUSE" });
    const fixture = dependencies(
      [
        { kind: "unreachable" },
        { kind: "unreachable" },
        { kind: "unreachable" },
        { kind: "unreachable" }
      ],
      () => Promise.reject(bindError)
    );

    await expect(
      startConfiguredRuntime(descriptor.configPath, false, fixture.resolved)
    ).rejects.toThrow("端口 4310 已被其他程序占用");
    expect(fixture.delay).toHaveBeenCalledTimes(2);
  });

  it("starts normally when no listener is present", async () => {
    const fixture = dependencies([{ kind: "unreachable" }]);
    await expect(
      startConfiguredRuntime(descriptor.configPath, false, fixture.resolved)
    ).resolves.toMatchObject({ kind: "started", origin: descriptor.origin });
    expect(fixture.start).toHaveBeenCalledTimes(1);
    expect(fixture.open).toHaveBeenCalledWith(`${descriptor.origin}/`);
  });
});

describe("groupx stop", () => {
  it("gracefully stops the same config-path runtime without starting a replacement", async () => {
    const changedIdentity = createGroupXRuntimeIdentity(
      { fixture: "changed-roster" },
      runtimeScopeMaterial
    );
    const fixture = restartDependencies([
      { kind: "different-config", identity: changedIdentity },
      { kind: "different-config", identity: changedIdentity },
      { kind: "unreachable" },
      { kind: "unreachable" },
      { kind: "unreachable" }
    ]);

    await expect(
      stopConfiguredRuntime(descriptor.configPath, fixture.resolved)
    ).resolves.toEqual({ kind: "stopped", origin: descriptor.origin });

    expect(fixture.requestShutdown).toHaveBeenCalledWith(descriptor, changedIdentity);
    expect(fixture.start).not.toHaveBeenCalled();
    expect(fixture.open).not.toHaveBeenCalled();
    expect(fixture.writeLine).toHaveBeenCalledWith(
      `GroupX 已完整停止: ${descriptor.origin}/`
    );
  });

  it("fails closed when the configured port is already unreachable", async () => {
    const fixture = restartDependencies([{ kind: "unreachable" }]);

    await expect(
      stopConfiguredRuntime(descriptor.configPath, fixture.resolved)
    ).rejects.toThrow("检测到可停止的 GroupX");
    expect(fixture.requestShutdown).not.toHaveBeenCalled();
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it("does not stop another config that happens to use the same port", async () => {
    const otherIdentity = createGroupXRuntimeIdentity({ fixture: "other-config" });
    const fixture = restartDependencies([
      { kind: "different-config", identity: otherIdentity }
    ]);

    await expect(
      stopConfiguredRuntime(descriptor.configPath, fixture.resolved)
    ).rejects.toThrow("无法停止 GroupX");
    expect(fixture.requestShutdown).not.toHaveBeenCalled();
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it("does not report success while the old runtime still holds its lease", async () => {
    const fixture = restartDependencies([]);
    fixture.resolved.probe = () => Promise.resolve({ kind: "same", identity });

    await expect(
      stopConfiguredRuntime(descriptor.configPath, fixture.resolved)
    ).rejects.toThrow("未将 runtime 报告为已停止");
    expect(fixture.requestShutdown).toHaveBeenCalledTimes(1);
    expect(fixture.start).not.toHaveBeenCalled();
    expect(fixture.writeLine).not.toHaveBeenCalledWith(
      `GroupX 已完整停止: ${descriptor.origin}/`
    );
  });
});

describe("groupx restart", () => {
  it("gracefully replaces a runtime after the config contents changed", async () => {
    const changedIdentity = createGroupXRuntimeIdentity(
      { fixture: "changed-roster" },
      runtimeScopeMaterial
    );
    const fixture = restartDependencies([
      { kind: "different-config", identity: changedIdentity },
      { kind: "different-config", identity: changedIdentity },
      { kind: "unreachable" },
      { kind: "unreachable" },
      { kind: "unreachable" },
      { kind: "unreachable" }
    ]);

    await expect(
      restartConfiguredRuntime(descriptor.configPath, false, fixture.resolved)
    ).resolves.toMatchObject({ kind: "started", origin: descriptor.origin });

    expect(fixture.requestShutdown).toHaveBeenCalledWith(descriptor, changedIdentity);
    expect(fixture.start).toHaveBeenCalledTimes(1);
    expect(fixture.open).toHaveBeenCalledWith(`${descriptor.origin}/`);
    expect(fixture.writeLine).toHaveBeenCalledWith(
      "原 GroupX 已完整关闭，正在按最新配置重载。"
    );
  });

  it("fails closed when no runtime is present at the configured port", async () => {
    const fixture = restartDependencies([{ kind: "unreachable" }]);

    await expect(
      restartConfiguredRuntime(descriptor.configPath, true, fixture.resolved)
    ).rejects.toThrow("若实例本来未运行，请使用 groupx start");
    expect(fixture.requestShutdown).not.toHaveBeenCalled();
    expect(fixture.start).not.toHaveBeenCalled();
    expect(fixture.open).not.toHaveBeenCalled();
  });

  it("does not stop another config that happens to use the same port", async () => {
    const otherIdentity = createGroupXRuntimeIdentity({ fixture: "other-config" });
    const fixture = restartDependencies([
      { kind: "different-config", identity: otherIdentity }
    ]);

    await expect(
      restartConfiguredRuntime(descriptor.configPath, false, fixture.resolved)
    ).rejects.toThrow("其他配置");
    expect(fixture.requestShutdown).not.toHaveBeenCalled();
    expect(fixture.start).not.toHaveBeenCalled();
  });

  it("does not start a replacement until the old runtime releases its lease", async () => {
    const fixture = restartDependencies([]);
    fixture.resolved.probe = () => Promise.resolve({ kind: "same", identity });

    await expect(
      restartConfiguredRuntime(descriptor.configPath, false, fixture.resolved)
    ).rejects.toThrow("为避免新旧 runtime 重叠");
    expect(fixture.requestShutdown).toHaveBeenCalledTimes(1);
    expect(fixture.start).not.toHaveBeenCalled();
  });
});
