import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  BootstrapResponse,
  CancelTurnRequest,
  CancelTurnResult,
  CompactContextRequest,
  CompactContextResult,
  CreateMessageAccepted,
  CreateMessageRequest,
  IdentityQuery,
  MemoryQuery,
  RememberIdentityRequest,
  RememberMemoryRequest,
  RestartAgentAccepted,
  RestartAgentRequest,
  RoomContextUsage,
  RetractIdentityRequest,
  RetractMemoryRequest,
  SupersedeIdentityRequest,
  SupersedeMemoryRequest
} from "../../../../src/contracts/index.js";
import { SafeErrorBodySchema } from "../../../../src/contracts/index.js";
import type { GroupXEnvelope } from "../../../../src/core/envelope.js";
import { createGroupXRuntimeIdentity } from "../../../../src/core/runtime-instance.js";
import { SseRuntime, type DurableGroupXEnvelope } from "../../../../src/web/sse/index.js";
import {
  createGroupXHttpServer,
  type Awaitable,
  type BrokerApi,
  type BrokerHealth,
  type GroupXHttpServer,
  type IdentityMutationAccepted,
  type IdentityPage,
  type MemoryMutationAccepted,
  type MemoryPage,
  type AssistantApi,
  type McpHttpHandler,
  type SetupApi
} from "../../../../src/web/server/index.js";

const createdAt = "2026-08-11T00:00:00.000Z";

class FakeBroker implements BrokerApi {
  readonly roomId = "room:main";
  readonly calls: Array<{ method: string; id?: string; value?: unknown }> = [];

  health(_signal: AbortSignal): Awaitable<BrokerHealth> {
    this.calls.push({ method: "health" });
    return { status: "ok", database: "ok" };
  }

  bootstrap(_signal: AbortSignal): Awaitable<BootstrapResponse> {
    this.calls.push({ method: "bootstrap" });
    return {
      schema: "groupx.bootstrap/0.1",
      room: { roomId: this.roomId, throughSeq: 0 },
      agents: [],
      recentEvents: [],
      activeTurns: []
    };
  }

  contextUsage(_signal: AbortSignal): Awaitable<RoomContextUsage> {
    this.calls.push({ method: "contextUsage" });
    return {
      roomId: this.roomId,
      throughSeq: 20,
      estimatedCharacters: 128_000,
      maxCharacters: 256_000,
      compactionTriggerCharacters: 192_000,
      utilizationPercent: 50,
      uncompactedMessageCount: 18,
      summaryThroughSeq: 8,
      compactable: true
    };
  }

  compactContext(
    request: CompactContextRequest,
    _signal: AbortSignal
  ): Awaitable<CompactContextResult> {
    this.calls.push({ method: "compactContext", value: request });
    return {
      compacted: true,
      usage: {
        roomId: this.roomId,
        throughSeq: 20,
        estimatedCharacters: 32_000,
        maxCharacters: 256_000,
        compactionTriggerCharacters: 192_000,
        utilizationPercent: 13,
        uncompactedMessageCount: 12,
        summaryThroughSeq: 8,
        compactable: false
      }
    };
  }

  createMessage(
    request: CreateMessageRequest,
    _signal: AbortSignal
  ): Awaitable<CreateMessageAccepted> {
    this.calls.push({ method: "createMessage", value: request });
    return {
      messageEventId: "event:message:1",
      correlationId: "correlation:1",
      turns: request.to.map((target, index) => ({
        target,
        turnId: `turn:${index + 1}`,
        status: "queued" as const
      }))
    };
  }

  cancelTurn(
    turnId: string,
    request: CancelTurnRequest,
    _signal: AbortSignal
  ): Awaitable<CancelTurnResult> {
    this.calls.push({ method: "cancelTurn", id: turnId, value: request });
    return { turnId, accepted: true, status: "cancelling" };
  }

  queryMemory(query: MemoryQuery, _signal: AbortSignal): Awaitable<MemoryPage> {
    this.calls.push({ method: "queryMemory", value: query });
    return { items: [] };
  }

