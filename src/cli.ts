#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";
import path from "node:path";

import { runDoctor } from "./app/doctor.js";
import { GroupXConfigSetupService } from "./app/init-config.js";
import { runGroupXUpdate } from "./app/update.js";
import { parseConfigPath } from "./config.js";
import { openBrowser } from "./utils/open-browser.js";
import { createGroupXSetupHttpServer } from "./web/setup/index.js";

const HELP = `GroupX — 本机多 CLI 群聊

用法:
  groupx [start] [--config <path>] [--no-open]   启动 Broker 与 Web UI(默认命令)
  groupx doctor [--config <path>]                检测系统、Node 与 codex/grok/kimi CLI
  groupx init [--config <path>] [--no-open]      配置 Agent，随后启动并进入群聊
  groupx update [--check]                       检查并安装 npm latest 版本
  groupx --version                               打印版本
  groupx --help                                  打印帮助
`;

function stdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

function fileExists(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

async function runSetupWizard(
  configPath: string,
  noOpen: boolean
): Promise<import("./app/runtime.js").GroupXRuntime> {
  const service = new GroupXConfigSetupService({ configPath, runtimeActive: false });
  const server = createGroupXSetupHttpServer({ setupApi: service });
  const address = await server.start();
  try {
    const url = `${address.origin}/`;
    stdout(`GroupX Agent 配置引导页: ${url}`);
    if (!noOpen) {
      stdout((await openBrowser(url)) ? "已在浏览器打开配置引导页" : `请手动打开 ${url}`);
    }
    const result = await server.completed;
    stdout(`已保存 ${result.agentCount} 个 Agent: ${result.configPath}`);
    const { main } = await import("./main.js");
    try {
      const runtime = await main(["--config", configPath]);
      const origin = runtime.address?.origin;
      if (origin === undefined) throw new Error("GroupX runtime did not expose a loopback address");
      server.markLaunchReady(origin);
      stdout(`GroupX 已就绪，引导页将自动进入 ${origin}/`);
      if (noOpen) stdout(`请手动打开 ${origin}/`);
      await Promise.race([
        server.launchObserved,
        new Promise<void>((resolve) => setTimeout(resolve, 5_000))
      ]);
      return runtime;
    } catch (error) {
      server.markLaunchFailed();
      await Promise.race([
        server.launchObserved,
        new Promise<void>((resolve) => setTimeout(resolve, 2_000))
      ]);
      throw error;
    }
  } finally {
    await server.close();
  }
}

async function packageVersion(): Promise<string> {
  try {
    const raw = await readFile(new URL("../../package.json", import.meta.url), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && "version" in parsed
      ? String(parsed.version)
      : "unknown";
  } catch {
    return "unknown";
  }
}

async function run(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
    case "start": {
      const noOpen = rest.includes("--no-open");
      const forwarded = rest.filter((value) => value !== "--no-open");
      const configPath = path.resolve(process.cwd(), parseConfigPath(forwarded) ?? "groupx.json");
      if (!fileExists(configPath)) {
        stdout(`未找到配置 ${configPath}，先打开 Agent 引导页。`);
        await runSetupWizard(configPath, noOpen);
      } else {
        const { main } = await import("./main.js");
        const runtime = await main(["--config", configPath]);
        const origin = runtime.address?.origin;
        if (origin !== undefined && !noOpen) {
          const url = `${origin}/`;
          stdout((await openBrowser(url)) ? `已在浏览器打开 ${url}` : `请手动打开 ${url}`);
        }
      }
      return 0;
    }
    case "doctor": {
      const configPath = parseConfigPath(rest);
      return runDoctor({ cwd: process.cwd(), ...(configPath === undefined ? {} : { configPath }) });
    }
    case "init": {
      const configPath = parseConfigPath(rest);
      await runSetupWizard(
        path.resolve(process.cwd(), configPath ?? "groupx.json"),
        rest.includes("--no-open")
      );
      return 0;
    }
    case "update": {
      const unknown = rest.filter((value) => value !== "--check");
      if (unknown.length > 0) {
        throw new Error(`groupx update 不支持参数: ${unknown.join(" ")}`);
      }
      await runGroupXUpdate({
        currentVersion: await packageVersion(),
        checkOnly: rest.includes("--check")
      });
      return 0;
    }
    case "--version":
    case "-v":
    case "version":
      stdout(await packageVersion());
      return 0;
    case "--help":
    case "-h":
    case "help":
      stdout(HELP);
      return 0;
    default:
      process.stderr.write(`未知命令: ${command}\n\n${HELP}`);
      return 1;
  }
}

void run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
