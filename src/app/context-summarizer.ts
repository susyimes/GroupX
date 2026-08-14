import type { CliAdapter, NativeEvent, NativeSession } from "../adapters/types.js";
import { AdapterRegistry } from "../adapters/registry.js";
import type { GroupXConfig } from "../config.js";
import { createCorrelationId, createId } from "../core/envelope.js";
import { GroupXError, toGroupXError } from "../core/errors.js";
import type {
  AgentDatedMemorySummarizer,
  AgentDatedMemorySummaryRequest,
  AgentDatedMemorySummaryResult
} from "../memory/dated-memory-engine.js";
import type {
  RoomCompactionRequest,
  RoomCompactionResult,
  RoomContextSummarizer
} from "../memory/context-engine.js";
import { createStructuredAgentAdapter } from "./adapter-factory.js";

const TERMINAL_TYPES = new Set<NativeEvent["type"]>([
  "turn.completed",
  "turn.cancelled",
  "turn.failed"
]);

export interface FirstAvailableAgentSummarizerOptions {
  config: Pick<GroupXConfig, "agents" | "timeouts">;
  primaryAdapters: AdapterRegistry;
  adapterFactory?: typeof createStructuredAgentAdapter;
  attemptsPerAgent?: number;
  retryBaseMs?: number;
  onAttempt?: (input: {
    agentId: string;
    attempt: number;
    maxAttempts: number;
    phase: "started" | "retrying" | "failed";
    nextDelayMs?: number;
    errorCode?: string;
  }) => void | Promise<void>;
}

export interface OwningAgentDatedMemorySummarizerOptions {
  config: Pick<GroupXConfig, "agents" | "timeouts">;
  primaryAdapters: AdapterRegistry;
  adapterFactory?: typeof createStructuredAgentAdapter;
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

function retryableSummaryFailure(error: unknown): boolean {
  return new Set([
    "ADAPTER_START_FAILED",
    "PROTOCOL_HANDSHAKE_TIMEOUT",
    "SESSION_NOT_AVAILABLE",
    "TURN_FIRST_EVENT_TIMEOUT",
    "TURN_IDLE_TIMEOUT",
    "TURN_INTERRUPTED"
  ]).has(toGroupXError(error, "TURN_INTERRUPTED").code);
}

function promptFor(input: RoomCompactionRequest): string {
  const prior = input.previousSummary
    ? `\n[previous_checkpoint through_seq=${input.previousSummary.throughSeq}]\n${input.previousSummary.content}\n[/previous_checkpoint]\n`
    : "";
  const transcript = input.messages
    .map(
      (message) =>
        `[message seq=${message.seq} event=${message.eventId} actor=${message.actorId} name=${message.actorDisplayName} at=${message.occurredAt}]\n${message.content}\n[/message]`
    )
    .join("\n\n");
  return `You are performing a GroupX room context checkpoint compaction.

Create a faithful handoff summary that another Agent can use instead of the older transcript. Preserve:
- current progress, decisions, corrections, commitments, and unresolved questions;
- user constraints and preferences;
- important facts, identifiers, paths, commands, errors, and references;
- who said or decided each material item.

Do not invent, reinterpret, answer the conversation, or use any tool. Keep recent state and conflicts explicit. Return only the checkpoint summary, in concise Markdown, at most ${input.maxOutputChars} characters.
room=${input.roomId}
coverage=${input.fromSeq}..${input.throughSeq}
${prior}
[new_transcript]
${transcript}
[/new_transcript]`;
}

function deltaText(event: NativeEvent): string {
  if (event.payload === null || typeof event.payload !== "object") return "";
  const payload = event.payload as Record<string, unknown>;
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.content === "string") return payload.content;
  return "";
}

function boundedMemoryPart(value: string, maxChars = 32_768): string {
  if (value.length <= maxChars) return value;
  const marker = "\n[…truncated by GroupX for dated-memory rollup]";
  return `${value.slice(0, Math.max(0, maxChars - marker.length))}${marker}`;
}

function datedMemoryPrompt(input: AgentDatedMemorySummaryRequest): string {
  const prior = input.previousMemory
    ? `\n[existing_daily_memory id=${input.previousMemory.memoryId}]\n${input.previousMemory.content}\n[/existing_daily_memory]\n`
    : "";
  const turns = input.sources
    .map(
      (source) =>
        `[successful_turn id=${source.turnId} at=${source.terminalAt}]\n[current_message]\n${boundedMemoryPart(source.currentMessage)}\n[/current_message]\n[final_response]\n${boundedMemoryPart(source.finalResponse)}\n[/final_response]\n[/successful_turn]`
    )
    .join("\n\n");
  return `You are updating your own private GroupX dated working memory for ${input.localDate}.

Produce a concise semantic rollup of only durable information worth carrying into your later work:
- important events, progress, decisions, corrections, preferences, constraints, and open loops;
- preserve concrete identifiers, paths, commands, errors, and who requested or decided them when material;
- merge with the existing daily memory instead of repeating it.

Ignore greetings, acknowledgements, trivial tests, duplicated wording, and routine chatter. Do not invent facts, answer the conversation, use tools, write core identity/persona memory, or mention this summarization instruction. The input contains only current messages and final responses; reasoning and tool records are intentionally absent.

If the entire batch adds no durable semantic value, return exactly ${input.noContentSentinel}. Otherwise return only concise Markdown, at most ${input.maxOutputChars} characters.
room=${input.roomId}
owner=${input.actorId}
date=${input.localDate}
${prior}
[new_successful_turns]
${turns}
[/new_successful_turns]`;
}

