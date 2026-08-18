import { fileURLToPath } from "node:url";

import { AdapterRegistry } from "../adapters/registry.js";
import { GroupXBroker } from "../broker/broker.js";
import type { BrokerContextProvider, BrokerErrorContext } from "../broker/types.js";
import { assertActiveTransport, isBuiltinAgentId, type GroupXConfig } from "../config.js";
import {
  ASSISTANT_ACTOR_ID,
  LOCAL_OPERATOR_BINDING_ID,
  LOCAL_OPERATOR_INSTANCE_ID,
  LOCAL_OPERATOR_PROTOCOL
} from "../core/assistant.js";
import {
  asTransientEnvelope,
  createCorrelationId,
  createId,
  DEFAULT_ROOM_ID
} from "../core/envelope.js";
import { GroupXError } from "../core/errors.js";
import {
  createGroupXRuntimeIdentity,
  type GroupXRuntimeIdentity
} from "../core/runtime-instance.js";
import {
  RoomContextEngine,
  type RoomCompactionProgress,
  type RoomContextSummarizer
} from "../memory/context-engine.js";
import {
  AgentDatedMemoryEngine,
  type AgentDatedMemorySummarizer
} from "../memory/dated-memory-engine.js";
import { McpBindingRegistry } from "../mcp/binding-registry.js";
import {
  createGroupXMcpHttpHandler,
  type GroupXMcpHttpHandler
} from "../mcp/server/index.js";
import { SqliteGroupXStore } from "../storage/sqlite-store.js";
import type { GroupXStore } from "../storage/types.js";
import {
  createGroupXHttpServer,
  type GroupXHttpServer,
  type GroupXHttpServerAddress,
  type SetupApi
} from "../web/server/index.js";
import { SseRuntime } from "../web/sse/index.js";
import { createAdapterRegistry } from "./adapter-factory.js";
import {
  FirstAvailableAgentSummarizer,
  OwningAgentDatedMemorySummarizer
} from "./context-summarizer.js";
import { toDurableEnvelope } from "./record-mappers.js";
import { SequencedEventPublisher, SqliteSseEventReader } from "./event-stream.js";
import { RuntimeReadiness } from "./readiness.js";
import { RestartAgentCommandCoordinator } from "./restart-commands.js";
import {
  AgentSessionManager,
  type SessionProgress,
  type SessionResumePlan
} from "./session-manager.js";
import { GroupXOperatorBrokerApi } from "./operator-broker-api.js";
import { GroupXAssistantHost, type AssistantHost } from "./operator-runtime.js";
import { GroupXToolBrokerApi } from "./tool-broker-api.js";
import { ActiveTurnCoordinator } from "./turn-lifecycle.js";
import { GroupXWebBrokerApi } from "./web-broker-api.js";
import { createGroupXOperatorMcpServer } from "../mcp/server/operator-tools.js";

export interface GroupXRuntimeOptions {
  store?: GroupXStore;
  adapters?: AdapterRegistry;
  /** Defaults to true only when the runtime created the store. */
  closeStore?: boolean;
  /** Zero is accepted for integration tests; persisted config remains 1..65535. */
  port?: number;
  staticRoot?: string;
  roomId?: string;
  setupApi?: SetupApi;
  onError?: (error: unknown, context: BrokerErrorContext) => void;
  /** Test/custom injection. Runtime defaults to the first healthy configured Agent. */
  contextSummarizer?: RoomContextSummarizer;
  /** Test/custom injection. Runtime otherwise uses the owning Agent only. */
  datedMemorySummarizer?: AgentDatedMemorySummarizer;
  /** CLI-supplied identity; embedded/test runtimes derive one from resolved config. */
  runtimeIdentity?: GroupXRuntimeIdentity;
}

export interface GroupXRuntimeStartResult {
  address: GroupXHttpServerAddress;
  recovery: SessionResumePlan;
}

