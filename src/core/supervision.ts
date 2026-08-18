import { GroupXError } from "./errors.js";

export const SUPERVISION_WATCH_KIND = "supervision.watch" as const;
export const SUPERVISION_MODE_LIVE_STEER = "live_steer" as const;
export const MAX_SUPERVISION_OBSERVERS = 4;
export const DEFAULT_STEERS_PER_SUBJECT_TURN = 3;
export const SUPERVISION_EXCERPT_CHARS = 500;
export const SUPERVISION_CONTENT_FLUSH_CHARS = 4_096;
export const SUPERVISION_SNAPSHOT_MESSAGE_LIMIT = 8;

export const SUPERVISION_WATCH_PROTOCOL_NOTE =
  "You are a live GroupX observer, not a second executor. Replies stay room-visible. " +
  "Use groupx.watch for the next bounded milestone. Use groupx.steer to nudge or " +
  "interrupt the whole watched Turn; you cannot approve or deny a single native tool. " +
  "Do not claim authorization. Do not ask the worker you are watching.";

export type SupervisionMode = typeof SUPERVISION_MODE_LIVE_STEER;
export type SupervisionTurnRole = "worker" | "observer";
export type SupervisionSteerAction = "nudge" | "interrupt";
export type SupervisionMilestoneKind =
  | "turn.started"
  | "tool.started"
  | "tool.completed"
  | "content.flushed"
  | "turn.terminal";

export interface SupervisionPairSpec {
  observers: readonly string[];
  mode: SupervisionMode;
}

export interface SupervisionWatchWorker {
  actorId: string;
  turnId: string;
}

export interface SupervisionSnapshotTool {
  name: string;
  status: "started" | "completed";
  toolCallId?: string;
}

export interface SupervisionSnapshotMessage {
  eventId: string;
  excerpt: string;
}

export interface SupervisionSnapshot {
  turnId: string;
  status: string;
  deliveryCertainty?: string;
  lastSeq: number;
  watchCursor: number;
  terminal: boolean;
  subjectCancelled: boolean;
  task: { eventId: string; excerpt: string };
  messages: SupervisionSnapshotMessage[];
  tools: SupervisionSnapshotTool[];
  steerCount: number;
  lastSteerReason?: string;
}

export interface SupervisionMilestone {
  kind: SupervisionMilestoneKind;
  turnId: string;
  watchCursor: number;
  seq: number | null;
  status?: string;
  tool?: SupervisionSnapshotTool;
  excerpt?: string;
}

export function isSupervisionWatchMessage(body: unknown): boolean {
  return (
    body !== null &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    (body as { kind?: unknown }).kind === SUPERVISION_WATCH_KIND
  );
}

export function excerptText(value: string, maxChars = SUPERVISION_EXCERPT_CHARS): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}…`;
}

export function toolNameFromDetails(details: unknown): string {
  if (details !== null && typeof details === "object" && !Array.isArray(details)) {
    const record = details as Record<string, unknown>;
    for (const key of ["name", "toolName", "title", "tool"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim() !== "") {
        return excerptText(value, 64);
      }
    }
  }
  return "tool";
}

export function buildSupervisionWatchBrief(input: {
  task: string;
  workers: readonly SupervisionWatchWorker[];
  observers: readonly string[];
}): string {
  if (input.workers.length === 0) {
    throw new GroupXError("SUPERVISION_PAIR_INVALID", "A supervision pair requires at least one worker");
  }
  if (input.observers.length === 0) {
    throw new GroupXError("SUPERVISION_PAIR_INVALID", "A supervision pair requires at least one observer");
  }
  const workerLines = input.workers
    .map((worker) => `- ${worker.actorId} turn ${worker.turnId}`)
    .join("\n");
  return [
    "You are a live GroupX observer for this turn pair, not a second executor.",
    "",
    "Task (do not perform it yourself):",
    excerptText(input.task, 8_000),
    "",
    "Workers:",
    workerLines,
    "",
    `Observers: ${input.observers.join(", ")}`,
    "",
    "Use groupx.watch to wait for the next bounded milestone or the terminal state.",
    "Use groupx.steer with action nudge or interrupt, a public reason, and guidance if you must redirect.",
    "nudge queues guidance after the current worker turn.",
    "interrupt cancels the whole current worker turn, then starts a new one.",
    "You cannot cancel a single native tool call, approve a tool, or deny a tool.",
    "Do not claim you approved, authorized, or denied anything. GroupX has no approval layer.",
    "Do not ask or send to the worker you are watching; steer is the only redirect path."
  ].join("\n");
}
