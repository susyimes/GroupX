import { collectCursorPages } from "./pagination.js";

type AgentDriver = "codex" | "grok" | "kimi" | "hermes";

interface AgentDraft {
  id: string;
  driver: AgentDriver;
  name: string;
  identity?: string;
  command: {
    executable: string;
    prefixArgs: string[];
  };
  cwd: string;
  enabled: boolean;
}

interface ConfigDraft {
  serverPort: number;
  storagePath: string;
  agents: AgentDraft[];
}

interface SetupSnapshot {
  configPath: string;
  existing: boolean;
  runtimeActive: boolean;
  drivers: Array<{ driver: AgentDriver; found: boolean }>;
  config: ConfigDraft;
  existingConfigError?: string;
}

interface SaveResponse {
  saved: true;
  configPath: string;
  agentCount: number;
  enabledAgentCount: number;
  restartRequired: boolean;
}

interface ErrorResponse {
  error?: {
    code?: string;
    message?: string;
    details?: {
      issues?: Array<{ path?: string; code?: string }>;
    };
  };
}

interface DriverMeta {
  label: string;
  short: string;
  tone: string;
}

interface AgentMemoryRecord {
  memoryId: string;
  actorId: string;
  agentMemoryType: "core" | "dated";
  kind: string;
  content: string;
  createdAt: string;
  status: string;
}

const DRIVER_META: Readonly<Record<AgentDriver, DriverMeta>> = {
  codex: { label: "Codex App Server", short: "CO", tone: "#3370ff" },
  grok: { label: "Grok ACP", short: "GR", tone: "#a348c5" },
  kimi: { label: "Kimi ACP", short: "KI", tone: "#0c9667" },
  hermes: { label: "Hermes ACP", short: "HE", tone: "#d97706" }
};

const THEME_KEY = "groupx-theme";
const loadingState = requiredElement<HTMLDivElement>("loading-state");
const form = requiredElement<HTMLFormElement>("setup-form");
const agentList = requiredElement<HTMLDivElement>("agent-list");
const template = requiredElement<HTMLTemplateElement>("agent-card-template");
const formError = requiredElement<HTMLDivElement>("form-error");
const existingBanner = requiredElement<HTMLDivElement>("existing-banner");
const driverProbes = requiredElement<HTMLDivElement>("driver-probes");
const serverPort = requiredElement<HTMLInputElement>("server-port");
const storagePath = requiredElement<HTMLInputElement>("storage-path");
const configPath = requiredElement<HTMLSpanElement>("config-path");
const saveButton = requiredElement<HTMLButtonElement>("save-button");
const backRoom = requiredElement<HTMLAnchorElement>("back-room");
const successState = requiredElement<HTMLElement>("success-state");
const successMark = requiredElement<HTMLElement>("success-mark");
const successEyebrow = requiredElement<HTMLParagraphElement>("success-eyebrow");
const successTitle = requiredElement<HTMLHeadingElement>("success-title");
const successCopy = requiredElement<HTMLParagraphElement>("success-copy");
const savedPath = requiredElement<HTMLElement>("saved-path");
const successRoomLink = requiredElement<HTMLAnchorElement>("success-room-link");
const editAgain = requiredElement<HTMLButtonElement>("edit-again");
const themeToggle = requiredElement<HTMLButtonElement>("theme-toggle");

let snapshot: SetupSnapshot | undefined;
let agents: AgentDraft[] = [];
let saving = false;
let agentMemoriesLoading = false;
let agentMemoriesLoaded = false;
let agentMemoriesError = "";
const runtimeAgentIds = new Set<string>();
const agentMemories = new Map<string, AgentMemoryRecord>();
const replacingMemoryIds = new Map<string, string>();
const memoryRetryIds = new Map<string, string>();

