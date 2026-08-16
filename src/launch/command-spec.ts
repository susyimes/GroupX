import { statSync } from "node:fs";
import path from "node:path";
import { GroupXError } from "../core/errors.js";

export const BUILTIN_AGENT_IDS = ["codex", "grok", "kimi", "hermes", "claude"] as const;

export type BuiltinAgentId = (typeof BUILTIN_AGENT_IDS)[number];

/**
 * A shell-free process command. `prefixArgs` is reserved for a JavaScript CLI
 * entrypoint that must appear before adapter-owned native arguments.
 */
export interface CommandSpec {
  executable: string;
  prefixArgs: string[];
}

/** Native CLI families GroupX knows how to drive. */
export type AgentDriver = BuiltinAgentId;

export interface CommandResolverDependencies {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  execPath: string;
  isFile(candidate: string): boolean;
}

export const systemCommandResolverDependencies: CommandResolverDependencies = {
  platform: process.platform,
  env: process.env,
  execPath: process.execPath,
  isFile(candidate) {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  }
};

const WINDOWS_SHELL_EXTENSIONS = new Set([".bat", ".cmd", ".ps1"]);
const JAVASCRIPT_EXTENSIONS = new Set([".cjs", ".js", ".mjs"]);

/**
 * Resolve config input into an argv head that Node can spawn with
 * `shell: false`. No model, permission, sandbox, or other native policy
 * arguments are accepted or added here.
 *
 * `agentId` is the room-local agent key (used in errors); `driver` selects
 * which native CLI family supplies the default command resolution.
 */
export function resolveAgentCommand(
  agentId: string,
  driver: AgentDriver,
  input: Readonly<CommandSpec>,
  baseDirectory: string,
  dependencies: CommandResolverDependencies = systemCommandResolverDependencies
): CommandSpec {
  const pathApi = dependencies.platform === "win32" ? path.win32 : path.posix;
  const executableInput = requireNonEmpty(input.executable, agentId, "empty_executable");
  const prefixArgs = [...input.prefixArgs];

  if (prefixArgs.some((argument) => argument.length === 0)) {
    throw resolutionError(agentId, "empty_prefix_arg");
  }

  if (prefixArgs.length === 0 && executableInput === driver) {
    return resolveDefaultAgentCommand(driver, dependencies, pathApi);
  }

  const executable = resolveExecutable(agentId, executableInput, baseDirectory, dependencies, pathApi);
  const executableIsNode = isNodeExecutable(executable, pathApi);

  if (prefixArgs.length === 0) {
    if (executableIsNode) {
      throw resolutionError(agentId, "node_entrypoint_required");
    }
    return { executable, prefixArgs: [] };
  }

  if (!executableIsNode) {
    throw resolutionError(agentId, "prefix_args_require_node");
  }
  if (prefixArgs.length !== 1) {
    throw resolutionError(agentId, "single_entrypoint_required");
  }

  const entrypointInput = prefixArgs[0];
  if (entrypointInput === undefined || entrypointInput.startsWith("-")) {
    throw resolutionError(agentId, "native_flags_forbidden_in_prefix_args");
  }
  const entrypoint = resolveFilePath(entrypointInput, baseDirectory, dependencies, pathApi);
  if (!JAVASCRIPT_EXTENSIONS.has(pathApi.extname(entrypoint).toLowerCase())) {
    throw resolutionError(agentId, "javascript_entrypoint_required");
  }
  if (!safeIsFile(dependencies, entrypoint)) {
    throw resolutionError(agentId, "entrypoint_not_found");
  }

  return { executable, prefixArgs: [entrypoint] };
}