  queryIdentity(query: IdentityQuery, _signal: AbortSignal): Awaitable<IdentityPage> {
    this.calls.push({ method: "queryIdentity", value: query });
    return { items: [] };
  }

  rememberMemory(
    request: RememberMemoryRequest,
    _signal: AbortSignal
  ): Awaitable<MemoryMutationAccepted> {
    this.calls.push({ method: "rememberMemory", value: request });
    return {
      memory: {
        memoryId: "memory:1",
        scope: request.scope,
        kind: request.kind,
        authorActorId: "user:web",
        ...(request.subjectActorId === undefined
          ? {}
          : { subjectActorId: request.subjectActorId }),
        content: request.content,
        ...(request.sourceEventId === undefined ? {} : { sourceEventId: request.sourceEventId }),
        sourceKind: "web",
        status: "active",
        createdAt
      }
    };
  }

  supersedeMemory(
    memoryId: string,
    request: SupersedeMemoryRequest,
    _signal: AbortSignal
  ): Awaitable<MemoryMutationAccepted> {
    this.calls.push({ method: "supersedeMemory", id: memoryId, value: request });
    return {
      memory: {
        memoryId: "memory:2",
        scope: { type: "room", id: this.roomId },
        kind: request.kind ?? "note",
        authorActorId: "user:web",
        content: request.content,
        sourceKind: "web",
        status: "active",
        supersedesMemoryId: memoryId,
        createdAt
      }
    };
  }

  retractMemory(
    memoryId: string,
    request: RetractMemoryRequest,
    _signal: AbortSignal
  ): Awaitable<MemoryMutationAccepted> {
    this.calls.push({ method: "retractMemory", id: memoryId, value: request });
    return {
      memory: {
        memoryId,
        scope: { type: "room", id: this.roomId },
        kind: "note",
        authorActorId: "user:web",
        content: "remembered",
        sourceKind: "web",
        status: "retracted",
        createdAt,
        retractedAt: createdAt
      }
    };
  }

  rememberIdentity(
    request: RememberIdentityRequest,
    _signal: AbortSignal
  ): Awaitable<IdentityMutationAccepted> {
    this.calls.push({ method: "rememberIdentity", value: request });
    return {
      identity: {
        identityId: "identity:1",
        subjectActorId: request.subjectActorId,
        authorActorId: "user:web",
        kind: request.kind,
        content: request.content,
        ...(request.sourceEventId === undefined ? {} : { sourceEventId: request.sourceEventId }),
        sourceKind: "web",
        status: "active",
        createdAt
      }
    };
  }

  supersedeIdentity(
    identityId: string,
    request: SupersedeIdentityRequest,
    _signal: AbortSignal
  ): Awaitable<IdentityMutationAccepted> {
    this.calls.push({ method: "supersedeIdentity", id: identityId, value: request });
    return {
      identity: {
        identityId: "identity:2",
        subjectActorId: "agent:grok",
        authorActorId: "user:web",
        kind: request.kind ?? "note",
        content: request.content,
        sourceKind: "web",
        status: "active",
        supersedesIdentityId: identityId,
        createdAt
      }
    };
  }

  retractIdentity(
    identityId: string,
    request: RetractIdentityRequest,
    _signal: AbortSignal
  ): Awaitable<IdentityMutationAccepted> {
    this.calls.push({ method: "retractIdentity", id: identityId, value: request });
    return {
      identity: {
        identityId,
        subjectActorId: "agent:grok",
        authorActorId: "user:web",
        kind: "note",
        content: "protocol reviewer",
        sourceKind: "web",
        status: "retracted",
        createdAt,
        retractedAt: createdAt
      }
    };
  }

  restartAgent(
    actorId: string,
    request: RestartAgentRequest,
    _signal: AbortSignal
  ): Awaitable<RestartAgentAccepted> {
    this.calls.push({ method: "restartAgent", id: actorId, value: request });
    return { actorId, accepted: true };
  }
}

