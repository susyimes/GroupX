import { createStructuredAgentAdapter } from "./adapter-factory.js";
import type { CliAdapter, NativeSession } from "../adapters/types.js";
import type { GroupXConfig } from "../config.js";
import type {
  AssistantConversationMessage,
  AssistantMessageAccepted,
  AssistantSnapshot,
  AssistantStatus
} from "../contracts/assistant.js";
import {
  ASSISTANT_ACTOR_ID,
  ASSISTANT_BRAIN_AGENT_ID,
  ASSISTANT_DEFAULT_NAME,
  LOCAL_OPERATOR_BINDING_ID,
  OPERATOR_MCP_PATH,
  buildAssistantPrompt
} from "../core/assistant.js";
import { createCorrelationId, createId } from "../core/envelope.js";
import { GroupXError, toGroupXError } from "../core/errors.js";
import type { GroupXStore } from "../storage/types.js";

export interface OperatorBrain {
  status(): AssistantStatus;
  detail(): string | undefined;
  start(origin: string): Promise<void>;
  prompt(text: string, signal: AbortSignal): Promise<string>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export class DisabledOperatorBrain implements OperatorBrain {
  status(): AssistantStatus {
    return "disabled";
  }
  detail(): string | undefined {
    return undefined;
  }
  async start(): Promise<void> {}
  async prompt(): Promise<string> {
    throw new GroupXError("SESSION_NOT_AVAILABLE", "The room assistant is not enabled");
  }
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
}

export class CliOperatorBrain implements OperatorBrain {
  readonly #config: GroupXConfig;
  #adapter: CliAdapter | undefined;
  #session: NativeSession | undefined;
  #origin: string | undefined;
  #state: AssistantStatus = "starting";
  #detail: string | undefined;
  #fatal = false;
  #cancelNativeTurnId: string | undefined;

  constructor(config: GroupXConfig) {
    this.#config = config;
  }

  status(): AssistantStatus {
    return this.#state;
  }

  detail(): string | undefined {
    return this.#detail;
  }

  async start(origin: string): Promise<void> {
    this.#origin = origin;
    const assistant = this.#config.assistant;
    if (assistant === undefined || !assistant.enabled) {
      this.#state = "disabled";
      return;
    }
    await this.#startHarness(origin);
  }

