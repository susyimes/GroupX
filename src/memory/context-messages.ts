import { isSupervisionWatchMessage } from "../core/supervision.js";
import type { StoredEventRecord } from "../storage/types.js";

/** Room history / compaction / dated-memory context. Watch briefs stay out. */
export function isRoomContextMessage(event: StoredEventRecord): boolean {
  if (event.eventType !== "message.created") return false;
  if (isSupervisionWatchMessage(event.body)) return false;
  if (event.eventType.startsWith("supervision.")) return false;
  return (
    event.body !== null &&
    typeof event.body === "object" &&
    typeof (event.body as { content?: unknown }).content === "string"
  );
}
