type JsonRecord = Record<string, unknown>;

export interface ReasoningRecordPresentation {
  readonly turnId: string;
  readonly content: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the bounded public shape of a durable, aggregated reasoning record. */
export function parseReasoningRecord(value: unknown): ReasoningRecordPresentation | null {
  if (!isRecord(value)) return null;
  const turnId = typeof value.turnId === "string" ? value.turnId.trim() : "";
  const content = typeof value.content === "string" ? value.content : "";
  if (turnId === "" || content.trim() === "") return null;
  return { turnId, content };
}