  async prompt(text: string, signal: AbortSignal): Promise<string> {
    if (this.#state === "disabled") {
      throw new GroupXError("SESSION_NOT_AVAILABLE", "The room assistant is not enabled");
    }
    if (this.#needsReopen()) {
      await this.#reopen();
    }
    if (!this.#adapter || !this.#session || this.#state === "failed") {
      throw new GroupXError(
        "SESSION_NOT_AVAILABLE",
        this.#detail ?? "The room assistant harness is not ready"
      );
    }
    try {
      return await this.#promptOnce(text, signal);
    } catch (error) {
      const normalized = toGroupXError(error, "SESSION_NOT_AVAILABLE");
      if (normalized.code === "UNEXPECTED_NATIVE_INTERACTION") {
        this.#fatal = true;
        this.#state = "failed";
        this.#detail = "The assistant brain requested a native interaction and was stopped.";
        throw new GroupXError("SESSION_NOT_AVAILABLE", this.#detail);
      }
      if (normalized.code === "TURN_INTERRUPTED" || signal.aborted) {
        throw error;
      }
      if (this.#canReopen(normalized)) {
        await this.#reopen();
        return await this.#promptOnce(text, signal);
      }
      throw error;
    }
  }

  async cancel(): Promise<void> {
    if (!this.#adapter || !this.#session || this.#cancelNativeTurnId === undefined) return;
    await this.#adapter.cancel(this.#session, this.#cancelNativeTurnId).catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.#adapter && this.#session) {
      await this.#adapter.close(this.#session).catch(() => undefined);
    }
    this.#adapter = undefined;
    this.#session = undefined;
    if (this.#state !== "disabled") this.#state = "failed";
  }

  async #startHarness(origin: string): Promise<void> {
    const assistant = this.#config.assistant;
    if (assistant === undefined || !assistant.enabled) {
      this.#state = "disabled";
      return;
    }
    this.#state = "starting";
    try {
      const adapter = createStructuredAgentAdapter(
        ASSISTANT_BRAIN_AGENT_ID,
        assistant.brain.driver,
        this.#config.timeouts
      );
      const session = await adapter.start({
        command: assistant.brain.command.executable,
        prefixArgs: assistant.brain.command.prefixArgs,
        cwd: assistant.brain.cwd,
        instanceId: "instance:assistant-brain",
        bindingId: LOCAL_OPERATOR_BINDING_ID,
        brokerUrl: `${origin}${OPERATOR_MCP_PATH}`,
        mcp: { transport: "streamable-http", url: `${origin}${OPERATOR_MCP_PATH}` }
      });
      this.#adapter = adapter;
      this.#session = session;
      this.#state = "ready";
      this.#detail = undefined;
    } catch (error) {
      this.#state = "failed";
      this.#detail = toGroupXError(error, "ADAPTER_START_FAILED").message.slice(0, 500);
    }
  }

  async #reopen(): Promise<void> {
    if (this.#adapter && this.#session) {
      await this.#adapter.close(this.#session).catch(() => undefined);
    }
    this.#adapter = undefined;
    this.#session = undefined;
    if (this.#origin === undefined) {
      this.#state = "failed";
      this.#detail = "The room assistant harness is not ready";
      throw new GroupXError("SESSION_NOT_AVAILABLE", this.#detail);
    }
    await this.#startHarness(this.#origin);
    if (this.#state === "failed" || !this.#adapter || !this.#session) {
      throw new GroupXError(
        "SESSION_NOT_AVAILABLE",
        this.#detail ?? "The room assistant harness is not ready"
      );
    }
  }

  #needsReopen(): boolean {
    if (this.#fatal || this.#state === "disabled") return false;
    if (!this.#adapter || !this.#session) return this.#origin !== undefined;
    const health = this.#adapter.health();
    return health.status === "failed" || health.status === "stopped";
  }

  #canReopen(error: GroupXError): boolean {
    if (this.#fatal || this.#origin === undefined) return false;
    if (error.message.includes("returned no text")) return false;
    return (
      error.code === "SESSION_NOT_AVAILABLE" ||
      error.code === "PROTOCOL_INVALID_MESSAGE" ||
      error.code === "ADAPTER_START_FAILED" ||
      /stdout line exceeded|line_too_large|requires restart/i.test(error.message)
    );
  }

  async #promptOnce(text: string, signal: AbortSignal): Promise<string> {
    if (!this.#adapter || !this.#session) {
      throw new GroupXError(
        "SESSION_NOT_AVAILABLE",
        this.#detail ?? "The room assistant harness is not ready"
      );
    }
    this.#state = "busy";
    let collected = "";
    try {
      const turnId = createId("asst_turn");
      this.#cancelNativeTurnId = undefined;
      for await (const event of this.#adapter.prompt(this.#session, {
        turnId,
        content: text,
        correlationId: createCorrelationId(),
        signal
      })) {
        if (event.nativeTurnId) this.#cancelNativeTurnId = event.nativeTurnId;
        if (event.type === "content.delta") {
          const chunk = stringPayload(event.payload, "text", "content", "delta");
          if (chunk) collected += chunk;
        }
        if (event.type === "turn.completed") {
          collected = stringPayload(event.payload, "content", "text", "message") ?? collected;
        }
        if (event.type === "turn.failed" || event.type === "transport.error") {
          throw new GroupXError(
            "SESSION_NOT_AVAILABLE",
            stringPayload(event.payload, "message", "error", "detail") ??
              "The assistant brain failed this turn"
          );
        }
        if (event.type === "turn.cancelled") {
          throw new GroupXError("TURN_INTERRUPTED", "The assistant turn was cancelled");
        }
      }
      this.#state = "ready";
      const trimmed = collected.trim();
      if (trimmed.length === 0) {
        throw new GroupXError("PROTOCOL_INVALID_MESSAGE", "The assistant brain returned no text");
      }
      return trimmed;
    } catch (error) {
      if (this.#state === "busy") this.#state = "ready";
      throw error;
    } finally {
      this.#cancelNativeTurnId = undefined;
    }
  }
}

function stringPayload(payload: unknown, ...names: string[]): string | undefined {
  if (typeof payload === "string") return payload;
  if (payload === null || typeof payload !== "object") return undefined;
  for (const name of names) {
    const value = (payload as Record<string, unknown>)[name];
    if (typeof value === "string") return value;
  }
  return undefined;
}

export interface AssistantHost {
  snapshot(): AssistantSnapshot;
  listMessages(): AssistantConversationMessage[];
  postMessage(
    input: { clientCommandId: string; content: string },
    signal: AbortSignal
  ): Promise<AssistantMessageAccepted>;
  cancel(clientCommandId?: string): Promise<{ accepted: boolean }>;
  start(origin: string): Promise<void>;
  close(): Promise<void>;
}

export interface GroupXAssistantHostOptions {
  config: GroupXConfig;
  store: Pick<
    GroupXStore,
    | "appendAssistantMessage"
    | "listAssistantMessages"
    | "getAssistantMessageByClientCommandId"
    | "getAssistantReplyAfter"
    | "upsertActor"
  >;
  brain?: OperatorBrain;
}

export class GroupXAssistantHost implements AssistantHost {
  readonly #config: GroupXConfig;
  readonly #store: GroupXAssistantHostOptions["store"];
  readonly #brain: OperatorBrain;
  #inflight: AbortController | undefined;
  readonly #commandFlights = new Map<string, Promise<AssistantMessageAccepted>>();
  #started = false;

