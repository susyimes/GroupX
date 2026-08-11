import { collectCursorPages } from "./pagination.js";

type JsonRecord = Record<string, unknown>;
type ConnectionState = "bootstrapping" | "connecting" | "live" | "reconnecting" | "offline";
type ActorKind = "user" | "agent" | "system";

interface ActorRef {
  actorId: string;
  kind: ActorKind;
  instanceId: string | null;
  displayName: string;
}

interface GroupXEnvelope {
  schema: string;
  eventId: string;
  seq: number | null;
  roomId: string;
  type: string;
  actor: ActorRef;
  to: string[];
  replyToEventId: string | null;
  causationId: string | null;
  correlationId: string;
  occurredAt: string;
  durability: "durable" | "transient";
  body: unknown;
}

interface AgentView {
  actorId: string;
  displayName: string;
  status: string;
  cwd: string;
  enabled: boolean;
  capabilities: string[];
}

interface TurnView {
  turnId: string;
  targetActorId: string;
  status: string;
  correlationId: string;
  error: string;
}

interface RecordView {
  id: string;
  kind: string;
  content: string;
  authorActorId: string;
  subjectActorId: string;
  createdAt: string;
  status: string;
}

interface MessageDraft {
  clientCommandId: string;
  to: string[];
  content: string;
  replyToEventId: string | null;
}

interface PendingSubmission {
  signature: string;
  draft: MessageDraft;
}

interface DeltaState {
  text: string;
  seenChunkIndexes: Set<number>;
}

interface DeltaPiece {
  chunkIndex: number | null;
  text: string;
}

interface DeltaBucket {
  envelope: GroupXEnvelope;
  key: string;
  pieces: DeltaPiece[];
  mode: "content" | "reasoning";
}

interface AppState {
  connection: ConnectionState;
  roomId: string;
  lastDurableSeq: number;
  agents: Map<string, AgentView>;
  messages: Map<string, GroupXEnvelope>;
  turns: Map<string, TurnView>;
  memories: Map<string, RecordView>;
  identities: Map<string, RecordView>;
  seenEventIds: Set<string>;
  transientText: Map<string, DeltaState>;
  replyToEventId: string | null;
  pendingSubmission: PendingSubmission | null;
  submitting: boolean;
}

interface ApiFailureShape {
  code: string;
  message: string;
  status: number;
}

class ApiFailure extends Error implements ApiFailureShape {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiFailure";
    this.code = code;
    this.status = status;
  }
}

const MESSAGE_MAX_LENGTH = 32_768;
const DELTA_BATCH_MS = 32;
const RECONNECT_MIN_MS = 250;
const RECONNECT_MAX_MS = 10_000;
const DEFAULT_ROOM_ID = "room:main";
const TERMINAL_TURN_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);

const DOCUMENTED_EVENT_TYPES = [
  "groupx.event",
  "groupx",
  "message.created",
  "turn.queued",
  "turn.dispatched",
  "turn.started",
  "turn.streaming",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "turn.interrupted",
  "turn.content.delta",
  "turn.reasoning.delta",
  "turn.progress",
  "tool.progress",
  "session.starting",
  "session.ready",
  "session.resumed",
  "session.stopped",
  "session.failed",
  "memory.remembered",
  "memory.superseded",
  "memory.retracted",
  "identity.remembered",
  "identity.superseded",
  "identity.retracted",
  "routing.loop_stopped",
  "system.error",
  "adapter.heartbeat",
] as const;

const DEFAULT_AGENTS: AgentView[] = [
  {
    actorId: "agent:codex",
    displayName: "Codex",
    status: "unknown",
    cwd: "",
    enabled: true,
    capabilities: [],
  },
  {
    actorId: "agent:grok",
    displayName: "Grok",
    status: "unknown",
    cwd: "",
    enabled: true,
    capabilities: [],
  },
  {
    actorId: "agent:kimi",
    displayName: "Kimi",
    status: "unknown",
    cwd: "",
    enabled: true,
    capabilities: [],
  },
];