export const LOCAL_REST_WEB_INSTANCE_ID = "instance:web" as const;
export const LOCAL_REST_WEB_BINDING_ID = "binding:web" as const;
export { LOCAL_OPERATOR_INSTANCE_ID, LOCAL_OPERATOR_BINDING_ID };

function compactionEventType(progress: RoomCompactionProgress) {
  return `context.compaction.${progress.phase}` as const;
}

function publishCompactionProgress(
  publisher: SequencedEventPublisher,
  progress: RoomCompactionProgress
): Promise<void> {
  const correlationId = createCorrelationId();
  return publisher.publish(
    asTransientEnvelope({
      eventId: createId(`context_compaction_${progress.phase}`),
      roomId: progress.roomId,
      type: compactionEventType(progress),
      actor: { actorId: "system:groupx", kind: "system", displayName: "GroupX" },
      to: [],
      causationId: progress.operationId,
      correlationId,
      rootCorrelationId: correlationId,
      body: progress,
      provenance: { sourceKind: "system", labels: ["context-compaction"] }
    })
  );
}

function sessionEventType(progress: SessionProgress) {
  if (progress.phase === "retrying") return "session.retrying" as const;
  if (progress.phase === "starting") return "session.starting" as const;
  if (progress.phase === "ready") {
    return progress.continuity === "resumed" ? "session.resumed" as const : "session.ready" as const;
  }
  return "session.failed" as const;
}

function contextProvider(
  engine: RoomContextEngine,
  config: GroupXConfig,
  store: Pick<GroupXStore, "getSupervisionTurnRole">
): BrokerContextProvider {
  return {
    async prepare({ turn, sourceEvent }) {
      const agentId = turn.targetActorId.startsWith("agent:")
        ? turn.targetActorId.slice("agent:".length)
        : "";
      const configuredIdentity = config.agents[agentId]?.identity?.trim();
      const packetKind =
        store.getSupervisionTurnRole(turn.turnId) === "observer"
          ? ("supervision_watch" as const)
          : undefined;
      const packet = await engine.prepare({
        roomId: sourceEvent.roomId,
        targetActorId: turn.targetActorId,
        ...(configuredIdentity ? { configuredIdentity } : {}),
        throughSeq: sourceEvent.seq,
        currentEvent: sourceEvent,
        ...(packetKind === undefined ? {} : { packetKind })
      });
      return {
        contextPacket: packet.text,
        contextThroughSeq: packet.throughSeq,
        ...(packet.sections.generatedSummary[0]?.seq === undefined
          ? {}
          : { summaryThroughSeq: packet.sections.generatedSummary[0].seq })
      };
    }
  };
}

/** Owns the complete in-process composition and its reverse-order shutdown. */
export class GroupXRuntime {
  readonly config: GroupXConfig;
  readonly store: GroupXStore;
  readonly adapters: AdapterRegistry;
  readonly bindings = new McpBindingRegistry();
  readonly readiness = new RuntimeReadiness();
  readonly sse: SseRuntime;
  readonly publisher: SequencedEventPublisher;
  readonly sessions: AgentSessionManager;
  readonly datedMemoryEngine: AgentDatedMemoryEngine;
  readonly contextEngine: RoomContextEngine;
  readonly roomId: string;
  readonly runtimeIdentity: GroupXRuntimeIdentity;

  readonly #closeStore: boolean;
  readonly #port: number;
  readonly #staticRoot: string | undefined;
  readonly #onError: GroupXRuntimeOptions["onError"];
  readonly #setupApi: SetupApi | undefined;

  #broker: GroupXBroker | undefined;
  #turns: ActiveTurnCoordinator | undefined;
  #webApi: GroupXWebBrokerApi | undefined;
  #toolApi: GroupXToolBrokerApi | undefined;
  #operatorApi: GroupXOperatorBrokerApi | undefined;
  #assistantHost: AssistantHost | undefined;
  #mcpHandler: GroupXMcpHttpHandler | undefined;
  #operatorMcpHandler: GroupXMcpHttpHandler | undefined;
  #http: GroupXHttpServer | undefined;
  #webBindingId: string | undefined;
  #operatorBindingId: string | undefined;
  #startPromise: Promise<GroupXRuntimeStartResult> | undefined;
  #startResult: GroupXRuntimeStartResult | undefined;
  #closePromise: Promise<void> | undefined;

