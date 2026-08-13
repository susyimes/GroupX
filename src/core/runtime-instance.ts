import { createHash } from "node:crypto";

export const GROUPX_RUNTIME_SERVICE = "groupx" as const;
export const GROUPX_RUNTIME_PROTOCOL = "groupx.runtime/1" as const;

export interface GroupXRuntimeIdentity {
  readonly service: typeof GROUPX_RUNTIME_SERVICE;
  readonly protocol: typeof GROUPX_RUNTIME_PROTOCOL;
  readonly runtimeKey: string;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)])
  );
}

/** Create a non-secret, deterministic identity for one concrete runtime configuration. */
export function createGroupXRuntimeIdentity(material: unknown): GroupXRuntimeIdentity {
  const canonical = JSON.stringify(canonicalize(material));
  const runtimeKey = createHash("sha256").update(canonical, "utf8").digest("hex");
  return {
    service: GROUPX_RUNTIME_SERVICE,
    protocol: GROUPX_RUNTIME_PROTOCOL,
    runtimeKey
  };
}

export function parseGroupXRuntimeIdentity(input: unknown): GroupXRuntimeIdentity | undefined {
  if (input === null || typeof input !== "object") return undefined;
  const candidate = input as Record<string, unknown>;
  if (
    candidate.service !== GROUPX_RUNTIME_SERVICE ||
    candidate.protocol !== GROUPX_RUNTIME_PROTOCOL ||
    typeof candidate.runtimeKey !== "string" ||
    !/^[a-f0-9]{64}$/u.test(candidate.runtimeKey)
  ) {
    return undefined;
  }
  return {
    service: GROUPX_RUNTIME_SERVICE,
    protocol: GROUPX_RUNTIME_PROTOCOL,
    runtimeKey: candidate.runtimeKey
  };
}