const state: AppState = {
  connection: "bootstrapping",
  roomId: DEFAULT_ROOM_ID,
  lastDurableSeq: 0,
  agents: new Map(DEFAULT_AGENTS.map((agent) => [agent.actorId, agent])),
  messages: new Map(),
  turns: new Map(),
  memories: new Map(),
  identities: new Map(),
  seenEventIds: new Set(),
  transientText: new Map(),
  replyToEventId: null,
  pendingSubmission: null,
  submitting: false,
};

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing required element: ${id}`);
  }
  return element as T;
}

const connectionStatus = byId<HTMLOutputElement>("connection-status");
const connectionLabel = byId<HTMLSpanElement>("connection-label");
const roomLabel = byId<HTMLSpanElement>("room-label");
const globalError = byId<HTMLDivElement>("global-error");
const agentList = byId<HTMLUListElement>("agent-list");
const agentCount = byId<HTMLSpanElement>("agent-count");
const timeline = byId<HTMLOListElement>("timeline");
const timelineEmpty = byId<HTMLLIElement>("timeline-empty");
const jumpLatest = byId<HTMLButtonElement>("jump-latest");
const composer = byId<HTMLFormElement>("composer");
const messageInput = byId<HTMLTextAreaElement>("message-input");
const sendButton = byId<HTMLButtonElement>("send-button");
const composerStatus = byId<HTMLSpanElement>("composer-status");
const characterCount = byId<HTMLSpanElement>("character-count");
const targetAll = byId<HTMLInputElement>("target-all");
const replyContext = byId<HTMLDivElement>("reply-context");
const replyDescription = byId<HTMLSpanElement>("reply-description");
const clearReplyButton = byId<HTMLButtonElement>("clear-reply");
const memoryList = byId<HTMLUListElement>("memory-list");
const identityList = byId<HTMLUListElement>("identity-list");
const memoryForm = byId<HTMLFormElement>("memory-form");
const memoryKind = byId<HTMLSelectElement>("memory-kind");
const memoryInput = byId<HTMLTextAreaElement>("memory-input");
const identityForm = byId<HTMLFormElement>("identity-form");
const identityActor = byId<HTMLSelectElement>("identity-actor");
const identityKind = byId<HTMLSelectElement>("identity-kind");
const identityInput = byId<HTMLTextAreaElement>("identity-input");

const targetInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="target"]'));
const eventNodes = new Map<string, HTMLElement>();
const turnNodes = new Map<string, HTMLElement>();
const streamNodes = new Map<string, HTMLElement>();
const deltaBuckets = new Map<string, DeltaBucket>();
const registeredEventTypes = new Set<string>(DOCUMENTED_EVENT_TYPES);
const retryCommandIds = new Map<string, string>();
const closedStreamKeys = new Set<string>();

let eventSource: EventSource | null = null;
let reconnectTimer: number | null = null;
let reconnectAttempt = 0;
let deltaFlushTimer: number | null = null;
let globalErrorTimer: number | null = null;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function readStringField(record: JsonRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

function readNumberField(record: JsonRecord, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function readBooleanField(record: JsonRecord, fallback: boolean, ...keys: string[]): boolean {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return fallback;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function safeStringify(value: unknown, maxLength = 4_000): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    rendered = String(value);
  }
  if (rendered.length <= maxLength) {
    return rendered;
  }
  return `${rendered.slice(0, maxLength)}\n…`;
}

function makeClientCommandId(prefix: string): string {
  const random = globalThis.crypto.randomUUID();
  return `${prefix}-${random}`;
}

function retryableCommandId(key: string, prefix: string): string {
  const existing = retryCommandIds.get(key);
  if (existing) {
    return existing;
  }
  const created = makeClientCommandId(prefix);
  retryCommandIds.set(key, created);
  return created;
}

function actorKind(value: unknown): ActorKind {
  return value === "user" || value === "agent" || value === "system" ? value : "system";
}

function normalizeActor(value: unknown): ActorRef {
  if (!isRecord(value)) {
    return {
      actorId: "system:unknown",
      kind: "system",
      instanceId: null,
      displayName: "Envelope actor 缺失",
    };
  }
  const actorId = readStringField(value, "actorId");
  const instanceIdValue = value.instanceId;
  return {
    actorId: actorId || "system:unknown",
    kind: actorKind(value.kind),
    instanceId: typeof instanceIdValue === "string" ? instanceIdValue : null,
    displayName: readStringField(value, "displayName") || actorId || "未知来源",
  };
}

function normalizeEnvelope(value: unknown): GroupXEnvelope | null {
  if (!isRecord(value)) {
    return null;
  }
  const eventId = readStringField(value, "eventId");
  const type = readStringField(value, "type");
  if (!eventId || !type) {
    return null;
  }
  const seqValue = value.seq;
  const seq = typeof seqValue === "number" && Number.isSafeInteger(seqValue) && seqValue >= 0 ? seqValue : null;
  const to = asArray(value.to).filter((entry): entry is string => typeof entry === "string");
  const durabilityValue = value.durability;
  const durability = durabilityValue === "transient" ? "transient" : "durable";
  return {
    schema: readStringField(value, "schema") || "groupx.event/unknown",
    eventId,
    seq,
    roomId: readStringField(value, "roomId") || state.roomId,
    type,
    actor: normalizeActor(value.actor),
    to,
    replyToEventId: typeof value.replyToEventId === "string" ? value.replyToEventId : null,
    causationId: typeof value.causationId === "string" ? value.causationId : null,
    correlationId: readStringField(value, "correlationId") || eventId,
    occurredAt: readStringField(value, "occurredAt"),
    durability,
    body: value.body,
  };
}

function normalizeCapabilities(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value)
    .filter(([, enabled]) => enabled === true || enabled === "verified" || enabled === "supported")
    .map(([name]) => name);
}

function normalizeAgent(value: unknown): AgentView | null {
  if (!isRecord(value)) {
    return null;
  }
  const actorRecord = isRecord(value.actor) ? value.actor : null;
  const actorId = readStringField(value, "actorId") || (actorRecord ? readStringField(actorRecord, "actorId") : "");
  if (!actorId) {
    return null;
  }
  const displayName =
    readStringField(value, "displayName", "name") ||
    (actorRecord ? readStringField(actorRecord, "displayName") : "") ||
    actorId;
  return {
    actorId,
    displayName,
    status: readStringField(value, "status", "sessionStatus", "health") || "unknown",
    cwd: readStringField(value, "cwd", "workingDirectory"),
    enabled: readBooleanField(value, true, "enabled"),
    capabilities: normalizeCapabilities(value.capabilities),
  };
}

function normalizeTurn(value: unknown): TurnView | null {
  if (!isRecord(value)) {
    return null;
  }
  const turnId = readStringField(value, "turnId", "id");
  if (!turnId) {
    return null;
  }
  return {
    turnId,
    targetActorId: readStringField(value, "targetActorId", "target"),
    status: readStringField(value, "status") || "queued",
    correlationId: readStringField(value, "correlationId", "rootCorrelationId"),
    error: readStringField(value, "error", "errorCode", "message"),
  };
}

function normalizeRecord(value: unknown, identity: boolean): RecordView | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = identity
    ? readStringField(value, "identityId", "id", "eventId")
    : readStringField(value, "memoryId", "id", "eventId");
  const content = readStringField(value, "content", "text");
  if (!id || !content) {
    return null;
  }
  return {
    id,
    kind: readStringField(value, "kind") || "note",
    content,
    authorActorId: readStringField(value, "authorActorId", "author") || "user:web",
    subjectActorId: readStringField(value, "subjectActorId", "subject"),
    createdAt: readStringField(value, "createdAt", "occurredAt"),
    status: readStringField(value, "status") || "active",
  };
}

function actorToneClass(actorId: string): string {
  if (actorId.startsWith("agent:codex")) {
    return "actor-codex";
  }
  if (actorId.startsWith("agent:grok")) {
    return "actor-grok";
  }
  if (actorId.startsWith("agent:kimi")) {
    return "actor-kimi";
  }
  if (actorId.startsWith("user:")) {
    return "actor-user";
  }
  return "actor-system";
}

function actorInitial(actor: ActorRef): string {
  const label = actor.displayName || actor.actorId;
  return label.slice(0, 2).toUpperCase();
}

function formatTime(value: string): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function humanStatus(status: string): string {
  const names: Record<string, string> = {
    unknown: "状态未知",
    starting: "正在启动",
    ready: "已就绪",
    resumed: "已恢复",
    online: "在线",
    offline: "离线",
    restarting: "正在重启",
    stopped: "已停止",
    failed: "失败",
    queued: "排队中",
    dispatched: "已派发",
    running: "运行中",
    streaming: "回复中",
    cancel_requested: "正在取消",
    completed: "已完成",
    cancelled: "已取消",
    interrupted: "已中断",
  };
  return names[status] ?? status;
}

function setConnection(next: ConnectionState, detail = ""): void {
  state.connection = next;
  connectionStatus.dataset.state = next;
  const labels: Record<ConnectionState, string> = {
    bootstrapping: "正在载入",
    connecting: "正在连接",
    live: "实时连接",
    reconnecting: "正在重连",
    offline: "连接离线",
  };
  connectionLabel.textContent = detail ? `${labels[next]} · ${detail}` : labels[next];
}

function showGlobalError(message: string): void {
  globalError.textContent = message;
  globalError.hidden = false;
  if (globalErrorTimer !== null) {
    window.clearTimeout(globalErrorTimer);
  }
  globalErrorTimer = window.setTimeout(() => {
    globalError.hidden = true;
    globalError.textContent = "";
    globalErrorTimer = null;
  }, 8_000);
}

function setComposerStatus(message: string, error = false): void {
  composerStatus.textContent = message;
  composerStatus.classList.toggle("is-error", error);
}

async function requestJson<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(path, {
    ...options,
    headers,
  });
  const text = await response.text();
  let decoded: unknown = null;
  if (text) {
    try {
      decoded = JSON.parse(text) as unknown;
    } catch {
      decoded = null;
    }
  }
  if (!response.ok) {
    const errorRecord = isRecord(decoded) && isRecord(decoded.error) ? decoded.error : null;
    const code = errorRecord ? readStringField(errorRecord, "code") : "HTTP_ERROR";
    const message = errorRecord ? readStringField(errorRecord, "message") : "";
    throw new ApiFailure(code || "HTTP_ERROR", message || `请求失败（HTTP ${response.status}）`, response.status);
  }
  return decoded as T;
}

function createActorMeta(envelope: GroupXEnvelope): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.className = "event-meta";

  const avatar = document.createElement("span");
  avatar.className = `actor-avatar ${actorToneClass(envelope.actor.actorId)}`;
  avatar.textContent = actorInitial(envelope.actor);
  avatar.setAttribute("aria-hidden", "true");

  const name = document.createElement("span");
  name.className = "actor-name";
  name.textContent = envelope.actor.displayName;

  const actorId = document.createElement("span");
  actorId.className = "actor-id";
  actorId.textContent = envelope.actor.actorId;

  const time = document.createElement("time");
  time.className = "event-time";
  time.dateTime = envelope.occurredAt;
  time.textContent = formatTime(envelope.occurredAt);

  wrapper.append(avatar, name, actorId, time);
  return wrapper;
}

function isTimelineNearBottom(): boolean {
  return timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 120;
}

function appendTimeline(node: HTMLLIElement): void {
  const shouldFollow = isTimelineNearBottom() || timeline.children.length <= 1;
  if (timelineEmpty.isConnected) {
    timelineEmpty.remove();
  }
  timeline.append(node);
  if (shouldFollow) {
    timeline.scrollTo({ top: timeline.scrollHeight, behavior: "smooth" });
    jumpLatest.hidden = true;
  } else {
    jumpLatest.hidden = false;
  }
}

function messageContent(body: unknown): string {
  if (typeof body === "string") {
    return body;
  }
  if (!isRecord(body)) {
    return safeStringify(body);
  }
  const direct = readStringField(body, "content", "text");
  if (direct) {
    return direct;
  }
  if (isRecord(body.message)) {
    const nested = readStringField(body.message, "content", "text");
    if (nested) {
      return nested;
    }
  }
  return safeStringify(body);
}

function turnIdFromBody(body: unknown): string {
  return isRecord(body) ? readStringField(body, "turnId", "id") : "";
}

function streamKey(envelope: GroupXEnvelope, mode: "content" | "reasoning" = "content"): string {
  const turnId = turnIdFromBody(envelope.body);
  const base = turnId ? `turn:${turnId}` : `correlation:${envelope.correlationId}:actor:${envelope.actor.actorId}`;
  return mode === "reasoning" ? `${base}:reasoning` : base;
}

function replyPreview(eventId: string): string {
  const referenced = state.messages.get(eventId);
  if (!referenced) {
    return eventId;
  }
  const preview = messageContent(referenced.body).replace(/\s+/g, " ").trim();
  const clipped = preview.length > 120 ? `${preview.slice(0, 120)}…` : preview;
  return `${referenced.actor.displayName}: ${clipped}`;
}

function setReply(eventId: string): void {
  state.replyToEventId = eventId;
  state.pendingSubmission = null;
  replyDescription.textContent = replyPreview(eventId);
  replyContext.hidden = false;
  messageInput.focus();
}

function clearReply(): void {
  state.replyToEventId = null;
  state.pendingSubmission = null;
  replyDescription.textContent = "";
  replyContext.hidden = true;
}

function renderMessage(envelope: GroupXEnvelope): void {
  if (eventNodes.has(envelope.eventId)) {
    return;
  }
  const key = streamKey(envelope);
  closedStreamKeys.add(key);
  closedStreamKeys.add(`${key}:reasoning`);
  deltaBuckets.delete(key);
  deltaBuckets.delete(`${key}:reasoning`);
  const existingArticle = streamNodes.get(key);
  let item: HTMLLIElement;
  let article: HTMLElement;
  if (existingArticle && existingArticle.parentElement instanceof HTMLLIElement) {
    article = existingArticle;
    item = existingArticle.parentElement;
    article.replaceChildren();
    streamNodes.delete(key);
    state.transientText.delete(key);
  } else {
    item = document.createElement("li");
    item.className = "timeline-item";
    article = document.createElement("article");
    item.append(article);
  }

  article.className = "event-card";
  if (envelope.actor.kind === "user") {
    article.classList.add("actor-user-card");
  }
  article.dataset.eventId = envelope.eventId;
  article.append(createActorMeta(envelope));

  if (envelope.replyToEventId) {
    const reply = document.createElement("div");
    reply.className = "reply-reference";
    reply.textContent = replyPreview(envelope.replyToEventId);
    article.append(reply);
  }

  const content = document.createElement("p");
  content.className = "event-content";
  content.textContent = messageContent(envelope.body);
  article.append(content);

  const actions = document.createElement("div");
  actions.className = "event-actions";
  const replyButton = document.createElement("button");
  replyButton.type = "button";
  replyButton.className = "text-button";
  replyButton.textContent = "回复";
  replyButton.addEventListener("click", () => setReply(envelope.eventId));
  actions.append(replyButton);
  article.append(actions);

  state.messages.set(envelope.eventId, envelope);
  eventNodes.set(envelope.eventId, article);
  if (!item.isConnected) {
    appendTimeline(item);
  }
}

function updateStreamingNode(bucket: DeltaBucket, text: string): void {
  let article = streamNodes.get(bucket.key);
  if (!article) {
    const item = document.createElement("li");
    item.className = "timeline-item";
    article = document.createElement("article");
    article.className = "event-card is-streaming";
    article.dataset.streamKey = bucket.key;
    article.append(createActorMeta(bucket.envelope));

    if (bucket.mode === "reasoning") {
      const label = document.createElement("div");
      label.className = "reply-reference";
      label.textContent = "推理流";
      article.append(label);
    }

    const content = document.createElement("p");
    content.className = "event-content";
    article.append(content);
    item.append(article);
    streamNodes.set(bucket.key, article);
    appendTimeline(item);
  }
  const content = article.querySelector<HTMLElement>(".event-content");
  if (content) {
    content.textContent = text;
  }
}

function flushDeltaBuckets(): void {
  deltaFlushTimer = null;
  for (const bucket of deltaBuckets.values()) {
    let deltaState = state.transientText.get(bucket.key);
    if (!deltaState) {
      deltaState = { text: "", seenChunkIndexes: new Set() };
      state.transientText.set(bucket.key, deltaState);
    }

    const indexed = bucket.pieces
      .filter((piece): piece is DeltaPiece & { chunkIndex: number } => piece.chunkIndex !== null)
      .sort((left, right) => left.chunkIndex - right.chunkIndex);
    const unindexed = bucket.pieces.filter((piece) => piece.chunkIndex === null);

    for (const piece of indexed) {
      if (deltaState.seenChunkIndexes.has(piece.chunkIndex)) {
        continue;
      }
      deltaState.seenChunkIndexes.add(piece.chunkIndex);
      deltaState.text += piece.text;
    }
    for (const piece of unindexed) {
      deltaState.text += piece.text;
    }
    updateStreamingNode(bucket, deltaState.text);
  }
  deltaBuckets.clear();
}

function queueDelta(envelope: GroupXEnvelope, mode: "content" | "reasoning"): void {
  if (!isRecord(envelope.body)) {
    renderGeneric(envelope);
    return;
  }
  const text = readStringField(envelope.body, "text", "delta", "content");
  if (!text) {
    return;
  }
  const key = streamKey(envelope, mode);
  if (closedStreamKeys.has(key)) {
    return;
  }
  const chunkIndexValue = readNumberField(envelope.body, "chunkIndex", "index");
  const chunkIndex = chunkIndexValue !== null && Number.isSafeInteger(chunkIndexValue) ? chunkIndexValue : null;
  let bucket = deltaBuckets.get(key);
  if (!bucket) {
    bucket = { envelope, key, pieces: [], mode };
    deltaBuckets.set(key, bucket);
  }
  bucket.pieces.push({ chunkIndex, text });
  if (deltaFlushTimer === null) {
    deltaFlushTimer = window.setTimeout(flushDeltaBuckets, DELTA_BATCH_MS);
  }
}

function turnStatusFromType(type: string): string {
  const segment = type.split(".").at(-1) ?? "unknown";
  if (segment === "started") {
    return "running";
  }
  return segment;
}

function finalizeStreamsForTurn(turnId: string, status: string): void {
  if (!TERMINAL_TURN_STATUSES.has(status)) {
    return;
  }
  for (const key of [`turn:${turnId}`, `turn:${turnId}:reasoning`]) {
    closedStreamKeys.add(key);
    deltaBuckets.delete(key);
    const stream = streamNodes.get(key);
    if (!stream) {
      continue;
    }
    stream.classList.remove("is-streaming");
    if (!stream.querySelector(".reply-reference")) {
      const label = document.createElement("div");
      label.className = "reply-reference";
      label.textContent = `未完成内容 · ${humanStatus(status)}`;
      const content = stream.querySelector(".event-content");
      stream.insertBefore(label, content);
    }
  }
}

function renderTurn(turn: TurnView): void {
  state.turns.set(turn.turnId, turn);
  finalizeStreamsForTurn(turn.turnId, turn.status);
  let article = turnNodes.get(turn.turnId);
  let item: HTMLLIElement | null = null;
  if (!article) {
    item = document.createElement("li");
    item.className = "timeline-item";
    article = document.createElement("article");
    article.className = "turn-card";
    item.append(article);
    turnNodes.set(turn.turnId, article);
  }
  article.replaceChildren();
  article.dataset.turnId = turn.turnId;
  article.dataset.status = turn.status;

  const header = document.createElement("div");
  header.className = "turn-card-header";
  const status = document.createElement("span");
  status.className = "turn-state";
  const targetLabel = (state.agents.get(turn.targetActorId)?.displayName ?? turn.targetActorId) || "Agent";
  status.textContent = `${targetLabel} · ${humanStatus(turn.status)}`;
  header.append(status);

  if (!TERMINAL_TURN_STATUSES.has(turn.status) && turn.status !== "cancel_requested") {
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "cancel-button";
    cancel.textContent = "取消";
    cancel.addEventListener("click", () => {
      void cancelTurn(turn.turnId);
    });
    header.append(cancel);
  }
  article.append(header);

  if (turn.error) {
    const error = document.createElement("p");
    error.className = "turn-error";
    error.textContent = turn.error;
    article.append(error);
  }
  if (item) {
    appendTimeline(item);
  }
}

function renderTurnEnvelope(envelope: GroupXEnvelope): void {
  const body = isRecord(envelope.body) ? envelope.body : {};
  const turnId = readStringField(body, "turnId", "id");
  if (!turnId) {
    renderGeneric(envelope);
    return;
  }
  const status = readStringField(body, "status") || turnStatusFromType(envelope.type);
  const targetActorId = readStringField(body, "targetActorId", "target") || envelope.to[0] || envelope.actor.actorId;
  const error = readStringField(body, "error", "errorCode", "message");
  renderTurn({ turnId, targetActorId, status, correlationId: envelope.correlationId, error });
}

async function cancelTurn(turnId: string): Promise<void> {
  const turn = state.turns.get(turnId);
  if (!turn || TERMINAL_TURN_STATUSES.has(turn.status) || turn.status === "cancel_requested") {
    return;
  }
  const retryKey = `cancel:${turnId}`;
  renderTurn({ ...turn, status: "cancel_requested" });
  try {
    await requestJson<unknown>(`/api/turns/${encodeURIComponent(turnId)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ clientCommandId: retryableCommandId(retryKey, "web-cancel") }),
    });
    retryCommandIds.delete(retryKey);
  } catch (error) {
    renderTurn(turn);
    showGlobalError(errorMessage(error));
  }
}

