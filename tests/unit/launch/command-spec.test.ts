import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveAgentCommand,
  type CommandResolverDependencies,
  type CommandSpec
} from "../../../src/launch/command-spec.js";

const paths = path.win32;
const baseDirectory = "C:\\workspace";
const appData = "C:\\Users\\groupx\\AppData\\Roaming";
const userProfile = "C:\\Users\\groupx";
const nodeExecutable = "C:\\Program Files\\nodejs\\node.exe";
const codexEntrypoint = paths.resolve(
  appData,
  "npm",
  "node_modules",
  "@openai",
  "codex",
  "bin",
  "codex.js"
);
const kimiEntrypoint = paths.resolve(
  appData,
  "npm",
  "node_modules",
  "@moonshot-ai",
  "kimi-code",
  "dist",
  "main.mjs"
);
const grokExecutable = paths.resolve(userProfile, ".grok", "bin", "grok.exe");

function dependencies(
  files: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {}
): CommandResolverDependencies {
  const normalizedFiles = new Set(files.map((candidate) => paths.normalize(candidate).toLowerCase()));
  return {
    platform: "win32",
    env: {
      APPDATA: appData,
      USERPROFILE: userProfile,
      PATH: "C:\\Tools",
      ...environment
    },
    execPath: nodeExecutable,
    isFile: (candidate) => normalizedFiles.has(paths.normalize(candidate).toLowerCase())
  };
}

function legacy(executable: string): CommandSpec {
  return { executable, prefixArgs: [] };
}