  constructor(config: GroupXConfig, options: GroupXRuntimeOptions = {}) {
    // Fail before opening SQLite or constructing adapters. Direct is retained
    // as historical code/data vocabulary, not as a runnable product entry.
    assertActiveTransport(config.transport);
    this.config = config;
    this.store = options.store ?? new SqliteGroupXStore(config.storage.path);
    this.adapters = options.adapters ?? createAdapterRegistry(config);
    this.#closeStore = options.closeStore ?? options.store === undefined;
    this.#port = options.port ?? config.server.port;
    this.#staticRoot = options.staticRoot;
    this.#onError = options.onError;
    this.#setupApi = options.setupApi;
    this.roomId = options.roomId ?? DEFAULT_ROOM_ID;
    this.runtimeIdentity =
      options.runtimeIdentity ?? createGroupXRuntimeIdentity({ embeddedConfig: config });

    const reader = new SqliteSseEventReader(this.store);
    this.sse = new SseRuntime(reader, {
      maxBufferedEvents: config.limits.sseEvents,
      maxBufferedBytes: config.limits.sseBytes
    });
    this.publisher = new SequencedEventPublisher(this.store, this.sse, {
      closeTimeoutMs: config.timeouts.closeMs
    });
    this.publisher.initialize([this.roomId]);
    this.sessions = new AgentSessionManager({
      config,
      store: this.store,
      adapters: this.adapters,
      mcpBindings: this.bindings,
      closeTimeoutMs: config.timeouts.closeMs,
      onProgress: async (progress) => {
        if (!this.publisher) return;
        const correlationId = createCorrelationId();
        await this.publisher.publish(
          asTransientEnvelope({
            eventId: createId(`session_${progress.phase}`),
            roomId: this.roomId,
            type: sessionEventType(progress),
            actor: {
              actorId: progress.actorId,
              kind: "agent",
              displayName: config.agents[progress.agentId]?.name ?? progress.agentId
            },
            to: [],
            correlationId,
            rootCorrelationId: correlationId,
            body: progress,
            provenance: { sourceKind: "system", labels: ["session-lifecycle"] }
          })
        );
      }
    });
    this.datedMemoryEngine = new AgentDatedMemoryEngine({
      store: this.store,
      summarizer:
        options.datedMemorySummarizer ??
        new OwningAgentDatedMemorySummarizer({
          config,
          primaryAdapters: this.adapters
        }),
      publish: async (event) => await this.publisher.publish(toDurableEnvelope(event)),
      onError: (error, context) => {
        this.#onError?.(error, {
          operation: "memory",
          actorId: context.actorId
        });
      }
    });
    this.contextEngine = new RoomContextEngine({
      store: this.store,
      summarizer:
        options.contextSummarizer ??
        new FirstAvailableAgentSummarizer({
          config,
          primaryAdapters: this.adapters
        }),
      maxChars: config.limits.contextCharacters,
      beforeCompaction: async ({ roomId, throughSeq, signal }) =>
        await this.datedMemoryEngine.flushBeforeCompaction({ roomId, throughSeq, signal }),
      onProgress: async (progress) => await publishCompactionProgress(this.publisher, progress)
    });
    this.#registerConfiguredActors();
  }

  /**
   * Give every configured agent an actors row so durable events can reference
   * it and the UI can show the configured display name. Builtin agents are
   * already seeded by the store; they are only upserted when renamed.
   */
  #registerConfiguredActors(): void {
    for (const [agentId, agent] of Object.entries(this.config.agents)) {
      if (isBuiltinAgentId(agentId) && agent.name === undefined) continue;
      this.store.upsertActor({
        actorId: `agent:${agentId}`,
        kind: "agent",
        displayName: agent.name ?? agentId,
        enabled: agent.enabled
      });
    }
  }

  get address(): GroupXHttpServerAddress | undefined {
    return this.#startResult?.address;
  }

  get broker(): GroupXBroker {
    if (!this.#broker) throw new GroupXError("SESSION_NOT_AVAILABLE", "Runtime has not started");
    return this.#broker;
  }

  get webBindingId(): string | undefined {
    return this.#webBindingId;
  }

  get mcpMounted(): boolean {
    return this.#mcpHandler !== undefined;
  }

  start(): Promise<GroupXRuntimeStartResult> {
    if (this.#startResult) return Promise.resolve(this.#startResult);
    if (this.#startPromise) return this.#startPromise;
    if (this.#closePromise) {
      return Promise.reject(new GroupXError("SESSION_NOT_AVAILABLE", "Runtime is closing"));
    }
    const operation = this.#performStart();
    this.#startPromise = operation;
    return operation.finally(() => {
      if (this.#startPromise === operation) this.#startPromise = undefined;
    });
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.readiness.markClosing();
    const starting = this.#startPromise;
    const operation = (async () => {
      if (starting) await starting.catch(() => undefined);
      await this.#performClose();
    })();
    this.#closePromise = operation;
    return operation;
  }

  async #performStart(): Promise<GroupXRuntimeStartResult> {
    try {
      this.#createWebBinding();
      this.#createOperatorBinding();
      const turns = new ActiveTurnCoordinator({
        transport: this.config.transport,
        bindings: this.bindings,
        sessions: this.sessions
      });
      const broker = new GroupXBroker({
        store: this.store,
        adapters: this.adapters,
        sessions: this.sessions,
        publisher: this.publisher,
        agentController: {
          restart: async (actorId) => {
            await this.sessions.restart(actorId);
          }
        },
        contextProvider: contextProvider(this.contextEngine, this.config, this.store),
        steerLimit: this.config.limits.steersPerSubjectTurn,
        watchTimeoutMs: this.config.timeouts.watchMs,
        contextController: this.contextEngine,
        datedMemoryController: this.datedMemoryEngine,
        turnLifecycle: turns,
        acceptMessageLimits: {
          rootTurns: this.config.limits.rootTurns,
          hopCount: this.config.limits.hopCount,
          actorCallsPerRoot: this.config.limits.actorCallsPerRoot,
          queuePerActor: this.config.limits.queuePerAgent
        },
        selectedTransport: this.config.transport,
        defaultRoomId: this.roomId,
        nativeCancelTimeoutMs: this.config.timeouts.cancelMs,
        closeTimeoutMs: this.config.timeouts.closeMs,
        ...(this.#onError === undefined ? {} : { onError: this.#onError })
      });
      const restartCommands = new RestartAgentCommandCoordinator({
        store: this.store,
        sessions: this.sessions,
        onSessionReady: (actorId) => broker.notifySessionReady(actorId)
      });
      const webApi = new GroupXWebBrokerApi({
        broker,
        restartCommands,
        readiness: this.readiness,
        config: this.config,
        roomId: this.roomId,
        bindingId: this.#webBindingId!
      });

      let toolApi: GroupXToolBrokerApi | undefined;
      let mcpHandler: GroupXMcpHttpHandler | undefined;
      let operatorApi: GroupXOperatorBrokerApi | undefined;
      let operatorMcpHandler: GroupXMcpHttpHandler | undefined;
      const knownTargets = this.adapters.list().map((adapter) => adapter.actorId);
      if (this.config.transport === "structured") {
        toolApi = new GroupXToolBrokerApi({
          broker,
          turns,
          roomId: this.roomId,
          askTimeoutMs: this.config.timeouts.askMs
        });
        mcpHandler = createGroupXMcpHttpHandler({
          broker: toolApi,
          bindings: this.bindings,
          knownTargets
        });
        operatorApi = new GroupXOperatorBrokerApi({
          broker,
          restartCommands,
          config: this.config,
          roomId: this.roomId,
          bindingId: this.#operatorBindingId!,
          store: this.store,
          askTimeoutMs: this.config.timeouts.askMs,
          ...(this.#setupApi === undefined ? {} : { setupApi: this.#setupApi })
        });
        this.bindings.register({
          bindingId: this.#operatorBindingId!,
          actorId: ASSISTANT_ACTOR_ID,
          instanceId: LOCAL_OPERATOR_INSTANCE_ID
        });
        this.bindings.markReady(this.#operatorBindingId!);
        operatorMcpHandler = createGroupXMcpHttpHandler({
          bindings: this.bindings,
          knownTargets,
          createServer: ({ binding, knownTargets: targets }) =>
            createGroupXOperatorMcpServer({
              broker: operatorApi!,
              binding,
              ...(targets === undefined ? {} : { knownTargets: targets })
            })
        });
      }
      const assistantHost = new GroupXAssistantHost({
        config: this.config,
        store: this.store
      });

      const http = createGroupXHttpServer({
        broker: webApi,
        sse: this.sse,
        host: this.config.server.host,
        port: this.#port,
        gracefulCloseTimeoutMs: this.config.timeouts.closeMs,
        ...(this.#staticRoot === undefined
          ? { staticRoot: fileURLToPath(new URL("../../web/", import.meta.url)) }
          : { staticRoot: this.#staticRoot }),
        ...(mcpHandler === undefined ? {} : { mcpHandler }),
        ...(operatorMcpHandler === undefined ? {} : { operatorMcpHandler }),
        ...(this.#setupApi === undefined ? {} : { setupApi: this.#setupApi }),
        assistantApi: {
          snapshot: (signal) => {
            signal.throwIfAborted();
            return assistantHost.snapshot();
          },
          listMessages: (signal) => {
            signal.throwIfAborted();
            return { messages: assistantHost.listMessages() };
          },
          postMessage: async (request, signal) => await assistantHost.postMessage(request, signal),
          cancel: async (request, signal) => {
            signal.throwIfAborted();
            return await assistantHost.cancel(request.clientCommandId);
          }
        },
        runtimeIdentity: this.runtimeIdentity
      });
      this.#broker = broker;
      this.#turns = turns;
      this.#webApi = webApi;
      this.#toolApi = toolApi;
      this.#operatorApi = operatorApi;
      this.#assistantHost = assistantHost;
      this.#mcpHandler = mcpHandler;
      this.#operatorMcpHandler = operatorMcpHandler;
      this.#http = http;

      // Structured sessions need the actual bound origin. HTTP therefore
      // listens first, while readiness keeps all write commands closed. The
      // loopback listener is also the single-runtime lease: stale process
      // recovery must not mutate a live runtime's bindings before this process
      // has successfully claimed the configured port.
      const address = await http.start();
      const recovery = this.sessions.prepareRecovery();
      if (this.config.transport === "structured") {
        this.sessions.setStructuredMcpUrl(`${address.origin}/mcp`);
      }
      await this.sessions.startAll({ nativeSessionIds: recovery.nativeSessionIds });
      await broker.recoverAfterRestart();
      this.datedMemoryEngine.recover(this.roomId);
      await assistantHost.start(address.origin);
      this.readiness.markReady();
      const result = { address, recovery };
      this.#startResult = result;
      return result;
    } catch (error) {
      this.readiness.markFailed(error);
      // If close() is already waiting for startup, do not await it here: that
      // would create a cycle. Otherwise register startup cleanup as the single
      // close promise so later callers cannot close the store twice.
      if (this.#closePromise === undefined) {
        const cleanup = this.#performClose();
        this.#closePromise = cleanup;
        await cleanup.catch(() => undefined);
      }
      throw error;
    }
  }

  #createWebBinding(): void {
    const existingInstance = this.store.getAgentInstance(LOCAL_REST_WEB_INSTANCE_ID);
    const existingBinding = this.store.getSessionBinding(LOCAL_REST_WEB_BINDING_ID);
    if (existingInstance === undefined && existingBinding === undefined) {
      this.store.createAgentInstance({
        instanceId: LOCAL_REST_WEB_INSTANCE_ID,
        actorId: "user:web",
        adapterId: "web",
        status: "ready"
      });
      this.store.createSessionBinding({
        bindingId: LOCAL_REST_WEB_BINDING_ID,
        instanceId: LOCAL_REST_WEB_INSTANCE_ID,
        actorId: "user:web",
        protocol: "local-rest",
        status: "ready",
        capabilities: {
          transport: "loopback-http",
          access: "unrestricted"
        }
      });
    } else if (
      existingInstance?.actorId !== "user:web" ||
      existingInstance.adapterId !== "web" ||
      existingInstance.processEndedAt !== undefined ||
      existingBinding?.instanceId !== LOCAL_REST_WEB_INSTANCE_ID ||
      existingBinding.actorId !== "user:web" ||
      existingBinding.protocol !== "local-rest" ||
      existingBinding.status !== "ready" ||
      existingBinding.closedAt !== undefined
    ) {
      throw new GroupXError(
        "STORE_CONFLICT",
        "Stable local-rest Web binding is missing or incompatible"
      );
    }
    this.#webBindingId = LOCAL_REST_WEB_BINDING_ID;
  }

  #createOperatorBinding(): void {
    const existingInstance = this.store.getAgentInstance(LOCAL_OPERATOR_INSTANCE_ID);
    const existingBinding = this.store.getSessionBinding(LOCAL_OPERATOR_BINDING_ID);
    if (existingInstance === undefined && existingBinding === undefined) {
      this.store.createAgentInstance({
        instanceId: LOCAL_OPERATOR_INSTANCE_ID,
        actorId: ASSISTANT_ACTOR_ID,
        adapterId: "operator",
        status: "ready"
      });
      this.store.createSessionBinding({
        bindingId: LOCAL_OPERATOR_BINDING_ID,
        instanceId: LOCAL_OPERATOR_INSTANCE_ID,
        actorId: ASSISTANT_ACTOR_ID,
        protocol: LOCAL_OPERATOR_PROTOCOL,
        status: "ready",
        capabilities: {
          transport: "loopback-http",
          access: "unrestricted",
          facet: "operator"
        }
      });
    } else if (
      existingInstance?.actorId !== ASSISTANT_ACTOR_ID ||
      existingInstance.adapterId !== "operator" ||
      existingInstance.processEndedAt !== undefined ||
      existingBinding?.instanceId !== LOCAL_OPERATOR_INSTANCE_ID ||
      existingBinding.actorId !== ASSISTANT_ACTOR_ID ||
      existingBinding.protocol !== LOCAL_OPERATOR_PROTOCOL ||
      existingBinding.status !== "ready" ||
      existingBinding.closedAt !== undefined
    ) {
      throw new GroupXError(
        "STORE_CONFLICT",
        "Stable local-operator assistant binding is missing or incompatible"
      );
    }
    this.#operatorBindingId = LOCAL_OPERATOR_BINDING_ID;
  }

  async #performClose(): Promise<void> {
    const failures: unknown[] = [];
    const settle = async (operation: () => void | Promise<void>): Promise<void> => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    };

    await settle(async () => await this.#http?.close());
    await settle(async () => await this.#assistantHost?.close());
    await settle(async () => await this.#operatorMcpHandler?.close());
    await settle(async () => await this.#mcpHandler?.close());
    await settle(() => this.contextEngine.close());
    await settle(async () => await this.datedMemoryEngine.close());
    await settle(async () => await this.#broker?.close());
    await settle(async () => await this.sessions.close());
    await settle(async () => await this.publisher.close());
    await settle(() => this.sse.close());
    if (this.#closeStore) await settle(() => this.store.close());

    if (failures.length > 0) {
      throw new AggregateError(failures, "GroupX runtime did not close cleanly");
    }
  }

}

export async function startGroupXRuntime(
  config: GroupXConfig,
  options: GroupXRuntimeOptions = {}
): Promise<GroupXRuntime> {
  const runtime = new GroupXRuntime(config, options);
  await runtime.start();
  return runtime;
}