function renderGeneric(envelope: GroupXEnvelope): void {
  if (eventNodes.has(envelope.eventId)) {
    return;
  }
  const item = document.createElement("li");
  item.className = "timeline-item";
  const article = document.createElement("article");
  article.className = "generic-card";
  article.dataset.eventId = envelope.eventId;
  article.append(createActorMeta(envelope));

  const type = document.createElement("div");
  type.className = "generic-type";
  type.textContent = envelope.type;
  article.append(type);

  const body = document.createElement("pre");
  body.className = "generic-body";
  body.textContent = safeStringify(envelope.body);
  article.append(body);

  item.append(article);
  eventNodes.set(envelope.eventId, article);
  appendTimeline(item);
}

function updateAgentFromSessionEvent(envelope: GroupXEnvelope): void {
  if (envelope.actor.kind !== "agent") {
    return;
  }
  const current = state.agents.get(envelope.actor.actorId) ?? {
    actorId: envelope.actor.actorId,
    displayName: envelope.actor.displayName,
    status: "unknown",
    cwd: "",
    enabled: true,
    capabilities: [],
  };
  const suffix = envelope.type.split(".").at(-1) ?? "unknown";
  const status = suffix === "resumed" ? "ready" : suffix;
  state.agents.set(current.actorId, { ...current, displayName: envelope.actor.displayName, status });
  renderAgents();
}