function resolveDefaultAgentCommand(
  agentId: BuiltinAgentId,
  dependencies: CommandResolverDependencies,
  pathApi: typeof path.win32 | typeof path.posix
): CommandSpec {
  if (dependencies.platform !== "win32") {
    const executable = findOnPath(agentId, dependencies, pathApi);
    if (executable !== undefined) {
      return { executable, prefixArgs: [] };
    }
    if (agentId === "claude") {
      return resolvePosixClaudeCommand(agentId, dependencies, pathApi);
    }
    throw resolutionError(agentId, "executable_not_found");
  }

  if (agentId === "hermes") {
    const onPath = findOnPath(agentId, dependencies, pathApi);
    if (onPath !== undefined) {
      return { executable: onPath, prefixArgs: [] };
    }
    const localAppData = readEnvironmentValue(dependencies.env, "LOCALAPPDATA");
    if (localAppData === undefined) {
      throw resolutionError(agentId, "localappdata_not_available");
    }
    const executable = pathApi.resolve(
      localAppData,
      "hermes",
      "hermes-agent",
      "venv",
      "Scripts",
      "hermes.exe"
    );
    if (!safeIsFile(dependencies, executable)) {
      throw resolutionError(agentId, "native_executable_not_found");
    }
    return { executable, prefixArgs: [] };
  }

  if (agentId === "grok") {
    const home = readEnvironmentValue(dependencies.env, "USERPROFILE") ?? readEnvironmentValue(dependencies.env, "HOME");
    if (home === undefined) {
      throw resolutionError(agentId, "home_not_available");
    }
    const executable = pathApi.resolve(home, ".grok", "bin", "grok.exe");
    if (!safeIsFile(dependencies, executable)) {
      throw resolutionError(agentId, "native_executable_not_found");
    }
    return { executable, prefixArgs: [] };
  }

  if (agentId === "claude") {
    return resolveWindowsClaudeCommand(agentId, dependencies, pathApi);
  }

  const appData = readEnvironmentValue(dependencies.env, "APPDATA");
  if (appData === undefined) {
    throw resolutionError(agentId, "appdata_not_available");
  }

  const entrypoint =
    agentId === "codex"
      ? pathApi.resolve(appData, "npm", "node_modules", "@openai", "codex", "bin", "codex.js")
      : pathApi.resolve(appData, "npm", "node_modules", "@moonshot-ai", "kimi-code", "dist", "main.mjs");
  return {
    executable: requireNodeRuntime(agentId, dependencies, pathApi),
    prefixArgs: [requireNpmEntrypoint(agentId, dependencies, entrypoint)]
  };
}

/**
 * Claude Code ships a native single-file build first and an npm package
 * second. Native lookup must not depend on APPDATA; that variable is only
 * required for the npm-global fallback.
 */
function resolveWindowsClaudeCommand(
  agentId: BuiltinAgentId,
  dependencies: CommandResolverDependencies,
  pathApi: typeof path.win32 | typeof path.posix
): CommandSpec {
  const onPath = findOnPath(agentId, dependencies, pathApi);
  if (onPath !== undefined) {
    return { executable: onPath, prefixArgs: [] };
  }
  const home = readEnvironmentValue(dependencies.env, "USERPROFILE") ?? readEnvironmentValue(dependencies.env, "HOME");
  if (home !== undefined) {
    const nativeExecutable = pathApi.resolve(home, ".local", "bin", "claude.exe");
    if (safeIsFile(dependencies, nativeExecutable)) {
      return { executable: nativeExecutable, prefixArgs: [] };
    }
  }
  const appData = readEnvironmentValue(dependencies.env, "APPDATA");
  if (appData === undefined) {
    throw resolutionError(agentId, "appdata_not_available");
  }
  return {
    executable: requireNodeRuntime(agentId, dependencies, pathApi),
    prefixArgs: [
      requireNpmEntrypoint(
        agentId,
        dependencies,
        pathApi.resolve(appData, "npm", "node_modules", "@anthropic-ai", "claude-code", "cli.js")
      )
    ]
  };
}

/**
 * POSIX Claude lookup mirrors Windows: native binary first, npm-global
 * `cli.js` second. The npm layer never shells out to `npm root -g`; it
 * walks this process's Node prefix, then Homebrew and /usr/local.
 */