describe("shell-free Agent command resolution", () => {
  it("resolves npm-global Codex and Kimi through absolute node plus their known entrypoints", () => {
    const resolver = dependencies([nodeExecutable, codexEntrypoint, kimiEntrypoint]);

    expect(resolveAgentCommand("codex", "codex", legacy("codex"), baseDirectory, resolver)).toEqual({
      executable: nodeExecutable,
      prefixArgs: [codexEntrypoint]
    });
    expect(resolveAgentCommand("kimi", "kimi", legacy("kimi"), baseDirectory, resolver)).toEqual({
      executable: nodeExecutable,
      prefixArgs: [kimiEntrypoint]
    });
  });

  it("resolves the native Grok executable under the user profile", () => {
    const resolver = dependencies([grokExecutable]);

    expect(resolveAgentCommand("grok", "grok", legacy("grok"), baseDirectory, resolver)).toEqual({
      executable: grokExecutable,
      prefixArgs: []
    });
  });

  it("fails closed when only an npm cmd shim exists instead of the known JavaScript entrypoint", () => {
    const npmShim = paths.resolve(appData, "npm", "codex.cmd");
    const resolver = dependencies([nodeExecutable, npmShim], { PATH: paths.dirname(npmShim) });

    expect(() => resolveAgentCommand("codex", "codex", legacy("codex"), baseDirectory, resolver)).toThrowError(
      expect.objectContaining({
        code: "INVALID_ENVELOPE",
        details: { agentId: "codex", reason: "npm_entrypoint_not_found" }
      })
    );
  });

  it("resolves an ordinary bare command only to a real executable on PATH", () => {
    const executable = "C:\\Tools\\custom-agent.exe";
    const resolver = dependencies([executable]);

    expect(resolveAgentCommand("codex", "codex", legacy("custom-agent"), baseDirectory, resolver)).toEqual({
      executable,
      prefixArgs: []
    });
  });

  it("does not silently pass an ordinary cmd, bat, or PowerShell shim to a shell", () => {
    const resolver = dependencies([
      "C:\\Tools\\custom-agent.cmd",
      "C:\\Tools\\custom-agent.bat",
      "C:\\Tools\\custom-agent.ps1"
    ]);

    expect(() => resolveAgentCommand("codex", "codex", legacy("custom-agent"), baseDirectory, resolver)).toThrowError(
      expect.objectContaining({
        code: "INVALID_ENVELOPE",
        details: { agentId: "codex", reason: "executable_not_found" }
      })
    );
    expect(() =>
      resolveAgentCommand("codex", "codex", legacy("C:\\Tools\\custom-agent.cmd"), baseDirectory, resolver)
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_ENVELOPE",
        details: { agentId: "codex", reason: "shell_wrapper_forbidden" }
      })
    );
  });

  it("resolves an explicit relative JavaScript entrypoint before adapter-owned native arguments", () => {
    const entrypoint = paths.resolve(baseDirectory, "tools", "cli.mjs");
    const resolver = dependencies([nodeExecutable, entrypoint]);

    expect(
      resolveAgentCommand("kimi", "kimi",
        { executable: nodeExecutable, prefixArgs: ["tools\\cli.mjs"] },
        baseDirectory,
        resolver
      )
    ).toEqual({ executable: nodeExecutable, prefixArgs: [entrypoint] });
  });

  it("rejects policy flags or more than one value in prefixArgs", () => {
    const entrypoint = paths.resolve(baseDirectory, "tools", "cli.mjs");
    const resolver = dependencies([nodeExecutable, entrypoint]);

    expect(() =>
      resolveAgentCommand("codex", "codex",
        { executable: nodeExecutable, prefixArgs: ["--yolo"] },
        baseDirectory,
        resolver
      )
    ).toThrowError(
      expect.objectContaining({
        details: { agentId: "codex", reason: "native_flags_forbidden_in_prefix_args" }
      })
    );
    expect(() =>
      resolveAgentCommand("codex", "codex",
        { executable: nodeExecutable, prefixArgs: [entrypoint, "--yolo"] },
        baseDirectory,
        resolver
      )
    ).toThrowError(
      expect.objectContaining({ details: { agentId: "codex", reason: "single_entrypoint_required" } })
    );
  });

  it("requires a JavaScript entrypoint whenever node itself is configured", () => {
    const resolver = dependencies([nodeExecutable]);

    expect(() => resolveAgentCommand("kimi", "kimi", legacy(nodeExecutable), baseDirectory, resolver)).toThrowError(
      expect.objectContaining({ details: { agentId: "kimi", reason: "node_entrypoint_required" } })
    );
  });

  it("converts filesystem probe failures into a bounded resolution error", () => {
    const resolver: CommandResolverDependencies = {
      platform: "win32",
      env: { APPDATA: appData, USERPROFILE: userProfile },
      execPath: nodeExecutable,
      isFile: () => {
        throw new Error("probe failed");
      }
    };

    expect(() => resolveAgentCommand("codex", "codex", legacy("codex"), baseDirectory, resolver)).toThrowError(
      expect.objectContaining({
        code: "INVALID_ENVELOPE",
        details: { agentId: "codex", reason: "node_runtime_not_found" }
      })
    );
  });

  it("resolves the default command by driver for a custom agent id", () => {
    const resolver = dependencies([nodeExecutable, codexEntrypoint]);

    expect(resolveAgentCommand("rex", "codex", legacy("codex"), baseDirectory, resolver)).toEqual({
      executable: nodeExecutable,
      prefixArgs: [codexEntrypoint]
    });
  });

  it("resolves default commands from PATH on posix platforms", () => {
    const resolver: CommandResolverDependencies = {
      platform: "darwin",
      env: { HOME: "/Users/groupx", PATH: "/usr/local/bin" },
      execPath: "/usr/local/bin/node",
      isFile: (candidate) => candidate === "/usr/local/bin/codex"
    };

    expect(resolveAgentCommand("rex", "codex", legacy("codex"), "/Users/groupx/work", resolver)).toEqual({
      executable: "/usr/local/bin/codex",
      prefixArgs: []
    });
  });

  it("resolves a custom executable path for a custom agent id", () => {
    const executable = "C:\\Tools\\rex-agent.exe";
    const resolver = dependencies([executable]);

    expect(resolveAgentCommand("rex", "grok", legacy("rex-agent"), baseDirectory, resolver)).toEqual({
      executable,
      prefixArgs: []
    });
  });
});