function addRecordFromEnvelope(envelope: GroupXEnvelope, identity: boolean): void {
  const record = normalizeRecord(envelope.body, identity);
  if (!record) {
    renderGeneric(envelope);
    return;
  }
  const target = identity ? state.identities : state.memories;
  if (envelope.type.endsWith(".retracted")) {
    target.delete(record.id);
  } else {
    target.set(record.id, record);
  }
  renderRecords(identity);
}

function dispatchEnvelope(envelope: GroupXEnvelope): void {
  switch (envelope.type) {
    case "message.created":
      renderMessage(envelope);
      return;
    case "turn.content.delta":
      queueDelta(envelope, "content");
      return;
    case "turn.reasoning.delta":
      queueDelta(envelope, "reasoning");
      return;
    case "turn.queued":
    case "turn.dispatched":
    case "turn.started":
    case "turn.streaming":
    case "turn.completed":
    case "turn.failed":
    case "turn.cancelled":
    case "turn.interrupted":
      renderTurnEnvelope(envelope);
      return;
    case "session.starting":
    case "session.ready":
    case "session.resumed":
    case "session.stopped":
    case "session.failed":
      updateAgentFromSessionEvent(envelope);
      if (envelope.type === "session.failed") {
        renderGeneric(envelope);
      }
      return;
    case "memory.remembered":
    case "memory.superseded":
    case "memory.retracted":
      addRecordFromEnvelope(envelope, false);
      return;
    case "identity.remembered":
    case "identity.superseded":
    case "identity.retracted":
      addRecordFromEnvelope(envelope, true);
      return;
    case "adapter.heartbeat":
      return;
    default:
      renderGeneric(envelope);
  }
}

