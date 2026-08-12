import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";

const PACKAGE_NAME = "@susyimes/groupx";
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const MAX_NPM_OUTPUT_BYTES = 64 * 1024;
const NPM_VIEW_TIMEOUT_MS = 30_000;

export interface NpmInvocation {
  readonly command: string;
  readonly prefixArgs: readonly string[];
}

export interface NpmResolverOptions {
  readonly platform: NodeJS.Platform;
  readonly execPath: string;
  readonly env: NodeJS.ProcessEnv;
  canExecute(candidate: string): Promise<boolean>;
}

export interface GroupXUpdateDependencies {
  readonly latestVersion: () => Promise<string>;
  readonly installVersion: (version: string) => Promise<void>;
  readonly stdout: (line: string) => void;
}

export interface GroupXUpdateOptions {
  readonly currentVersion: string;
  readonly checkOnly?: boolean;
}

function parseStableVersion(version: string): readonly [number, number, number] {
  const match = VERSION_PATTERN.exec(version.trim());
  if (!match) throw new Error(`无法解析 GroupX 版本: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareStableVersions(left: string, right: string): number {
  const a = parseStableVersion(left);
  const b = parseStableVersion(right);
  for (let index = 0; index < a.length; index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

async function firstExecutable(
  candidates: readonly string[],
  canExecute: (candidate: string) => Promise<boolean>,
  platform: NodeJS.Platform,
  pathApi: typeof path.win32 | typeof path.posix
): Promise<string | undefined> {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const resolved = pathApi.resolve(candidate);
    const key = platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    if (await canExecute(resolved)) return resolved;
  }
  return undefined;
}

/** Locate npm without passing a .cmd/.bat shim through a shell on Windows. */
export async function resolveNpmInvocation(options: NpmResolverOptions): Promise<NpmInvocation> {
  const pathApi = options.platform === "win32" ? path.win32 : path.posix;
  const executableDirectory = pathApi.dirname(options.execPath);
  const npmExecPath = options.env.npm_execpath;
  const javascriptCandidates = [
    ...(npmExecPath?.match(/\.(?:c?js|mjs)$/iu) ? [npmExecPath] : []),
    pathApi.join(executableDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    pathApi.join(executableDirectory, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    pathApi.join(executableDirectory, "..", "share", "nodejs", "npm", "bin", "npm-cli.js")
  ];
  const npmCli = await firstExecutable(javascriptCandidates, options.canExecute, options.platform, pathApi);
  if (npmCli !== undefined) return { command: options.execPath, prefixArgs: [npmCli] };

  if (options.platform !== "win32") {
    const pathEntries = (options.env.PATH ?? "").split(":").filter(Boolean);
    const npmExecutable = await firstExecutable(
      pathEntries.map((entry) => pathApi.join(entry, "npm")),
      options.canExecute,
      options.platform,
      pathApi
    );
    if (npmExecutable !== undefined) return { command: npmExecutable, prefixArgs: [] };
  }

  throw new Error("找不到可安全调用的 npm；请确认 npm 与当前 Node.js 安装在同一环境中。");
}

async function runNpmCaptured(invocation: NpmInvocation, args: readonly string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.prefixArgs, ...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("npm Registry 更新检查超时。"));
    }, NPM_VIEW_TIMEOUT_MS);
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(stdout);
    };
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > MAX_NPM_OUTPUT_BYTES) {
        child.kill();
        finish(new Error("npm 返回内容超过 GroupX 更新检查上限。"));
      }
      return next;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(`npm 更新检查失败(exit ${String(code)}): ${stderr.trim() || "无诊断"}`));
    });
  });
}

async function runNpmInherited(invocation: NpmInvocation, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.prefixArgs, ...args], {
      shell: false,
      windowsHide: true,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm 全局更新失败(exit ${String(code)})。请根据上方 npm 诊断修复后重试。`));
    });
  });
}

async function systemCanExecute(candidate: string): Promise<boolean> {
  try {
    await access(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function systemGroupXUpdateDependencies(): Promise<GroupXUpdateDependencies> {
  const invocation = await resolveNpmInvocation({
    platform: process.platform,
    execPath: process.execPath,
    env: process.env,
    canExecute: systemCanExecute
  });
  return {
    latestVersion: async () => {
      const output = await runNpmCaptured(invocation, ["view", PACKAGE_NAME, "version", "--json"]);
      const parsed: unknown = JSON.parse(output);
      if (typeof parsed !== "string") throw new Error("npm Registry 返回了无效的 GroupX 版本。");
      parseStableVersion(parsed);
      return parsed;
    },
    installVersion: (version) =>
      runNpmInherited(invocation, [
        "install",
        "--global",
        `${PACKAGE_NAME}@${version}`,
        "--no-audit",
        "--no-fund"
      ]),
    stdout: (line) => process.stdout.write(`${line}\n`)
  };
}

export async function runGroupXUpdate(
  options: GroupXUpdateOptions,
  dependencies?: GroupXUpdateDependencies
): Promise<"current" | "newer" | "available" | "updated"> {
  const resolvedDependencies = dependencies ?? await systemGroupXUpdateDependencies();
  const currentVersion = options.currentVersion.trim();
  parseStableVersion(currentVersion);
  const latestVersion = (await resolvedDependencies.latestVersion()).trim();
  parseStableVersion(latestVersion);
  const comparison = compareStableVersions(currentVersion, latestVersion);

  resolvedDependencies.stdout(`当前版本: ${currentVersion}`);
  resolvedDependencies.stdout(`最新版本: ${latestVersion}`);
  if (comparison === 0) {
    resolvedDependencies.stdout("GroupX 已是最新版本。");
    return "current";
  }
  if (comparison > 0) {
    resolvedDependencies.stdout("当前版本高于 npm latest，不执行降级。");
    return "newer";
  }
  if (options.checkOnly === true) {
    resolvedDependencies.stdout(`有可用更新: ${currentVersion} -> ${latestVersion}`);
    return "available";
  }

  resolvedDependencies.stdout(`正在更新 GroupX ${currentVersion} -> ${latestVersion}...`);
  await resolvedDependencies.installVersion(latestVersion);
  resolvedDependencies.stdout(`GroupX 已更新到 ${latestVersion}。请重新运行 groupx start。`);
  return "updated";
}
