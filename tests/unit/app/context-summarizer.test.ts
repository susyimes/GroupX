import path from "node:path";

import { describe, expect, it } from "vitest";

import { AdapterRegistry } from "../../../src/adapters/registry.js";
import type {
  AdapterHealth,
  CancelResult,
  CapabilityReport,
  CliAdapter,
  LaunchProfile,
  NativeEvent,
  NativeSession,
  PromptInput
} from "../../../src/adapters/types.js";
import { FirstAvailableAgentSummarizer } from "../../../src/app/context-summarizer.js";
import { GroupXError } from "../../../src/core/errors.js";

class SummaryAdapter implements CliAdapter {
  readonly actorId: string;
  readonly starts: LaunchProfile[] = [];
  readonly prompts: PromptInput[] = [];
  readonly closes: NativeSession[] = [];
  failStartsRemaining = 0;

  constructor(
    readonly adapterId: string,
    readonly status: AdapterHealth["status"] = "ready",
    readonly output = "compressed by first agent"
  ) {
    this.actorId = `agent:${adapterId}`;
  }

  async probe(): Promise<CapabilityReport> {
    return { adapterId: this.adapterId, launchArgvShape: [], findings: [], generatedAt: "now" };
  }
  async start(input: LaunchProfile): Promise<NativeSession> {
    this.starts.push(input);
    if (this.failStartsRemaining > 0) {
      this.failStartsRemaining -= 1;
      throw new GroupXError("ADAPTER_START_FAILED", "temporary fixture start failure");
    }
    return {
      adapterId: this.adapterId,
      actorId: this.actorId,
      instanceId: input.instanceId!,
      bindingId: input.bindingId!,
      protocol: "fixture",
      startedAt: "now"
    };
  }
  async resume(input: LaunchProfile & { nativeSessionId: string }): Promise<NativeSession> {
    return { ...(await this.start(input)), nativeSessionId: input.nativeSessionId };
  }
  async *prompt(session: NativeSession, input: PromptInput): AsyncIterable<NativeEvent> {
    this.prompts.push(input);
    yield {
      adapterId: this.adapterId,
      instanceId: session.instanceId,
      type: "content.delta",
      payload: { text: this.output },
      occurredAt: "now"
    };
    yield {
      adapterId: this.adapterId,
      instanceId: session.instanceId,
      type: "turn.completed",
      payload: {},
      occurredAt: "now"
    };
  }
  async cancel(): Promise<CancelResult> {
    return { requested: true, supported: true, terminalObserved: false };
  }
  async close(session: NativeSession): Promise<void> {
    this.closes.push(session);
  }
  health(): AdapterHealth {
    return {
      adapterId: this.adapterId,
      status: this.status,
      nativeSessionAvailable: this.status === "ready",
      updatedAt: "now"
    };
  }
}

