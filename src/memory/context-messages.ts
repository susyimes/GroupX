import { isSupervisionWatchMessage } from "../core/supervision.js";
import { GroupXError } from "../core/errors.js";
import type { StoredEventRecord } from "../storage/types.js";

/** Room history / compaction / dated-memory context. Watch briefs stay out. */
export function isRoomContextMessage(event: StoredEventRecord): boolean {
  if (event.eventType !== "message.created" && event.eventType !== "operator.dispatch") {
    return false;
  }
  if (isSupervisionWatchMessage(event.body)) return false;
  return (
    event.body !== null &&
    typeof event.body === "object" &&
    typeof (event.body as { content?: unknown }).content === "string"
  );
}

export function contentFromRoomContextMessage(event: StoredEventRecord): string {
  if (!isRoomContextMessage(event)) {
    throw new GroupXError(
      "INVALID_ENVELOPE",
      `Context message ${event.eventId} is not a current-task source event`
    );
  }
  return (event.body as { content: string }).content;
}

/** Current-task / reply-chain text. Watch briefs are valid here; they stay out of room history. */
export function contentFromTaskSourceEvent(event: StoredEventRecord): string {
  if (event.eventType !== "message.created" && event.eventType !== "operator.dispatch") {
    throw new GroupXError(
      "INVALID_ENVELOPE",
      `Context message ${event.eventId} is not a current-task source event`
    );
  }
  if (
    event.body === null ||
    typeof event.body !== "object" ||
    typeof (event.body as { content?: unknown }).content !== "string"
  ) {
    throw new GroupXError(
      "STORE_UNAVAILABLE",
      `Context message ${event.eventId} has no string content`
    );
  }
  return (event.body as { content: string }).content;
}
