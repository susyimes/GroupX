import { collectCursorPages } from "./pagination.js";
import { parseReasoningRecord } from "./reasoning-record.js";
import { copyPlainText, flashButtonLabel, renderRichContent } from "./rich-text.js";
import { describeToolProgress, mergeToolProgressSnapshot } from "./tool-progress.js";

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
  scopeType: "room" | "agent" | "global";
  scopeId: string;
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

interface ContextUsageView {
  roomId: string;
  throughSeq: number;
  estimatedCharacters: number;
  maxCharacters: number;
  compactionTriggerCharacters: number;
  utilizationPercent: number;
  uncompactedMessageCount: number;
  summaryThroughSeq: number | null;
  compactable: boolean;
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
  seenEventIds: Set<string>;
  transientText: Map<string, DeltaState>;
  replyToEventId: string | null;
  pendingSubmission: PendingSubmission | null;
  replacing: { id: string } | null;
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
const COMPOSER_HINT = "Enter 发送 · Shift+Enter 换行";
const DRAFT_STORAGE_KEY = "groupx:draft";
const THEME_STORAGE_KEY = "groupx:theme";
const TIMELINE_MAX_ITEMS = 500;
const TIMELINE_TRIM_BATCH = 100;
const HEALTH_POLL_MS = 60_000;
const BASE_TITLE = document.title;

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
  "turn.reasoning.recorded",
  "turn.progress",
  "tool.progress",
  "tool.progress.recorded",
  "context.compaction.started",
  "context.compaction.retrying",
  "context.compaction.completed",
  "context.compaction.failed",
  "session.starting",
  "session.retrying",
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

const state: AppState = {
  connection: "bootstrapping",
  roomId: DEFAULT_ROOM_ID,
  lastDurableSeq: 0,
  agents: new Map(),
  messages: new Map(),
  turns: new Map(),
  memories: new Map(),
  seenEventIds: new Set(),
  transientText: new Map(),
  replyToEventId: null,
  pendingSubmission: null,
  replacing: null,
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
const memoryForm = byId<HTMLFormElement>("memory-form");
const memoryKind = byId<HTMLSelectElement>("memory-kind");
const memoryInput = byId<HTMLTextAreaElement>("memory-input");
const memoryReplaceBanner = byId<HTMLDivElement>("memory-replace-banner");
const memorySubmit = byId<HTMLButtonElement>("memory-submit");
const publicMemoryCount = byId<HTMLSpanElement>("public-memory-count");
const publicMemorySection = byId<HTMLDetailsElement>("public-memory-section");
const themeToggle = byId<HTMLButtonElement>("theme-toggle");
const targetPicker = byId<HTMLFieldSetElement>("target-picker");
const runtimeProgress = byId<HTMLElement>("runtime-progress");
const runtimeProgressTitle = byId<HTMLElement>("runtime-progress-title");
const runtimeProgressDetail = byId<HTMLElement>("runtime-progress-detail");
const runtimeProgressAttempt = byId<HTMLElement>("runtime-progress-attempt");
const contextUsage = byId<HTMLElement>("context-usage");
const contextUsageValue = byId<HTMLElement>("context-usage-value");
const contextUsageFill = byId<HTMLElement>("context-usage-fill");
const compactContextButton = byId<HTMLButtonElement>("compact-context");

function targetInputs(): HTMLInputElement[] {
  return Array.from(targetPicker.querySelectorAll<HTMLInputElement>('input[name="target"]'));
}
const eventNodes = new Map<string, HTMLElement>();
const turnNodes = new Map<string, HTMLElement>();
const streamNodes = new Map<string, HTMLElement>();
const toolProgressNodes = new Map<string, { node: HTMLElement; snapshot: unknown }>();
const deltaBuckets = new Map<string, DeltaBucket>();
const registeredEventTypes = new Set<string>(DOCUMENTED_EVENT_TYPES);
const retryCommandIds = new Map<string, string>();
const closedStreamKeys = new Set<string>();

let eventSource: EventSource | null = null;
let reconnectTimer: number | null = null;
let reconnectAttempt = 0;
let deltaFlushTimer: number | null = null;
let globalErrorTimer: number | null = null;
let healthTimer: number | null = null;
let unreadCount = 0;
let newWhileScrolledUp = 0;
let lastTimelineDate = "";
let trimmedItemCount = 0;
let trimNoticeNode: HTMLLIElement | null = null;
let runtimeProgressHideTimer: number | null = null;
let contextUsageRefreshTimer: number | null = null;
let contextUsageRefreshInFlight = false;
let contextCompacting = false;
let latestContextUsage: ContextUsageView | null = null;

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

function normalizeContextUsage(value: unknown): ContextUsageView | null {
  if (!isRecord(value)) return null;
  const roomId = readStringField(value, "roomId");
  const throughSeq = readNumberField(value, "throughSeq");
  const estimatedCharacters = readNumberField(value, "estimatedCharacters");
  const maxCharacters = readNumberField(value, "maxCharacters");
  const compactionTriggerCharacters = readNumberField(value, "compactionTriggerCharacters");
  const utilizationPercent = readNumberField(value, "utilizationPercent");
  const uncompactedMessageCount = readNumberField(value, "uncompactedMessageCount");
  const summaryThroughSeq = readNumberField(value, "summaryThroughSeq");
  if (
    !roomId ||
    throughSeq === null ||
    estimatedCharacters === null ||
    maxCharacters === null ||
    maxCharacters <= 0 ||
    compactionTriggerCharacters === null ||
    utilizationPercent === null ||
    uncompactedMessageCount === null
  ) {
    return null;
  }
  return {
    roomId,
    throughSeq,
    estimatedCharacters,
    maxCharacters,
    compactionTriggerCharacters,
    utilizationPercent: Math.min(100, Math.max(0, Math.round(utilizationPercent))),
    uncompactedMessageCount,
    summaryThroughSeq,
    compactable: readBooleanField(value, false, "compactable")
  };
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
  const scope = isRecord(value.scope) ? value.scope : {};
  const scopeType =
    readStringField(scope, "type") ||
    readStringField(value, "scopeType") ||
    (identity ? "agent" : "room");
  const scopeId = readStringField(scope, "id") || readStringField(value, "scopeId");
  return {
    id,
    scopeType:
      scopeType === "agent" || scopeType === "global" ? scopeType : "room",
    scopeId,
    kind: readStringField(value, "kind") || "note",
    content,
    authorActorId: readStringField(value, "authorActorId", "author") || "user:web",
    subjectActorId: readStringField(value, "subjectActorId", "subject"),
    createdAt: readStringField(value, "createdAt", "occurredAt"),
    status: readStringField(value, "status") || "active",
  };
}

const DYNAMIC_TONE_COUNT = 6;

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
  if (actorId.startsWith("agent:hermes")) {
    return "actor-hermes";
  }
  if (actorId.startsWith("user:")) {
    return "actor-user";
  }
  if (actorId.startsWith("agent:")) {
    let hash = 0;
    for (const char of actorId) {
      hash = (hash * 31 + (char.codePointAt(0) ?? 0)) % 997;
    }
    return `actor-dynamic-${hash % DYNAMIC_TONE_COUNT}`;
  }
  return "actor-system";
}

function actorInitial(actor: ActorRef): string {
  const label = actor.displayName || actor.actorId;
  return label.slice(0, 2).toUpperCase();
}

function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function formatTime(value: string): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  const sameDay = localDateKey(date) === localDateKey(new Date());
  return new Intl.DateTimeFormat(
    "zh-CN",
    sameDay
      ? { hour: "2-digit", minute: "2-digit" }
      : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }
  ).format(date);
}

function formatFullTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" }).format(date);
}

function dateDividerLabel(date: Date): string {
  const now = new Date();
  const key = localDateKey(date);
  if (key === localDateKey(now)) {
    return "今天";
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (key === localDateKey(yesterday)) {
    return "昨天";
  }
  const monthDay = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === now.getFullYear() ? monthDay : `${date.getFullYear()}年${monthDay}`;
}

function humanStatus(status: string): string {
  const names: Record<string, string> = {
    unknown: "状态未知",
    starting: "正在启动",
    retrying: "正在重试",
    ready: "已就绪",
    resumed: "已恢复",
    online: "在线",
    offline: "离线",
    restarting: "正在重启",
    stopped: "已停止",
    failed: "失败",
    queued: "排队中",
    dispatched: "已派发",
    dispatching: "派发中",
    running: "运行中",
    streaming: "回复中",
    cancel_requested: "正在取消",
    cancelling: "正在取消",
    completed: "已完成",
    cancelled: "已取消",
    interrupted: "已中断",
    error: "错误",
    native_policy_blocked: "原生策略阻止",
  };
  return names[status] ?? status;
}

function humanCapability(capability: string): string {
  const names: Record<string, string> = {
    currentTurnMcp: "回合内 MCP",
    loadSession: "会话恢复",
    semanticCancel: "语义取消",
    streaming: "流式输出",
  };
  return names[capability] ?? capability.replace(/([a-z0-9])([A-Z])/gu, "$1 $2");
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

function autoresizeComposer(): void {
  messageInput.style.height = "auto";
  const next = Math.min(messageInput.scrollHeight, 180);
  messageInput.style.height = `${next}px`;
  messageInput.style.overflowY = messageInput.scrollHeight > 180 ? "auto" : "hidden";
}

function saveDraft(): void {
  try {
    if (messageInput.value) {
      sessionStorage.setItem(DRAFT_STORAGE_KEY, messageInput.value);
    } else {
      sessionStorage.removeItem(DRAFT_STORAGE_KEY);
    }
  } catch {
    // sessionStorage may be unavailable; drafts are best-effort only
  }
}

function clearDraft(): void {
  try {
    sessionStorage.removeItem(DRAFT_STORAGE_KEY);
  } catch {
    // sessionStorage may be unavailable; drafts are best-effort only
  }
}

function restoreDraft(): void {
  try {
    const saved = sessionStorage.getItem(DRAFT_STORAGE_KEY);
    if (saved) {
      messageInput.value = saved;
    }
  } catch {
    // sessionStorage may be unavailable; drafts are best-effort only
  }
}

function updateCharacterCount(): void {
  const length = messageInput.value.length;
  characterCount.textContent = `${length} / ${MESSAGE_MAX_LENGTH}`;
  characterCount.classList.toggle(
    "is-warning",
    length > MESSAGE_MAX_LENGTH * 0.9 && length < MESSAGE_MAX_LENGTH
  );
  characterCount.classList.toggle("is-error", length >= MESSAGE_MAX_LENGTH);
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

function formatContextCharacters(value: number): string {
  if (value < 1_000) return String(Math.max(0, Math.round(value)));
  const scaled = value / 1_000;
  const digits = scaled >= 100 ? 0 : 1;
  return `${scaled.toFixed(digits).replace(/\.0$/u, "")}k`;
}

function renderContextUsage(usage: ContextUsageView | null): void {
  latestContextUsage = usage;
  if (!usage) {
    contextUsageValue.textContent = "暂不可用";
    contextUsageFill.style.width = "0%";
    contextUsage.dataset.level = "normal";
    compactContextButton.disabled = true;
    return;
  }
  contextUsageValue.textContent = `约 ${formatContextCharacters(usage.estimatedCharacters)} / ${formatContextCharacters(usage.maxCharacters)} 字符`;
  contextUsageFill.style.width = `${usage.utilizationPercent}%`;
  contextUsage.dataset.level =
    usage.utilizationPercent >= 95
      ? "critical"
      : usage.utilizationPercent >= 75
        ? "warning"
        : "normal";
  contextUsage.title = [
    `GroupX 房间上下文估算：${Math.round(usage.estimatedCharacters).toLocaleString()} / ${Math.round(usage.maxCharacters).toLocaleString()} 字符`,
    `自动压缩软阈值：${Math.round(usage.compactionTriggerCharacters).toLocaleString()} 字符`,
    "这不是模型 token 数；目标 Agent 的身份、记忆和原生 instructions 会另占空间。"
  ].join("\n");
  compactContextButton.disabled = contextCompacting || !usage.compactable;
  compactContextButton.title = usage.compactable
    ? "把较早消息滚动整理为摘要；完整聊天记录仍保留"
    : "近期未压缩消息较少，当前无需手动压缩";
}

async function refreshContextUsage(): Promise<void> {
  if (contextUsageRefreshInFlight) return;
  contextUsageRefreshInFlight = true;
  try {
    const decoded = await requestJson<unknown>("/api/context");
    const usage = normalizeContextUsage(decoded);
    if (!usage) throw new ApiFailure("INVALID_CONTEXT_USAGE", "上下文用量响应无效", 500);
    renderContextUsage(usage);
  } catch (error) {
    renderContextUsage(null);
    if (!(error instanceof ApiFailure) || error.status !== 404) {
      contextUsage.title = errorMessage(error);
    }
  } finally {
    contextUsageRefreshInFlight = false;
  }
}

function scheduleContextUsageRefresh(delayMs = 120): void {
  if (contextUsageRefreshTimer !== null) {
    window.clearTimeout(contextUsageRefreshTimer);
  }
  contextUsageRefreshTimer = window.setTimeout(() => {
    contextUsageRefreshTimer = null;
    void refreshContextUsage();
  }, delayMs);
}

async function compactCurrentContext(): Promise<void> {
  if (contextCompacting || !latestContextUsage?.compactable) return;
  if (runtimeProgressHideTimer !== null) {
    window.clearTimeout(runtimeProgressHideTimer);
    runtimeProgressHideTimer = null;
  }
  contextCompacting = true;
  compactContextButton.disabled = true;
  compactContextButton.textContent = "压缩中…";
  compactContextButton.setAttribute("aria-busy", "true");
  runtimeProgress.hidden = false;
  runtimeProgress.dataset.phase = "started";
  runtimeProgressTitle.textContent = "正在请求压缩会话";
  runtimeProgressDetail.textContent = "较早消息会整理为摘要，完整记录不会删除";
  runtimeProgressAttempt.textContent = "手动";
  const retryKey = `context-compact:${state.roomId}`;
  try {
    const decoded = await requestJson<unknown>("/api/context/compact", {
      method: "POST",
      body: JSON.stringify({
        clientCommandId: retryableCommandId(retryKey, "web-context-compact")
      })
    });
    if (!isRecord(decoded)) {
      throw new ApiFailure("INVALID_CONTEXT_RESULT", "压缩响应无效", 500);
    }
    const usage = normalizeContextUsage(decoded.usage);
    if (!usage) throw new ApiFailure("INVALID_CONTEXT_USAGE", "压缩后的用量响应无效", 500);
    retryCommandIds.delete(retryKey);
    renderContextUsage(usage);
    if (!readBooleanField(decoded, false, "compacted")) {
      runtimeProgress.dataset.phase = "completed";
      runtimeProgressTitle.textContent = "当前无需压缩";
      runtimeProgressDetail.textContent = "近期消息会继续保留原文";
      runtimeProgressAttempt.textContent = "";
      runtimeProgressHideTimer = window.setTimeout(() => {
        runtimeProgress.hidden = true;
      }, 3_000);
    } else if (runtimeProgress.dataset.phase !== "completed") {
      runtimeProgress.dataset.phase = "completed";
      runtimeProgressTitle.textContent = "房间上下文已压缩";
      runtimeProgressDetail.textContent = "较早消息已整理为摘要，近期消息仍保留原文";
      runtimeProgressAttempt.textContent = "";
      runtimeProgressHideTimer = window.setTimeout(() => {
        runtimeProgress.hidden = true;
      }, 4_000);
    }
  } catch (error) {
    runtimeProgress.dataset.phase = "failed";
    runtimeProgressTitle.textContent = "会话压缩失败";
    runtimeProgressDetail.textContent = `${errorMessage(error)} · 原聊天记录未丢失`;
    runtimeProgressAttempt.textContent = "";
    showGlobalError(errorMessage(error));
  } finally {
    contextCompacting = false;
    compactContextButton.textContent = "压缩会话";
    compactContextButton.removeAttribute("aria-busy");
    renderContextUsage(latestContextUsage);
  }
}

function createActorAvatar(actor: ActorRef): HTMLSpanElement {
  const avatar = document.createElement("span");
  avatar.className = `actor-avatar ${actorToneClass(actor.actorId)}`;
  avatar.textContent = actorInitial(actor);
  avatar.setAttribute("aria-hidden", "true");
  return avatar;
}

function createActorMeta(envelope: GroupXEnvelope): HTMLDivElement {
  const wrapper = document.createElement("div");
  wrapper.className = "event-meta";
  wrapper.title = envelope.actor.actorId;

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
  time.title = formatFullTime(envelope.occurredAt);

  wrapper.append(name, actorId, time);
  return wrapper;
}

function isTimelineNearBottom(): boolean {
  return timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 120;
}

function resetJumpLatest(): void {
  newWhileScrolledUp = 0;
  jumpLatest.textContent = "回到最新";
  jumpLatest.hidden = true;
}

function cleanupRemovedItem(node: Element): void {
  const card = node.querySelector<HTMLElement>("[data-event-id], [data-turn-id], [data-stream-key]");
  if (!card) {
    return;
  }
  const { eventId, turnId, streamKey } = card.dataset;
  if (eventId) {
    eventNodes.delete(eventId);
  }
  if (turnId) {
    turnNodes.delete(turnId);
  }
  if (streamKey) {
    streamNodes.delete(streamKey);
  }
  for (const progress of node.querySelectorAll<HTMLElement>("[data-tool-progress-key]")) {
    const key = progress.dataset.toolProgressKey;
    if (key) {
      toolProgressNodes.delete(key);
    }
  }
}

function trimTimelineIfNeeded(): void {
  const overflow = timeline.children.length - TIMELINE_MAX_ITEMS;
  if (overflow <= 0) {
    return;
  }
  const target = overflow + TIMELINE_TRIM_BATCH;
  let removed = 0;
  let node = timeline.firstElementChild;
  while (removed < target && node) {
    if (node.id === "timeline-empty") {
      break;
    }
    const next = node.nextElementSibling;
    if (node !== trimNoticeNode) {
      cleanupRemovedItem(node);
      node.remove();
      removed += 1;
    }
    node = next;
  }
  if (removed === 0) {
    return;
  }
  trimmedItemCount += removed;
  if (!trimNoticeNode) {
    trimNoticeNode = document.createElement("li");
    trimNoticeNode.className = "trim-notice";
    timeline.prepend(trimNoticeNode);
  }
  trimNoticeNode.textContent = `已收起 ${trimmedItemCount} 条较早消息`;
}

function appendTimeline(node: HTMLLIElement, countsAsNew = true): void {
  const shouldFollow = isTimelineNearBottom() || timeline.children.length <= 1;
  if (timelineEmpty.isConnected) {
    timelineEmpty.remove();
  }
  timeline.append(node);
  if (shouldFollow) {
    // Instant snap: smooth scrolling lags behind rapid appends (bootstrap
    // replay, streaming flushes) and loses the bottom anchor.
    timeline.scrollTop = timeline.scrollHeight;
    resetJumpLatest();
  } else {
    if (countsAsNew) {
      newWhileScrolledUp += 1;
      jumpLatest.textContent = `↓ ${newWhileScrolledUp} 条新消息`;
    }
    jumpLatest.hidden = false;
  }
  trimTimelineIfNeeded();
}

function maybeInsertDateDivider(occurredAt: string): void {
  if (!occurredAt) {
    return;
  }
  const date = new Date(occurredAt);
  if (Number.isNaN(date.getTime())) {
    return;
  }
  const key = localDateKey(date);
  if (key === lastTimelineDate) {
    return;
  }
  lastTimelineDate = key;
  const item = document.createElement("li");
  item.className = "date-divider";
  const label = document.createElement("span");
  label.textContent = dateDividerLabel(date);
  item.append(label);
  appendTimeline(item, false);
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

function cardToneClass(actorId: string): string {
  return actorToneClass(actorId).replace("actor-", "tone-");
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
    const retainedToolProgress = article.querySelector<HTMLElement>(".tool-progress-list");
    article.replaceChildren();
    streamNodes.delete(key);
    state.transientText.delete(key);
    delete article.dataset.streamKey;
    if (retainedToolProgress) {
      article.dataset.retainedToolProgress = "true";
      article.append(retainedToolProgress);
    }
  } else {
    item = document.createElement("li");
    item.className = "timeline-item";
    article = document.createElement("article");
    item.append(article);
  }

  article.className = `event-card ${cardToneClass(envelope.actor.actorId)}`;
  if (envelope.actor.kind === "user") {
    article.classList.add("actor-user-card");
  }
  article.dataset.eventId = envelope.eventId;

  const body = document.createElement("div");
  body.className = "event-body";
  body.append(createActorMeta(envelope));

  const retainedToolProgress = article.querySelector<HTMLElement>(".tool-progress-list");
  if (retainedToolProgress) {
    retainedToolProgress.remove();
    body.append(retainedToolProgress);
    delete article.dataset.retainedToolProgress;
  }

  if (envelope.replyToEventId) {
    const sourceId = envelope.replyToEventId;
    const reply = document.createElement("div");
    reply.className = "reply-reference is-linked";
    reply.textContent = replyPreview(sourceId);
    reply.setAttribute("role", "button");
    reply.tabIndex = 0;
    const scrollToSource = (): void => {
      const target = eventNodes.get(sourceId);
      if (!target) {
        return;
      }
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.add("is-highlighted");
      window.setTimeout(() => target.classList.remove("is-highlighted"), 1_200);
    };
    reply.addEventListener("click", scrollToSource);
    reply.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        scrollToSource();
      }
    });
    body.append(reply);
  }

  const content = document.createElement("p");
  content.className = "event-content";
  renderRichContent(content, messageContent(envelope.body));
  body.append(content);

  const actions = document.createElement("div");
  actions.className = "event-actions";
  const replyButton = document.createElement("button");
  replyButton.type = "button";
  replyButton.className = "text-button";
  replyButton.textContent = "回复";
  replyButton.addEventListener("click", () => setReply(envelope.eventId));
  const copyButton = document.createElement("button");
  copyButton.type = "button";
  copyButton.className = "text-button";
  copyButton.textContent = "复制";
  copyButton.addEventListener("click", () => {
    void copyPlainText(messageContent(envelope.body)).then((ok) => {
      flashButtonLabel(copyButton, ok ? "已复制" : "复制失败");
    });
  });
  actions.append(replyButton, copyButton);
  body.append(actions);
  article.append(createActorAvatar(envelope.actor), body);

  state.messages.set(envelope.eventId, envelope);
  eventNodes.set(envelope.eventId, article);
  if (!item.isConnected) {
    maybeInsertDateDivider(envelope.occurredAt);
    appendTimeline(item);
  }
}

