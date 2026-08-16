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
const localAppData = "C:\\Users\\groupx\\AppData\\Local";
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
const hermesExecutable = paths.resolve(
  localAppData,
  "hermes",
  "hermes-agent",
  "venv",
  "Scripts",
  "hermes.exe"
);

function dependencies(
  files: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = {}
): CommandResolverDependencies {
  const normalizedFiles = new Set(files.map((candidate) => paths.normalize(candidate).toLowerCase()));
  return {
    platform: "win32",
    env: {
      APPDATA: appData,
      LOCALAPPDATA: localAppData,
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

  it("resolves Hermes from PATH or its official Windows install location", () => {
    const pathExecutable = "C:\\Tools\\hermes.exe";
    expect(
      resolveAgentCommand(
        "hermes",
        "hermes",
        legacy("hermes"),
        baseDirectory,
        dependencies([pathExecutable])
      )
    ).toEqual({ executable: pathExecutable, prefixArgs: [] });

    expect(
      resolveAgentCommand(
        "hermes",
        "hermes",
        legacy("hermes"),
        baseDirectory,
        dependencies([hermesExecutable], { PATH: "C:\\Empty" })
      )
    ).toEqual({ executable: hermesExecutable, prefixArgs: [] });
  });

  it("resolves Hermes as a native executable on a POSIX PATH", () => {
    const executable = "/opt/homebrew/bin/hermes";
    const resolver: CommandResolverDependencies = {
      platform: "darwin",
      env: { PATH: "/opt/homebrew/bin:/usr/local/bin" },
      execPath: "/opt/homebrew/bin/node",
      isFile: (candidate) => candidate === executable
    };

    expect(
      resolveAgentCommand(
        "hermes",
        "hermes",
        legacy("hermes"),
        "/workspace",
        resolver
      )
    ).toEqual({ executable, prefixArgs: [] });
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

  it("resolves Windows Claude from PATH without requiring APPDATA", () => {
    const executable = "C:\\Tools\\claude.exe";
    const resolver = dependencies([executable], { APPDATA: undefined, PATH: "C:\\Tools" });

    expect(resolveAgentCommand("claude", "claude", legacy("claude"), baseDirectory, resolver)).toEqual({
      executable,
      prefixArgs: []
    });
  });

  it("resolves Windows Claude from the native installer path before npm", () => {
    const nativeExecutable = paths.resolve(userProfile, ".local", "bin", "claude.exe");
    const npmEntrypoint = paths.resolve(
      appData,
      "npm",
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "cli.js"
    );
    const resolver = dependencies([nativeExecutable, nodeExecutable, npmEntrypoint], { PATH: "C:\\Empty" });

    expect(resolveAgentCommand("claude", "claude", legacy("claude"), baseDirectory, resolver)).toEqual({
      executable: nativeExecutable,
      prefixArgs: []
    });
  });

  it("falls back to the Claude npm entrypoint only after native lookup misses", () => {
    const npmEntrypoint = paths.resolve(
      appData,
      "npm",
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "cli.js"
    );
    const resolver = dependencies([nodeExecutable, npmEntrypoint], { PATH: "C:\\Empty" });

    expect(resolveAgentCommand("claude", "claude", legacy("claude"), baseDirectory, resolver)).toEqual({
      executable: nodeExecutable,
      prefixArgs: [npmEntrypoint]
    });
  });

  it("does not treat a Claude cmd shim as a resolved executable", () => {
    const npmShim = paths.resolve(appData, "npm", "claude.cmd");
    const resolver = dependencies([nodeExecutable, npmShim], { PATH: paths.dirname(npmShim) });

    expect(() => resolveAgentCommand("claude", "claude", legacy("claude"), baseDirectory, resolver)).toThrowError(
      expect.objectContaining({
        code: "INVALID_ENVELOPE",
        details: { agentId: "claude", reason: "npm_entrypoint_not_found" }
      })
    );
  });

  it("resolves a custom Claude-driver agent with the same default lookup", () => {
    const executable = "C:\\Tools\\claude.exe";
    const resolver = dependencies([executable]);

    expect(resolveAgentCommand("reviewer", "claude", legacy("claude"), baseDirectory, resolver)).toEqual({
      executable,
      prefixArgs: []
    });
  });

  it("resolves POSIX Claude from ~/.local/bin when PATH has no claude", () => {
    const executable = "/Users/groupx/.local/bin/claude";
    const npmEntrypoint = "/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js";
    const resolver: CommandResolverDependencies = {
      platform: "darwin",
      env: { HOME: "/Users/groupx", PATH: "/usr/bin" },
      execPath: "/usr/local/bin/node",
      isFile: (candidate) => candidate === executable || candidate === "/usr/local/bin/node" || candidate === npmEntrypoint
    };

    expect(resolveAgentCommand("claude", "claude", legacy("claude"), "/Users/groupx/work", resolver)).toEqual({
      executable,
      prefixArgs: []
    });
  });

  it("falls back to the current Node prefix npm entrypoint on macOS", () => {
    const nodeExecutable = "/Users/groupx/.nvm/versions/node/v24.14.1/bin/node";
    const npmEntrypoint =
      "/Users/groupx/.nvm/versions/node/v24.14.1/lib/node_modules/@anthropic-ai/claude-code/cli.js";
    const resolver: CommandResolverDependencies = {
      platform: "darwin",
      env: { HOME: "/Users/groupx", PATH: "/usr/bin" },
      execPath: nodeExecutable,
      isFile: (candidate) => candidate === nodeExecutable || candidate === npmEntrypoint
    };

    expect(resolveAgentCommand("claude", "claude", legacy("claude"), "/Users/groupx/work", resolver)).toEqual({
      executable: nodeExecutable,
      prefixArgs: [npmEntrypoint]
    });
  });

  it("falls back to Homebrew's global Claude package when this Node prefix has none", () => {
    const nodeExecutable = "/usr/local/bin/node";
    const homebrewEntrypoint = "/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/cli.js";
    const resolver: CommandResolverDependencies = {
      platform: "darwin",
      env: { HOME: "/Users/groupx", PATH: "/usr/bin" },
      execPath: nodeExecutable,
      isFile: (candidate) => candidate === nodeExecutable || candidate === homebrewEntrypoint
    };

    expect(resolveAgentCommand("claude", "claude", legacy("claude"), "/Users/groupx/work", resolver)).toEqual({
      executable: nodeExecutable,
      prefixArgs: [homebrewEntrypoint]
    });
  });

  it("fails closed on POSIX when no Claude native binary or npm entrypoint exists", () => {
    const nodeExecutable = "/usr/local/bin/node";
    const resolver: CommandResolverDependencies = {
      platform: "darwin",
      env: { HOME: "/Users/groupx", PATH: "/usr/bin" },
      execPath: nodeExecutable,
      isFile: (candidate) => candidate === nodeExecutable
    };

    expect(() =>
      resolveAgentCommand("claude", "claude", legacy("claude"), "/Users/groupx/work", resolver)
    ).toThrowError(
      expect.objectContaining({
        code: "INVALID_ENVELOPE",
        details: { agentId: "claude", reason: "npm_entrypoint_not_found" }
      })
    );
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
