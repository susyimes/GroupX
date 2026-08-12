type JsonRecord = Record<string, unknown>;

export type ToolProgressTone = "running" | "success" | "danger";

export interface ToolProgressPresentation {
  readonly keyPart: string;
  readonly label: string;
  readonly status: string;
  readonly tone: ToolProgressTone;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(record: JsonRecord, ...keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return "";
}

function compact(value: string, maxLength = 120): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  return oneLine.length <= maxLength ? oneLine : `${oneLine.slice(0, maxLength - 1)}…`;
}

/**
 * Preserve useful start metadata (for example a tool name) when a later
 * completion update contains only status/result fields.
 */
export function mergeToolProgressSnapshot(previous: unknown, current: unknown): JsonRecord {
  const before = isRecord(previous) ? previous : {};
  const next = isRecord(current) ? current : {};
  const merged: JsonRecord = { ...before, ...next };
  const beforeDetails = isRecord(before.details) ? before.details : {};
  const nextDetails = isRecord(next.details) ? next.details : {};
  if (Object.keys(beforeDetails).length > 0 || Object.keys(nextDetails).length > 0) {
    merged.details = { ...beforeDetails, ...nextDetails };
  }
  return merged;
}

export function describeToolProgress(value: unknown): ToolProgressPresentation {
  const body = isRecord(value) ? value : {};
  const details = isRecord(body.details) ? body.details : {};
  const server = firstString(details, "server");
  const tool = firstString(details, "tool", "name");
  const rawFallbackLabel = firstString(details, "title", "itemType", "kind", "type");
  const fallbackLabel = rawFallbackLabel === "mcpToolCall" ? "工具调用" : rawFallbackLabel || "工具调用";
  const label = compact(server && tool ? `${server}.${tool}` : tool || fallbackLabel);
  const identity =
    firstString(body, "toolCallId", "nativeEventId", "itemId", "id") ||
    firstString(details, "toolCallId", "itemId", "id") ||
    `label:${label}`;
  const nativeType = firstString(body, "nativeType").toLowerCase();
  const nativeStatus = (firstString(details, "status") || firstString(body, "status")).toLowerCase();

  if (nativeStatus === "failed" || nativeStatus === "error") {
    return { keyPart: identity, label, status: "失败", tone: "danger" };
  }
  if (nativeStatus === "cancelled" || nativeStatus === "canceled") {
    return { keyPart: identity, label, status: "已取消", tone: "danger" };
  }
  if (
    nativeType === "tool.completed" ||
    nativeStatus === "completed" ||
    nativeStatus === "succeeded" ||
    nativeStatus === "success"
  ) {
    return { keyPart: identity, label, status: "已完成", tone: "success" };
  }
  return { keyPart: identity, label, status: "运行中", tone: "running" };
}