class MemoryEventReader {
  readonly events: DurableGroupXEnvelope[] = [];

  captureHighWaterSeq(): number {
    return this.events.at(-1)?.seq ?? 0;
  }

  *readDurableRange(request: {
    roomId: string;
    afterSeq: number;
    throughSeq: number;
    signal: AbortSignal;
  }): Iterable<DurableGroupXEnvelope> {
    for (const event of this.events) {
      if (
        !request.signal.aborted &&
        event.roomId === request.roomId &&
        event.seq > request.afterSeq &&
        event.seq <= request.throughSeq
      ) {
        yield event;
      }
    }
  }
}

function event(seq: number, text: string): DurableGroupXEnvelope {
  const envelope: GroupXEnvelope<{ text: string }> = {
    schema: "groupx.event/0.1",
    eventId: `event:${seq}`,
    seq,
    roomId: "room:main",
    type: "message.created",
    actor: { actorId: "agent:codex", kind: "agent", displayName: "Codex" },
    to: [],
    correlationId: `correlation:${seq}`,
    rootCorrelationId: `correlation:${seq}`,
    occurredAt: createdAt,
    durability: "durable",
    body: { text }
  };
  return envelope as DurableGroupXEnvelope;
}

async function eventually(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("GroupXHttpServer", () => {
  let staticRoot: string;
  let broker: FakeBroker;
  let reader: MemoryEventReader;
  let sse: SseRuntime;
  let server: GroupXHttpServer | undefined;
  let origin: string;

  beforeEach(async () => {
    staticRoot = await mkdtemp(path.join(tmpdir(), "groupx-http-"));
    await Promise.all([
      writeFile(path.join(staticRoot, "index.html"), "<!doctype html><title>GroupX</title>"),
      writeFile(path.join(staticRoot, "app.js"), "document.body.dataset.ready = 'yes';"),
      writeFile(path.join(staticRoot, "agent-roster.js"), "export const rosterReady = true;"),
      writeFile(path.join(staticRoot, "pagination.js"), "export const paginationReady = true;"),
      writeFile(path.join(staticRoot, "reasoning-record.js"), "export const reasoningRecordReady = true;"),
      writeFile(path.join(staticRoot, "rich-text.js"), "export const richTextReady = true;"),
      writeFile(path.join(staticRoot, "tool-progress.js"), "export const toolProgressReady = true;"),
      writeFile(path.join(staticRoot, "styles.css"), "body { color: black; }"),
      writeFile(path.join(staticRoot, "setup.html"), "<!doctype html><title>Agent setup</title>"),
      writeFile(path.join(staticRoot, "setup.js"), "document.body.dataset.setup = 'ready';"),
      writeFile(path.join(staticRoot, "setup.css"), "body { color: blue; }")
    ]);
    broker = new FakeBroker();
    reader = new MemoryEventReader();
    sse = new SseRuntime(reader, { heartbeatIntervalMs: 60_000 });
    server = createGroupXHttpServer({ broker, sse, staticRoot, port: 0 });
    origin = (await server.start()).origin;
  });

  afterEach(async () => {
    await server?.close();
    sse.close();
    await rm(staticRoot, { recursive: true, force: true });
  });

  it("binds loopback and serves only the mapped static paths", async () => {
    expect(server?.address?.host).toBe("127.0.0.1");

    const index = await fetch(`${origin}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(index.headers.get("access-control-allow-origin")).toBeNull();
    expect(await index.text()).toContain("GroupX");

    const script = await fetch(`${origin}/app.js`);
    expect(script.status).toBe(200);
    expect(await script.text()).toContain("dataset.ready");

    const roster = await fetch(`${origin}/agent-roster.js`);
    expect(roster.status).toBe(200);
    expect(await roster.text()).toContain("rosterReady");

    const pagination = await fetch(`${origin}/pagination.js`);
    expect(pagination.status).toBe(200);
    expect(await pagination.text()).toContain("paginationReady");

    const reasoningRecord = await fetch(`${origin}/reasoning-record.js`);
    expect(reasoningRecord.status).toBe(200);
    expect(await reasoningRecord.text()).toContain("reasoningRecordReady");

    const richText = await fetch(`${origin}/rich-text.js`);
    expect(richText.status).toBe(200);
    expect(await richText.text()).toContain("richTextReady");

    const toolProgress = await fetch(`${origin}/tool-progress.js`);
    expect(toolProgress.status).toBe(200);
    expect(await toolProgress.text()).toContain("toolProgressReady");

    const styles = await fetch(`${origin}/styles.css`, { method: "HEAD" });
    expect(styles.status).toBe(200);
    expect(await styles.text()).toBe("");

    expect((await fetch(`${origin}/index.html`)).status).toBe(404);
    expect((await fetch(`${origin}/nested/app.js`)).status).toBe(404);
    const wrongMethod = await fetch(`${origin}/`, { method: "POST" });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("GET, HEAD");
    expect(SafeErrorBodySchema.safeParse(await wrongMethod.json()).success).toBe(true);
  });

  it("serves the running Agent editor and marks saved roster changes for restart", async () => {
    await server?.close();
    const setupApi: SetupApi = {
      snapshot: () => ({
        configPath: "D:\\GroupX\\groupx.json",
        existing: true,
        runtimeActive: true,
        drivers: [
          { driver: "codex", found: true },
          { driver: "grok", found: true },
          { driver: "kimi", found: true },
          { driver: "hermes", found: true },
          { driver: "claude", found: true }
        ],
        config: {
          serverPort: 4_310,
          storagePath: ".groupx/groupx.db",
          agents: [{
            id: "codex",
            driver: "codex",
            name: "Builder",
            command: { executable: "codex", prefixArgs: [] },
            cwd: ".",
            enabled: true
          }]
        }
      }),
      save: (request) => ({
        saved: true,
        configPath: "D:\\GroupX\\groupx.json",
        agentCount: request.config.agents.length,
        enabledAgentCount: request.config.agents.filter((agent) => agent.enabled).length,
        restartRequired: true
      })
    };
    server = createGroupXHttpServer({ broker, sse, staticRoot, port: 0, setupApi });
    origin = (await server.start()).origin;

    expect(await (await fetch(`${origin}/setup`)).text()).toContain("Agent setup");
    expect(await (await fetch(`${origin}/api/setup`)).json()).toMatchObject({
      runtimeActive: true,
      config: { agents: [{ id: "codex", driver: "codex" }] }
    });
    const saved = await fetch(`${origin}/api/setup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: {
          serverPort: 4_310,
          storagePath: ".groupx/groupx.db",
          agents: ["codex", "reviewer"].map((id) => ({
            id,
            driver: "codex",
            name: "",
            command: { executable: "codex", prefixArgs: [] },
            cwd: ".",
            enabled: true
          }))
        }
      })
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ agentCount: 2, restartRequired: true });
  });

  it("keeps assistant side-chat off the room message API", async () => {
    await server?.close();
    const assistantCalls: Array<{ method: string; value?: unknown }> = [];
    const assistantApi: AssistantApi = {
      snapshot() {
        assistantCalls.push({ method: "snapshot" });
        return { enabled: true, name: "房间助理", status: "ready" };
      },
      listMessages() {
        assistantCalls.push({ method: "listMessages" });
        return { messages: [] };
      },
      postMessage(request) {
        assistantCalls.push({ method: "postMessage", value: request });
        return {
          userMessage: {
            messageId: "asst_user_1",
            role: "user",
            content: request.content,
            createdAt,
            clientCommandId: request.clientCommandId
          },
          assistantMessage: {
            messageId: "asst_reply_1",
            role: "assistant",
            content: "已记下",
            createdAt
          },
          status: "ready"
        };
      },
      cancel(request) {
        assistantCalls.push({ method: "cancel", value: request });
        return { accepted: true };
      }
    };
    server = createGroupXHttpServer({ broker, sse, staticRoot, port: 0, assistantApi });
    origin = (await server.start()).origin;

    expect(await (await fetch(`${origin}/api/assistant`)).json()).toMatchObject({
      enabled: true,
      status: "ready"
    });
    const posted = await fetch(`${origin}/api/assistant/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientCommandId: "web-assistant-1",
        content: "停掉他们"
      })
    });
    expect(posted.status).toBe(200);
    expect(await posted.json()).toMatchObject({
      userMessage: { content: "停掉他们", role: "user" },
      status: "ready"
    });
    expect(assistantCalls.some((call) => call.method === "postMessage")).toBe(true);
    expect(broker.calls.some((call) => call.method === "createMessage")).toBe(false);

    const forged = await fetch(`${origin}/api/assistant/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientCommandId: "web-assistant-2",
        content: "停掉他们",
        from: "user:web"
      })
    });
    expect(forged.status).toBeGreaterThanOrEqual(400);
    expect(broker.calls.some((call) => call.method === "createMessage")).toBe(false);
  });

  it("exposes health/bootstrap and validates message JSON before calling Broker", async () => {
    const health = await fetch(`${origin}/api/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok", database: "ok" });

    const bootstrap = await fetch(`${origin}/api/bootstrap`);
    expect(bootstrap.status).toBe(200);
    expect((await bootstrap.json()) as object).toMatchObject({ schema: "groupx.bootstrap/0.1" });

    const accepted = await fetch(`${origin}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({
        clientCommandId: "web-message-1",
        to: ["agent:kimi", "agent:codex"],
        content: "hello"
      })
    });
    expect(accepted.status).toBe(202);
    expect((await accepted.json()) as object).toMatchObject({ messageEventId: "event:message:1" });
    expect(broker.calls.at(-1)).toEqual({
      method: "createMessage",
      value: {
        clientCommandId: "web-message-1",
        to: ["agent:codex", "agent:kimi"],
        content: "hello"
      }
    });

    const callsBeforeInvalid = broker.calls.length;
    const forgedSender = await fetch(`${origin}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientCommandId: "web-message-2",
        to: ["agent:grok"],
        content: "hello",
        from: "agent:codex"
      })
    });
    expect(forgedSender.status).toBe(400);
    expect((await forgedSender.json()) as object).toMatchObject({
      error: { code: "SENDER_FIELD_FORBIDDEN" }
    });
    expect(broker.calls).toHaveLength(callsBeforeInvalid);

    const malformed = await fetch(`${origin}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{"
    });
    expect(malformed.status).toBe(400);

    const wrongMedia = await fetch(`${origin}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "hello"
    });
    expect(wrongMedia.status).toBe(415);
  });

  it("accepts a scoped CLI shutdown request and retains health identity while draining", async () => {
    await server?.close();
    const identity = createGroupXRuntimeIdentity(
      { config: "current" },
      { configPath: "D:\\GroupX\\groupx.json" }
    );
    let shutdownRequested = false;
    server = createGroupXHttpServer({
      broker,
      sse,
      staticRoot,
      port: 0,
      runtimeIdentity: identity,
      runtimeControl: {
        requestShutdown() {
          shutdownRequested = true;
          server?.beginClose();
        }
      }
    });
    origin = (await server.start()).origin;

    const rejected = await fetch(`${origin}/api/runtime/shutdown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runtimeScopeKey: "0".repeat(64) })
    });
    expect(rejected.status).not.toBe(202);
    expect(shutdownRequested).toBe(false);

    const accepted = await fetch(`${origin}/api/runtime/shutdown`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runtimeScopeKey: identity.runtimeScopeKey })
    });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({
      accepted: true,
      runtimeKey: identity.runtimeKey,
      runtimeScopeKey: identity.runtimeScopeKey
    });
    await eventually(() => shutdownRequested);

    const health = await fetch(`${origin}/api/health`);
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({ status: "closing", ...identity });
    expect(server.address?.origin).toBe(origin);
  });

  it("exposes room context usage and validates the explicit compaction command", async () => {
    const usage = await fetch(`${origin}/api/context`);
    expect(usage.status).toBe(200);
    expect(await usage.json()).toMatchObject({
      roomId: "room:main",
      estimatedCharacters: 128_000,
      maxCharacters: 256_000,
      utilizationPercent: 50,
      compactable: true
    });

    const compacted = await fetch(`${origin}/api/context/compact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientCommandId: "web-context-compact-1" })
    });
    expect(compacted.status).toBe(200);
    expect(await compacted.json()).toMatchObject({
      compacted: true,
      usage: { uncompactedMessageCount: 12, compactable: false }
    });
    expect(broker.calls.at(-1)).toEqual({
      method: "compactContext",
      value: { clientCommandId: "web-context-compact-1" }
    });

    const callsBeforeInvalid = broker.calls.length;
    const invalid = await fetch(`${origin}/api/context/compact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientCommandId: "web-context-compact-2", from: "agent:codex" })
    });
    expect(invalid.status).toBe(400);
    expect(broker.calls).toHaveLength(callsBeforeInvalid);
  });

  it("accepts bootstrap agents that omit optional runtime details", async () => {
    broker.bootstrap = () => ({
      schema: "groupx.bootstrap/0.1",
      room: { roomId: broker.roomId, throughSeq: 0 },
      agents: [
        {
          actorId: "agent:codex",
          displayName: "Codex",
          status: "ready"
        },
        {
          actorId: "agent:grok",
          displayName: "Grok",
          status: "stopped",
          cwd: "D:\\GroupX",
          enabled: false,
          capabilities: { loadSession: true, cancel: "not_observed" }
        }
      ],
      recentEvents: [],
      activeTurns: []
    });

    const response = await fetch(`${origin}/api/bootstrap`);
    expect(response.status).toBe(200);
    expect((await response.json()) as object).toMatchObject({
      agents: [
        { actorId: "agent:codex", status: "ready" },
        {
          actorId: "agent:grok",
          cwd: "D:\\GroupX",
          enabled: false,
          capabilities: { loadSession: true, cancel: "not_observed" }
        }
      ]
    });
  });

  it("enforces the byte boundary without dispatching an oversized command", async () => {
    await server?.close();
    server = createGroupXHttpServer({
      broker,
      sse,
      staticRoot,
      port: 0,
      maxRequestBodyBytes: 256
    });
    origin = (await server.start()).origin;
    const before = broker.calls.length;
    const response = await fetch(`${origin}/api/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientCommandId: "large",
        to: ["agent:codex"],
        content: "x".repeat(1_000)
      })
    });
    expect(response.status).toBe(413);
    expect((await response.json()) as object).toMatchObject({ error: { code: "MESSAGE_TOO_LARGE" } });
    expect(broker.calls).toHaveLength(before);
  });

  it("turns an invalid Broker success projection into an internal error", async () => {
    broker.bootstrap = () => ({ broken: true }) as unknown as BootstrapResponse;
    const response = await fetch(`${origin}/api/bootstrap`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "An internal GroupX error occurred."
      }
    });
  });

  it("maps cancel, memory, identity and restart routes without exposing an approval route", async () => {
    const post = async (pathname: string, body: object): Promise<Response> =>
      await fetch(`${origin}${pathname}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });

    const cancel = await post("/api/turns/turn%3A1/cancel", { clientCommandId: "cancel-1" });
    expect(cancel.status).toBe(202);
    expect(await cancel.json()).toEqual({
      turnId: "turn:1",
      accepted: true,
      status: "cancelling"
    });
    expect(broker.calls.at(-1)).toMatchObject({ method: "cancelTurn", id: "turn:1" });

    expect(
      (
        await post("/api/approvals/approval%3A1/resolve", {
          clientCommandId: "approval-1",
          decisionId: "allow_once"
        })
      ).status
    ).toBe(404);

    const memoryPage = await fetch(
      `${origin}/api/memory?scopeType=room&scopeId=room%3Amain&cursor=4&limit=20&includeHistory=true`
    );
    expect(memoryPage.status).toBe(200);
    expect(broker.calls.at(-1)).toEqual({
      method: "queryMemory",
      value: {
        scopeType: "room",
        scopeId: "room:main",
        cursor: 4,
        limit: 20,
        includeHistory: true
      }
    });

    expect(
      (
        await post("/api/memory", {
          clientCommandId: "memory-1",
          scope: { type: "room", id: "room:main" },
          kind: "note",
          content: "remember this"
        })
      ).status
    ).toBe(201);
    expect(broker.calls.at(-1)).toMatchObject({ method: "rememberMemory" });

    expect(
      (
        await post("/api/memory/memory%3A1/supersede", {
          clientCommandId: "memory-2",
          content: "replace it"
        })
      ).status
    ).toBe(201);
    expect(broker.calls.at(-1)).toMatchObject({ method: "supersedeMemory", id: "memory:1" });

    expect(
      (
        await post("/api/memory/memory%3A2/retract", {
          clientCommandId: "memory-3"
        })
      ).status
    ).toBe(200);
    expect(broker.calls.at(-1)).toMatchObject({ method: "retractMemory", id: "memory:2" });

    const identityPage = await fetch(
      `${origin}/api/identity?subjectActorId=agent%3Agrok&limit=10&includeHistory=false`
    );
    expect(identityPage.status).toBe(200);
    expect(broker.calls.at(-1)).toEqual({
      method: "queryIdentity",
      value: { subjectActorId: "agent:grok", limit: 10, includeHistory: false }
    });

    expect(
      (
        await post("/api/identity", {
          clientCommandId: "identity-1",
          subjectActorId: "agent:grok",
          kind: "note",
          content: "protocol reviewer"
        })
      ).status
    ).toBe(201);
    expect(broker.calls.at(-1)).toMatchObject({ method: "rememberIdentity" });

    expect(
      (
        await post("/api/identity/identity%3A1/supersede", {
          clientCommandId: "identity-2",
          content: "lead protocol reviewer"
        })
      ).status
    ).toBe(201);
    expect(broker.calls.at(-1)).toMatchObject({
      method: "supersedeIdentity",
      id: "identity:1"
    });

    expect(
      (
        await post("/api/identity/identity%3A2/retract", {
          clientCommandId: "identity-3"
        })
      ).status
    ).toBe(200);
    expect(broker.calls.at(-1)).toMatchObject({
      method: "retractIdentity",
      id: "identity:2"
    });

    expect(
      (
        await post("/api/agents/agent%3Acodex%2Freviewer/restart", {
          clientCommandId: "restart-1"
        })
      ).status
    ).toBe(202);
    expect(broker.calls.at(-1)).toMatchObject({
      method: "restartAgent",
      id: "agent:codex/reviewer"
    });

    expect((await fetch(`${origin}/api/memory?limit=1&limit=2`)).status).toBe(400);
    expect((await fetch(`${origin}/api/memory?unknown=value`)).status).toBe(400);
    expect((await fetch(`${origin}/api/not-real`)).status).toBe(404);
  });

  it("delegates GET/POST/DELETE /mcp verbatim and closes the MCP handler", async () => {
    await server?.close();
    const handled: Array<{ method: string | undefined; body: string }> = [];
    let handlerClosed = false;
    const mcpHandler: McpHttpHandler = {
      async handle(request, response) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks).toString("utf8");
        handled.push({ method: request.method, body });
        response.statusCode = 207;
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.end(`${request.method}:${body}`);
      },
      async close() {
        handlerClosed = true;
      }
    };
    server = createGroupXHttpServer({ broker, sse, staticRoot, port: 0, mcpHandler });
    origin = (await server.start()).origin;

    const get = await fetch(`${origin}/mcp?session=opaque`);
    expect(get.status).toBe(207);
    expect(await get.text()).toBe("GET:");

    const post = await fetch(`${origin}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not-json"
    });
    expect(post.status).toBe(207);
    expect(await post.text()).toBe("POST:not-json");

    const remove = await fetch(`${origin}/mcp`, { method: "DELETE" });
    expect(remove.status).toBe(207);
    expect(await remove.text()).toBe("DELETE:");
    expect(handled).toEqual([
      { method: "GET", body: "" },
      { method: "POST", body: "not-json" },
      { method: "DELETE", body: "" }
    ]);

    expect((await fetch(`${origin}/mcp`, { method: "PUT" })).status).toBe(405);
    await server.close();
    server = undefined;
    expect(handlerClosed).toBe(true);
  });

  it("clears shutdown state when an MCP handler close throws synchronously", async () => {
    await server?.close();
    const mcpHandler: McpHttpHandler = {
      async handle(_request, response) {
        response.end();
      },
      close() {
        throw new Error("fixture close failure");
      }
    };
    server = createGroupXHttpServer({ broker, sse, staticRoot, port: 0, mcpHandler });
    await server.start();

    await expect(server.close()).rejects.toThrow("fixture close failure");
    expect(server.address).toBeUndefined();
    await expect(server.close()).resolves.toBeUndefined();
    server = undefined;
  });

  it("replays SSE, honors Last-Event-ID and removes disconnected clients", async () => {
    reader.events.push(event(1, "one"));
    const abort = new AbortController();
    const response = await fetch(`${origin}/api/events?afterSeq=0`, {
      headers: { "Last-Event-ID": "1" },
      signal: abort.signal
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    await eventually(() => sse.connectionCount === 1);

    sse.publish(event(2, "two"));
    const readerStream = response.body?.getReader();
    expect(readerStream).toBeDefined();
    const chunk = await readerStream?.read();
    const text = new TextDecoder().decode(chunk?.value);
    expect(text).toContain("id: 2");
    expect(text).toContain('"text":"two"');
    expect(text).not.toContain("id: 1");

    abort.abort();
    await readerStream?.cancel().catch(() => undefined);
    await eventually(() => sse.connectionCount === 0);
  });

  it("closes open SSE responses during graceful server shutdown", async () => {
    const response = await fetch(`${origin}/api/events`);
    await eventually(() => sse.connectionCount === 1);
    const body = response.body?.getReader();

    await server?.close();
    server = undefined;
    await eventually(() => sse.connectionCount === 0);
    const completed = await body?.read();
    expect(completed?.done).toBe(true);
  });

  it("sweeps an MCP connection that becomes idle while its handler closes", async () => {
    await server?.close();
    let finishRequest: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const mcpHandler: McpHttpHandler = {
      async handle(_request, response) {
        markStarted?.();
        await new Promise<void>((resolve) => {
          finishRequest = () => {
            response.end("closed");
            resolve();
          };
        });
      },
      async close() {
        finishRequest?.();
      }
    };
    server = createGroupXHttpServer({
      broker,
      sse,
      staticRoot,
      port: 0,
      gracefulCloseTimeoutMs: 500,
      mcpHandler
    });
    origin = (await server.start()).origin;
    const pendingFetch = fetch(`${origin}/mcp`);
    await started;

    await expect(server.close()).resolves.toBeUndefined();
    server = undefined;
    expect(await (await pendingFetch).text()).toBe("closed");
  });

  it("bounds graceful shutdown when a Broker operation ignores abort", async () => {
    await server?.close();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    broker.health = () => {
      markStarted?.();
      return new Promise<BrokerHealth>(() => undefined);
    };
    server = createGroupXHttpServer({
      broker,
      sse,
      staticRoot,
      port: 0,
      gracefulCloseTimeoutMs: 50
    });
    origin = (await server.start()).origin;
    const pendingFetch = fetch(`${origin}/api/health`).catch((error: unknown) => error);
    await started;

    const before = Date.now();
    await expect(server.close()).rejects.toThrow("graceful close timed out");
    expect(Date.now() - before).toBeLessThan(1_000);
    server = undefined;
    await pendingFetch;
  });
});