  constructor(options: GroupXAssistantHostOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#brain =
      options.brain ??
      (options.config.assistant?.enabled === true
        ? new CliOperatorBrain(options.config)
        : new DisabledOperatorBrain());
    const name = options.config.assistant?.name ?? ASSISTANT_DEFAULT_NAME;
    this.#store.upsertActor({
      actorId: ASSISTANT_ACTOR_ID,
      kind: "user",
      displayName: name,
      enabled: options.config.assistant?.enabled === true
    });
  }

  snapshot(): AssistantSnapshot {
    const enabled = this.#config.assistant?.enabled === true;
    return {
      enabled,
      name: this.#config.assistant?.name ?? ASSISTANT_DEFAULT_NAME,
      status: enabled ? this.#brain.status() : "disabled",
      ...(this.#brain.detail() === undefined ? {} : { detail: this.#brain.detail() })
    };
  }

  listMessages(): AssistantConversationMessage[] {
    return this.#store.listAssistantMessages().map(toContractMessage);
  }

  async start(origin: string): Promise<void> {
    if (this.#started) return;
    this.#started = true;
    await this.#brain.start(origin);
  }

  async postMessage(
    input: { clientCommandId: string; content: string },
    signal: AbortSignal
  ): Promise<AssistantMessageAccepted> {
    const existingFlight = this.#commandFlights.get(input.clientCommandId);
    if (existingFlight) return existingFlight;

    const flight = this.#postMessageOnce(input, signal);
    this.#commandFlights.set(input.clientCommandId, flight);
    try {
      return await flight;
    } finally {
      if (this.#commandFlights.get(input.clientCommandId) === flight) {
        this.#commandFlights.delete(input.clientCommandId);
      }
    }
  }

  async #postMessageOnce(
    input: { clientCommandId: string; content: string },
    signal: AbortSignal
  ): Promise<AssistantMessageAccepted> {
    const existing = this.#store.getAssistantMessageByClientCommandId(input.clientCommandId);
    if (existing) {
      const reply = this.#store.getAssistantReplyAfter(existing.messageId);
      if (reply) {
        return {
          userMessage: toContractMessage(existing),
          assistantMessage: toContractMessage(reply),
          status: this.#brain.status()
        };
      }
    }

    const snapshot = this.snapshot();
    if (!snapshot.enabled) {
      throw new GroupXError("SESSION_NOT_AVAILABLE", "尚未添加房间助理");
    }
    if (snapshot.status === "starting") {
      throw new GroupXError(
        "SESSION_NOT_AVAILABLE",
        snapshot.detail ?? "房间助理正在启动，请稍后再试"
      );
    }

    const userMessage =
      existing ??
      this.#store.appendAssistantMessage({
        role: "user",
        content: input.content,
        clientCommandId: input.clientCommandId
      });
    const history = this.#store
      .listAssistantMessages()
      .filter((message) => message.messageId !== userMessage.messageId)
      .map((message) => ({ role: message.role, content: message.content }));
    const prompt = buildAssistantPrompt({
      ...(this.#config.assistant?.extraInstructions === undefined
        ? {}
        : { extraInstructions: this.#config.assistant.extraInstructions }),
      history,
      userText: input.content
    });

    this.#inflight?.abort();
    const controller = new AbortController();
    this.#inflight = controller;
    const onAbort = (): void => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const reply = await this.#brain.prompt(prompt, controller.signal);
      const assistantMessage = this.#store.appendAssistantMessage({
        role: "assistant",
        content: reply
      });
      return {
        userMessage: toContractMessage(userMessage),
        assistantMessage: toContractMessage(assistantMessage),
        status: this.#brain.status()
      };
    } catch (error) {
      const normalized = toGroupXError(error, "SESSION_NOT_AVAILABLE");
      const assistantMessage = this.#store.appendAssistantMessage({
        role: "assistant",
        content: publicAssistantFailure(normalized)
      });
      return {
        userMessage: toContractMessage(userMessage),
        assistantMessage: toContractMessage(assistantMessage),
        status: this.#brain.status(),
        detail: normalized.message.slice(0, 500)
      };
    } finally {
      signal.removeEventListener("abort", onAbort);
      if (this.#inflight === controller) this.#inflight = undefined;
    }
  }

  async cancel(_clientCommandId?: string): Promise<{ accepted: boolean }> {
    if (this.#inflight === undefined) return { accepted: false };
    this.#inflight.abort(new GroupXError("TURN_INTERRUPTED", "The assistant turn was cancelled"));
    await this.#brain.cancel();
    return { accepted: true };
  }

  async close(): Promise<void> {
    this.#inflight?.abort();
    await this.#brain.close();
  }
}

function publicAssistantFailure(error: GroupXError): string {
  if (error.code === "TURN_INTERRUPTED") {
    return "这一轮已取消。";
  }
  if (/stdout line exceeded|line_too_large|Protocol stdout/i.test(error.message)) {
    return "这一轮房间记录太大，助理脑进程被协议行上限打断了。请再发一次；现在只会看最近的公开事件。";
  }
  if (
    error.code === "SESSION_NOT_AVAILABLE" &&
    /requires restart|harness is not ready|not ready/i.test(error.message)
  ) {
    return "助理脑会话已中断。请再发一次，我会重新接上。";
  }
  return `工具或模型失败：${error.message}`;
}

function toContractMessage(
  record: import("../storage/types.js").AssistantConversationMessageRecord
): AssistantConversationMessage {
  return {
    messageId: record.messageId,
    role: record.role,
    content: record.content,
    createdAt: record.createdAt,
    ...(record.clientCommandId === undefined ? {} : { clientCommandId: record.clientCommandId })
  };
}
