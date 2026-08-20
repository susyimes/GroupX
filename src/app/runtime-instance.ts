import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import { parseConfigDocument } from "../config.js";
import { parseRuntimeShutdownAccepted } from "../contracts/index.js";
import { GroupXError } from "../core/errors.js";
import {
  createGroupXRuntimeIdentity,
  GROUPX_RUNTIME_SERVICE,
  parseGroupXRuntimeIdentity,
  type GroupXRuntimeIdentity
} from "../core/runtime-instance.js";

const DEFAULT_PROBE_TIMEOUT_MS = 500;
const MAX_HEALTH_BODY_CHARACTERS = 65_536;

export interface GroupXRuntimeLaunchDescriptor {
  readonly configPath: string;
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly origin: string;
  readonly closeTimeoutMs: number;
  readonly identity: GroupXRuntimeIdentity;
}

export type GroupXRuntimeProbe =
  | { readonly kind: "same"; readonly identity: GroupXRuntimeIdentity }
  | { readonly kind: "different-config"; readonly identity: GroupXRuntimeIdentity }
  | { readonly kind: "legacy-groupx" }
  | { readonly kind: "incompatible-groupx" }
  | { readonly kind: "occupied" }
  | { readonly kind: "unreachable" };

export interface GroupXRuntimeProbeOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export interface GroupXRuntimeShutdownOptions extends GroupXRuntimeProbeOptions {}

function normalizedConfigPath(configPath: string): string {
  const normalized = path.normalize(configPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export async function describeGroupXRuntimeLaunch(
  configPath: string
): Promise<GroupXRuntimeLaunchDescriptor> {
  const absolutePath = path.resolve(configPath);
  let document: unknown;
  try {
    document = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (error) {
    throw new GroupXError(
      "INVALID_ENVELOPE",
      `Unable to read GroupX config: ${absolutePath}`,
      undefined,
      { cause: error }
    );
  }
  const config = parseConfigDocument(document);
  const canonicalPath = await realpath(absolutePath).catch(() => absolutePath);
  const normalizedPath = normalizedConfigPath(canonicalPath);
  const identity = createGroupXRuntimeIdentity(
    { configPath: normalizedPath, config },
    { configPath: normalizedPath }
  );
  return {
    configPath: absolutePath,
    host: "127.0.0.1",
    port: config.server.port,
    origin: `http://127.0.0.1:${config.server.port}`,
    closeTimeoutMs: config.timeouts.closeMs,
    identity
  };
}

function looksLikeLegacyGroupXHealth(input: unknown): boolean {
  if (input === null || typeof input !== "object") return false;
  const candidate = input as Record<string, unknown>;
  return (
    typeof candidate.status === "string" &&
    candidate.access === "unrestricted" &&
    typeof candidate.transport === "string" &&
    candidate.store !== null &&
    typeof candidate.store === "object" &&
    Array.isArray(candidate.agents)
  );
}

export async function probeGroupXRuntime(
  descriptor: GroupXRuntimeLaunchDescriptor,
  options: GroupXRuntimeProbeOptions = {}
): Promise<GroupXRuntimeProbe> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(`${descriptor.origin}/api/health`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal
    });
    const text = await response.text();
    if (text.length > MAX_HEALTH_BODY_CHARACTERS) return { kind: "occupied" };
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { kind: "occupied" };
    }

    const identity = parseGroupXRuntimeIdentity(body);
    if (identity !== undefined) {
      return identity.runtimeKey === descriptor.identity.runtimeKey
        ? { kind: "same", identity }
        : { kind: "different-config", identity };
    }
    if (body !== null && typeof body === "object") {
      const candidate = body as Record<string, unknown>;
      if (candidate.service === GROUPX_RUNTIME_SERVICE) {
        return { kind: "incompatible-groupx" };
      }
    }
    return looksLikeLegacyGroupXHealth(body)
      ? { kind: "legacy-groupx" }
      : { kind: "occupied" };
  } catch {
    return { kind: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

/** Ask one already-identified local runtime to begin a graceful shutdown. */
export async function requestGroupXRuntimeShutdown(
  descriptor: GroupXRuntimeLaunchDescriptor,
  runningIdentity: GroupXRuntimeIdentity,
  options: GroupXRuntimeShutdownOptions = {}
): Promise<void> {
  const runtimeScopeKey =
    runningIdentity.runtimeScopeKey ??
    (runningIdentity.runtimeKey === descriptor.identity.runtimeKey
      ? descriptor.identity.runtimeScopeKey
      : undefined);
  if (
    runtimeScopeKey === undefined ||
    runtimeScopeKey !== descriptor.identity.runtimeScopeKey
  ) {
    throw new Error("无法确认运行中的 GroupX 使用同一配置路径，未执行重启。");
  }

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS * 10;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(`${descriptor.origin}/api/runtime/shutdown`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json"
      },
      body: JSON.stringify({ runtimeScopeKey }),
      signal: controller.signal
    });
    const text = await response.text();
    if (text.length > MAX_HEALTH_BODY_CHARACTERS) {
      throw new Error("GroupX 重启控制响应过大。");
    }
    if (response.status === 404) {
      throw new Error(
        "正在运行的 GroupX 版本不支持 `groupx stop` / `groupx restart`，请先手动停止一次。"
      );
    }
    if (response.status !== 202) {
      throw new Error(`GroupX 拒绝了重启请求 (HTTP ${response.status})。`);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (error) {
      throw new Error("GroupX 重启控制响应不是有效 JSON。", { cause: error });
    }
    const accepted = parseRuntimeShutdownAccepted(body);
    if (
      accepted.runtimeKey !== runningIdentity.runtimeKey ||
      accepted.runtimeScopeKey !== runtimeScopeKey
    ) {
      throw new Error("GroupX 重启控制响应来自另一个 runtime，未继续启动。");
    }
  } finally {
    clearTimeout(timer);
  }
}

export function isAddressInUseError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current === null || typeof current !== "object") return false;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (candidate.code === "EADDRINUSE") return true;
    current = candidate.cause;
  }
  return false;
}