describe("FirstAvailableAgentSummarizer", () => {
  it("uses the first healthy configured Agent in insertion order and starts it without MCP", async () => {
    const primary = new AdapterRegistry();
    primary.register(new SummaryAdapter("codex", "failed"));
    primary.register(new SummaryAdapter("grok", "ready"));
    primary.register(new SummaryAdapter("kimi", "ready"));
    const created: SummaryAdapter[] = [];
    const config = {
      agents: {
        codex: {
          driver: "codex" as const,
          command: { executable: process.execPath, prefixArgs: [path.resolve("codex.mjs")] },
          cwd: path.resolve("codex"),
          enabled: true
        },
        grok: {
          driver: "grok" as const,
          command: { executable: process.execPath, prefixArgs: [path.resolve("grok.mjs")] },
          cwd: path.resolve("grok"),
          enabled: true
        },
        kimi: {
          driver: "kimi" as const,
          command: { executable: process.execPath, prefixArgs: [path.resolve("kimi.mjs")] },
          cwd: path.resolve("kimi"),
          enabled: true
        }
      },
      timeouts: {
        handshakeMs: 100,
        requestMs: 100,
        firstEventMs: 100,
        idleMs: 100,
        cancelMs: 100,
        closeMs: 100,
        askMs: 100
      }
    };
    const summarizer = new FirstAvailableAgentSummarizer({
      config,
      primaryAdapters: primary,
      adapterFactory: (agentId) => {
        const adapter = new SummaryAdapter(agentId);
        created.push(adapter);
        return adapter;
      }
    });

    const result = await summarizer.compact({
      roomId: "room:main",
      messages: [
        {
          seq: 1,
          eventId: "evt:1",
          actorId: "user:web",
          actorDisplayName: "You",
          occurredAt: "now",
          content: "old message"
        }
      ],
      fromSeq: 1,
      throughSeq: 1,
      maxOutputChars: 1_000,
      signal: new AbortController().signal
    });

    expect(result).toEqual({
      content: "compressed by first agent",
      generatorActorId: "agent:grok"
    });
    expect(created.map((adapter) => adapter.adapterId)).toEqual(["grok"]);
    expect(created[0]!.starts[0]).not.toHaveProperty("mcp");
    expect(created[0]!.prompts[0]!.content).toContain("Do not invent");
    expect(created[0]!.prompts[0]!.content).toContain("Do not invent, reinterpret, answer the conversation, or use any tool");
    expect(created[0]!.closes).toHaveLength(1);
  });

  it("tries the next healthy Agent when the first returns an oversized summary", async () => {
    const primary = new AdapterRegistry();
    primary.register(new SummaryAdapter("codex"));
    primary.register(new SummaryAdapter("grok"));
    const created: SummaryAdapter[] = [];
    const config = {
      agents: {
        codex: {
          driver: "codex" as const,
          command: { executable: process.execPath, prefixArgs: [path.resolve("codex.mjs")] },
          cwd: path.resolve("codex"),
          enabled: true
        },
        grok: {
          driver: "grok" as const,
          command: { executable: process.execPath, prefixArgs: [path.resolve("grok.mjs")] },
          cwd: path.resolve("grok"),
          enabled: true
        }
      },
      timeouts: {
        handshakeMs: 100,
        requestMs: 100,
        firstEventMs: 100,
        idleMs: 100,
        cancelMs: 100,
        closeMs: 100,
        askMs: 100
      }
    };
    const summarizer = new FirstAvailableAgentSummarizer({
      config,
      primaryAdapters: primary,
      adapterFactory: (agentId) => {
        const adapter = new SummaryAdapter(
          agentId,
          "ready",
          agentId === "codex" ? "x".repeat(101) : "valid fallback summary"
        );
        created.push(adapter);
        return adapter;
      }
    });

    const result = await summarizer.compact({
      roomId: "room:main",
      messages: [
        {
          seq: 1,
          eventId: "evt:fallback",
          actorId: "user:web",
          actorDisplayName: "You",
          occurredAt: "now",
          content: "old message"
        }
      ],
      fromSeq: 1,
      throughSeq: 1,
      maxOutputChars: 100,
      signal: new AbortController().signal
    });

    expect(result).toEqual({
      content: "valid fallback summary",
      generatorActorId: "agent:grok"
    });
    expect(created.map((adapter) => adapter.adapterId)).toEqual(["codex", "grok"]);
    expect(created.every((adapter) => adapter.closes.length === 1)).toBe(true);
  });

  it("preserves a deterministic invalid-summary failure so the outer engine will not retry it", async () => {
    const primary = new AdapterRegistry();
    primary.register(new SummaryAdapter("codex"));
    const config = {
      agents: {
        codex: {
          driver: "codex" as const,
          command: { executable: process.execPath, prefixArgs: [path.resolve("codex.mjs")] },
          cwd: path.resolve("codex"),
          enabled: true
        }
      },
      timeouts: {
        handshakeMs: 100, requestMs: 100, firstEventMs: 100, idleMs: 100,
        cancelMs: 100, closeMs: 100, askMs: 100
      }
    };
    const summarizer = new FirstAvailableAgentSummarizer({
      config,
      primaryAdapters: primary,
      attemptsPerAgent: 2,
      retryBaseMs: 1,
      adapterFactory: (agentId) => new SummaryAdapter(agentId, "ready", "x".repeat(101))
    });

    await expect(summarizer.compact({
      roomId: "room:main",
      messages: [{ seq: 1, eventId: "evt:invalid", actorId: "user:web", actorDisplayName: "You", occurredAt: "now", content: "old" }],
      fromSeq: 1,
      throughSeq: 1,
      maxOutputChars: 100,
      signal: new AbortController().signal
    })).rejects.toMatchObject({ code: "PROTOCOL_INVALID_MESSAGE" });
  });

  it("retries a transient compactor session failure before falling through to another Agent", async () => {
    const primary = new AdapterRegistry();
    primary.register(new SummaryAdapter("codex"));
    primary.register(new SummaryAdapter("grok"));
    const created: SummaryAdapter[] = [];
    const attempts: Array<{ phase: string; attempt: number }> = [];
    const config = {
      agents: {
        codex: {
          driver: "codex" as const,
          command: { executable: process.execPath, prefixArgs: [path.resolve("codex.mjs")] },
          cwd: path.resolve("codex"),
          enabled: true
        },
        grok: {
          driver: "grok" as const,
          command: { executable: process.execPath, prefixArgs: [path.resolve("grok.mjs")] },
          cwd: path.resolve("grok"),
          enabled: true
        }
      },
      timeouts: {
        handshakeMs: 100, requestMs: 100, firstEventMs: 100, idleMs: 100,
        cancelMs: 100, closeMs: 100, askMs: 100
      }
    };
    const summarizer = new FirstAvailableAgentSummarizer({
      config,
      primaryAdapters: primary,
      attemptsPerAgent: 2,
      retryBaseMs: 1,
      onAttempt(progress) {
        attempts.push({ phase: progress.phase, attempt: progress.attempt });
      },
      adapterFactory: (agentId) => {
        const adapter = new SummaryAdapter(agentId, "ready", "summary after retry");
        if (agentId === "codex" && created.length === 0) adapter.failStartsRemaining = 1;
        created.push(adapter);
        return adapter;
      }
    });

    const result = await summarizer.compact({
      roomId: "room:main",
      messages: [{ seq: 1, eventId: "evt:retry", actorId: "user:web", actorDisplayName: "You", occurredAt: "now", content: "old" }],
      fromSeq: 1,
      throughSeq: 1,
      maxOutputChars: 1_000,
      signal: new AbortController().signal
    });

    expect(result.generatorActorId).toBe("agent:codex");
    expect(created).toHaveLength(2);
    expect(attempts).toEqual([
      { phase: "started", attempt: 1 },
      { phase: "retrying", attempt: 1 },
      { phase: "started", attempt: 2 }
    ]);
  });
});