function ensureStreamingNode(
  envelope: GroupXEnvelope,
  key: string,
  mode: "content" | "reasoning"
): HTMLElement {
  let article = streamNodes.get(key);
  if (!article) {
    const item = document.createElement("li");
    item.className = "timeline-item";
    article = document.createElement("article");
    article.className = `event-card is-streaming ${cardToneClass(envelope.actor.actorId)}`;
    article.dataset.streamKey = key;

    const body = document.createElement("div");
    body.className = "event-body";
    body.append(createActorMeta(envelope));

    if (mode === "reasoning") {
      const label = document.createElement("div");
      label.className = "reply-reference";
      label.textContent = "推理流";
      body.append(label);
    }

    const content = document.createElement("p");
    content.className = "event-content";
    content.hidden = true;
    body.append(content);
    article.append(createActorAvatar(envelope.actor), body);
    item.append(article);
    streamNodes.set(key, article);
    maybeInsertDateDivider(envelope.occurredAt);
    appendTimeline(item);
  }
  return article;
}

function updateStreamingNode(bucket: DeltaBucket, text: string): void {
  const article = ensureStreamingNode(bucket.envelope, bucket.key, bucket.mode);
  const content = article.querySelector<HTMLElement>(".event-content");
  if (content) {
    content.hidden = false;
    renderRichContent(content, text);
  }
}