function resolvePosixClaudeCommand(
  agentId: BuiltinAgentId,
  dependencies: CommandResolverDependencies,
  pathApi: typeof path.win32 | typeof path.posix
): CommandSpec {
  const home = readEnvironmentValue(dependencies.env, "HOME") ?? readEnvironmentValue(dependencies.env, "USERPROFILE");
  if (home !== undefined) {
    const nativeExecutable = pathApi.resolve(home, ".local", "bin", "claude");
    if (safeIsFile(dependencies, nativeExecutable)) {
      return { executable: nativeExecutable, prefixArgs: [] };
    }
  }

  const nodeExecutable = requireNodeRuntime(agentId, dependencies, pathApi);
  for (const prefix of posixNodeInstallPrefixes(nodeExecutable, pathApi)) {
    const entrypoint = claudeNpmEntrypoint(prefix, pathApi);
    if (safeIsFile(dependencies, entrypoint)) {
      return { executable: nodeExecutable, prefixArgs: [entrypoint] };
    }
  }
  throw resolutionError(agentId, "npm_entrypoint_not_found");
}

const CLAUDE_NPM_ENTRYPOINT = ["lib", "node_modules", "@anthropic-ai", "claude-code", "cli.js"] as const;
const POSIX_KNOWN_NODE_PREFIXES = ["/opt/homebrew", "/usr/local"] as const;

function claudeNpmEntrypoint(
  prefix: string,
  pathApi: typeof path.win32 | typeof path.posix
): string {
  return pathApi.resolve(prefix, ...CLAUDE_NPM_ENTRYPOINT);
}

function nodeInstallPrefix(
  nodeExecutable: string,
  pathApi: typeof path.win32 | typeof path.posix
): string | undefined {
  const binDirectory = pathApi.dirname(nodeExecutable);
  return pathApi.basename(binDirectory) === "bin" ? pathApi.dirname(binDirectory) : undefined;
}

function posixNodeInstallPrefixes(
  nodeExecutable: string,
  pathApi: typeof path.win32 | typeof path.posix
): string[] {
  const prefixes: string[] = [];
  const fromNode = nodeInstallPrefix(nodeExecutable, pathApi);
  if (fromNode !== undefined) {
    prefixes.push(fromNode);
  }
  for (const known of POSIX_KNOWN_NODE_PREFIXES) {
    const resolved = pathApi.resolve(known);
    if (!prefixes.includes(resolved)) {
      prefixes.push(resolved);
    }
  }
  return prefixes;
}

function requireNodeRuntime(
  agentId: BuiltinAgentId,
  dependencies: CommandResolverDependencies,
  pathApi: typeof path.win32 | typeof path.posix
): string {
  const nodeExecutable = normalizeAbsolutePath(dependencies.execPath, dependencies, pathApi);
  if (!isNodeExecutable(nodeExecutable, pathApi) || !safeIsFile(dependencies, nodeExecutable)) {
    throw resolutionError(agentId, "node_runtime_not_found");
  }
  return nodeExecutable;
}

function requireNpmEntrypoint(
  agentId: BuiltinAgentId,
  dependencies: CommandResolverDependencies,
  entrypoint: string
): string {
  if (!safeIsFile(dependencies, entrypoint)) {
    throw resolutionError(agentId, "npm_entrypoint_not_found");
  }
  return entrypoint;
}

function resolveExecutable(
  agentId: string,
  input: string,
  baseDirectory: string,
  dependencies: CommandResolverDependencies,
  pathApi: typeof path.win32 | typeof path.posix
): string {
  const extension = pathApi.extname(input).toLowerCase();
  if (dependencies.platform === "win32" && WINDOWS_SHELL_EXTENSIONS.has(extension)) {
    throw resolutionError(agentId, "shell_wrapper_forbidden");
  }

  if (pathApi.isAbsolute(input) || hasPathSeparator(input, pathApi)) {
    const candidate = resolveFilePath(input, baseDirectory, dependencies, pathApi);
    if (dependencies.platform === "win32" && WINDOWS_SHELL_EXTENSIONS.has(pathApi.extname(candidate).toLowerCase())) {
      throw resolutionError(agentId, "shell_wrapper_forbidden");
    }
    if (!safeIsFile(dependencies, candidate)) {
      throw resolutionError(agentId, "executable_not_found");
    }
    return candidate;
  }

  const executable = findOnPath(input, dependencies, pathApi);
  if (executable === undefined) {
    throw resolutionError(agentId, "executable_not_found");
  }
  return executable;
}