function acceptEnvelope(envelope: GroupXEnvelope, source: "bootstrap" | "live"): boolean {
  if (state.seenEventIds.has(envelope.eventId)) {
    return true;
  }
  if (envelope.seq !== null) {
    if (source === "live" && envelope.seq <= state.lastDurableSeq) {
      state.seenEventIds.add(envelope.eventId);
      return true;
    }
    if (source === "live" && envelope.seq > state.lastDurableSeq + 1) {
      reconnectForGap(envelope.seq);
      return false;
    }
    state.lastDurableSeq = Math.max(state.lastDurableSeq, envelope.seq);
  }
  state.seenEventIds.add(envelope.eventId);
  dispatchEnvelope(envelope);
  return true;
}

function renderAgents(): void {
  agentList.replaceChildren();
  const ordered = Array.from(state.agents.values()).sort((left, right) => left.actorId.localeCompare(right.actorId));
  let available = 0;
  for (const agent of ordered) {
    const item = document.createElement("li");
    item.className = "agent-card";
    item.dataset.actorId = agent.actorId;

    const top = document.createElement("div");
    top.className = "agent-card-top";
    const nameRow = document.createElement("div");
    nameRow.className = "agent-name-row";
    const avatar = document.createElement("span");
    avatar.className = `agent-avatar ${actorToneClass(agent.actorId)}`;
    avatar.textContent = agent.displayName.slice(0, 2).toUpperCase();
    avatar.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "agent-name";
    name.textContent = agent.displayName;
    nameRow.append(avatar, name);

    const status = document.createElement("span");
    status.className = "agent-status";
    status.dataset.status = agent.status;
    status.textContent = humanStatus(agent.status);
    top.append(nameRow, status);

    const meta = document.createElement("div");
    meta.className = "agent-meta-row";
    const details = document.createElement("div");
    details.className = "agent-details";
    const cwd = document.createElement("span");
    cwd.className = "agent-cwd";
    cwd.textContent = agent.cwd || "cwd 未报告";
    const capabilities = document.createElement("span");
    capabilities.className = "agent-capabilities";
    capabilities.textContent = agent.capabilities.length > 0 ? agent.capabilities.join(" · ") : "能力待现场确认";
    details.append(cwd, capabilities);

    const restart = document.createElement("button");
    restart.type = "button";
    restart.className = "restart-button";
    restart.textContent = "重启";
    restart.disabled = !agent.enabled || agent.status === "restarting";
    restart.addEventListener("click", () => {
      void restartAgent(agent.actorId);
    });
    meta.append(details, restart);

    item.append(top, meta);
    agentList.append(item);
    if (agent.enabled && !["failed", "offline", "stopped", "unknown"].includes(agent.status)) {
      available += 1;
    }
  }
  agentCount.textContent = `${available} / ${ordered.length}`;
  syncTargetAvailability();
}