/** Uses a short-lived, MCP-free session from the first healthy configured Agent. */
export class FirstAvailableAgentSummarizer implements RoomContextSummarizer {
  readonly #config: FirstAvailableAgentSummarizerOptions["config"];
  readonly #primaryAdapters: AdapterRegistry;
  readonly #factory: NonNullable<FirstAvailableAgentSummarizerOptions["adapterFactory"]>;
  readonly #attemptsPerAgent: number;
  readonly #retryBaseMs: number;
  readonly #onAttempt: FirstAvailableAgentSummarizerOptions["onAttempt"];

  constructor(options: FirstAvailableAgentSummarizerOptions) {
    this.#config = options.config;
    this.#primaryAdapters = options.primaryAdapters;
    this.#factory = options.adapterFactory ?? createStructuredAgentAdapter;
    this.#attemptsPerAgent = options.attemptsPerAgent ?? 1;
    this.#retryBaseMs = options.retryBaseMs ?? 250;
    this.#onAttempt = options.onAttempt;
    if (!Number.isSafeInteger(this.#attemptsPerAgent) || this.#attemptsPerAgent < 1) {
      throw new RangeError("attemptsPerAgent must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.#retryBaseMs) || this.#retryBaseMs < 1) {
      throw new RangeError("retryBaseMs must be a positive safe integer");
    }
  }

  async compact(input: RoomCompactionRequest): Promise<RoomCompactionResult> {
    input.signal.throwIfAborted();
    const failures: unknown[] = [];
    for (const [agentId, configured] of Object.entries(this.#config.agents)) {
      if (!configured.enabled) continue;
      input.signal.throwIfAborted();
      let primary: CliAdapter;
      try {
        primary = this.#primaryAdapters.get(agentId);
      } catch (error) {
        failures.push(error);
        continue;
      }
      const health = primary.health();
      if (
        !health.nativeSessionAvailable ||
        (health.status !== "ready" && health.status !== "degraded")
      ) {
        continue;
      }
      for (let attempt = 1; attempt <= this.#attemptsPerAgent; attempt += 1) {
        await this.#notifyAttempt({
          agentId,
          attempt,
          maxAttempts: this.#attemptsPerAgent,
          phase: "started"
        });
        try {
          const content = await this.#compactWithAgent(agentId, configured, input);
          if (content.length > input.maxOutputChars) {
            throw new GroupXError(
              "PROTOCOL_INVALID_MESSAGE",
              "Compactor exceeded the requested summary output budget",
              { summaryChars: content.length, maxOutputChars: input.maxOutputChars }
            );
          }
          return { content, generatorActorId: primary.actorId };
        } catch (error) {
          if (input.signal.aborted) throw input.signal.reason;
          failures.push(error);
          const normalized = toGroupXError(error, "TURN_INTERRUPTED");
          if (attempt >= this.#attemptsPerAgent || !retryableSummaryFailure(error)) {
            await this.#notifyAttempt({
              agentId,
              attempt,
              maxAttempts: this.#attemptsPerAgent,
              phase: "failed",
              errorCode: normalized.code
            });
            break;
          }
          const nextDelayMs = this.#retryBaseMs * 2 ** (attempt - 1);
          await this.#notifyAttempt({
            agentId,
            attempt,
            maxAttempts: this.#attemptsPerAgent,
            phase: "retrying",
            nextDelayMs,
            errorCode: normalized.code
          });
          await waitForRetry(nextDelayMs, input.signal);
        }
      }
    }
    if (failures.length > 0 && failures.every((error) => !retryableSummaryFailure(error))) {
      throw toGroupXError(failures.at(-1), "PROTOCOL_INVALID_MESSAGE");
    }
    throw new GroupXError(
      "SESSION_NOT_AVAILABLE",
      "No configured Agent is currently available for room context compaction",
      { attemptedAgents: failures.length },
      failures.length === 0 ? undefined : { cause: new AggregateError(failures) }
    );
  }

  async #notifyAttempt(
    input: Parameters<NonNullable<FirstAvailableAgentSummarizerOptions["onAttempt"]>>[0]
  ): Promise<void> {
    try {
      await this.#onAttempt?.(input);
    } catch {
      // Progress observers are best-effort telemetry only.
    }
  }

  async #compactWithAgent(
    agentId: string,
    configured: GroupXConfig["agents"][string],
    input: RoomCompactionRequest
  ): Promise<string> {
    const adapter = this.#factory(agentId, configured.driver, this.#config.timeouts);
    let session: NativeSession | undefined;
    let terminal: NativeEvent["type"] | undefined;
    let output = "";
    let promptError: unknown;
    try {
      session = await adapter.start({
        command: configured.command.executable,
        prefixArgs: configured.command.prefixArgs,
        cwd: configured.cwd,
        instanceId: createId(`summary_instance_${agentId}`),
        bindingId: createId(`summary_binding_${agentId}`)
      });
      for await (const event of adapter.prompt(session, {
        turnId: createId("summary_turn"),
        content: promptFor(input),
        correlationId: createCorrelationId(),
        signal: input.signal
      })) {
        if (event.type === "content.delta") output += deltaText(event);
        if (TERMINAL_TYPES.has(event.type)) {
          terminal = event.type;
          if (event.type === "turn.completed" && output.length === 0) {
            output = deltaText(event);
          }
        }
      }
      if (terminal !== "turn.completed") {
        throw new GroupXError(
          "TURN_INTERRUPTED",
          `Context compaction ended without completion (${terminal ?? "no terminal"})`
        );
      }
      if (output.trim().length === 0) {
        throw new GroupXError("PROTOCOL_INVALID_MESSAGE", "Compactor returned no summary text");
      }
      return output.trim();
    } catch (error) {
      promptError = error;
      throw toGroupXError(error, "TURN_INTERRUPTED");
    } finally {
      if (session !== undefined) {
        try {
          await adapter.close(session);
        } catch (closeError) {
          if (promptError === undefined) throw closeError;
        }
      }
    }
  }
}

