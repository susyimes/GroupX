import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { parse } from "smol-toml";

import { GroupXError } from "../core/errors.js";

export type KimiUnrestrictedPermissionMode = "yolo" | "auto";

export interface KimiUnrestrictedConfigSnapshot {
  permissionMode: KimiUnrestrictedPermissionMode;
  planMode: false;
  source: "KIMI_CODE_HOME" | "default-home";
}

export type KimiUnrestrictedConfigPreflight =
  () => Promise<KimiUnrestrictedConfigSnapshot>;

export interface KimiConfigPreflightOptions {
  env?: Readonly<Record<string, string | undefined>>;
  homeDirectory?: string;
  readText?: (configPath: string) => Promise<string>;
}

/**
 * Read only the two native Kimi defaults that affect GroupX's fixed
 * unrestricted startup contract. The rest of config.toml is neither returned
 * nor logged.
 */
export async function preflightKimiUnrestrictedConfig(
  options: KimiConfigPreflightOptions = {}
): Promise<KimiUnrestrictedConfigSnapshot> {
  const env = options.env ?? process.env;
  const configuredHome = env.KIMI_CODE_HOME?.trim();
  const source = configuredHome ? "KIMI_CODE_HOME" : "default-home";
  const kimiHome = configuredHome
    ? path.resolve(configuredHome)
    : path.join(options.homeDirectory ?? homedir(), ".kimi-code");
  const configPath = path.join(kimiHome, "config.toml");

  let text: string;
  try {
    text = await (options.readText ?? readUtf8)(configPath);
  } catch (error) {
    throw new GroupXError(
      "ADAPTER_START_FAILED",
      "Kimi unrestricted preflight could not read config.toml",
      undefined,
      error instanceof Error ? { cause: error } : undefined
    );
  }

  let config: Record<string, unknown>;
  try {
    config = parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new GroupXError(
      "ADAPTER_START_FAILED",
      "Kimi unrestricted preflight found an invalid config.toml",
      undefined,
      error instanceof Error ? { cause: error } : undefined
    );
  }

  const permissionMode = config.default_permission_mode ?? "manual";
  const planMode = config.default_plan_mode ?? false;
  if (permissionMode !== "yolo" && permissionMode !== "auto") {
    throw new GroupXError(
      "ADAPTER_START_FAILED",
      "Kimi unrestricted preflight requires default_permission_mode to be yolo or auto"
    );
  }
  if (planMode !== false) {
    throw new GroupXError(
      "ADAPTER_START_FAILED",
      "Kimi unrestricted preflight requires default_plan_mode to be false"
    );
  }

  return { permissionMode, planMode: false, source };
}

async function readUtf8(configPath: string): Promise<string> {
  return await readFile(configPath, "utf8");
}