function syncTargetAvailability(): void {
  for (const input of targetInputs) {
    const agent = state.agents.get(input.value);
    const unavailable = agent?.enabled === false;
    input.disabled = state.submitting || unavailable;
    if (unavailable) {
      input.checked = false;
    }
  }
  syncTargetAll();
}

function setComposerBusy(busy: boolean): void {
  messageInput.disabled = busy;
  sendButton.disabled = busy;
  clearReplyButton.disabled = busy;
  syncTargetAvailability();
}

async function restartAgent(actorId: string): Promise<void> {
  const agent = state.agents.get(actorId);
  if (!agent || !agent.enabled || agent.status === "restarting") {
    return;
  }
  const retryKey = `restart:${actorId}`;
  state.agents.set(actorId, { ...agent, status: "restarting" });
  renderAgents();
  try {
    await requestJson<unknown>(`/api/agents/${encodeURIComponent(actorId)}/restart`, {
      method: "POST",
      body: JSON.stringify({ clientCommandId: retryableCommandId(retryKey, "web-restart") }),
    });
    retryCommandIds.delete(retryKey);
  } catch (error) {
    state.agents.set(actorId, agent);
    renderAgents();
    showGlobalError(errorMessage(error));
  }
}

function renderRecords(identity: boolean): void {
  const records = Array.from((identity ? state.identities : state.memories).values())
    .filter((record) => record.status !== "retracted")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const list = identity ? identityList : memoryList;
  list.replaceChildren();
  for (const record of records) {
    const item = document.createElement("li");
    item.className = "record-card";
    item.dataset.recordId = record.id;
    const meta = document.createElement("div");
    meta.className = "record-meta";
    const kind = document.createElement("span");
    kind.className = "record-kind";
    kind.textContent = record.kind;
    const source = document.createElement("span");
    const subject = record.subjectActorId ? ` → ${record.subjectActorId}` : "";
    source.textContent = `${record.authorActorId}${subject}`;
    meta.append(kind, source);
    const content = document.createElement("p");
    content.className = "record-content";
    content.textContent = record.content;
    item.append(meta, content);
    list.append(item);
  }
}

function extractCollection(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  if (!isRecord(value)) {
    return [];
  }
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }
  return [];
}

function nextCursorFromPage(value: unknown): number | undefined {
  if (!isRecord(value) || value.nextCursor === undefined || value.nextCursor === null) {
    return undefined;
  }
  if (
    typeof value.nextCursor !== "number" ||
    !Number.isSafeInteger(value.nextCursor) ||
    value.nextCursor < 0
  ) {
    throw new ApiFailure("INVALID_PAGE_CURSOR", "记录分页游标无效", 500);
  }
  return value.nextCursor;
}

function recordPagePath(path: "/api/memory" | "/api/identity", cursor: number | undefined): string {
  if (cursor === undefined) {
    return path;
  }
  const query = new URLSearchParams({ cursor: String(cursor) });
  return `${path}?${query.toString()}`;
}