function renderReasoningRecord(envelope: GroupXEnvelope): void {
  if (eventNodes.has(envelope.eventId)) return;
  const record = parseReasoningRecord(envelope.body);
  if (!record) {
    renderGeneric(envelope);
    return;
  }
  const key = `turn:${record.turnId}:reasoning`;
  deltaBuckets.delete(key);
  state.transientText.delete(key);
  closedStreamKeys.add(key);

  const article = ensureStreamingNode(envelope, key, "reasoning");
  article.classList.remove("is-streaming");
  article.dataset.eventId = envelope.eventId;
  const label = article.querySelector<HTMLElement>(".reply-reference");
  if (label) label.textContent = "推理记录";
  const content = article.querySelector<HTMLElement>(".event-content");
  if (content) {
    content.hidden = false;
    renderRichContent(content, record.content);
  }
  eventNodes.set(envelope.eventId, article);
}

function toolProgressList(article: HTMLElement): HTMLElement {
  const existing = article.querySelector<HTMLElement>(".tool-progress-list");
  if (existing) {
    return existing;
  }
  const list = document.createElement("div");
  list.className = "tool-progress-list";
  const content = article.querySelector<HTMLElement>(".event-content");
  content?.before(list);
  return list;
}

function updateToolProgressNode(node: HTMLElement, snapshot: unknown): void {
  const presentation = describeToolProgress(snapshot);
  node.dataset.tone = presentation.tone;
  const label = node.querySelector<HTMLElement>(".tool-progress-label");
  const status = node.querySelector<HTMLElement>(".tool-progress-status");
  const details = node.querySelector<HTMLElement>(".tool-progress-details");
  if (label) label.textContent = presentation.label;
  if (status) status.textContent = presentation.status;
  if (details) details.textContent = safeStringify(snapshot);
}