/** Uses only the owning Agent; another Agent never impersonates its private daily history. */
export class OwningAgentDatedMemorySummarizer implements AgentDatedMemorySummarizer {
  readonly #config: OwningAgentDatedMemorySummarizerOptions["config"];
  readonly #primaryAdapters: AdapterRegistry;
  readonly #factory: NonNullable<OwningAgentDatedMemorySummarizerOptions["adapterFactory"]>;

  constructor(options: OwningAgentDatedMemorySummarizerOptions) {
    this.#config = options.config;
    this.#primaryAdapters = options.primaryAdapters;
    this.#factory = options.adapterFactory ?? createStructuredAgentAdapter;
  }

  async summarize(input: AgentDatedMemorySummaryRequest): Promise<AgentDatedMemorySummaryResult> {
    input.signal.throwIfAborted();
    if (!input.actorId.startsWith("agent:")) {
      throw new GroupXError(
        "PROTOCOL_INVALID_MESSAGE",
        "Dated-memory owner must be an Agent actor"
      );
    }
    const agentId = input.actorId.slice("agent:".length);
    const configured = this.#config.agents[agentId];
    if (!configured?.enabled) {
      throw new GroupXError(
        "SESSION_NOT_AVAILABLE",
        "Dated-memory owner is not an enabled configured Agent"
      );
    }
    const primary = this.#primaryAdapters.get(agentId);
    const health = primary.health();
    if (
      !health.nativeSessionAvailable ||
      (health.status !== "ready" && health.status !== "degraded")
    ) {
      throw new GroupXError(
        "SESSION_NOT_AVAILABLE",
        "Dated-memory owner is not currently available"
      );
    }

    const adapter = this.#factory(agentId, configured.driver, this.#config.timeouts);
    let session: NativeSession | undefined;
    let terminal: NativeEvent["type"] | undefined;
    let output = "";
    let promptError: unknown;
    try {
      session = await adapter.start({
        command: configured.command.executable,
        prefixArgs: configured.command.prefixArgs,
        cwd: configured.cwd,
        instanceId: createId(`dated_memory_instance_${agentId}`),
        bindingId: createId(`dated_memory_binding_${agentId}`)
      });
      for await (const event of adapter.prompt(session, {
        turnId: createId("dated_memory_turn"),
        content: datedMemoryPrompt(input),
        correlationId: createCorrelationId(),
        signal: input.signal
      })) {
        if (event.type === "content.delta") output += deltaText(event);
        if (TERMINAL_TYPES.has(event.type)) {
          terminal = event.type;
          if (event.type === "turn.completed" && output.length === 0) {
            output = deltaText(event);
          }
        }
      }
      if (terminal !== "turn.completed") {
        throw new GroupXError(
          "TURN_INTERRUPTED",
          `Dated-memory rollup ended without completion (${terminal ?? "no terminal"})`
        );
      }
      const content = output.trim();
      if (content.length === 0) {
        throw new GroupXError(
          "PROTOCOL_INVALID_MESSAGE",
          "Dated-memory owner returned no rollup result"
        );
      }
      if (content.length > input.maxOutputChars) {
        throw new GroupXError(
          "PROTOCOL_INVALID_MESSAGE",
          "Dated-memory owner exceeded the requested output budget"
        );
      }
      return { content, generatorActorId: primary.actorId };
    } catch (error) {
      promptError = error;
      throw toGroupXError(error, "TURN_INTERRUPTED");
    } finally {
      if (session !== undefined) {
        try {
          await adapter.close(session);
        } catch (closeError) {
          if (promptError === undefined) throw closeError;
        }
      }
    }
  }
}