async function loadRecords(path: "/api/memory" | "/api/identity", identity: boolean): Promise<void> {
  try {
    const target = identity ? state.identities : state.memories;
    const records = await collectCursorPages(async (cursor) => {
      const response = await requestJson<unknown>(recordPagePath(path, cursor));
      const items = extractCollection(
        response,
        identity ? ["identities", "records", "items"] : ["memory", "memories", "records", "items"]
      );
      const nextCursor = nextCursorFromPage(response);
      return nextCursor === undefined ? { items } : { items, nextCursor };
    });
    for (const value of records) {
      const record = normalizeRecord(value, identity);
      if (record) {
        target.set(record.id, record);
      }
    }
    renderRecords(identity);
  } catch (error) {
    if (!(error instanceof ApiFailure) || error.status !== 404) {
      showGlobalError(errorMessage(error));
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiFailure) {
    return error.code ? `${error.code}: ${error.message}` : error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return "发生未知错误";
}

function selectedTargets(): string[] {
  return targetInputs.filter((input) => input.checked && !input.disabled).map((input) => input.value);
}

function draftSignature(content: string, to: string[], replyToEventId: string | null): string {
  return JSON.stringify({ content, to: [...to].sort(), replyToEventId });
}

function invalidatePendingSubmission(): void {
  if (!state.submitting) {
    state.pendingSubmission = null;
  }
}

async function submitMessage(): Promise<void> {
  const content = messageInput.value.trim();
  const to = selectedTargets();
  if (!content) {
    setComposerStatus("请输入消息内容", true);
    messageInput.focus();
    return;
  }
  if (content.length > MESSAGE_MAX_LENGTH) {
    setComposerStatus(`消息超过 ${MESSAGE_MAX_LENGTH} 字符`, true);
    return;
  }
  if (to.length === 0) {
    setComposerStatus("请至少选择一个目标 Agent", true);
    return;
  }
  if (state.submitting) {
    return;
  }

  const signature = draftSignature(content, to, state.replyToEventId);
  const existing = state.pendingSubmission?.signature === signature ? state.pendingSubmission.draft : null;
  const draft: MessageDraft = existing ?? {
    clientCommandId: makeClientCommandId("web-message"),
    to,
    content,
    replyToEventId: state.replyToEventId,
  };
  state.pendingSubmission = { signature, draft };
  state.submitting = true;
  setComposerBusy(true);
  setComposerStatus(existing ? "正在使用同一命令 ID 重试…" : "正在提交…");

  try {
    await requestJson<unknown>("/api/messages", {
      method: "POST",
      body: JSON.stringify(draft),
    });
    messageInput.value = "";
    characterCount.textContent = `0 / ${MESSAGE_MAX_LENGTH}`;
    clearReply();
    state.pendingSubmission = null;
    setComposerStatus("已接受，等待 Agent 事件");
  } catch (error) {
    setComposerStatus(`${errorMessage(error)}；再次发送会复用同一命令 ID`, true);
  } finally {
    state.submitting = false;
    setComposerBusy(false);
  }
}

async function submitMemory(): Promise<void> {
  const content = memoryInput.value.trim();
  if (!content) {
    memoryInput.focus();
    return;
  }
  const button = memoryForm.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (button) {
    button.disabled = true;
  }
  const retryKey = `memory:${state.roomId}:${memoryKind.value}:${content}`;
  try {
    const response = await requestJson<unknown>("/api/memory", {
      method: "POST",
      body: JSON.stringify({
        clientCommandId: retryableCommandId(retryKey, "web-memory"),
        scope: { type: "room", id: state.roomId },
        kind: memoryKind.value,
        content,
      }),
    });
    const memory = isRecord(response) ? normalizeRecord(response.memory, false) : null;
    if (memory) {
      state.memories.set(memory.id, memory);
      renderRecords(false);
    }
    retryCommandIds.delete(retryKey);
    memoryInput.value = "";
  } catch (error) {
    showGlobalError(errorMessage(error));
  } finally {
    if (button) {
      button.disabled = false;
    }
  }
}

async function submitIdentity(): Promise<void> {
  const content = identityInput.value.trim();
  if (!content) {
    identityInput.focus();
    return;
  }
  const button = identityForm.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (button) {
    button.disabled = true;
  }
  const retryKey = `identity:${identityActor.value}:${identityKind.value}:${content}`;
  try {
    const response = await requestJson<unknown>("/api/identity", {
      method: "POST",
      body: JSON.stringify({
        clientCommandId: retryableCommandId(retryKey, "web-identity"),
        subjectActorId: identityActor.value,
        kind: identityKind.value,
        content,
      }),
    });
    const identity = isRecord(response) ? normalizeRecord(response.identity, true) : null;
    if (identity) {
      state.identities.set(identity.id, identity);
      renderRecords(true);
    }
    retryCommandIds.delete(retryKey);
    identityInput.value = "";
  } catch (error) {
    showGlobalError(errorMessage(error));
  } finally {
    if (button) {
      button.disabled = false;
    }
  }
}

function syncTargetAll(): void {
  const selectableTargets = targetInputs.filter((input) => state.agents.get(input.value)?.enabled !== false);
  targetAll.checked = selectableTargets.length > 0 && selectableTargets.every((input) => input.checked);
  targetAll.indeterminate = selectableTargets.some((input) => input.checked) && !targetAll.checked;
  targetAll.disabled = state.submitting || selectableTargets.length === 0;
}

function activateContextTab(tabId: string): void {
  const tabs = ["memory", "identity"] as const;
  for (const name of tabs) {
    const tab = byId<HTMLButtonElement>(`${name}-tab`);
    const panel = byId<HTMLElement>(`${name}-panel`);
    const active = name === tabId;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    panel.hidden = !active;
  }
}

function supportedEventTypesFromBootstrap(bootstrap: JsonRecord): string[] {
  const result = new Set<string>(DOCUMENTED_EVENT_TYPES);
  const direct = extractCollection(bootstrap, ["eventTypes", "supportedEventTypes"]);
  for (const type of direct) {
    if (typeof type === "string" && type) {
      result.add(type);
    }
  }
  if (isRecord(bootstrap.capabilities)) {
    for (const type of extractCollection(bootstrap.capabilities, ["eventTypes", "supportedEventTypes"])) {
      if (typeof type === "string" && type) {
        result.add(type);
      }
    }
  }
  return Array.from(result);
}

function handleSseMessage(event: MessageEvent<string>): void {
  let decoded: unknown;
  try {
    decoded = JSON.parse(event.data) as unknown;
  } catch {
    showGlobalError("收到无法解析的 SSE 事件");
    return;
  }
  const envelope = normalizeEnvelope(decoded);
  if (!envelope) {
    showGlobalError("收到不完整的 GroupX Envelope");
    return;
  }
  acceptEnvelope(envelope, "live");
}

function closeEventSource(): void {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function scheduleReconnect(detail = ""): void {
  closeEventSource();
  if (reconnectTimer !== null) {
    return;
  }
  const base = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** reconnectAttempt);
  const jittered = Math.round(base * (1 + Math.random() * 0.2));
  reconnectAttempt += 1;
  setConnection("reconnecting", detail || `${jittered} ms`);
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connectEventSource();
  }, jittered);
}