/** Render one tool call inside its Agent conversation bubble, collapsed by default. */
export function renderToolProgress(envelope: GroupXEnvelope): void {
  if (!isRecord(envelope.body)) {
    renderGeneric(envelope);
    return;
  }
  const turnId = turnIdFromBody(envelope.body);
  if (!turnId) {
    renderGeneric(envelope);
    return;
  }
  const key = `turn:${turnId}`;
  if (closedStreamKeys.has(key)) {
    return;
  }
  const initialPresentation = describeToolProgress(envelope.body);
  const progressKey = `${key}:tool:${initialPresentation.keyPart}`;
  const existing = toolProgressNodes.get(progressKey);
  if (existing) {
    existing.snapshot = mergeToolProgressSnapshot(existing.snapshot, envelope.body);
    updateToolProgressNode(existing.node, existing.snapshot);
    return;
  }

  const article = ensureStreamingNode(envelope, key, "content");
  const list = toolProgressList(article);
  const row = document.createElement("section");
  row.className = "tool-progress";
  row.dataset.toolProgressKey = progressKey;

  const summary = document.createElement("div");
  summary.className = "tool-progress-summary";
  const indicator = document.createElement("span");
  indicator.className = "tool-progress-indicator";
  indicator.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.className = "tool-progress-label";
  const status = document.createElement("span");
  status.className = "tool-progress-status";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "tool-progress-toggle";
  toggle.textContent = "展开";
  toggle.setAttribute("aria-expanded", "false");

  const details = document.createElement("pre");
  details.className = "tool-progress-details";
  details.hidden = true;
  toggle.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!expanded));
    toggle.textContent = expanded ? "展开" : "收起";
    details.hidden = expanded;
  });

  summary.append(indicator, label, status, toggle);
  row.append(summary, details);
  list.append(row);
  const entry = { node: row, snapshot: envelope.body };
  toolProgressNodes.set(progressKey, entry);
  updateToolProgressNode(row, entry.snapshot);
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

