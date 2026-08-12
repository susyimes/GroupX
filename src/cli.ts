#!/usr/bin/env node
import { readFile } from "node:fs/promises";

import { runDoctor } from "./app/doctor.js";
import { runInit } from "./app/init-config.js";
import { main } from "./main.js";
import { openBrowser } from "./utils/open-browser.js";

const HELP = `GroupX — 本机多 CLI 群聊

用法:
  groupx [start] [--config <path>] [--no-open]   启动 Broker 与 Web UI(默认命令)
  groupx doctor [--config <path>]                检测系统、Node 与 codex/grok/kimi CLI
  groupx init [--config <path>] [--force]        按检测结果生成 groupx.json
  groupx --version                               打印版本
  groupx --help                                  打印帮助
`;

function stdout(line: string): void {
  process.stdout.write(`${line}\n`);
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
      const runtime = await main(forwarded);
      const origin = runtime.address?.origin;
      if (origin !== undefined && !noOpen) {
        const url = `${origin}/`;
        stdout(openBrowser(url) ? `已在浏览器打开 ${url}` : `请手动打开 ${url}`);
      }
      return 0;
    }
    case "doctor": {
      const configFlagIndex = rest.indexOf("--config");
      const configPath = configFlagIndex >= 0 ? rest[configFlagIndex + 1] : undefined;
      return runDoctor({ cwd: process.cwd(), ...(configPath === undefined ? {} : { configPath }) });
    }
    case "init": {
      const configFlagIndex = rest.indexOf("--config");
      const configPath = configFlagIndex >= 0 ? rest[configFlagIndex + 1] : undefined;
      return runInit({
        cwd: process.cwd(),
        force: rest.includes("--force"),
        ...(configPath === undefined ? {} : { configPath })
      });
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