function findOnPath(
  command: string,
  dependencies: CommandResolverDependencies,
  pathApi: typeof path.win32 | typeof path.posix
): string | undefined {
  const pathValue = readEnvironmentValue(dependencies.env, "PATH");
  if (pathValue === undefined) {
    return undefined;
  }

  const commandExtension = pathApi.extname(command).toLowerCase();
  if (dependencies.platform === "win32" && WINDOWS_SHELL_EXTENSIONS.has(commandExtension)) {
    return undefined;
  }
  const names =
    dependencies.platform === "win32" && commandExtension.length === 0
      ? [`${command}.exe`, `${command}.com`, command]
      : [command];

  for (const directory of pathValue.split(pathApi.delimiter)) {
    if (directory.length === 0) {
      continue;
    }
    for (const name of names) {
      const candidate = pathApi.resolve(directory, name);
      if (WINDOWS_SHELL_EXTENSIONS.has(pathApi.extname(candidate).toLowerCase())) {
        continue;
      }
      if (safeIsFile(dependencies, candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function resolveFilePath(
  input: string,
  baseDirectory: string,
  dependencies: CommandResolverDependencies,
  pathApi: typeof path.win32 | typeof path.posix
): string {
  if (input === "~" || input.startsWith("~/") || input.startsWith("~\\")) {
    const home = readEnvironmentValue(dependencies.env, dependencies.platform === "win32" ? "USERPROFILE" : "HOME");
    if (home === undefined) {
      throw new GroupXError("INVALID_ENVELOPE", "Unable to resolve an Agent command", {
        reason: "home_not_available"
      });
    }
    const suffix = input.slice(1).replace(/^[/\\]+/u, "");
    return pathApi.resolve(home, suffix);
  }
  return pathApi.isAbsolute(input) ? pathApi.normalize(input) : pathApi.resolve(baseDirectory, input);
}

function normalizeAbsolutePath(
  input: string,
  dependencies: CommandResolverDependencies,
  pathApi: typeof path.win32 | typeof path.posix
): string {
  if (!pathApi.isAbsolute(input)) {
    throw new GroupXError("INVALID_ENVELOPE", "Unable to resolve an Agent command", {
      reason: "runtime_path_not_absolute",
      platform: dependencies.platform
    });
  }
  return pathApi.normalize(input);
}

function readEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string
): string | undefined {
  const direct = environment[name];
  if (direct !== undefined && direct.length > 0) {
    return direct;
  }
  const matchingKey = Object.keys(environment).find((key) => key.toLowerCase() === name.toLowerCase());
  const value = matchingKey === undefined ? undefined : environment[matchingKey];
  return value === undefined || value.length === 0 ? undefined : value;
}

function hasPathSeparator(input: string, pathApi: typeof path.win32 | typeof path.posix): boolean {
  return input.includes(pathApi.sep) || (pathApi === path.win32 && input.includes("/"));
}

function isNodeExecutable(input: string, pathApi: typeof path.win32 | typeof path.posix): boolean {
  const basename = pathApi.basename(input).toLowerCase();
  return basename === "node" || basename === "node.exe";
}

function safeIsFile(dependencies: CommandResolverDependencies, candidate: string): boolean {
  try {
    return dependencies.isFile(candidate);
  } catch {
    return false;
  }
}

function requireNonEmpty(input: string, agentId: string, reason: string): string {
  if (input.length === 0) {
    throw resolutionError(agentId, reason);
  }
  return input;
}

function resolutionError(agentId: string, reason: string): GroupXError {
  return new GroupXError("INVALID_ENVELOPE", `Unable to resolve the ${agentId} command without a shell`, {
    agentId,
    reason
  });
}