function renderRuntimeProgress(envelope: GroupXEnvelope): void {
  const body = isRecord(envelope.body) ? envelope.body : {};
  const attempt = readNumberField(body, "attempt") ?? 1;
  const maxAttempts = readNumberField(body, "maxAttempts") ?? 1;
  const nextDelayMs = readNumberField(body, "nextDelayMs") ?? 0;
  const errorCode = readStringField(body, "errorCode");
  if (runtimeProgressHideTimer !== null) {
    window.clearTimeout(runtimeProgressHideTimer);
    runtimeProgressHideTimer = null;
  }
  runtimeProgress.hidden = false;
  runtimeProgress.dataset.phase = envelope.type.split(".").at(-1) ?? "started";
  runtimeProgressAttempt.textContent = `${attempt} / ${maxAttempts}`;
  if (envelope.type.startsWith("context.compaction.")) {
    if (envelope.type.endsWith("retrying")) {
      runtimeProgressTitle.textContent = "会话压缩暂时失败，正在重试";
      runtimeProgressDetail.textContent = `${errorCode || "临时故障"} · ${Math.max(1, Math.ceil(nextDelayMs / 1000))} 秒后重试`;
    } else if (envelope.type.endsWith("completed")) {
      runtimeProgressTitle.textContent = "房间上下文已压缩";
      runtimeProgressDetail.textContent = `已整理 ${readNumberField(body, "messageCount") ?? 0} 条较早消息，近期消息仍保留原文`;
      runtimeProgressHideTimer = window.setTimeout(() => {
        runtimeProgress.hidden = true;
      }, 4_000);
    } else if (envelope.type.endsWith("failed")) {
      runtimeProgressTitle.textContent = "会话压缩失败";
      runtimeProgressDetail.textContent = `${errorCode || "压缩器不可用"} · 原聊天记录未丢失`;
    } else {
      runtimeProgressTitle.textContent = "正在压缩较早的会话记录";
      runtimeProgressDetail.textContent = `处理 ${readNumberField(body, "messageCount") ?? 0} 条消息，期间当前回复会等待`;
    }
    return;
  }
  const actor = state.agents.get(envelope.actor.actorId)?.displayName ?? envelope.actor.displayName;
  if (envelope.type === "session.retrying") {
    runtimeProgressTitle.textContent = `${actor} 会话连接失败，正在重试`;
    runtimeProgressDetail.textContent = `${errorCode || "临时故障"} · ${Math.max(1, Math.ceil(nextDelayMs / 1000))} 秒后重试`;
  } else if (envelope.type === "session.failed") {
    runtimeProgressTitle.textContent = `${actor} 会话启动失败`;
    runtimeProgressDetail.textContent = errorCode || "请检查本机 CLI 状态";
  } else if (envelope.type === "session.ready" || envelope.type === "session.resumed") {
    runtimeProgressTitle.textContent = `${actor} 会话已就绪`;
    runtimeProgressDetail.textContent = "可以继续接收新的消息";
    runtimeProgressHideTimer = window.setTimeout(() => {
      runtimeProgress.hidden = true;
    }, 2_500);
  } else {
    runtimeProgressTitle.textContent = `${actor} 正在建立会话`;
    runtimeProgressDetail.textContent = "正在连接本机 CLI";
  }
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

function recordEventPayload(body: unknown): unknown {
  return isRecord(body) && isRecord(body.record) ? body.record : body;
}

function renderRecordActivity(envelope: GroupXEnvelope, record: RecordView, identity: boolean): void {
  if (eventNodes.has(envelope.eventId)) {
    return;
  }
  const item = document.createElement("li");
  item.className = "timeline-item";
  const article = document.createElement("article");
  article.className = "activity-card";
  article.dataset.eventId = envelope.eventId;
  article.append(createActorMeta(envelope));

  const memoryLabel = record.scopeType === "agent" ? "Agent 记忆" : "公共记忆";
  const verb = identity
    ? envelope.type.endsWith(".retracted")
      ? "移除了一条兼容身份记录"
      : envelope.type.endsWith(".superseded")
        ? "替换了一条兼容身份记录"
        : "更新了一条兼容身份记录"
    : envelope.type.endsWith(".retracted")
      ? `移除了一条${memoryLabel}`
      : envelope.type.endsWith(".superseded")
        ? `替换了一条${memoryLabel}`
        : `保存了一条${memoryLabel}`;
  const line = document.createElement("p");
  line.className = "activity-line";
  line.textContent = verb;
  const preview = document.createElement("p");
  preview.className = "activity-preview";
  preview.textContent =
    record.content.length > 160 ? `${record.content.slice(0, 160)}…` : record.content;
  article.append(line, preview);

  item.append(article);
  eventNodes.set(envelope.eventId, article);
  appendTimeline(item);
}

function addRecordFromEnvelope(envelope: GroupXEnvelope, identity: boolean): void {
  const payload = recordEventPayload(envelope.body);
  const record = normalizeRecord(payload, identity);
  if (!record) {
    renderGeneric(envelope);
    return;
  }
  // Identity records remain a supported compatibility/API data class, but are
  // deliberately no longer exposed in the room UI. Stable identity and
  // per-Agent memory are configured together in /setup.
  if (identity) {
    renderRecordActivity(envelope, record, true);
    return;
  }
  const target = state.memories;
  if (envelope.type.endsWith(".retracted")) {
    target.delete(record.id);
  } else {
    if (envelope.type.endsWith(".superseded") && isRecord(payload)) {
      const previousId = readStringField(
        payload,
        identity ? "supersedesIdentityId" : "supersedesMemoryId"
      );
      if (previousId) {
        target.delete(previousId);
      }
    }
    target.set(record.id, record);
  }
  renderPublicMemoryRecords();
  renderRecordActivity(envelope, record, false);
}

function dispatchEnvelope(envelope: GroupXEnvelope): void {
  switch (envelope.type) {
    case "message.created":
      renderMessage(envelope);
      if (document.hidden && envelope.actor.kind !== "user") {
        unreadCount += 1;
        document.title = `(${unreadCount}) ${BASE_TITLE}`;
      }
      return;
    case "turn.content.delta":
      queueDelta(envelope, "content");
      return;
    case "turn.reasoning.delta":
      queueDelta(envelope, "reasoning");
      return;
    case "turn.reasoning.recorded":
      renderReasoningRecord(envelope);
      return;
    case "tool.progress":
    case "tool.progress.recorded":
      renderToolProgress(envelope);
      return;
    case "context.compaction.started":
    case "context.compaction.retrying":
    case "context.compaction.completed":
    case "context.compaction.failed":
      renderRuntimeProgress(envelope);
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
    case "session.retrying":
    case "session.ready":
    case "session.resumed":
    case "session.stopped":
    case "session.failed":
      updateAgentFromSessionEvent(envelope);
      renderRuntimeProgress(envelope);
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
  if (envelope.type === "message.created" || envelope.type === "context.compaction.completed") {
    scheduleContextUsageRefresh();
  }
  return true;
}

function orderedAgents(): AgentView[] {
  return Array.from(state.agents.values()).sort((left, right) => left.actorId.localeCompare(right.actorId));
}

/** Rebuild the composer target chips from the configured agents, preserving the user's current selection. */
function renderTargetPicker(): void {
  const existing = targetInputs();
  const initialized = existing.length > 0;
  const previouslyChecked = new Set(existing.filter((input) => input.checked).map((input) => input.value));
  for (const chip of Array.from(targetPicker.querySelectorAll(".target-chip[data-agent]"))) {
    chip.remove();
  }
  for (const agent of orderedAgents()) {
    const label = document.createElement("label");
    label.className = `target-chip ${cardToneClass(agent.actorId)}`;
    label.dataset.agent = agent.actorId;
    const input = document.createElement("input");
    input.name = "target";
    input.type = "checkbox";
    input.value = agent.actorId;
    input.checked = initialized ? previouslyChecked.has(agent.actorId) : agent.enabled;
    input.addEventListener("change", () => {
      syncTargetAll();
      invalidatePendingSubmission();
    });
    const text = document.createElement("span");
    text.textContent = `@${agent.displayName}`;
    label.append(input, text);
    targetPicker.append(label);
  }
}

function renderAgents(): void {
  agentList.replaceChildren();
  const ordered = orderedAgents();
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
    capabilities.textContent =
      agent.capabilities.length > 0 ? agent.capabilities.map(humanCapability).join(" · ") : "能力待现场确认";
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
  renderTargetPicker();
  syncTargetAvailability();
}

function syncTargetAvailability(): void {
  for (const input of targetInputs()) {
    const agent = state.agents.get(input.value);
    const unavailable = agent?.enabled === false;
    input.disabled = state.submitting || unavailable;
    if (unavailable) {
      input.checked = false;
    }
  }
  syncTargetAll();
}

function syncSendButton(): void {
  sendButton.disabled = state.submitting || messageInput.value.trim().length === 0;
}

function setComposerBusy(busy: boolean): void {
  messageInput.disabled = busy;
  syncSendButton();
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

function selectHasOption(select: HTMLSelectElement, value: string): boolean {
  return Array.from(select.options).some((option) => option.value === value);
}

function enterReplaceMode(record: RecordView): void {
  state.replacing = { id: record.id };
  if (selectHasOption(memoryKind, record.kind)) memoryKind.value = record.kind;
  memoryInput.value = record.content;
  publicMemorySection.open = true;
  memoryReplaceBanner.hidden = false;
  memorySubmit.textContent = "保存替换";
  memoryInput.focus();
}

function exitReplaceMode(): void {
  state.replacing = null;
  memoryReplaceBanner.hidden = true;
  memorySubmit.textContent = "固定到房间";
  memoryInput.value = "";
}

async function retractRecord(recordId: string): Promise<void> {
  const retryKey = `retract:memory:${recordId}`;
  const path = `/api/memory/${encodeURIComponent(recordId)}/retract`;
  try {
    await requestJson<unknown>(path, {
      method: "POST",
      body: JSON.stringify({ clientCommandId: retryableCommandId(retryKey, "web-retract") }),
    });
    retryCommandIds.delete(retryKey);
    state.memories.delete(recordId);
    if (state.replacing?.id === recordId) exitReplaceMode();
    renderPublicMemoryRecords();
  } catch (error) {
    showGlobalError(errorMessage(error));
  }
}

function wireRetractButton(button: HTMLButtonElement, recordId: string): void {
  let armed = false;
  let armTimer: number | null = null;
  const disarm = (): void => {
    armed = false;
    button.classList.remove("is-armed");
    button.textContent = "移除";
    if (armTimer !== null) {
      window.clearTimeout(armTimer);
      armTimer = null;
    }
  };
  button.addEventListener("click", () => {
    if (!armed) {
      armed = true;
      button.classList.add("is-armed");
      button.textContent = "确认移除";
      armTimer = window.setTimeout(disarm, 3_000);
      return;
    }
    disarm();
    void retractRecord(recordId);
  });
}

function activePublicMemories(): RecordView[] {
  return Array.from(state.memories.values())
    .filter((record) => record.status === "active" && record.scopeType === "room" && record.scopeId === state.roomId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function createRecordCard(record: RecordView): HTMLLIElement {
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
    if (record.createdAt) {
      source.title = formatFullTime(record.createdAt);
    }
    meta.append(kind, source);
    const content = document.createElement("p");
    content.className = "record-content";
    content.textContent = record.content;

    const actions = document.createElement("div");
    actions.className = "record-actions";
    const replace = document.createElement("button");
    replace.type = "button";
    replace.className = "text-button";
    replace.textContent = "替换";
    replace.addEventListener("click", () => enterReplaceMode(record));
    const retract = document.createElement("button");
    retract.type = "button";
    retract.className = "text-button danger-text";
    retract.textContent = "移除";
    wireRetractButton(retract, record.id);
    actions.append(replace, retract);

    item.append(meta, content, actions);
    return item;
}

function renderPublicMemoryRecords(): void {
  const records = activePublicMemories();
  memoryList.replaceChildren(...records.map(createRecordCard));
  publicMemoryCount.textContent = String(records.length);
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

function publicMemoryPagePath(cursor: number | undefined): string {
  const query = new URLSearchParams({ scopeType: "room", scopeId: state.roomId });
  if (cursor !== undefined) {
    query.set("cursor", String(cursor));
  }
  return `/api/memory?${query.toString()}`;
}

async function loadMemoryRecords(): Promise<void> {
  try {
    const records = await collectCursorPages(async (cursor) => {
      const response = await requestJson<unknown>(publicMemoryPagePath(cursor));
      const items = extractCollection(response, ["memory", "memories", "records", "items"]);
      const nextCursor = nextCursorFromPage(response);
      return nextCursor === undefined ? { items } : { items, nextCursor };
    });
    for (const value of records) {
      const record = normalizeRecord(value, false);
      if (record) {
        state.memories.set(record.id, record);
      }
    }
    renderPublicMemoryRecords();
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
  return targetInputs().filter((input) => input.checked && !input.disabled).map((input) => input.value);
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
    clearDraft();
    updateCharacterCount();
    autoresizeComposer();
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
  const replacing = state.replacing;
  memorySubmit.disabled = true;
  const retryKey = replacing
    ? `supersede-memory:${replacing.id}:${memoryKind.value}:${content}`
    : `memory:${state.roomId}:${memoryKind.value}:${content}`;
  try {
    const response = await requestJson<unknown>(
      replacing
        ? `/api/memory/${encodeURIComponent(replacing.id)}/supersede`
        : "/api/memory",
      {
        method: "POST",
        body: JSON.stringify(
          replacing
            ? {
                clientCommandId: retryableCommandId(retryKey, "web-supersede"),
                kind: memoryKind.value,
                content,
              }
            : {
                clientCommandId: retryableCommandId(retryKey, "web-memory"),
                scope: { type: "room", id: state.roomId },
                kind: memoryKind.value,
                content,
              }
        ),
      }
    );
    const memory = isRecord(response) ? normalizeRecord(response.memory, false) : null;
    if (memory) {
      if (replacing) {
        state.memories.delete(replacing.id);
      }
      state.memories.set(memory.id, memory);
      renderPublicMemoryRecords();
    }
    retryCommandIds.delete(retryKey);
    memoryInput.value = "";
    if (replacing) {
      exitReplaceMode();
    }
  } catch (error) {
    showGlobalError(errorMessage(error));
  } finally {
    memorySubmit.disabled = false;
  }
}

function syncTargetAll(): void {
  const selectableTargets = targetInputs().filter((input) => state.agents.get(input.value)?.enabled !== false);
  targetAll.checked = selectableTargets.length > 0 && selectableTargets.every((input) => input.checked);
  targetAll.indeterminate = selectableTargets.some((input) => input.checked) && !targetAll.checked;
  targetAll.disabled = state.submitting || selectableTargets.length === 0;
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

function refreshEmptyStateCopy(): void {
  if (!timelineEmpty.isConnected) {
    return;
  }
  const heading = timelineEmpty.querySelector("h3");
  const paragraph = timelineEmpty.querySelector("p");
  if (heading) {
    heading.textContent = "房间已就绪";
  }
  if (paragraph) {
    paragraph.textContent = "保持 @all 并行提问,或只勾选一个 Agent 单独对话。";
  }
}

async function refreshHealth(): Promise<void> {
  try {
    const health = await requestJson<unknown>("/api/health");
    if (!isRecord(health)) {
      return;
    }
    const store = isRecord(health.store) ? health.store : null;
    const available = store ? readBooleanField(store, true, "available") : true;
    const integrityOk = store ? readBooleanField(store, true, "integrityOk") : true;
    const activeTurns = readNumberField(health, "activeTurns") ?? 0;
    const queuedTurns = readNumberField(health, "queuedTurns") ?? 0;
    const healthy = available && integrityOk;
    connectionStatus.dataset.health = healthy ? "ok" : "degraded";
    connectionStatus.title = healthy
      ? `存储正常 · 活跃回合 ${activeTurns} · 排队 ${queuedTurns}`
      : "存储不可用或完整性检查未通过";
  } catch {
    connectionStatus.dataset.health = "unknown";
    connectionStatus.title = "健康检查失败";
  }
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
    refreshEmptyStateCopy();
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
  renderPublicMemoryRecords();
  try {
    const decoded = await requestJson<unknown>("/api/bootstrap");
    if (!isRecord(decoded)) {
      throw new ApiFailure("INVALID_BOOTSTRAP", "bootstrap 响应不是对象", 500);
    }
    const room = isRecord(decoded.room) ? decoded.room : {};
    state.roomId = readStringField(room, "roomId") || readStringField(decoded, "roomId") || DEFAULT_ROOM_ID;
    roomLabel.textContent = state.roomId;

    state.agents.clear();
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
    renderPublicMemoryRecords();

    const throughSeq = readNumberField(room, "throughSeq") ?? readNumberField(decoded, "throughSeq") ?? 0;
    if (Number.isSafeInteger(throughSeq) && throughSeq >= 0) {
      state.lastDurableSeq = Math.max(state.lastDurableSeq, throughSeq);
    }

    void loadMemoryRecords();
    void refreshContextUsage();
    connectEventSource(supportedEventTypesFromBootstrap(decoded));
    void refreshHealth();
    if (healthTimer === null) {
      healthTimer = window.setInterval(() => {
        void refreshHealth();
      }, HEALTH_POLL_MS);
    }
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
  updateCharacterCount();
  syncSendButton();
  autoresizeComposer();
  saveDraft();
  invalidatePendingSubmission();
  if (messageInput.value.length <= MESSAGE_MAX_LENGTH) {
    setComposerStatus(COMPOSER_HINT);
  }
});

messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.replyToEventId) {
    clearReply();
    return;
  }
  if (event.key !== "Enter" || event.isComposing) {
    return;
  }
  if (event.shiftKey) {
    return;
  }
  event.preventDefault();
  if (messageInput.value.trim().length === 0) {
    return;
  }
  composer.requestSubmit();
});

targetAll.addEventListener("change", () => {
  for (const input of targetInputs()) {
    if (!input.disabled) {
      input.checked = targetAll.checked;
    }
  }
  targetAll.indeterminate = false;
  invalidatePendingSubmission();
});

clearReplyButton.addEventListener("click", clearReply);

compactContextButton.addEventListener("click", () => {
  void compactCurrentContext();
});

jumpLatest.addEventListener("click", () => {
  timeline.scrollTo({ top: timeline.scrollHeight, behavior: "smooth" });
  resetJumpLatest();
});

timeline.addEventListener("scroll", () => {
  if (isTimelineNearBottom()) {
    resetJumpLatest();
  }
});

memoryForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitMemory();
});

byId<HTMLButtonElement>("memory-replace-cancel").addEventListener("click", () => {
  exitReplaceMode();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    unreadCount = 0;
    document.title = BASE_TITLE;
  }
});

type ThemeName = "light" | "dark";

function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset.theme = theme;
  const toDark = theme !== "dark";
  themeToggle.textContent = toDark ? "☾" : "☀";
  const label = toDark ? "切换到夜间模式" : "切换到日间模式";
  themeToggle.setAttribute("aria-label", label);
  themeToggle.title = label;
}

function initTheme(): void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(THEME_STORAGE_KEY);
  } catch {
    // localStorage may be unavailable; theme preference is best-effort
  }
  applyTheme(stored === "dark" ? "dark" : "light");
}

themeToggle.addEventListener("click", () => {
  const next: ThemeName = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  applyTheme(next);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, next);
  } catch {
    // localStorage may be unavailable; theme preference is best-effort
  }
});

initTheme();
restoreDraft();
updateCharacterCount();
autoresizeComposer();
syncSendButton();

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
  if (healthTimer !== null) {
    window.clearInterval(healthTimer);
  }
  if (contextUsageRefreshTimer !== null) {
    window.clearTimeout(contextUsageRefreshTimer);
  }
});

void bootstrap();