interface SetupLaunchState {
  status: "waiting" | "ready" | "failed";
  origin?: string;
  message?: string;
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing setup element: ${id}`);
  }
  return element as T;
}

function isDriver(value: string): value is AgentDriver {
  return value === "codex" || value === "grok" || value === "kimi" || value === "hermes";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringField(value: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string") return candidate;
  }
  return "";
}

function actorIdForAgent(agent: AgentDraft): string {
  return `agent:${agent.id}`;
}

function makeClientCommandId(prefix: string): string {
  return `${prefix}-${globalThis.crypto.randomUUID()}`;
}

function retryableMemoryCommandId(key: string, prefix: string): string {
  const existing = memoryRetryIds.get(key);
  if (existing) return existing;
  const created = makeClientCommandId(prefix);
  memoryRetryIds.set(key, created);
  return created;
}

function cloneAgent(agent: AgentDraft): AgentDraft {
  return {
    ...agent,
    command: { executable: agent.command.executable, prefixArgs: [...agent.command.prefixArgs] }
  };
}

function uniqueId(driver: AgentDriver): string {
  const used = new Set(agents.map((agent) => agent.id));
  if (!used.has(driver)) return driver;
  for (let index = 2; index < 10_000; index += 1) {
    const candidate = `${driver}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${driver}-${Date.now()}`;
}

function addAgent(driver: AgentDriver): void {
  agents.push({
    id: uniqueId(driver),
    driver,
    name: "",
    identity: "",
    command: { executable: driver, prefixArgs: [] },
    cwd: ".",
    enabled: true
  });
  renderAgents();
  const card = agentList.lastElementChild;
  card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  card?.querySelector<HTMLInputElement>(".agent-name")?.focus();
}

function updateCardHeading(card: HTMLElement, agent: AgentDraft): void {
  const meta = DRIVER_META[agent.driver];
  const avatar = card.querySelector<HTMLElement>(".agent-avatar");
  const title = card.querySelector<HTMLElement>(".agent-card-title strong");
  const actor = card.querySelector<HTMLElement>(".actor-preview");
  if (avatar) {
    avatar.textContent = meta.short;
    avatar.style.setProperty("--agent-tone", meta.tone);
  }
  if (title) title.textContent = agent.name.trim() || meta.label;
  if (actor) actor.textContent = `agent:${agent.id || "…"}`;
}

function validateDuplicateIds(): boolean {
  const counts = new Map<string, number>();
  for (const agent of agents) counts.set(agent.id, (counts.get(agent.id) ?? 0) + 1);
  let valid = true;
  for (const input of agentList.querySelectorAll<HTMLInputElement>(".agent-id")) {
    const duplicate = (counts.get(input.value) ?? 0) > 1;
    input.setCustomValidity(duplicate ? "稳定 ID 不能重复" : "");
    if (duplicate) valid = false;
  }
  return valid;
}

function normalizeAgentMemory(value: unknown): AgentMemoryRecord | null {
  if (!isRecord(value) || !isRecord(value.scope)) return null;
  const memoryId = readStringField(value, "memoryId");
  const actorId = readStringField(value.scope, "id");
  const content = readStringField(value, "content");
  if (!memoryId || !actorId.startsWith("agent:") || !content) return null;
  return {
    memoryId,
    actorId,
    agentMemoryType: readStringField(value, "agentMemoryType") === "dated" ? "dated" : "core",
    kind: readStringField(value, "kind") || "note",
    content,
    createdAt: readStringField(value, "createdAt"),
    status: readStringField(value, "status") || "active"
  };
}

function extractMemoryItems(value: unknown): unknown[] {
  if (!isRecord(value)) return [];
  return Array.isArray(value.items) ? value.items : [];
}

function nextMemoryCursor(value: unknown): number | undefined {
  if (!isRecord(value) || value.nextCursor === undefined) return undefined;
  return typeof value.nextCursor === "number" && Number.isSafeInteger(value.nextCursor) && value.nextCursor >= 0
    ? value.nextCursor
    : undefined;
}

async function requestJson(path: string, options: RequestInit = {}): Promise<unknown> {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) throw new Error(await readError(response));
  return response.json() as Promise<unknown>;
}

function localDateHeading(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "日期未知";
  const now = new Date();
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (day === today) return "今天";
  if (day === today - 86_400_000) return "昨天";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(date);
}

function memoriesForActor(actorId: string): AgentMemoryRecord[] {
  return Array.from(agentMemories.values())
    .filter((record) => record.status === "active" && record.actorId === actorId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function renderAgentMemoryCard(card: HTMLElement, agent: AgentDraft): void {
  const actorId = actorIdForAgent(agent);
  const status = card.querySelector<HTMLElement>(".agent-memory-status");
  const count = card.querySelector<HTMLElement>(".agent-memory-count");
  const groups = card.querySelector<HTMLElement>(".agent-memory-groups");
  const editor = card.querySelector<HTMLElement>(".agent-memory-editor");
  const kind = card.querySelector<HTMLSelectElement>(".agent-memory-kind");
  const input = card.querySelector<HTMLTextAreaElement>(".agent-memory-input");
  const submit = card.querySelector<HTMLButtonElement>(".agent-memory-submit");
  const banner = card.querySelector<HTMLElement>(".agent-memory-replace-banner");
  const cancel = card.querySelector<HTMLButtonElement>(".agent-memory-replace-cancel");
  if (!status || !count || !groups || !editor || !kind || !input || !submit || !banner || !cancel) {
    throw new Error("Incomplete Agent memory template");
  }
  const records = memoriesForActor(actorId);
  count.textContent = String(records.length);
  groups.replaceChildren();
  const available = snapshot?.runtimeActive === true && runtimeAgentIds.has(agent.id);
  editor.hidden = !available;
  if (!snapshot?.runtimeActive) {
    status.textContent = "首次启动后可在这里管理核心记忆，并查看自动日期记忆。";
  } else if (!runtimeAgentIds.has(agent.id)) {
    status.textContent = "这是新增或改名的 Agent；保存并重启后即可使用两层记忆。";
  } else if (agentMemoriesLoading) {
    status.textContent = "正在读取独立记忆…";
  } else if (agentMemoriesError) {
    status.textContent = agentMemoriesError;
  } else if (records.length === 0) {
    status.textContent = "还没有核心记忆或自动日期记忆。";
  } else {
    status.textContent = "核心记忆长期保留；成功回合会在安静窗口后批量整理为每日记忆。两者都只进入这个 Agent 的上下文。";
  }

  const appendRecord = (
    list: HTMLUListElement,
    record: AgentMemoryRecord,
    allowReplace: boolean
  ): void => {
    const item = document.createElement("li");
    const meta = document.createElement("div");
    meta.className = "agent-memory-record-meta";
    const badge = document.createElement("span");
    badge.textContent = record.kind;
    const actions = document.createElement("span");
    if (allowReplace) {
      const replace = document.createElement("button");
      replace.type = "button";
      replace.textContent = "替换";
      replace.addEventListener("click", () => {
        replacingMemoryIds.set(actorId, record.memoryId);
        kind.value = record.kind;
        input.value = record.content;
        banner.hidden = false;
        submit.textContent = "保存替换";
        input.focus();
      });
      actions.append(replace);
    }
    const retract = document.createElement("button");
    retract.type = "button";
    retract.textContent = "移除";
    let retractArmed = false;
    let retractTimer: number | undefined;
    retract.addEventListener("click", () => {
      if (!retractArmed) {
        retractArmed = true;
        retract.textContent = "确认移除";
        retractTimer = window.setTimeout(() => {
          retractArmed = false;
          retract.textContent = "移除";
        }, 3_000);
        return;
      }
      if (retractTimer !== undefined) window.clearTimeout(retractTimer);
      void retractAgentMemory(record);
    });
    actions.append(retract);
    meta.append(badge, actions);
    const content = document.createElement("p");
    content.textContent = record.content;
    item.append(meta, content);
    list.append(item);
  };

  const coreRecords = records.filter((record) => record.agentMemoryType === "core");
  const datedRecords = records.filter((record) => record.agentMemoryType === "dated");
  if (coreRecords.length > 0) {
    const section = document.createElement("section");
    section.className = "agent-memory-date-group agent-memory-core-group";
    const title = document.createElement("h4");
    title.textContent = "核心记忆";
    const list = document.createElement("ul");
    for (const record of coreRecords) appendRecord(list, record, true);
    section.append(title, list);
    groups.append(section);
  }

  const datedHeading = document.createElement("h4");
  datedHeading.className = "agent-memory-layer-heading";
  datedHeading.textContent = "按日期自动记忆";
  if (datedRecords.length > 0) groups.append(datedHeading);
  const byDate = new Map<string, AgentMemoryRecord[]>();
  for (const record of datedRecords) {
    const heading = localDateHeading(record.createdAt);
    const group = byDate.get(heading) ?? [];
    group.push(record);
    byDate.set(heading, group);
  }
  for (const [heading, recordsForDate] of byDate) {
    const section = document.createElement("section");
    section.className = "agent-memory-date-group";
    const title = document.createElement("h4");
    title.textContent = heading;
    const list = document.createElement("ul");
    for (const record of recordsForDate) appendRecord(list, record, false);
    section.append(title, list);
    groups.append(section);
  }

  cancel.onclick = () => {
    replacingMemoryIds.delete(actorId);
    banner.hidden = true;
    submit.textContent = "保存核心记忆";
    input.value = "";
  };
  submit.onclick = () => void saveAgentMemory(agent, { kind, input, submit, banner });
}

function refreshRenderedAgentMemoryCards(): void {
  const cards = Array.from(agentList.querySelectorAll<HTMLElement>(".agent-editor-card"));
  cards.forEach((card, index) => {
    const agent = agents[index];
    if (agent) renderAgentMemoryCard(card, agent);
  });
}

async function loadAgentMemories(): Promise<void> {
  if (agentMemoriesLoaded || agentMemoriesLoading || snapshot?.runtimeActive !== true) return;
  agentMemoriesLoading = true;
  refreshRenderedAgentMemoryCards();
  try {
    const values = await collectCursorPages(async (cursor) => {
      const query = new URLSearchParams({ scopeType: "agent" });
      if (cursor !== undefined) query.set("cursor", String(cursor));
      const page = await requestJson(`/api/memory?${query.toString()}`);
      const nextCursor = nextMemoryCursor(page);
      return nextCursor === undefined
        ? { items: extractMemoryItems(page) }
        : { items: extractMemoryItems(page), nextCursor };
    });
    agentMemories.clear();
    for (const value of values) {
      const record = normalizeAgentMemory(value);
      if (record) agentMemories.set(record.memoryId, record);
    }
    agentMemoriesLoaded = true;
    agentMemoriesError = "";
  } catch (error) {
    agentMemoriesError = error instanceof Error ? `独立记忆读取失败：${error.message}` : "独立记忆读取失败";
  } finally {
    agentMemoriesLoading = false;
    refreshRenderedAgentMemoryCards();
  }
}

async function saveAgentMemory(
  agent: AgentDraft,
  controls: { kind: HTMLSelectElement; input: HTMLTextAreaElement; submit: HTMLButtonElement; banner: HTMLElement }
): Promise<void> {
  const actorId = actorIdForAgent(agent);
  const content = controls.input.value.trim();
  if (!content || !runtimeAgentIds.has(agent.id)) {
    controls.input.focus();
    return;
  }
  const replacingId = replacingMemoryIds.get(actorId);
  const retryKey = replacingId
    ? `setup-supersede:${replacingId}:${controls.kind.value}:${content}`
    : `setup-memory:${actorId}:${controls.kind.value}:${content}`;
  controls.submit.disabled = true;
  try {
    const response = await requestJson(
      replacingId ? `/api/memory/${encodeURIComponent(replacingId)}/supersede` : "/api/memory",
      {
        method: "POST",
        body: JSON.stringify(replacingId
          ? { clientCommandId: retryableMemoryCommandId(retryKey, "setup-memory-replace"), kind: controls.kind.value, content }
          : {
              clientCommandId: retryableMemoryCommandId(retryKey, "setup-agent-memory"),
              scope: { type: "agent", id: actorId },
              subjectActorId: actorId,
              kind: controls.kind.value,
              content
            })
      }
    );
    const memory = isRecord(response) ? normalizeAgentMemory(response.memory) : null;
    if (memory) {
      if (replacingId) agentMemories.delete(replacingId);
      agentMemories.set(memory.memoryId, memory);
    }
    memoryRetryIds.delete(retryKey);
    replacingMemoryIds.delete(actorId);
    controls.input.value = "";
    controls.banner.hidden = true;
    controls.submit.textContent = "保存核心记忆";
    refreshRenderedAgentMemoryCards();
  } catch (error) {
    showError(error instanceof Error ? error.message : "保存 Agent 记忆失败");
  } finally {
    controls.submit.disabled = false;
  }
}

async function retractAgentMemory(record: AgentMemoryRecord): Promise<void> {
  const retryKey = `setup-retract:${record.memoryId}`;
  try {
    await requestJson(`/api/memory/${encodeURIComponent(record.memoryId)}/retract`, {
      method: "POST",
      body: JSON.stringify({ clientCommandId: retryableMemoryCommandId(retryKey, "setup-memory-retract") })
    });
    memoryRetryIds.delete(retryKey);
    agentMemories.delete(record.memoryId);
    replacingMemoryIds.delete(record.actorId);
    refreshRenderedAgentMemoryCards();
  } catch (error) {
    showError(error instanceof Error ? error.message : "移除 Agent 记忆失败");
  }
}

function renderAgents(): void {
  agentList.replaceChildren();
  agents.forEach((agent, index) => {
    const fragment = template.content.cloneNode(true) as DocumentFragment;
    const card = fragment.querySelector<HTMLElement>(".agent-editor-card");
    if (!card) throw new Error("Invalid Agent card template");
    const driverInput = card.querySelector<HTMLSelectElement>(".agent-driver");
    const idInput = card.querySelector<HTMLInputElement>(".agent-id");
    const nameInput = card.querySelector<HTMLInputElement>(".agent-name");
    const identityInput = card.querySelector<HTMLTextAreaElement>(".agent-identity");
    const cwdInput = card.querySelector<HTMLInputElement>(".agent-cwd");
    const commandInput = card.querySelector<HTMLInputElement>(".agent-command");
    const entrypointInput = card.querySelector<HTMLInputElement>(".agent-entrypoint");
    const enabledInput = card.querySelector<HTMLInputElement>(".agent-enabled");
    const removeButton = card.querySelector<HTMLButtonElement>(".remove-agent");
    if (!driverInput || !idInput || !nameInput || !identityInput || !cwdInput || !commandInput || !entrypointInput || !enabledInput || !removeButton) {
      throw new Error("Incomplete Agent card template");
    }

    driverInput.value = agent.driver;
    idInput.value = agent.id;
    nameInput.value = agent.name;
    identityInput.value = agent.identity ?? "";
    cwdInput.value = agent.cwd;
    commandInput.value = agent.command.executable;
    entrypointInput.value = agent.command.prefixArgs[0] ?? "";
    enabledInput.checked = agent.enabled;
    removeButton.disabled = agents.length === 1;
    updateCardHeading(card, agent);

    driverInput.addEventListener("change", () => {
      if (!isDriver(driverInput.value)) return;
      const previous = agent.driver;
      agent.driver = driverInput.value;
      if (agent.command.executable === previous && agent.command.prefixArgs.length === 0) {
        agent.command.executable = agent.driver;
      }
      if (agent.id === previous || new RegExp(`^${previous}-\\d+$`, "u").test(agent.id)) {
        agent.id = uniqueId(agent.driver);
      }
      renderAgents();
    });
    idInput.addEventListener("input", () => {
      agent.id = idInput.value;
      validateDuplicateIds();
      updateCardHeading(card, agent);
      renderAgentMemoryCard(card, agent);
    });
    nameInput.addEventListener("input", () => {
      agent.name = nameInput.value;
      updateCardHeading(card, agent);
    });
    identityInput.addEventListener("input", () => {
      agent.identity = identityInput.value;
    });
    cwdInput.addEventListener("input", () => {
      agent.cwd = cwdInput.value;
    });
    commandInput.addEventListener("input", () => {
      agent.command.executable = commandInput.value;
    });
    entrypointInput.addEventListener("input", () => {
      agent.command.prefixArgs = entrypointInput.value.trim().length === 0 ? [] : [entrypointInput.value];
    });
    enabledInput.addEventListener("change", () => {
      agent.enabled = enabledInput.checked;
      card.classList.toggle("is-disabled", !agent.enabled);
    });
    removeButton.addEventListener("click", () => {
      if (agents.length === 1) return;
      agents.splice(index, 1);
      renderAgents();
    });
    card.classList.toggle("is-disabled", !agent.enabled);
    renderAgentMemoryCard(card, agent);
    agentList.append(fragment);
  });
  validateDuplicateIds();
}

function renderProbes(probes: SetupSnapshot["drivers"]): void {
  driverProbes.replaceChildren();
  for (const probe of probes) {
    const item = document.createElement("span");
    item.className = `probe${probe.found ? " is-found" : ""}`;
    item.textContent = `${DRIVER_META[probe.driver].label} · ${probe.found ? "已找到" : "未找到"}`;
    driverProbes.append(item);
  }
}

function showError(message: string): void {
  formError.textContent = message;
  formError.hidden = false;
  formError.scrollIntoView({ block: "nearest" });
}

function clearError(): void {
  formError.textContent = "";
  formError.hidden = true;
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json() as ErrorResponse;
    const issues = body.error?.details?.issues
      ?.map((issue) => {
        const code = issue.code === undefined ? undefined : COMMAND_ERROR_LABELS[issue.code] ?? issue.code;
        return [issue.path, code].filter(Boolean).join(": ");
      })
      .filter((issue) => issue.length > 0);
    if (issues && issues.length > 0) return issues.join("；");
    return body.error?.message ?? `保存失败（HTTP ${response.status}）`;
  } catch {
    return `保存失败（HTTP ${response.status}）`;
  }
}

function isLoopbackOrigin(value: string | undefined): value is string {
  if (value === undefined) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port.length > 0;
  } catch {
    return false;
  }
}

async function waitForLaunch(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("/api/setup/launch", {
        headers: { Accept: "application/json" },
        cache: "no-store"
      });
      if (response.ok) {
        const state = await response.json() as SetupLaunchState;
        if (state.status === "ready" && isLoopbackOrigin(state.origin)) {
          successMark.classList.remove("is-loading");
          successMark.textContent = "✓";
          successEyebrow.textContent = "GroupX ready";
          successTitle.textContent = "房间已启动";
          successCopy.textContent = "正在进入群聊…";
          window.location.replace(`${new URL(state.origin).origin}/`);
          return;
        }
        if (state.status === "failed") {
          successMark.classList.remove("is-loading");
          successMark.classList.add("is-error");
          successMark.textContent = "!";
          successEyebrow.textContent = "Launch failed";
          successTitle.textContent = "配置已保存，但启动失败";
          successCopy.textContent = state.message ?? "请查看终端中的诊断信息，然后运行 groupx start。";
          return;
        }
      }
    } catch {
      // The temporary setup server may briefly hand over to the main runtime.
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
  }
  successMark.classList.remove("is-loading");
  successMark.classList.add("is-error");
  successMark.textContent = "!";
  successEyebrow.textContent = "Launch timeout";
  successTitle.textContent = "等待启动超时";
  successCopy.textContent = "配置已经保存。请查看终端诊断，或运行 groupx start 后进入群聊。";
}

const COMMAND_ERROR_LABELS: Readonly<Record<string, string>> = {
  executable_not_found: "未找到可执行文件",
  native_executable_not_found: "未找到原生 CLI 可执行文件",
  npm_entrypoint_not_found: "未找到全局 npm CLI 入口",
  node_runtime_not_found: "未找到可用 Node.js runtime",
  node_entrypoint_required: "Node.js 命令需要填写 CLI 入口",
  entrypoint_not_found: "未找到 Node CLI 入口",
  javascript_entrypoint_required: "CLI 入口必须是 .js/.mjs/.cjs 文件",
  prefix_args_require_node: "只有 Node.js 命令可以填写 CLI 入口",
  shell_wrapper_forbidden: "不能使用 .cmd/.bat/.ps1 shell wrapper"
};

async function loadSetup(): Promise<void> {
  try {
    const response = await fetch("/api/setup", { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(await readError(response));
    snapshot = await response.json() as SetupSnapshot;
    agents = snapshot.config.agents.map(cloneAgent);
    runtimeAgentIds.clear();
    for (const agent of snapshot.config.agents) runtimeAgentIds.add(agent.id);
    serverPort.value = String(snapshot.config.serverPort);
    storagePath.value = snapshot.config.storagePath;
    configPath.textContent = snapshot.configPath;
    configPath.title = snapshot.configPath;
    renderProbes(snapshot.drivers);
    renderAgents();
    if (snapshot.runtimeActive) {
      backRoom.hidden = false;
      successRoomLink.hidden = false;
    }
    const banner = snapshot.existingConfigError
      ?? (snapshot.existing
        ? snapshot.runtimeActive
          ? "已载入当前 Agent 名册。保存后需要重启 GroupX，当前房间不会在运行中换绑。"
          : "已载入现有 groupx.json；保存会更新这份配置。"
        : undefined);
    if (banner) {
      existingBanner.textContent = banner;
      existingBanner.hidden = false;
    }
    loadingState.hidden = true;
    form.hidden = false;
    void loadAgentMemories();
  } catch (error) {
    loadingState.hidden = true;
    form.hidden = false;
    showError(error instanceof Error ? error.message : "无法读取 GroupX 配置");
  }
}

async function saveSetup(): Promise<void> {
  if (!snapshot || saving) return;
  clearError();
  validateDuplicateIds();
  if (!form.reportValidity()) return;
  if (!agents.some((agent) => agent.enabled)) {
    showError("至少启用一个 Agent。你也可以保留其他 Agent 为停用状态。");
    return;
  }
  const port = Number(serverPort.value);
  const config: ConfigDraft = {
    serverPort: port,
    storagePath: storagePath.value,
    agents: agents.map(cloneAgent)
  };
  saving = true;
  saveButton.disabled = true;
  saveButton.textContent = "正在验证并保存…";
  try {
    const response = await fetch("/api/setup", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ config })
    });
    if (!response.ok) throw new Error(await readError(response));
    const result = await response.json() as SaveResponse;
    form.hidden = true;
    successState.hidden = false;
    savedPath.textContent = result.configPath;
    savedPath.title = result.configPath;
    if (result.restartRequired) {
      successCopy.textContent = `已保存 ${result.agentCount} 个 Agent（${result.enabledAgentCount} 个启用）。返回群聊会立即显示新名册；新增 Agent 将标记为等待重启。`;
      editAgain.hidden = false;
    } else {
      successMark.textContent = "";
      successMark.classList.add("is-loading");
      successEyebrow.textContent = "Starting GroupX";
      successTitle.textContent = "配置已保存，正在启动房间";
      successCopy.textContent = `已保存 ${result.agentCount} 个 Agent（${result.enabledAgentCount} 个启用）。服务就绪后会自动进入群聊。`;
      editAgain.hidden = true;
      void waitForLaunch();
    }
  } catch (error) {
    showError(error instanceof Error ? error.message : "保存失败");
  } finally {
    saving = false;
    saveButton.disabled = false;
    saveButton.textContent = "保存配置";
  }
}

function applyTheme(theme: "light" | "dark"): void {
  document.documentElement.dataset.theme = theme;
  themeToggle.textContent = theme === "dark" ? "☀" : "☾";
  themeToggle.setAttribute("aria-label", theme === "dark" ? "切换到日间模式" : "切换到夜间模式");
}

function initializeTheme(): void {
  const stored = localStorage.getItem(THEME_KEY);
  applyTheme(stored === "dark" || (stored !== "light" && matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light");
  themeToggle.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveSetup();
});
document.querySelectorAll<HTMLButtonElement>("[data-add-driver]").forEach((button) => {
  button.addEventListener("click", () => {
    const driver = button.dataset.addDriver;
    if (driver && isDriver(driver)) addAgent(driver);
  });
});
requiredElement<HTMLButtonElement>("add-agent").addEventListener("click", () => addAgent("codex"));
editAgain.addEventListener("click", () => {
  successState.hidden = true;
  form.hidden = false;
  clearError();
});

initializeTheme();
void loadSetup();