function reconnectForGap(receivedSeq: number): void {
  scheduleReconnect(`游标缺口 ${state.lastDurableSeq} → ${receivedSeq}`);
}

function connectEventSource(extraTypes: string[] = []): void {
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  closeEventSource();
  setConnection(reconnectAttempt > 0 ? "reconnecting" : "connecting");
  const source = new EventSource(`/api/events?afterSeq=${encodeURIComponent(String(state.lastDurableSeq))}`);
  eventSource = source;
  for (const eventType of extraTypes) {
    registeredEventTypes.add(eventType);
  }
  for (const eventType of registeredEventTypes) {
    source.addEventListener(eventType, (event) => handleSseMessage(event as MessageEvent<string>));
  }
  source.onmessage = handleSseMessage;
  source.onopen = () => {
    reconnectAttempt = 0;
    setConnection("live");
  };
  source.onerror = () => {
    if (source !== eventSource) {
      return;
    }
    setConnection("reconnecting", "等待 EventSource 恢复");
  };
}

async function bootstrap(): Promise<void> {
  setConnection("bootstrapping");
  renderAgents();
  renderRecords(false);
  renderRecords(true);
  try {
    const decoded = await requestJson<unknown>("/api/bootstrap");
    if (!isRecord(decoded)) {
      throw new ApiFailure("INVALID_BOOTSTRAP", "bootstrap 响应不是对象", 500);
    }
    const room = isRecord(decoded.room) ? decoded.room : {};
    state.roomId = readStringField(room, "roomId") || readStringField(decoded, "roomId") || DEFAULT_ROOM_ID;
    roomLabel.textContent = state.roomId;

    for (const value of extractCollection(decoded, ["agents"])) {
      const agent = normalizeAgent(value);
      if (agent) {
        state.agents.set(agent.actorId, agent);
      }
    }
    renderAgents();

    const recentEvents = extractCollection(decoded, ["recentEvents", "events"])
      .map(normalizeEnvelope)
      .filter((event): event is GroupXEnvelope => event !== null)
      .sort((left, right) => (left.seq ?? Number.MAX_SAFE_INTEGER) - (right.seq ?? Number.MAX_SAFE_INTEGER));
    for (const envelope of recentEvents) {
      acceptEnvelope(envelope, "bootstrap");
    }

    for (const value of extractCollection(decoded, ["activeTurns", "turns"])) {
      const turn = normalizeTurn(value);
      if (turn) {
        renderTurn(turn);
      }
    }

    for (const value of extractCollection(decoded, ["memory", "memories"])) {
      const record = normalizeRecord(value, false);
      if (record) {
        state.memories.set(record.id, record);
      }
    }
    for (const value of extractCollection(decoded, ["identities", "identity"])) {
      const record = normalizeRecord(value, true);
      if (record) {
        state.identities.set(record.id, record);
      }
    }
    renderRecords(false);
    renderRecords(true);

    const throughSeq = readNumberField(room, "throughSeq") ?? readNumberField(decoded, "throughSeq") ?? 0;
    if (Number.isSafeInteger(throughSeq) && throughSeq >= 0) {
      state.lastDurableSeq = Math.max(state.lastDurableSeq, throughSeq);
    }

    void Promise.allSettled([loadRecords("/api/memory", false), loadRecords("/api/identity", true)]);
    connectEventSource(supportedEventTypesFromBootstrap(decoded));
  } catch (error) {
    setConnection("offline", "bootstrap 失败");
    showGlobalError(errorMessage(error));
    window.setTimeout(() => {
      void bootstrap();
    }, 2_000);
  }
}

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitMessage();
});

messageInput.addEventListener("input", () => {
  characterCount.textContent = `${messageInput.value.length} / ${MESSAGE_MAX_LENGTH}`;
  invalidatePendingSubmission();
  if (messageInput.value.length <= MESSAGE_MAX_LENGTH) {
    setComposerStatus("Ctrl / ⌘ + Enter 发送");
  }
});

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    composer.requestSubmit();
  }
});

targetAll.addEventListener("change", () => {
  for (const input of targetInputs) {
    if (!input.disabled) {
      input.checked = targetAll.checked;
    }
  }
  targetAll.indeterminate = false;
  invalidatePendingSubmission();
});

for (const input of targetInputs) {
  input.addEventListener("change", () => {
    syncTargetAll();
    invalidatePendingSubmission();
  });
}

clearReplyButton.addEventListener("click", clearReply);

jumpLatest.addEventListener("click", () => {
  timeline.scrollTo({ top: timeline.scrollHeight, behavior: "smooth" });
  jumpLatest.hidden = true;
});

timeline.addEventListener("scroll", () => {
  if (isTimelineNearBottom()) {
    jumpLatest.hidden = true;
  }
});

memoryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitMemory();
});

identityForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitIdentity();
});

for (const tabId of ["memory", "identity"] as const) {
  byId<HTMLButtonElement>(`${tabId}-tab`).addEventListener("click", () => activateContextTab(tabId));
}

window.addEventListener("online", () => {
  if (!eventSource) {
    reconnectAttempt = 0;
    connectEventSource();
  }
});

window.addEventListener("offline", () => {
  if (state.connection !== "live") {
    setConnection("reconnecting", "本地 EventSource 仍在重试");
  }
});

window.addEventListener("beforeunload", () => {
  closeEventSource();
  if (reconnectTimer !== null) {
    window.clearTimeout(reconnectTimer);
  }
  if (deltaFlushTimer !== null) {
    window.clearTimeout(deltaFlushTimer);
  }
});

void bootstrap();
