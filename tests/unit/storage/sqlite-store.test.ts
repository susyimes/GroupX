import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { GroupXError } from "../../../src/core/errors.js";
import { isRoomContextMessage } from "../../../src/memory/context-messages.js";
import { SqliteGroupXStore } from "../../../src/storage/sqlite-store.js";
import type {
  AcceptMessageInput,
  CreateIdentityInput,
  CreateMemoryInput,
  TurnTargetInput
} from "../../../src/storage/types.js";

interface Fixture {
  directory: string;
  databasePath: string;
  store: SqliteGroupXStore;
}

const fixtures = new Set<Fixture>();

function seedBindings(store: SqliteGroupXStore): void {
  const seeds = [
    ["user:web", "web", "instance:web", "binding:web"],
    ["agent:codex", "codex", "instance:codex", "binding:codex"],
    ["agent:grok", "grok", "instance:grok", "binding:grok"],
    ["agent:kimi", "kimi", "instance:kimi", "binding:kimi"]
  ] as const;
  for (const [actorId, adapterId, instanceId, bindingId] of seeds) {
    store.createAgentInstance({
      instanceId,
      actorId,
      adapterId,
      ...(actorId.startsWith("agent:") ? { transport: "structured" as const } : {}),
      processStartedAt: "2026-08-11T00:00:00.000Z",
      status: "ready"
    });
    store.createSessionBinding({
      bindingId,
      instanceId,
      actorId,
      protocol: adapterId === "web" ? "local-rest" : "test-protocol",
      ...(actorId.startsWith("agent:") ? { transport: "structured" as const } : {}),
      protocolVersion: "test/1",
      status: "ready",
      capabilities: { prompt: true },
      createdAt: "2026-08-11T00:00:00.000Z",
      lastReadyAt: "2026-08-11T00:00:00.000Z"
    });
  }
}

function createFixture(): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "groupx-store-"));
  const fixture: Fixture = {
    directory,
    databasePath: join(directory, "groupx.db"),
    store: undefined as unknown as SqliteGroupXStore
  };
  fixture.store = new SqliteGroupXStore(fixture.databasePath);
  seedBindings(fixture.store);
  fixtures.add(fixture);
  return fixture;
}

function reopen(fixture: Fixture): SqliteGroupXStore {
  fixture.store.close();
  fixture.store = new SqliteGroupXStore(fixture.databasePath);
  return fixture.store;
}

function target(actorId: "agent:codex" | "agent:grok" | "agent:kimi"): TurnTargetInput {
  return {
    actorId,
    adapterId: actorId.slice("agent:".length),
    transport: "structured"
  };
}

function messageInput(
  clientCommandId: string,
  content = "hello",
  targets: readonly TurnTargetInput[] = [target("agent:codex")]
): AcceptMessageInput {
  return {
    sourceBindingId: "binding:web",
    clientCommandId,
    roomId: "room:main",
    targets,
    content
  };
}

function expectGroupXCode(operation: () => unknown, code: string): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(GroupXError);
    expect((error as GroupXError).code).toBe(code);
    return;
  }
  throw new Error(`Expected GroupXError(${code})`);
}

function sourceEvent(store: SqliteGroupXStore, suffix: string) {
  return store.appendDurableEvent({
    eventId: `evt_${suffix}`,
    roomId: "room:main",
    eventType: "system.error",
    actorId: "system:groupx",
    correlationId: `corr_${suffix}`,
    body: { message: suffix }
  });
}

afterEach(() => {
  for (const fixture of fixtures) {
    fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
  fixtures.clear();
});

describe.sequential("SqliteGroupXStore runtime lifecycle", () => {
  it("persists starting bindings, marks native session ready and closes runtime records with CAS", () => {
    const fixture = createFixture();
    fixture.store.createAgentInstance({
      instanceId: "instance:codex:next",
      actorId: "agent:codex",
      adapterId: "codex",
      transport: "structured",
      processStartedAt: "2026-08-11T00:20:00.000Z",
      status: "starting"
    });
    fixture.store.createSessionBinding({
      bindingId: "binding:codex:next",
      instanceId: "instance:codex:next",
      actorId: "agent:codex",
      protocol: "codex-app-server",
      transport: "structured",
      status: "starting",
      createdAt: "2026-08-11T00:20:00.000Z"
    });

    const ready = fixture.store.markSessionBindingReady("binding:codex:next", {
      nativeSessionId: "thread-1",
      protocolVersion: "0.147.0",
      capabilities: { resume: true, mcp: true },
      lastReadyAt: "2026-08-11T00:20:01.000Z"
    });
    expect(ready).toMatchObject({
      status: "ready",
      nativeSessionId: "thread-1",
      protocolVersion: "0.147.0",
      capabilities: { resume: true, mcp: true },
      lastReadyAt: "2026-08-11T00:20:01.000Z"
    });
    expect(fixture.store.getAgentInstance("instance:codex:next")?.status).toBe("ready");
    expectGroupXCode(
      () =>
        fixture.store.markSessionBindingReady("binding:codex:next", {
          nativeSessionId: "thread-other"
        }),
      "STORE_CONFLICT"
    );

    const failed = fixture.store.markSessionBindingFailed("binding:codex:next", {
      status: "failed",
      closedAt: "2026-08-11T00:20:02.000Z"
    });
    expect(failed).toMatchObject({
      status: "failed",
      closedAt: "2026-08-11T00:20:02.000Z"
    });
    expect(
      fixture.store.markSessionBindingFailed("binding:codex:next", { status: "failed" })
    ).toEqual(failed);
    const finished = fixture.store.finishAgentInstance("instance:codex:next", {
      status: "failed",
      processEndedAt: "2026-08-11T00:20:02.000Z"
    });
    expect(finished).toMatchObject({
      status: "failed",
      processEndedAt: "2026-08-11T00:20:02.000Z"
    });
    expect(
      fixture.store.finishAgentInstance("instance:codex:next", { status: "failed" })
    ).toEqual(finished);
  });

  it("closes bindings with their process instance and rejects bindings on a dead instance", () => {
    const fixture = createFixture();
    const endedAt = "2026-08-11T00:25:00.000Z";
    fixture.store.finishAgentInstance("instance:codex", {
      status: "stopped",
      processEndedAt: endedAt
    });
    expect(fixture.store.getSessionBinding("binding:codex")).toMatchObject({
      status: "closed",
      closedAt: endedAt
    });
    expectGroupXCode(
      () =>
        fixture.store.createSessionBinding({
          bindingId: "binding:codex:dead",
          instanceId: "instance:codex",
          actorId: "agent:codex",
          protocol: "codex-app-server",
          transport: "structured",
          status: "ready"
        }),
      "MCP_BINDING_MISMATCH"
    );
    expectGroupXCode(
      () =>
        fixture.store.beginClientCommand({
          sourceBindingId: "binding:codex",
          clientCommandId: "dead-instance-command",
          commandType: "test.command",
          canonicalPayload: {}
        }),
      "MCP_BINDING_MISMATCH"
    );
  });

  it("recovers stale bindings and instances explicitly across reopen", () => {
    const fixture = createFixture();
    const accepted = fixture.store.acceptMessageWithDisposition(
      messageInput("stable-web-binding")
    );
    reopen(fixture);
    const recovered = fixture.store.recoverStaleRuntimeRecords(
      "2026-08-11T00:30:00.000Z"
    );
    expect(recovered.sessionBindings).toHaveLength(3);
    expect(recovered.agentInstances).toHaveLength(3);
    expect(recovered.sessionBindings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          bindingId: "binding:codex",
          status: "interrupted",
          closedAt: "2026-08-11T00:30:00.000Z"
        })
      ])
    );
    expect(recovered.agentInstances).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          instanceId: "instance:codex",
          status: "interrupted",
          processEndedAt: "2026-08-11T00:30:00.000Z"
        })
      ])
    );
    expect(fixture.store.recoverStaleRuntimeRecords()).toEqual({
      sessionBindings: [],
      agentInstances: []
    });
    expect(fixture.store.getSessionBinding("binding:web")).toMatchObject({
      actorId: "user:web",
      protocol: "local-rest",
      status: "ready"
    });
    expect(fixture.store.getSessionBinding("binding:web")?.closedAt).toBeUndefined();
    expect(fixture.store.getAgentInstance("instance:web")).toMatchObject({
      actorId: "user:web",
      status: "ready"
    });
    expect(fixture.store.getAgentInstance("instance:web")?.processEndedAt).toBeUndefined();
    expect(
      fixture.store.acceptMessageWithDisposition(messageInput("stable-web-binding"))
    ).toEqual({ result: accepted.result, disposition: "replayed" });
    expect(
      fixture.store.acceptMessageWithDisposition(
        messageInput("stable-web-binding-new-command", "after recovery", [target("agent:grok")])
      ).disposition
    ).toBe("accepted");
    reopen(fixture);
    expect(fixture.store.getSessionBinding("binding:codex")?.status).toBe("interrupted");
    expect(fixture.store.getAgentInstance("instance:codex")?.status).toBe("interrupted");
    expect(fixture.store.getSessionBinding("binding:web")?.status).toBe("ready");
    expect(fixture.store.getAgentInstance("instance:web")?.status).toBe("ready");
  });

  it("rejects unbounded session capability snapshots", () => {
    const fixture = createFixture();
    fixture.store.createAgentInstance({
      instanceId: "instance:bounded",
      actorId: "agent:codex",
      adapterId: "codex",
      transport: "structured"
    });
    expectGroupXCode(
      () =>
        fixture.store.createSessionBinding({
          bindingId: "binding:bounded",
          instanceId: "instance:bounded",
          actorId: "agent:codex",
          protocol: "codex-app-server",
          transport: "structured",
          capabilities: { oversized: "x".repeat(70 * 1024) }
        }),
      "INVALID_ENVELOPE"
    );
    expect(fixture.store.getSessionBinding("binding:bounded")).toBeUndefined();
  });
});

describe.sequential("SqliteGroupXStore transactions and idempotency", () => {
  it("D-001 rolls back command, message, queued events and every Turn on a late failure", () => {
    const fixture = createFixture();
    fixture.store.close();
    const raw = new Database(fixture.databasePath);
    raw.exec(`
      CREATE TRIGGER fail_command_result
      BEFORE UPDATE OF result_json ON client_commands
      WHEN NEW.result_json IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'forced acceptance failure');
      END;
    `);
    raw.close();
    fixture.store = new SqliteGroupXStore(fixture.databasePath);

    expect(() => fixture.store.acceptMessage(messageInput("D-001"))).toThrow();
    expect(fixture.store.getClientCommand("binding:web", "D-001")).toBeUndefined();
    expect(fixture.store.countEvents()).toBe(0);
    expect(fixture.store.countTurns()).toBe(0);
    expect(fixture.store.integrityCheck().ok).toBe(true);
  });

  it("D-004 replays the exact persisted acceptance and conflicts on changed payload", () => {
    const fixture = createFixture();
    const originalInput = messageInput("D-004", "review", [
      target("agent:grok"),
      target("agent:codex")
    ]);
    const first = fixture.store.acceptMessageWithDisposition(originalInput);
    expect(first.disposition).toBe("accepted");
    const eventCount = fixture.store.countEvents();
    const turnCount = fixture.store.countTurns();

    reopen(fixture);
    const replay = fixture.store.acceptMessageWithDisposition({
      ...messageInput("D-004", "review", [target("agent:codex"), target("agent:grok")]),
      targets: [target("agent:codex"), target("agent:grok")].map((entry) => ({
        ...entry,
        transport: "direct" as const
      }))
    });
    expect(replay).toEqual({ result: first.result, disposition: "replayed" });
    expect(replay.result.turns.map((turn) => fixture.store.getTurn(turn.turnId)?.transport)).toEqual([
      "structured",
      "structured"
    ]);
    expect(fixture.store.countEvents()).toBe(eventCount);
    expect(fixture.store.countTurns()).toBe(turnCount);

    expectGroupXCode(
      () => fixture.store.acceptMessage(messageInput("D-004", "changed")),
      "CLIENT_COMMAND_CONFLICT"
    );
    expect(fixture.store.countEvents()).toBe(eventCount);
    expect(fixture.store.countTurns()).toBe(turnCount);
  });

  it("claims external client commands once and distinguishes pending from completed replay", () => {
    const fixture = createFixture();
    const input = {
      sourceBindingId: "binding:web",
      clientCommandId: "cancel-receipt",
      commandType: "turn.cancel",
      canonicalPayload: { turnId: "turn:one" },
      acceptedAt: "2026-08-11T00:15:00.000Z"
    };

    expect(fixture.store.beginClientCommand(input)).toEqual({ disposition: "accepted" });
    expect(fixture.store.getClientCommand("binding:web", "cancel-receipt")).toMatchObject({
      commandType: "turn.cancel",
      completed: false,
      result: null,
      acceptedAt: "2026-08-11T00:15:00.000Z"
    });

    reopen(fixture);
    expect(fixture.store.beginClientCommand(input)).toEqual({ disposition: "pending" });
    const result = { status: "cancelled", turnId: "turn:one" };
    expect(
      fixture.store.completeClientCommand({
        sourceBindingId: "binding:web",
        clientCommandId: "cancel-receipt",
        result
      })
    ).toEqual(result);
    expect(fixture.store.beginClientCommand<typeof result>(input)).toEqual({
      disposition: "replayed",
      result
    });
    expect(
      fixture.store.completeClientCommand({
        sourceBindingId: "binding:web",
        clientCommandId: "cancel-receipt",
        result: { turnId: "turn:one", status: "cancelled" }
      })
    ).toEqual(result);
    expectGroupXCode(
      () =>
        fixture.store.completeClientCommand({
          sourceBindingId: "binding:web",
          clientCommandId: "cancel-receipt",
          result: { status: "running", turnId: "turn:one" }
        }),
      "CLIENT_COMMAND_CONFLICT"
    );
    expectGroupXCode(
      () => fixture.store.beginClientCommand({ ...input, canonicalPayload: { turnId: "turn:two" } }),
      "CLIENT_COMMAND_CONFLICT"
    );

    const nullInput = {
      ...input,
      clientCommandId: "restart-null-result",
      commandType: "agent.restart",
      canonicalPayload: { actorId: "agent:codex" }
    };
    expect(fixture.store.beginClientCommand(nullInput)).toEqual({ disposition: "accepted" });
    expect(
      fixture.store.completeClientCommand({
        sourceBindingId: "binding:web",
        clientCommandId: "restart-null-result",
        result: null
      })
    ).toBeNull();
    expect(fixture.store.beginClientCommand<null>(nullInput)).toEqual({
      disposition: "replayed",
      result: null
    });
    expect(
      fixture.store.getClientCommand("binding:web", "restart-null-result")?.completed
    ).toBe(true);
  });

  it("D-005 rolls back a three-target fan-out when the last Turn insert conflicts", () => {
    const fixture = createFixture();
    fixture.store.close();
    const raw = new Database(fixture.databasePath);
    raw.exec(`
      CREATE TRIGGER fail_kimi_turn
      BEFORE INSERT ON turns
      WHEN NEW.target_actor_id = 'agent:kimi'
      BEGIN
        SELECT RAISE(ABORT, 'forced third turn failure');
      END;
    `);
    raw.close();
    fixture.store = new SqliteGroupXStore(fixture.databasePath);

    expect(() =>
      fixture.store.acceptMessage(
        messageInput("D-005", "fan-out", [
          target("agent:codex"),
          target("agent:grok"),
          target("agent:kimi")
        ])
      )
    ).toThrow();
    expect(fixture.store.getClientCommand("binding:web", "D-005")).toBeUndefined();
    expect(fixture.store.countEvents()).toBe(0);
    expect(fixture.store.countTurns()).toBe(0);
  });

  it("enforces hop/root/actor/queue limits inside the fan-out transaction", () => {
    const fixture = createFixture();
    const defaults = {
      rootTurns: 24,
      hopCount: 12,
      actorCallsPerRoot: 8,
      queuePerActor: 64
    };

    expectGroupXCode(
      () =>
        fixture.store.acceptMessage({
          ...messageInput("limit-hop", "too deep", [
            { ...target("agent:codex"), hopCount: 2 }
          ]),
          limits: { ...defaults, hopCount: 1 }
        }),
      "HOP_LIMIT_REACHED"
    );
    expect(fixture.store.getClientCommand("binding:web", "limit-hop")).toBeUndefined();
    expect(fixture.store.countEvents()).toBe(0);

    fixture.store.acceptMessage({
      ...messageInput("limit-root-first", "first", [target("agent:codex")]),
      correlationId: "corr_limit_root",
      limits: defaults
    });
    const beforeRootReject = {
      events: fixture.store.countEvents(),
      turns: fixture.store.countTurns()
    };
    expectGroupXCode(
      () =>
        fixture.store.acceptMessage({
          ...messageInput("limit-root-second", "second", [target("agent:grok")]),
          correlationId: "corr_limit_root",
          limits: { ...defaults, rootTurns: 1 }
        }),
      "ROOT_TURN_LIMIT_REACHED"
    );
    expect(fixture.store.countEvents()).toBe(beforeRootReject.events);
    expect(fixture.store.countTurns()).toBe(beforeRootReject.turns);
    expect(fixture.store.getClientCommand("binding:web", "limit-root-second")).toBeUndefined();

    expectGroupXCode(
      () =>
        fixture.store.acceptMessage({
          ...messageInput("limit-actor-second", "again", [target("agent:codex")]),
          correlationId: "corr_limit_root",
          limits: { ...defaults, actorCallsPerRoot: 1 }
        }),
      "ROOT_TURN_LIMIT_REACHED"
    );
    expect(fixture.store.getClientCommand("binding:web", "limit-actor-second")).toBeUndefined();

    expectGroupXCode(
      () =>
        fixture.store.acceptMessage({
          ...messageInput("limit-queue", "queued", [target("agent:codex")]),
          correlationId: "corr_limit_queue",
          limits: { ...defaults, queuePerActor: 1 }
        }),
      "QUEUE_CAPACITY_REACHED"
    );
    expect(fixture.store.getClientCommand("binding:web", "limit-queue")).toBeUndefined();

    expectGroupXCode(
      () =>
        fixture.store.acceptMessage({
          ...messageInput("limit-runtime-malformed", "invalid runtime limits", [
            target("agent:grok")
          ]),
          limits: { hopCount: 12, rootTurns: 0 } as never
        }),
      "INVALID_ENVELOPE"
    );
    expect(fixture.store.getClientCommand("binding:web", "limit-runtime-malformed")).toBeUndefined();
  });

  it("replays a committed command without re-evaluating a now-tighter queue limit", () => {
    const fixture = createFixture();
    const input = {
      ...messageInput("limit-replay"),
      limits: {
        rootTurns: 24,
        hopCount: 12,
        actorCallsPerRoot: 8,
        queuePerActor: 64
      }
    };
    const first = fixture.store.acceptMessageWithDisposition(input);
    const eventCount = fixture.store.countEvents();
    const replay = fixture.store.acceptMessageWithDisposition({
      ...input,
      limits: { ...input.limits, queuePerActor: 1 }
    });
    expect(replay).toEqual({ result: first.result, disposition: "replayed" });
    expect(fixture.store.countEvents()).toBe(eventCount);
  });

  it("authoritatively validates root, hop and ancestor causality with atomic fan-out rollback", () => {
    const fixture = createFixture();
    const rootCorrelationId = "corr_causal_root";

    expectGroupXCode(
      () =>
        fixture.store.acceptMessage({
          ...messageInput("causal-forged-root-hop", "forged root", [
            { ...target("agent:codex"), hopCount: 1 }
          ]),
          correlationId: rootCorrelationId
        }),
      "INVALID_ENVELOPE"
    );
    expect(fixture.store.getClientCommand("binding:web", "causal-forged-root-hop")).toBeUndefined();

    const root = fixture.store.acceptMessage({
      ...messageInput("causal-root", "root", [target("agent:codex")]),
      correlationId: rootCorrelationId
    });
    const rootTurnId = root.turns[0]!.turnId;

    const childBase = {
      sourceBindingId: "binding:codex",
      roomId: "room:main",
      targets: [
        {
          ...target("agent:grok"),
          parentTurnId: rootTurnId,
          hopCount: 1
        }
      ],
      content: "child"
    };
    expectGroupXCode(
      () =>
        fixture.store.acceptMessage({
          ...childBase,
          clientCommandId: "causal-forged-root",
          correlationId: "corr_wrong"
        }),
      "INVALID_ENVELOPE"
    );
    expectGroupXCode(
      () =>
        fixture.store.acceptMessage({
          ...childBase,
          clientCommandId: "causal-forged-hop",
          correlationId: rootCorrelationId,
          targets: [{ ...childBase.targets[0]!, hopCount: 2 }]
        }),
      "INVALID_ENVELOPE"
    );
    expect(fixture.store.getClientCommand("binding:codex", "causal-forged-root")).toBeUndefined();
    expect(fixture.store.getClientCommand("binding:codex", "causal-forged-hop")).toBeUndefined();

    const child = fixture.store.acceptMessage({
      ...childBase,
      clientCommandId: "causal-child",
      correlationId: rootCorrelationId
    });
    const childTurnId = child.turns[0]!.turnId;
    const asyncBack = fixture.store.acceptMessage({
      sourceBindingId: "binding:grok",
      clientCommandId: "causal-async-back",
      commandType: "mcp.send",
      roomId: "room:main",
      correlationId: rootCorrelationId,
      content: "async back to ancestor is bounded but does not synchronously wait",
      targets: [
        { ...target("agent:codex"), parentTurnId: childTurnId, hopCount: 2 }
      ]
    });
    expect(asyncBack.turns).toHaveLength(1);
    const beforeCycle = {
      commands: fixture.store.getClientCommand("binding:grok", "causal-cycle"),
      events: fixture.store.countEvents(),
      turns: fixture.store.countTurns()
    };
    expectGroupXCode(
      () =>
        fixture.store.acceptMessage({
          sourceBindingId: "binding:grok",
          clientCommandId: "causal-cycle",
          commandType: "mcp.ask",
          roomId: "room:main",
          correlationId: rootCorrelationId,
          content: "mixed fan-out",
          targets: [
            { ...target("agent:kimi"), parentTurnId: childTurnId, hopCount: 2 },
            { ...target("agent:codex"), parentTurnId: childTurnId, hopCount: 2 }
          ]
        }),
      "CAUSAL_CYCLE"
    );
    expect(beforeCycle.commands).toBeUndefined();
    expect(fixture.store.getClientCommand("binding:grok", "causal-cycle")).toBeUndefined();
    expect(fixture.store.countEvents()).toBe(beforeCycle.events);
    expect(fixture.store.countTurns()).toBe(beforeCycle.turns);

    fixture.store.close();
    const raw = new Database(fixture.databasePath);
    raw.prepare("UPDATE turns SET hop_count = 7 WHERE turn_id = ?").run(childTurnId);
    raw.close();
    fixture.store = new SqliteGroupXStore(fixture.databasePath);
    expectGroupXCode(
      () =>
        fixture.store.acceptMessage({
          sourceBindingId: "binding:grok",
          clientCommandId: "causal-corrupt-chain",
          roomId: "room:main",
          correlationId: rootCorrelationId,
          content: "must fail closed",
          targets: [
            { ...target("agent:kimi"), parentTurnId: childTurnId, hopCount: 8 }
          ]
        }),
      "STORE_UNAVAILABLE"
    );
    expect(
      fixture.store.getClientCommand("binding:grok", "causal-corrupt-chain")
    ).toBeUndefined();
  });

  it("serializes competing writers so a rejected concurrent acceptance leaves no receipt", async () => {
    const fixture = createFixture();
    const script = String.raw`
      const { SqliteGroupXStore } = await import('./src/storage/sqlite-store.ts');
      const [databasePath, clientCommandId] = process.argv.slice(1);
      const store = new SqliteGroupXStore(databasePath);
      process.stdout.write('READY\n');
      process.stdin.once('data', () => {
        let result;
        try {
          const outcome = store.acceptMessageWithDisposition({
            sourceBindingId: 'binding:web',
            clientCommandId,
            roomId: 'room:main',
            correlationId: 'corr_' + clientCommandId,
            content: clientCommandId,
            targets: [{
              actorId: 'agent:codex',
              adapterId: 'codex',
              transport: 'structured'
            }],
            limits: {
              rootTurns: 24,
              hopCount: 12,
              actorCallsPerRoot: 8,
              queuePerActor: 1
            }
          });
          result = { state: outcome.disposition };
        } catch (error) {
          result = { state: 'rejected', code: error?.code ?? error?.name ?? 'Error' };
        } finally {
          store.close();
        }
        process.stdout.write('RESULT ' + JSON.stringify(result) + '\n', () => process.exit(0));
      });
    `;
    const runWriters = async (databasePath: string, commandIds: string[]) => {
      const children = commandIds.map((clientCommandId) =>
        spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            script,
            databasePath,
            clientCommandId
          ],
          { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
        )
      );
      const outputs = children.map(() => "");
      await Promise.all(
        children.map(
          (child, index) =>
            new Promise<void>((resolveReady, rejectReady) => {
              child.stdout.setEncoding("utf8");
              child.stderr.setEncoding("utf8");
              let stderr = "";
              child.stderr.on("data", (chunk: string) => {
                stderr += chunk;
              });
              child.stdout.on("data", (chunk: string) => {
                outputs[index] += chunk;
                if (outputs[index]!.includes("READY")) resolveReady();
              });
              child.once("error", rejectReady);
              child.once("exit", (code) => {
                if (!outputs[index]!.includes("READY")) {
                  rejectReady(new Error(`concurrent writer exited ${String(code)}: ${stderr}`));
                }
              });
            })
        )
      );
      const exits = children.map((child) => once(child, "exit"));
      for (const child of children) child.stdin.write("GO\n");
      await Promise.all(exits);
      return outputs.map((output) => {
        const line = output
          .split(/\r?\n/u)
          .find((candidate) => candidate.startsWith("RESULT "));
        if (!line) throw new Error(`missing concurrent writer result: ${output}`);
        return JSON.parse(line.slice("RESULT ".length)) as { state: string; code?: string };
      });
    };

    const commandIds = ["concurrent-a", "concurrent-b"];
    const outcomes = await runWriters(fixture.databasePath, commandIds);
    expect(outcomes.map((outcome) => outcome.state).sort()).toEqual(["accepted", "rejected"]);
    expect(outcomes.find((outcome) => outcome.state === "rejected")?.code).toBe(
      "QUEUE_CAPACITY_REACHED"
    );
    const persisted = commandIds.filter(
      (clientCommandId) =>
        fixture.store.getClientCommand("binding:web", clientCommandId) !== undefined
    );
    expect(persisted).toHaveLength(1);
    expect(fixture.store.countTurns()).toBe(1);

    const replayFixture = createFixture();
    const replayOutcomes = await runWriters(replayFixture.databasePath, [
      "concurrent-same",
      "concurrent-same"
    ]);
    expect(replayOutcomes.map((outcome) => outcome.state).sort()).toEqual([
      "accepted",
      "replayed"
    ]);
    expect(replayFixture.store.countTurns()).toBe(1);
    expect(
      replayFixture.store.getClientCommand("binding:web", "concurrent-same")?.completed
    ).toBe(true);
  });

  it("D-006 rejects a second Turn for the same source event and target", () => {
    const fixture = createFixture();
    const accepted = fixture.store.acceptMessage(messageInput("D-006"));
    const beforeEvents = fixture.store.countEvents();
    const beforeTurns = fixture.store.countTurns();

    expectGroupXCode(
      () =>
        fixture.store.enqueueTurn({
          sourceEventId: accepted.messageEventId,
          targetActorId: "agent:codex",
          adapterId: "codex",
          transport: "structured",
          rootCorrelationId: accepted.correlationId
        }),
      "DUPLICATE_DISPATCH"
    );
    expect(fixture.store.countEvents()).toBe(beforeEvents);
    expect(fixture.store.countTurns()).toBe(beforeTurns);
  });

  it("D-008 stores replayable reasoning/tool records without persisting transient deltas", () => {
    const fixture = createFixture();
    const accepted = fixture.store.acceptMessage(messageInput("D-008"));
    const turnId = accepted.turns[0]!.turnId;
    const source = fixture.store.getEvent(accepted.messageEventId)!;
    const claim = fixture.store.claimNextQueuedTurn({
      targetActorId: "agent:codex",
      bindingId: "binding:codex",
      instanceId: "instance:codex",
      contextThroughSeq: source.seq,
      expectedTurnId: turnId,
      expectedTransport: "structured"
    })!;
    fixture.store.markPromptInvoked(claim.attempt.attemptId);
    fixture.store.markAttemptRunning(claim.attempt.attemptId, "native-turn-1");
    const beforeDeltas = fixture.store.countEvents();
    for (let index = 0; index < 100; index += 1) {
      fixture.store.saveTurnPartialText(turnId, `partial ${index}`);
    }
    expect(fixture.store.countEvents()).toBe(beforeDeltas);
    expectGroupXCode(
      () =>
        fixture.store.appendDurableEvent({
          roomId: "room:main",
          eventType: "turn.content.delta",
          actorId: "agent:codex",
          correlationId: accepted.correlationId,
          body: { text: "token" }
        }),
      "INVALID_ENVELOPE"
    );
    expectGroupXCode(
      () =>
        fixture.store.appendDurableEvent({
          roomId: "room:main",
          eventType: "turn.reasoning.delta",
          actorId: "agent:codex",
          correlationId: accepted.correlationId,
          body: { text: "thinking token" }
        }),
      "INVALID_ENVELOPE"
    );
    expectGroupXCode(
      () =>
        fixture.store.appendDurableEvent({
          roomId: "room:main",
          eventType: "tool.progress",
          actorId: "agent:codex",
          correlationId: accepted.correlationId,
          body: { nativeType: "tool.started" }
        }),
      "INVALID_ENVELOPE"
    );

    const terminal = fixture.store.terminalizeTurn({
      turnId,
      attemptId: claim.attempt.attemptId,
      status: "completed",
      content: "final",
      reasoning: "first thought\nsecond thought",
      toolProgress: [
        {
          occurredAt: "2026-08-11T00:00:01.000Z",
          nativeType: "tool.started",
          toolCallId: "call-1",
          details: { server: "groupx", tool: "memory_search", status: "in_progress" }
        },
        {
          occurredAt: "2026-08-11T00:00:02.000Z",
          nativeType: "tool.completed",
          toolCallId: "call-1",
          details: { status: "completed" }
        }
      ],
      occurredAt: "2026-08-11T00:00:03.000Z"
    });
    expect(terminal.reasoningEvent).toMatchObject({
      eventType: "turn.reasoning.recorded",
      actorId: "agent:codex",
      instanceId: "instance:codex",
      body: {
        turnId,
        content: "first thought\nsecond thought",
        terminalStatus: "completed"
      }
    });
    expect(terminal.toolProgressEvents).toHaveLength(2);
    expect(terminal.toolProgressEvents).toEqual([
      expect.objectContaining({
        eventType: "tool.progress.recorded",
        actorId: "agent:codex",
        instanceId: "instance:codex",
        body: {
          turnId,
          nativeType: "tool.started",
          toolCallId: "call-1",
          details: { server: "groupx", tool: "memory_search", status: "in_progress" }
        }
      }),
      expect.objectContaining({
        eventType: "tool.progress.recorded",
        body: {
          turnId,
          nativeType: "tool.completed",
          toolCallId: "call-1",
          details: { status: "completed" }
        }
      })
    ]);
    expect(terminal.responseEvent?.eventType).toBe("message.created");
    expect(terminal.terminalEvent.eventType).toBe("turn.completed");
    expect(terminal.datedMemoryRollup).toMatchObject({
      roomId: "room:main",
      actorId: "agent:codex",
      localDate: "2026-08-11",
      pendingTurns: 1,
      pendingChars: "hello".length + "final".length
    });
    const rollupSources = fixture.store.listAgentDatedMemorySources({
      roomId: "room:main",
      actorId: "agent:codex",
      localDate: "2026-08-11"
    });
    expect(rollupSources).toEqual([
      expect.objectContaining({
        turnId,
        currentMessage: "hello",
        finalResponse: "final",
        responseEventId: terminal.responseEvent?.eventId
      })
    ]);
    expect(JSON.stringify(rollupSources)).not.toContain("first thought");
    expect(JSON.stringify(rollupSources)).not.toContain("memory_search");
    expect(terminal.reasoningEvent!.seq).toBeLessThan(terminal.toolProgressEvents![0]!.seq);
    expect(terminal.toolProgressEvents![0]!.seq).toBeLessThan(
      terminal.toolProgressEvents![1]!.seq
    );
    expect(terminal.toolProgressEvents![1]!.seq).toBeLessThan(terminal.responseEvent!.seq);
    expect(terminal.responseEvent!.seq).toBeLessThan(terminal.terminalEvent.seq);
    expect(terminal.terminalEvent.body).toMatchObject({
      reasoningEventId: terminal.reasoningEvent?.eventId,
      toolProgressEventIds: terminal.toolProgressEvents?.map((event) => event.eventId)
    });
    expect(terminal.turn.responseEventId).toBe(terminal.responseEvent?.eventId);
    expect(terminal.turn.terminalEventId).toBe(terminal.terminalEvent.eventId);
    expect(fixture.store.countEvents()).toBe(beforeDeltas + 5);

    expectGroupXCode(
      () =>
        fixture.store.terminalizeTurn({
          turnId,
          attemptId: claim.attempt.attemptId,
          status: "completed",
          content: "duplicate"
        }),
      "STORE_CONFLICT"
    );
    expect(fixture.store.countEvents()).toBe(beforeDeltas + 5);
  });

  it("atomically rolls pending sources into one generated dated memory and checkpoints trivial batches", () => {
    const fixture = createFixture();
    const accepted = fixture.store.acceptMessage(
      messageInput("dated-memory-bounds", "u".repeat(32_768))
    );
    const turnId = accepted.turns[0]!.turnId;
    const source = fixture.store.getEvent(accepted.messageEventId)!;
    const claim = fixture.store.claimNextQueuedTurn({
      targetActorId: "agent:codex",
      bindingId: "binding:codex",
      instanceId: "instance:codex",
      contextThroughSeq: source.seq,
      expectedTurnId: turnId,
      expectedTransport: "structured"
    })!;
    fixture.store.markPromptInvoked(claim.attempt.attemptId);
    fixture.store.markAttemptRunning(claim.attempt.attemptId, "native-dated-bounds");

    const terminal = fixture.store.terminalizeTurn({
      turnId,
      attemptId: claim.attempt.attemptId,
      status: "completed",
      content: "a".repeat(32_768),
      occurredAt: "2026-08-11T12:00:00.000Z"
    });

    reopen(fixture);
    expect(fixture.store.searchMemory({ scopeType: "agent", scopeId: "agent:codex" })).toEqual([]);
    const committed = fixture.store.commitAgentDatedMemoryRollup({
      roomId: "room:main",
      actorId: "agent:codex",
      localDate: "2026-08-11",
      selectedTurnIds: [turnId],
      content: "- Preserved one material result",
      generatedAt: "2026-08-11T12:05:00.000Z"
    });
    expect(committed.memory).toMatchObject({
      scopeType: "agent",
      scopeId: "agent:codex",
      agentMemoryType: "dated",
      kind: "summary",
      sourceKind: "automatic_rollup",
      content: "- Preserved one material result",
      sourceEventId: terminal.responseEvent?.eventId
    });
    expect(committed.event).toMatchObject({
      eventType: "memory.remembered",
      actorId: "agent:codex",
      body: { record: committed.memory }
    });
    expect(committed.rollup).toMatchObject({
      memoryId: committed.memory?.memoryId,
      pendingTurns: 0,
      pendingChars: 0,
      summarizedThroughSeq: terminal.responseEvent?.seq
    });
    expect(
      fixture.store.listAgentDatedMemorySources({
        roomId: "room:main",
        actorId: "agent:codex",
        localDate: "2026-08-11",
        pendingOnly: false
      })[0]
    ).toMatchObject({ processedAt: "2026-08-11T12:05:00.000Z", memoryId: committed.memory?.memoryId });

    const edited = fixture.store.supersedeMemory(committed.memory!.memoryId, {
      scopeType: "agent",
      scopeId: "agent:codex",
      agentMemoryType: "dated",
      kind: "summary",
      authorActorId: "user:web",
      subjectActorId: "agent:codex",
      content: "- User corrected the daily rollup",
      sourceKind: "web",
      createdAt: "2026-08-11T12:06:00.000Z"
    });
    expect(
      fixture.store.getAgentDatedMemoryRollup({
        roomId: "room:main",
        actorId: "agent:codex",
        localDate: "2026-08-11"
      })?.memoryId
    ).toBe(edited.memoryId);

    fixture.store.retractMemory(edited.memoryId, "2026-08-11T12:07:00.000Z");
    expect(
      fixture.store.getAgentDatedMemoryRollup({
        roomId: "room:main",
        actorId: "agent:codex",
        localDate: "2026-08-11"
      })?.memoryId
    ).toBeUndefined();

    const nextAccepted = fixture.store.acceptMessage(
      messageInput("dated-memory-after-retract", "next source")
    );
    const nextTurnId = nextAccepted.turns[0]!.turnId;
    const nextClaim = fixture.store.claimNextQueuedTurn({
      targetActorId: "agent:codex",
      bindingId: "binding:codex",
      instanceId: "instance:codex",
      contextThroughSeq: fixture.store.getEvent(nextAccepted.messageEventId)!.seq,
      expectedTurnId: nextTurnId,
      expectedTransport: "structured"
    })!;
    fixture.store.markPromptInvoked(nextClaim.attempt.attemptId);
    fixture.store.markAttemptRunning(nextClaim.attempt.attemptId, "native-after-retract");
    fixture.store.terminalizeTurn({
      turnId: nextTurnId,
      attemptId: nextClaim.attempt.attemptId,
      status: "completed",
      content: "next response",
      occurredAt: "2026-08-11T12:08:00.000Z"
    });
    const regenerated = fixture.store.commitAgentDatedMemoryRollup({
      roomId: "room:main",
      actorId: "agent:codex",
      localDate: "2026-08-11",
      selectedTurnIds: [nextTurnId],
      content: "- Fresh rollup after retraction",
      generatedAt: "2026-08-11T12:09:00.000Z"
    });
    expect(regenerated.memory).toMatchObject({
      status: "active",
      content: "- Fresh rollup after retraction"
    });
    expect(regenerated.memory?.supersedesMemoryId).toBeUndefined();
    expect(regenerated.rollup.memoryId).toBe(regenerated.memory?.memoryId);
  });

  it("claims only one FIFO lane head until its attempt reaches terminal state", () => {
    const fixture = createFixture();
    const first = fixture.store.acceptMessage(messageInput("claim-1", "first"));
    const second = fixture.store.acceptMessage(messageInput("claim-2", "second"));
    const firstClaim = fixture.store.claimNextQueuedTurn({
      targetActorId: "agent:codex",
      bindingId: "binding:codex",
      instanceId: "instance:codex",
      contextThroughSeq: fixture.store.getEvent(first.messageEventId)!.seq,
      expectedTurnId: first.turns[0]!.turnId,
      expectedTransport: "structured"
    })!;
    expect(firstClaim.turn.turnId).toBe(first.turns[0]!.turnId);
    expect(
      fixture.store.claimNextQueuedTurn({
        targetActorId: "agent:codex",
        bindingId: "binding:codex",
        instanceId: "instance:codex",
        contextThroughSeq: fixture.store.getEvent(second.messageEventId)!.seq,
        expectedTurnId: second.turns[0]!.turnId,
        expectedTransport: "structured"
      })
    ).toBeUndefined();
    fixture.store.markPromptInvoked(firstClaim.attempt.attemptId);
    fixture.store.markAttemptRunning(firstClaim.attempt.attemptId, "native-first");
    fixture.store.terminalizeTurn({
      turnId: firstClaim.turn.turnId,
      attemptId: firstClaim.attempt.attemptId,
      status: "completed",
      content: "done"
    });
    expect(
      fixture.store.claimNextQueuedTurn({
        targetActorId: "agent:codex",
        bindingId: "binding:codex",
        instanceId: "instance:codex",
        contextThroughSeq: fixture.store.getEvent(second.messageEventId)!.seq,
        expectedTurnId: second.turns[0]!.turnId,
        expectedTransport: "structured"
      })?.turn.turnId
    ).toBe(second.turns[0]!.turnId);
  });

  it("uses expectedTurnId as a stale-head CAS and never claims a newer Turn", () => {
    const fixture = createFixture();
    const first = fixture.store.acceptMessage(messageInput("claim-cas-1", "first"));
    const second = fixture.store.acceptMessage(messageInput("claim-cas-2", "second"));
    const secondTurnId = second.turns[0]!.turnId;

    expect(
      fixture.store.claimNextQueuedTurn({
        targetActorId: "agent:codex",
        bindingId: "binding:codex",
        instanceId: "instance:codex",
        contextThroughSeq: fixture.store.getEvent(second.messageEventId)!.seq,
        expectedTurnId: secondTurnId,
        expectedTransport: "structured"
      })
    ).toBeUndefined();
    expect(fixture.store.listTurnAttempts(first.turns[0]!.turnId)).toEqual([]);
    expect(fixture.store.listTurnAttempts(secondTurnId)).toEqual([]);

    fixture.store.cancelQueuedTurn(first.turns[0]!.turnId);
    expect(
      fixture.store.claimNextQueuedTurn({
        targetActorId: "agent:codex",
        bindingId: "binding:codex",
        instanceId: "instance:codex",
        contextThroughSeq: fixture.store.getEvent(first.messageEventId)!.seq,
        expectedTurnId: first.turns[0]!.turnId,
        expectedTransport: "structured"
      })
    ).toBeUndefined();
    expect(fixture.store.getTurn(secondTurnId)?.status).toBe("queued");
    expect(fixture.store.listTurnAttempts(secondTurnId)).toEqual([]);

    expect(
      fixture.store.claimNextQueuedTurn({
        targetActorId: "agent:codex",
        bindingId: "binding:codex",
        instanceId: "instance:codex",
        contextThroughSeq: fixture.store.getEvent(second.messageEventId)!.seq,
        expectedTurnId: secondTurnId,
        expectedTransport: "structured"
      })?.turn.turnId
    ).toBe(secondTurnId);
  });

  it("snapshots transport and fails a queued Turn instead of crossing modes after restart", () => {
    const fixture = createFixture();
    const accepted = fixture.store.acceptMessage(messageInput("transport-snapshot"));
    const turnId = accepted.turns[0]!.turnId;
    expect(fixture.store.getTurn(turnId)?.transport).toBe("structured");

    fixture.store.createAgentInstance({
      instanceId: "instance:codex:direct",
      actorId: "agent:codex",
      adapterId: "codex",
      transport: "direct",
      status: "ready"
    });
    fixture.store.createSessionBinding({
      bindingId: "binding:codex:direct",
      instanceId: "instance:codex:direct",
      actorId: "agent:codex",
      protocol: "direct-cli",
      transport: "direct",
      status: "ready"
    });
    expectGroupXCode(
      () =>
        fixture.store.claimNextQueuedTurn({
          targetActorId: "agent:codex",
          bindingId: "binding:codex:direct",
          instanceId: "instance:codex:direct",
          contextThroughSeq: fixture.store.getEvent(accepted.messageEventId)!.seq,
          expectedTurnId: turnId,
          expectedTransport: "direct"
        }),
      "TRANSPORT_MODE_MISMATCH"
    );
    expect(fixture.store.getTurn(turnId)?.status).toBe("queued");
    expect(fixture.store.listTurnAttempts(turnId)).toEqual([]);

    const failed = fixture.store.failQueuedTurn(
      turnId,
      "TRANSPORT_MODE_MISMATCH",
      "2026-08-11T00:40:00.000Z",
      { expectedTransport: "direct", turnTransport: "structured" }
    );
    expect(failed.turn).toMatchObject({
      status: "failed",
      transport: "structured",
      errorCode: "TRANSPORT_MODE_MISMATCH"
    });
    expect(failed.terminalEvent).toMatchObject({
      eventType: "turn.failed",
      actorId: "system:groupx"
    });
    expect(fixture.store.getDeliveryCursor("agent:codex", "room:main")).toBeUndefined();
    reopen(fixture);
    expect(fixture.store.getTurn(turnId)?.transport).toBe("structured");
  });

  it("write-aheads prompt invocation, CAS-binds late native ids and advances cursor only on confirmed start", () => {
    const fixture = createFixture();
    const accepted = fixture.store.acceptMessage(messageInput("dispatch-phases"));
    const turnId = accepted.turns[0]!.turnId;
    const contextThroughSeq = fixture.store.getEvent(accepted.messageEventId)!.seq;
    const claim = fixture.store.claimNextQueuedTurn({
      targetActorId: "agent:codex",
      bindingId: "binding:codex",
      instanceId: "instance:codex",
      contextThroughSeq,
      expectedTurnId: turnId,
      expectedTransport: "structured"
    })!;
    expect(claim.attempt).toMatchObject({
      dispatchPhase: "prepared",
      deliveryCertainty: "not_delivered"
    });
    expectGroupXCode(
      () => fixture.store.bindAttemptNativeTurnId(claim.attempt.attemptId, "too-early"),
      "STORE_CONFLICT"
    );
    expectGroupXCode(
      () => fixture.store.markAttemptRunning(claim.attempt.attemptId, "too-early"),
      "STORE_CONFLICT"
    );
    expect(fixture.store.getDeliveryCursor("agent:codex", "room:main")).toBeUndefined();

    const invoked = fixture.store.markPromptInvoked(
      claim.attempt.attemptId,
      "2026-08-11T00:10:00.000Z"
    );
    expect(invoked.attempt).toMatchObject({
      dispatchPhase: "prompt_invoked",
      deliveryCertainty: "unknown",
      promptInvokedAt: "2026-08-11T00:10:00.000Z"
    });
    expect(fixture.store.getDeliveryCursor("agent:codex", "room:main")).toBeUndefined();

    const bound = fixture.store.bindAttemptNativeTurnId(
      claim.attempt.attemptId,
      "native-late"
    );
    expect(bound.attempt.nativeTurnId).toBe("native-late");
    expect(bound.turn.nativeTurnId).toBe("native-late");
    expect(
      fixture.store.bindAttemptNativeTurnId(claim.attempt.attemptId, "native-late")
    ).toEqual(bound);
    expectGroupXCode(
      () => fixture.store.bindAttemptNativeTurnId(claim.attempt.attemptId, "native-other"),
      "STORE_CONFLICT"
    );

    const running = fixture.store.markAttemptRunning(
      claim.attempt.attemptId,
      undefined,
      "2026-08-11T00:10:01.000Z"
    );
    expect(running.turn.status).toBe("running");
    expect(running.attempt).toMatchObject({
      dispatchPhase: "native_started",
      deliveryCertainty: "delivered",
      nativeTurnId: "native-late"
    });
    expect(fixture.store.getDeliveryCursor("agent:codex", "room:main")?.lastDeliveredSeq).toBe(
      contextThroughSeq
    );

    fixture.store.terminalizeTurn({
      turnId,
      attemptId: claim.attempt.attemptId,
      status: "completed",
      content: "done"
    });
    expect(fixture.store.getTurnAttempt(claim.attempt.attemptId)).toMatchObject({
      dispatchPhase: "terminal",
      deliveryCertainty: "delivered"
    });
  });

  it("advances the summary watermark only when the attempt containing it reaches native start", () => {
    const fixture = createFixture();
    const first = sourceEvent(fixture.store, "cursor-summary-first");
    const summary = fixture.store.replaceActiveSummary({
      roomId: "room:main",
      fromSeq: first.seq,
      throughSeq: first.seq,
      content: "durable checkpoint",
      generatorActorId: "agent:codex"
    });
    const accepted = fixture.store.acceptMessage(messageInput("summary-cursor"));
    const contextThroughSeq = fixture.store.getEvent(accepted.messageEventId)!.seq;
    const claim = fixture.store.claimNextQueuedTurn({
      targetActorId: "agent:codex",
      bindingId: "binding:codex",
      instanceId: "instance:codex",
      contextThroughSeq,
      summaryThroughSeq: summary.throughSeq,
      expectedTurnId: accepted.turns[0]!.turnId,
      expectedTransport: "structured"
    })!;
    expect(claim.attempt.summaryThroughSeq).toBe(summary.throughSeq);
    expect(fixture.store.getDeliveryCursor("agent:codex", "room:main")).toBeUndefined();

    fixture.store.markPromptInvoked(claim.attempt.attemptId);
    fixture.store.markAttemptRunning(claim.attempt.attemptId, "native:summary");
    expect(fixture.store.getDeliveryCursor("agent:codex", "room:main")).toMatchObject({
      lastDeliveredSeq: contextThroughSeq,
      lastSummarySeq: summary.throughSeq
    });
  });

  it("rejects a dispatch checkpoint that was superseded after context preparation", () => {
    const fixture = createFixture();
    const first = sourceEvent(fixture.store, "summary-race-first");
    const stale = fixture.store.replaceActiveSummary({
      summaryId: "summary:dispatch-stale",
      roomId: "room:main",
      fromSeq: first.seq,
      throughSeq: first.seq,
      content: "prepared checkpoint",
      generatorActorId: "agent:codex"
    });
    const accepted = fixture.store.acceptMessage(messageInput("summary-race-claim"));
    const contextThroughSeq = fixture.store.getEvent(accepted.messageEventId)!.seq;
    fixture.store.replaceActiveSummary({
      summaryId: "summary:dispatch-current",
      roomId: "room:main",
      fromSeq: first.seq,
      throughSeq: contextThroughSeq,
      content: "advanced checkpoint",
      generatorActorId: "agent:grok",
      expectedPreviousSummaryId: stale.summaryId
    });

    try {
      fixture.store.claimNextQueuedTurn({
        targetActorId: "agent:codex",
        bindingId: "binding:codex",
        instanceId: "instance:codex",
        contextThroughSeq,
        summaryThroughSeq: stale.throughSeq,
        expectedTurnId: accepted.turns[0]!.turnId,
        expectedTransport: "structured"
      });
      throw new Error("expected stale summary claim to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(GroupXError);
      expect(error).toMatchObject({
        code: "STORE_CONFLICT",
        details: { reason: "summary_checkpoint_changed" }
      });
    }
    expect(fixture.store.getTurn(accepted.turns[0]!.turnId)?.status).toBe("queued");
    expect(fixture.store.listTurnAttempts(accepted.turns[0]!.turnId)).toEqual([]);
  });

  it("does not advance context cursor for queued cancellation or pre-native terminal", () => {
    const fixture = createFixture();
    const queued = fixture.store.acceptMessage(messageInput("no-cursor-queued"));
    fixture.store.cancelQueuedTurn(queued.turns[0]!.turnId);
    expect(fixture.store.getDeliveryCursor("agent:codex", "room:main")).toBeUndefined();

    const failed = fixture.store.acceptMessage(messageInput("no-cursor-dispatch"));
    const claim = fixture.store.claimNextQueuedTurn({
      targetActorId: "agent:codex",
      bindingId: "binding:codex",
      instanceId: "instance:codex",
      contextThroughSeq: fixture.store.getEvent(failed.messageEventId)!.seq,
      expectedTurnId: failed.turns[0]!.turnId,
      expectedTransport: "structured"
    })!;
    fixture.store.markPromptInvoked(claim.attempt.attemptId);
    fixture.store.terminalizeTurn({
      turnId: claim.turn.turnId,
      attemptId: claim.attempt.attemptId,
      status: "interrupted",
      errorCode: "TURN_INTERRUPTED"
    });
    expect(fixture.store.getDeliveryCursor("agent:codex", "room:main")).toBeUndefined();
    expect(fixture.store.getTurnAttempt(claim.attempt.attemptId)).toMatchObject({
      dispatchPhase: "terminal",
      deliveryCertainty: "unknown"
    });
  });

  it("rejects context and cursor boundaries outside the room high-water", () => {
    const fixture = createFixture();
    const accepted = fixture.store.acceptMessage(messageInput("context-bounds"));
    const turnId = accepted.turns[0]!.turnId;
    const sourceSeq = fixture.store.getEvent(accepted.messageEventId)!.seq;
    fixture.store.advanceDeliveryCursor("agent:codex", "room:main", sourceSeq);

    expectGroupXCode(
      () =>
        fixture.store.claimNextQueuedTurn({
          targetActorId: "agent:codex",
          bindingId: "binding:codex",
          instanceId: "instance:codex",
          contextThroughSeq: sourceSeq - 1,
          expectedTurnId: turnId,
          expectedTransport: "structured"
        }),
      "INVALID_ENVELOPE"
    );
    expectGroupXCode(
      () => fixture.store.advanceDeliveryCursor("agent:codex", "room:main", 1_000_000),
      "INVALID_ENVELOPE"
    );
    expectGroupXCode(
      () =>
        fixture.store.advanceDeliveryCursor("agent:codex", "room:main", sourceSeq, {
          lastSummarySeq: sourceSeq + 1
        }),
      "INVALID_ENVELOPE"
    );
    expect(fixture.store.getTurn(turnId)?.status).toBe("queued");
    expect(fixture.store.listTurnAttempts(turnId)).toEqual([]);
  });

  it("cancels a queued Turn with one compare-and-set terminal event and no attempt", () => {
    const fixture = createFixture();
    const accepted = fixture.store.acceptMessage(messageInput("queued-cancel"));
    const turnId = accepted.turns[0]!.turnId;
    const before = fixture.store.countEvents();
    const cancelled = fixture.store.cancelQueuedTurn(turnId);
    expect(cancelled.turn.status).toBe("cancelled");
    expect(cancelled.responseEvent).toBeUndefined();
    expect(cancelled.terminalEvent.eventType).toBe("turn.cancelled");
    expect(cancelled.terminalEvent.actorId).toBe("system:groupx");
    expect(fixture.store.listTurnAttempts(turnId)).toEqual([]);
    expect(fixture.store.countEvents()).toBe(before + 1);
    expectGroupXCode(() => fixture.store.cancelQueuedTurn(turnId), "STORE_CONFLICT");
    expect(fixture.store.countEvents()).toBe(before + 1);
  });
});

describe.sequential("SqliteGroupXStore summaries and recovery", () => {
  it("atomically rolls a cumulative room summary and preserves history", () => {
    const fixture = createFixture();
    const first = sourceEvent(fixture.store, "summary-first");
    const second = sourceEvent(fixture.store, "summary-second");

    const initial = fixture.store.replaceActiveSummary({
      summaryId: "summary:one",
      roomId: "room:main",
      fromSeq: first.seq,
      throughSeq: first.seq,
      content: "First checkpoint",
      generatorActorId: "agent:codex",
      createdAt: "2026-08-11T00:30:00.000Z"
    });
    expect(fixture.store.getActiveSummary("room:main")).toEqual(initial);

    const next = fixture.store.replaceActiveSummary({
      summaryId: "summary:two",
      roomId: "room:main",
      fromSeq: first.seq,
      throughSeq: second.seq,
      content: "Rolled checkpoint",
      generatorActorId: "agent:grok",
      expectedPreviousSummaryId: initial.summaryId,
      createdAt: "2026-08-11T00:31:00.000Z"
    });
    expect(next.status).toBe("active");
    expect(fixture.store.listSummaries({ roomId: "room:main", includeHistory: true })).toEqual([
      next,
      { ...initial, status: "superseded" }
    ]);
    expectGroupXCode(
      () =>
        fixture.store.replaceActiveSummary({
          roomId: "room:main",
          fromSeq: first.seq,
          throughSeq: second.seq,
          content: "stale",
          generatorActorId: "agent:kimi",
          expectedPreviousSummaryId: initial.summaryId
        }),
      "STORE_CONFLICT"
    );
    expect(fixture.store.countEvents()).toBe(2);
  });

  it("supersedes the active room summary when recording a context reset", () => {
    const fixture = createFixture();
    const first = sourceEvent(fixture.store, "reset-summary-first");
    const summary = fixture.store.replaceActiveSummary({
      summaryId: "summary:reset-old",
      roomId: "room:main",
      fromSeq: first.seq,
      throughSeq: first.seq,
      content: "Pre-reset checkpoint",
      generatorActorId: "agent:codex"
    });
    expect(fixture.store.getActiveSummary("room:main")).toEqual(summary);

    const reset = fixture.store.recordContextReset({
      roomId: "room:main",
      throughSeq: first.seq
    });
    expect(reset.throughSeq).toBe(first.seq);
    expect(fixture.store.getActiveSummary("room:main")).toBeUndefined();
    expect(fixture.store.getLatestContextResetThroughSeq("room:main")).toBe(first.seq);
    expect(fixture.store.listSummaries({ roomId: "room:main", includeHistory: true })).toEqual([
      { ...summary, status: "superseded" }
    ]);
  });

  it("X-001 reopens sessions, transcript, Turns, cursor, memory and identity", () => {
    const fixture = createFixture();
    const accepted = fixture.store.acceptMessage(messageInput("X-001", "persist everything"));
    const event = fixture.store.getEvent(accepted.messageEventId)!;
    fixture.store.advanceDeliveryCursor("agent:codex", "room:main", event.seq, {
      lastSummarySeq: event.seq
    });
    const memory = fixture.store.rememberMemory({
      scopeType: "room",
      scopeId: "room:main",
      kind: "fact",
      authorActorId: "user:web",
      content: "Pinned fact",
      sourceEventId: event.eventId,
      sourceKind: "web"
    });
    const identity = fixture.store.rememberIdentity({
      subjectActorId: "agent:codex",
      authorActorId: "user:web",
      kind: "role",
      content: "Reviewer",
      sourceEventId: event.eventId,
      sourceKind: "web"
    });
    fixture.store.upsertActor({
      actorId: "user:web",
      kind: "user",
      displayName: "Renamed User"
    });
    reopen(fixture);

    expect(fixture.store.getSchemaVersion()).toBe(9);
    expect(fixture.store.getJournalMode()).toBe("wal");
    expect(fixture.store.getSessionBinding("binding:codex")?.capabilities).toEqual({
      prompt: true
    });
    expect(fixture.store.getEvent(event.eventId)?.actorDisplayName).toBe("You");
    expect(fixture.store.getTurn(accepted.turns[0]!.turnId)?.status).toBe("queued");
    expect(fixture.store.getDeliveryCursor("agent:codex", "room:main")?.lastDeliveredSeq).toBe(
      event.seq
    );
    expect(fixture.store.searchMemory({ scopeId: "room:main" })).toContainEqual(memory);
    expect(fixture.store.readIdentity({ subjectActorId: "agent:codex" })).toContainEqual(identity);
    expect(fixture.store.integrityCheck()).toEqual({ ok: true, messages: ["ok"] });
  });

  it("X-005 recovers only queued work and marks all in-flight attempts unknown/interrupted", () => {
    const fixture = createFixture();
    const queued = fixture.store.acceptMessage(
      messageInput("X-005-q", "queued", [target("agent:codex")])
    );
    const dispatching = fixture.store.acceptMessage(
      messageInput("X-005-d", "dispatching", [target("agent:grok")])
    );
    const running = fixture.store.acceptMessage(
      messageInput("X-005-r", "running", [target("agent:kimi")])
    );
    const grokClaim = fixture.store.claimNextQueuedTurn({
      targetActorId: "agent:grok",
      bindingId: "binding:grok",
      instanceId: "instance:grok",
      contextThroughSeq: fixture.store.getEvent(dispatching.messageEventId)!.seq,
      expectedTurnId: dispatching.turns[0]!.turnId,
      expectedTransport: "structured"
    })!;
    const kimiClaim = fixture.store.claimNextQueuedTurn({
      targetActorId: "agent:kimi",
      bindingId: "binding:kimi",
      instanceId: "instance:kimi",
      contextThroughSeq: fixture.store.getEvent(running.messageEventId)!.seq,
      expectedTurnId: running.turns[0]!.turnId,
      expectedTransport: "structured"
    })!;
    fixture.store.markPromptInvoked(grokClaim.attempt.attemptId);
    fixture.store.markPromptInvoked(kimiClaim.attempt.attemptId);
    fixture.store.markAttemptRunning(kimiClaim.attempt.attemptId, "native-kimi-turn");

    fixture.store.close();
    const legacyCursor = new Database(fixture.databasePath);
    legacyCursor
      .prepare("DELETE FROM delivery_cursors WHERE actor_id = ? AND room_id = ?")
      .run("agent:kimi", "room:main");
    legacyCursor.close();
    fixture.store = new SqliteGroupXStore(fixture.databasePath);
    const recovery = fixture.store.recoverAfterRestart("2026-08-11T01:00:00.000Z");
    expect(recovery.queuedTurns.map((turn) => turn.turnId)).toEqual([
      queued.turns[0]!.turnId
    ]);
    expect(recovery.interruptedTurns.map((turn) => turn.turnId).sort()).toEqual(
      [dispatching.turns[0]!.turnId, running.turns[0]!.turnId].sort()
    );
    expect(fixture.store.getTurnAttempt(grokClaim.attempt.attemptId)?.deliveryCertainty).toBe(
      "unknown"
    );
    expect(fixture.store.getTurnAttempt(kimiClaim.attempt.attemptId)?.deliveryCertainty).toBe(
      "unknown"
    );
    expect(fixture.store.getTurn(dispatching.turns[0]!.turnId)?.status).toBe("interrupted");
    expect(fixture.store.getTurn(running.turns[0]!.turnId)?.status).toBe("interrupted");
    expect(fixture.store.getDeliveryCursor("agent:kimi", "room:main")?.lastDeliveredSeq).toBe(
      kimiClaim.attempt.contextThroughSeq
    );
    const afterFirstRecovery = fixture.store.countEvents();
    const repeatedRecovery = fixture.store.recoverAfterRestart("2026-08-11T01:01:00.000Z");
    expect(repeatedRecovery.interruptedTurns).toEqual([]);
    expect(repeatedRecovery.queuedTurns.map((turn) => turn.turnId)).toEqual([
      queued.turns[0]!.turnId
    ]);
    expect(fixture.store.countEvents()).toBe(afterFirstRecovery);
    expect(
      fixture.store.claimNextQueuedTurn({
        targetActorId: "agent:grok",
        bindingId: "binding:grok",
        instanceId: "instance:grok",
        contextThroughSeq: 0,
        expectedTurnId: dispatching.turns[0]!.turnId,
        expectedTransport: "structured"
      })
    ).toBeUndefined();
    expect(
      fixture.store.claimNextQueuedTurn({
        targetActorId: "agent:codex",
        bindingId: "binding:codex",
        instanceId: "instance:codex",
        contextThroughSeq: fixture.store.getEvent(queued.messageEventId)!.seq,
        expectedTurnId: queued.turns[0]!.turnId,
        expectedTransport: "structured"
      })?.turn.turnId
    ).toBe(queued.turns[0]!.turnId);
  });

  it("requeues only a v2 prepared/not_delivered attempt and closes the old attempt before reclaim", () => {
    const fixture = createFixture();
    const accepted = fixture.store.acceptMessage(messageInput("recover-prepared"));
    const turnId = accepted.turns[0]!.turnId;
    const contextThroughSeq = fixture.store.getEvent(accepted.messageEventId)!.seq;
    const firstClaim = fixture.store.claimNextQueuedTurn({
      targetActorId: "agent:codex",
      bindingId: "binding:codex",
      instanceId: "instance:codex",
      contextThroughSeq,
      expectedTurnId: turnId,
      expectedTransport: "structured"
    })!;

    reopen(fixture);
    const recovery = fixture.store.recoverAfterRestart("2026-08-11T01:10:00.000Z");
    expect(recovery.interruptedTurns).toEqual([]);
    expect(recovery.queuedTurns.map((turn) => turn.turnId)).toContain(turnId);
    expect(fixture.store.getTurnAttempt(firstClaim.attempt.attemptId)).toMatchObject({
      dispatchPhase: "terminal",
      deliveryCertainty: "not_delivered",
      terminalAt: "2026-08-11T01:10:00.000Z"
    });

    const secondClaim = fixture.store.claimNextQueuedTurn({
      targetActorId: "agent:codex",
      bindingId: "binding:codex",
      instanceId: "instance:codex",
      contextThroughSeq,
      expectedTurnId: turnId,
      expectedTransport: "structured"
    })!;
    expect(secondClaim.attempt.attemptId).not.toBe(firstClaim.attempt.attemptId);
    expect(fixture.store.listTurnAttempts(turnId)).toHaveLength(2);
    expect(
      fixture.store.listTurnAttempts(turnId).filter((attempt) => attempt.terminalAt === undefined)
    ).toEqual([secondClaim.attempt]);
  });

  it("migrates a legacy v1 not_delivered active attempt conservatively and never replays it", () => {
    const fixture = createFixture();
    const accepted = fixture.store.acceptMessage(messageInput("legacy-v1-attempt"));
    const turnId = accepted.turns[0]!.turnId;
    const claim = fixture.store.claimNextQueuedTurn({
      targetActorId: "agent:codex",
      bindingId: "binding:codex",
      instanceId: "instance:codex",
      contextThroughSeq: fixture.store.getEvent(accepted.messageEventId)!.seq,
      expectedTurnId: turnId,
      expectedTransport: "structured"
    })!;
    fixture.store.close();

    const raw = new Database(fixture.databasePath);
    raw.pragma("foreign_keys = OFF");
    raw.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE turn_attempts RENAME TO turn_attempts_v3;
      CREATE TABLE turn_attempts (
        attempt_id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL REFERENCES turns(turn_id),
        binding_id TEXT NOT NULL REFERENCES session_bindings(binding_id),
        instance_id TEXT NOT NULL REFERENCES agent_instances(instance_id),
        context_through_seq INTEGER NOT NULL CHECK (context_through_seq >= 0),
        native_turn_id TEXT,
        claimed_at TEXT NOT NULL,
        started_at TEXT,
        terminal_at TEXT,
        delivery_certainty TEXT NOT NULL CHECK (delivery_certainty IN (
          'not_delivered', 'delivered', 'unknown', 'terminal'
        ))
      );
      INSERT INTO turn_attempts(
        attempt_id, turn_id, binding_id, instance_id, context_through_seq,
        native_turn_id, claimed_at, started_at, terminal_at, delivery_certainty
      )
      SELECT attempt_id, turn_id, binding_id, instance_id, context_through_seq,
             native_turn_id, claimed_at, started_at, terminal_at, delivery_certainty
      FROM turn_attempts_v3;
      DROP TABLE turn_attempts_v3;
      CREATE INDEX turn_attempts_turn_claimed_idx
        ON turn_attempts(turn_id, claimed_at);
      ALTER TABLE agent_instances DROP COLUMN transport;
      ALTER TABLE session_bindings DROP COLUMN transport;
      ALTER TABLE turns DROP COLUMN transport;
      DROP TRIGGER memory_records_agent_type_bi;
      DROP TRIGGER memory_records_agent_type_bu;
      DROP INDEX memory_agent_type_status_created_idx;
      ALTER TABLE memory_records DROP COLUMN agent_memory_type;
      DROP TABLE agent_dated_memory_sources;
      DROP TABLE agent_dated_memory_rollups;
      DROP TABLE IF EXISTS context_resets;
      DROP TABLE IF EXISTS assistant_conversation_messages;
      DROP TABLE IF EXISTS supervision_steer_counts;
      DROP TABLE IF EXISTS supervision_pair_turns;
      DROP TABLE IF EXISTS supervision_pairs;
      DELETE FROM schema_migrations WHERE version > 1;
      PRAGMA user_version = 1;
      COMMIT;
    `);
    raw.close();

    fixture.store = new SqliteGroupXStore(fixture.databasePath);
    expect(fixture.store.getSchemaVersion()).toBe(9);
    expect(fixture.store.getTurnAttempt(claim.attempt.attemptId)).toMatchObject({
      dispatchPhase: "prompt_invoked",
      deliveryCertainty: "unknown"
    });
    const recovery = fixture.store.recoverAfterRestart("2026-08-11T01:20:00.000Z");
    expect(recovery.interruptedTurns.map((turn) => turn.turnId)).toEqual([turnId]);
    expect(recovery.queuedTurns).toEqual([]);
    expect(fixture.store.getTurn(turnId)?.status).toBe("interrupted");
  });

  it("migrates existing v5 Agent memory to core without rewriting room memory", () => {
    const fixture = createFixture();
    fixture.store.close();
    const raw = new Database(fixture.databasePath);
    raw.exec(`
      BEGIN IMMEDIATE;
      DROP TRIGGER memory_records_agent_type_bi;
      DROP TRIGGER memory_records_agent_type_bu;
      DROP INDEX memory_agent_type_status_created_idx;
      ALTER TABLE memory_records DROP COLUMN agent_memory_type;
      DROP TABLE agent_dated_memory_sources;
      DROP TABLE agent_dated_memory_rollups;
      DROP TABLE IF EXISTS context_resets;
      DROP TABLE IF EXISTS assistant_conversation_messages;
      DROP TABLE IF EXISTS supervision_steer_counts;
      DROP TABLE IF EXISTS supervision_pair_turns;
      DROP TABLE IF EXISTS supervision_pairs;
      DELETE FROM schema_migrations WHERE version = 6;
      DELETE FROM schema_migrations WHERE version = 7;
      DELETE FROM schema_migrations WHERE version = 8;
      DELETE FROM schema_migrations WHERE version = 9;
      PRAGMA user_version = 5;
      INSERT INTO memory_records(
        memory_id, scope_type, scope_id, kind, author_actor_id, subject_actor_id,
        content, source_event_id, source_kind, status, supersedes_memory_id,
        created_at, retracted_at
      ) VALUES (
        'memory:legacy-agent', 'agent', 'agent:codex', 'instruction', 'user:web',
        'agent:codex', 'legacy curated memory', NULL, 'web', 'active', NULL,
        '2026-08-11T00:00:00.000Z', NULL
      );
      COMMIT;
    `);
    raw.close();

    fixture.store = new SqliteGroupXStore(fixture.databasePath);
    expect(fixture.store.getSchemaVersion()).toBe(9);
    expect(fixture.store.getMemory("memory:legacy-agent")).toMatchObject({
      scopeType: "agent",
      agentMemoryType: "core",
      content: "legacy curated memory"
    });
  });

  it("closes and deregisters the database when migration validation fails", () => {
    const fixture = createFixture();
    fixture.store.close();
    const raw = new Database(fixture.databasePath);
    raw.pragma("user_version = 999");
    raw.close();

    expectGroupXCode(() => new SqliteGroupXStore(fixture.databasePath), "STORE_UNAVAILABLE");

    const repair = new Database(fixture.databasePath);
    repair.exec(`
      DROP TABLE IF EXISTS context_resets;
      DROP TABLE IF EXISTS assistant_conversation_messages;
      DROP TABLE IF EXISTS supervision_steer_counts;
      DROP TABLE IF EXISTS supervision_pair_turns;
      DROP TABLE IF EXISTS supervision_pairs;
      DELETE FROM schema_migrations WHERE version = 8;
      DELETE FROM schema_migrations WHERE version = 9;
    `);
    repair.pragma("user_version = 7");
    repair.close();
    fixture.store = new SqliteGroupXStore(fixture.databasePath);
    expect(fixture.store.getSchemaVersion()).toBe(9);
    expect(fixture.store.integrityCheck()).toEqual({ ok: true, messages: ["ok"] });
  });

  it("X-006 preserves committed WAL frames and drops an uncommitted transaction after crash", async () => {
    const fixture = createFixture();
    fixture.store.close();
    const script = String.raw`
      const Database = require('better-sqlite3');
      const db = new Database(process.argv[1]);
      db.pragma('journal_mode = WAL');
      db.pragma('wal_autocheckpoint = 0');
      const insert = db.prepare(
        'INSERT INTO events(event_id,schema_version,room_id,event_type,actor_id,actor_kind,actor_display_name,instance_id,targets_json,reply_to_event_id,causation_id,correlation_id,idempotency_key,occurred_at,body_json,provenance_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
      );
      insert.run('evt_committed','groupx.event/0.1','room:main','system.error','system:groupx','system','GroupX',null,'[]',null,null,'corr_crash',null,new Date().toISOString(),'{"committed":true}',null);
      db.exec('BEGIN IMMEDIATE');
      insert.run('evt_uncommitted','groupx.event/0.1','room:main','system.error','system:groupx','system','GroupX',null,'[]',null,null,'corr_crash',null,new Date().toISOString(),'{"committed":false}',null);
      process.stdout.write('READY\n');
      setInterval(() => {}, 1000);
    `;
    const child = spawn(process.execPath, ["-e", script, fixture.databasePath], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let output = "";
    await new Promise<void>((resolveReady, rejectReady) => {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        output += chunk;
        if (output.includes("READY")) resolveReady();
      });
      child.once("error", rejectReady);
      child.once("exit", (code) => {
        if (!output.includes("READY")) {
          rejectReady(new Error(`crash fixture exited early with ${String(code)}`));
        }
      });
    });
    child.kill();
    await once(child, "exit");

    fixture.store = new SqliteGroupXStore(fixture.databasePath);
    expect(fixture.store.getEvent("evt_committed")?.body).toEqual({ committed: true });
    expect(fixture.store.getEvent("evt_uncommitted")).toBeUndefined();
    expect(fixture.store.getJournalMode()).toBe("wal");
    expect(fixture.store.integrityCheck()).toEqual({ ok: true, messages: ["ok"] });
  });
});

describe.sequential("SqliteGroupXStore memory and identity", () => {
  it("atomically persists and replays a memory command with its durable event", () => {
    const fixture = createFixture();
    const input = {
      sourceBindingId: "binding:web",
      clientCommandId: "memory-atomic-remember",
      roomId: "room:main",
      correlationId: "corr_memory_atomic",
      occurredAt: "2026-08-11T02:10:00.000Z",
      mutation: {
        kind: "remember" as const,
        record: {
          memoryId: "mem_atomic",
          scopeType: "room" as const,
          scopeId: "room:main",
          kind: "fact" as const,
          authorActorId: "user:web",
          content: "Atomic memory",
          sourceKind: "web"
        }
      }
    };
    const before = fixture.store.countEvents();
    const accepted = fixture.store.mutateMemoryWithDisposition(input);
    expect(accepted.disposition).toBe("accepted");
    expect(accepted.result.record).toMatchObject({
      memoryId: "mem_atomic",
      status: "active",
      createdAt: "2026-08-11T02:10:00.000Z"
    });
    expect(accepted.result.event).toMatchObject({
      eventType: "memory.remembered",
      actorId: "user:web",
      correlationId: "corr_memory_atomic"
    });
    expect(fixture.store.countEvents()).toBe(before + 1);

    reopen(fixture);
    const replayed = fixture.store.mutateMemoryWithDisposition(input);
    expect(replayed).toEqual({ result: accepted.result, disposition: "replayed" });
    expect(fixture.store.countEvents()).toBe(before + 1);
    expectGroupXCode(
      () =>
        fixture.store.mutateMemoryWithDisposition({
          ...input,
          mutation: {
            ...input.mutation,
            record: { ...input.mutation.record, content: "Changed" }
          }
        }),
      "CLIENT_COMMAND_CONFLICT"
    );
  });

  it("rolls back the memory record and client command when durable event insertion fails", () => {
    const fixture = createFixture();
    fixture.store.close();
    const raw = new Database(fixture.databasePath);
    raw.exec(`
      CREATE TRIGGER fail_memory_event
      BEFORE INSERT ON events
      WHEN NEW.event_type = 'memory.remembered'
      BEGIN
        SELECT RAISE(ABORT, 'forced memory event failure');
      END;
    `);
    raw.close();
    fixture.store = new SqliteGroupXStore(fixture.databasePath);
    const before = fixture.store.countEvents();

    expect(() =>
      fixture.store.mutateMemoryWithDisposition({
        sourceBindingId: "binding:web",
        clientCommandId: "memory-event-failure",
        roomId: "room:main",
        mutation: {
          kind: "remember",
          record: {
            memoryId: "mem_should_rollback",
            scopeType: "room",
            scopeId: "room:main",
            kind: "note",
            authorActorId: "user:web",
            content: "rollback",
            sourceKind: "web"
          }
        }
      })
    ).toThrow();
    expect(fixture.store.getMemory("mem_should_rollback")).toBeUndefined();
    expect(
      fixture.store.getClientCommand("binding:web", "memory-event-failure")
    ).toBeUndefined();
    expect(fixture.store.countEvents()).toBe(before);
  });

  it("atomically versions and retracts identity records with binding-assigned authors", () => {
    const fixture = createFixture();
    const first = fixture.store.mutateIdentityWithDisposition({
      sourceBindingId: "binding:web",
      clientCommandId: "identity-remember",
      roomId: "room:main",
      occurredAt: "2026-08-11T02:20:00.000Z",
      mutation: {
        kind: "remember",
        record: {
          identityId: "identity_atomic_1",
          subjectActorId: "agent:codex",
          authorActorId: "user:web",
          kind: "role",
          content: "Reviewer",
          sourceKind: "web"
        }
      }
    });
    const second = fixture.store.mutateIdentityWithDisposition({
      sourceBindingId: "binding:web",
      clientCommandId: "identity-supersede",
      roomId: "room:main",
      occurredAt: "2026-08-11T02:21:00.000Z",
      mutation: {
        kind: "supersede",
        identityId: first.result.record.identityId,
        replacement: {
          identityId: "identity_atomic_2",
          subjectActorId: "agent:codex",
          authorActorId: "user:web",
          kind: "role",
          content: "Lead reviewer",
          sourceKind: "web"
        }
      }
    });
    expect(second.result.event.eventType).toBe("identity.superseded");
    expect(fixture.store.getIdentity(first.result.record.identityId)?.status).toBe("superseded");
    const retracted = fixture.store.mutateIdentityWithDisposition({
      sourceBindingId: "binding:web",
      clientCommandId: "identity-retract",
      roomId: "room:main",
      occurredAt: "2026-08-11T02:22:00.000Z",
      mutation: { kind: "retract", identityId: second.result.record.identityId }
    });
    expect(retracted.result.record).toMatchObject({
      identityId: "identity_atomic_2",
      status: "retracted",
      retractedAt: "2026-08-11T02:22:00.000Z"
    });
    expect(retracted.result.event.eventType).toBe("identity.retracted");

    expectGroupXCode(
      () =>
        fixture.store.mutateIdentityWithDisposition({
          sourceBindingId: "binding:web",
          clientCommandId: "identity-forged-author",
          roomId: "room:main",
          mutation: {
            kind: "remember",
            record: {
              subjectActorId: "agent:codex",
              authorActorId: "agent:codex",
              kind: "role",
              content: "Forged",
              sourceKind: "web"
            }
          }
        }),
      "SENDER_FIELD_FORBIDDEN"
    );
    expect(
      fixture.store.getClientCommand("binding:web", "identity-forged-author")
    ).toBeUndefined();
  });

  it("M-002 persists a public fact with scope, author and source provenance", () => {
    const fixture = createFixture();
    const source = sourceEvent(fixture.store, "M002");
    const input: CreateMemoryInput = {
      scopeType: "room",
      scopeId: "room:main",
      kind: "fact",
      authorActorId: "user:web",
      content: "The project is local-first",
      sourceEventId: source.eventId,
      sourceKind: "web"
    };
    const record = fixture.store.rememberMemory(input);
    reopen(fixture);
    expect(fixture.store.getMemory(record.memoryId)).toEqual(record);
    expect(fixture.store.searchMemory({ text: "local-first" })).toEqual([record]);
    expect(fixture.store.getEvent(record.sourceEventId!)).toEqual(source);
  });

  it("M-005 supersedes by appending a new active version while preserving history", () => {
    const fixture = createFixture();
    const firstSource = sourceEvent(fixture.store, "M005a");
    const nextSource = sourceEvent(fixture.store, "M005b");
    const first = fixture.store.rememberMemory({
      scopeType: "room",
      scopeId: "room:main",
      kind: "decision",
      authorActorId: "user:web",
      content: "Use polling",
      sourceEventId: firstSource.eventId,
      sourceKind: "web"
    });
    const next = fixture.store.supersedeMemory(first.memoryId, {
      scopeType: "room",
      scopeId: "room:main",
      kind: "decision",
      authorActorId: "user:web",
      content: "Use SSE",
      sourceEventId: nextSource.eventId,
      sourceKind: "web"
    });

    expect(fixture.store.searchMemory({ scopeId: "room:main" })).toEqual([next]);
    const history = fixture.store.searchMemory({ scopeId: "room:main", includeHistory: true });
    expect(history).toEqual(expect.arrayContaining([
      expect.objectContaining({
        memoryId: first.memoryId,
        content: "Use polling",
        sourceEventId: firstSource.eventId,
        status: "superseded"
      }),
      expect.objectContaining({
        memoryId: next.memoryId,
        content: "Use SSE",
        sourceEventId: nextSource.eventId,
        status: "active",
        supersedesMemoryId: first.memoryId
      })
    ]));
    expectGroupXCode(
      () =>
        fixture.store.supersedeMemory(first.memoryId, {
          scopeType: "room",
          scopeId: "room:main",
          kind: "decision",
          authorActorId: "user:web",
          content: "Forked head",
          sourceKind: "web"
        }),
      "STORE_CONFLICT"
    );
  });

  it("M-006 retracts with an auditable tombstone and no destructive delete", () => {
    const fixture = createFixture();
    const source = sourceEvent(fixture.store, "M006");
    const record = fixture.store.rememberMemory({
      scopeType: "agent",
      scopeId: "agent:codex",
      agentMemoryType: "core",
      kind: "preference",
      authorActorId: "user:web",
      subjectActorId: "agent:codex",
      content: "Prefer concise replies",
      sourceEventId: source.eventId,
      sourceKind: "web"
    });
    const retracted = fixture.store.retractMemory(
      record.memoryId,
      "2026-08-11T02:00:00.000Z"
    );
    expect(fixture.store.searchMemory({ scopeId: "agent:codex" })).toEqual([]);
    expect(fixture.store.searchMemory({ scopeId: "agent:codex", includeHistory: true })).toEqual([
      expect.objectContaining({
        memoryId: record.memoryId,
        content: record.content,
        sourceEventId: source.eventId,
        status: "retracted",
        retractedAt: "2026-08-11T02:00:00.000Z"
      })
    ]);
  });

  it("M-007 preserves Codex as observer and Grok as subject without forging Grok self identity", () => {
    const fixture = createFixture();
    const source = sourceEvent(fixture.store, "M007");
    const input: CreateIdentityInput = {
      subjectActorId: "agent:grok",
      authorActorId: "agent:codex",
      kind: "note",
      content: "Grok focused on interoperability in this round",
      sourceEventId: source.eventId,
      sourceKind: "adapter"
    };
    const observation = fixture.store.rememberIdentity(input);
    expect(fixture.store.getIdentity(observation.identityId)).toEqual(observation);
    expect(fixture.store.readIdentity({ subjectActorId: "agent:grok" })).toEqual([observation]);
    expect(
      fixture.store.readIdentity({
        subjectActorId: "agent:grok",
        authorActorId: "agent:grok"
      })
    ).toEqual([]);
  });
});

describe.sequential("SqliteGroupXStore paging and cursors", () => {
  it("pages more than 500 memory records with a restart-stable offset cursor", () => {
    const fixture = createFixture();
    const createdAt = "2026-08-11T03:00:00.000Z";
    const expectedIds: string[] = [];
    for (let index = 0; index < 503; index += 1) {
      const memoryId = `mem_page_${String(index).padStart(4, "0")}`;
      expectedIds.push(memoryId);
      fixture.store.rememberMemory({
        memoryId,
        scopeType: "room",
        scopeId: index % 3 === 0 ? "room:filtered" : "room:main",
        kind: index % 2 === 0 ? "fact" : "note",
        authorActorId: "user:web",
        content: `memory page ${index}`,
        sourceKind: "web",
        createdAt
      });
    }
    expectedIds.reverse();

    const collectedIds: string[] = [];
    const limit = 137;
    for (let cursor = 0; ; cursor += limit) {
      const page = fixture.store.searchMemory({ cursor, limit });
      collectedIds.push(...page.map((record) => record.memoryId));
      if (cursor === 0) reopen(fixture);
      if (page.length < limit) break;
    }
    expect(collectedIds).toEqual(expectedIds);

    const filtered = fixture.store.searchMemory({
      scopeId: "room:filtered",
      kind: "fact",
      cursor: 23,
      limit: 41
    });
    const allFiltered = fixture.store.searchMemory({
      scopeId: "room:filtered",
      kind: "fact",
      limit: 1_000
    });
    expect(filtered).toEqual(allFiltered.slice(23, 64));
    expectGroupXCode(() => fixture.store.searchMemory({ cursor: -1 }), "INVALID_ENVELOPE");
    expectGroupXCode(() => fixture.store.searchMemory({ cursor: 0.5 }), "INVALID_ENVELOPE");
    expectGroupXCode(
      () => fixture.store.searchMemory({ cursor: Number.MAX_SAFE_INTEGER + 1 }),
      "INVALID_ENVELOPE"
    );
    expectGroupXCode(() => fixture.store.searchMemory({ limit: 1_001 }), "INVALID_ENVELOPE");
  });

  it("applies identity offsets after filtering and preserves stable order across reopen", () => {
    const fixture = createFixture();
    const createdAt = "2026-08-11T03:10:00.000Z";
    const expectedIds: string[] = [];
    for (let index = 0; index < 501; index += 1) {
      const identityId = `identity_page_${String(index).padStart(4, "0")}`;
      expectedIds.push(identityId);
      fixture.store.rememberIdentity({
        identityId,
        subjectActorId: index % 4 === 0 ? "agent:grok" : "agent:codex",
        authorActorId: "user:web",
        kind: index % 2 === 0 ? "role" : "note",
        content: `identity page ${index}`,
        sourceKind: "web",
        createdAt
      });
    }
    expectedIds.reverse();

    const first = fixture.store.readIdentity({ cursor: 0, limit: 211 });
    reopen(fixture);
    const second = fixture.store.readIdentity({ cursor: first.length, limit: 211 });
    const third = fixture.store.readIdentity({
      cursor: first.length + second.length,
      limit: 211
    });
    expect([...first, ...second, ...third].map((record) => record.identityId)).toEqual(
      expectedIds
    );

    const allFiltered = fixture.store.readIdentity({
      subjectActorId: "agent:grok",
      kind: "role",
      limit: 1_000
    });
    const filtered = fixture.store.readIdentity({
      subjectActorId: "agent:grok",
      kind: "role",
      cursor: 17,
      limit: 29
    });
    expect(filtered).toEqual(allFiltered.slice(17, 46));
    expectGroupXCode(() => fixture.store.readIdentity({ cursor: -1 }), "INVALID_ENVELOPE");
  });

  it("holds a durable room snapshot boundary while newer events are appended", () => {
    const fixture = createFixture();
    for (let index = 0; index < 5; index += 1) {
      sourceEvent(fixture.store, `snapshot_before_${index}`);
    }
    const throughSeq = fixture.store.getRoomHighWaterSeq("room:main");
    for (let index = 0; index < 3; index += 1) {
      sourceEvent(fixture.store, `snapshot_after_${index}`);
    }

    const first = fixture.store.listEventsThrough({
      roomId: "room:main",
      afterSeq: 0,
      throughSeq,
      limit: 2
    });
    const second = fixture.store.listEventsThrough({
      roomId: "room:main",
      afterSeq: first.nextAfterSeq,
      throughSeq,
      limit: 10
    });
    const snapshot = [...first.events, ...second.events];
    expect(first.hasMore).toBe(true);
    expect(second.hasMore).toBe(false);
    expect(snapshot).toHaveLength(5);
    expect(snapshot.every((event) => event.seq <= throughSeq)).toBe(true);
    expect(fixture.store.getRoomHighWaterSeq("room:main")).toBeGreaterThan(throughSeq);
    expectGroupXCode(
      () =>
        fixture.store.listEventsThrough({
          roomId: "room:main",
          throughSeq: fixture.store.getRoomHighWaterSeq("room:main") + 1
        }),
      "INVALID_ENVELOPE"
    );
  });

  it("reads a bounded room bootstrap snapshot with room-local active Turns", () => {
    const fixture = createFixture();
    for (let index = 0; index < 505; index += 1) {
      sourceEvent(fixture.store, `bootstrap_${String(index).padStart(3, "0")}`);
    }
    const main = fixture.store.acceptMessage(messageInput("bootstrap-main"));
    const other = fixture.store.acceptMessage({
      ...messageInput("bootstrap-other", "other room", [target("agent:grok")]),
      roomId: "room:other"
    });

    const snapshot = fixture.store.readRoomBootstrapSnapshot({
      roomId: "room:main",
      recentLimit: 3
    });

    expect(snapshot.roomId).toBe("room:main");
    expect(snapshot.throughSeq).toBe(fixture.store.getRoomHighWaterSeq("room:main"));
    expect(snapshot.recentEvents).toHaveLength(3);
    expect(snapshot.recentEvents.every((event) => event.roomId === "room:main")).toBe(true);
    expect(snapshot.recentEvents.map((event) => event.seq)).toEqual(
      [...snapshot.recentEvents.map((event) => event.seq)].sort((left, right) => left - right)
    );
    expect(snapshot.recentEvents.at(-1)?.seq).toBe(snapshot.throughSeq);
    expect(snapshot.activeTurns.map((turn) => turn.turnId)).toEqual([main.turns[0]!.turnId]);
    expect(snapshot.activeTurns.map((turn) => turn.turnId)).not.toContain(
      other.turns[0]!.turnId
    );
  });

  it("pages durable seq strictly after the cursor and never moves delivery cursors backward", () => {
    const fixture = createFixture();
    for (let index = 0; index < 55; index += 1) {
      sourceEvent(fixture.store, `page_${String(index).padStart(3, "0")}`);
    }
    const collected: number[] = [];
    let afterSeq = 0;
    do {
      const page = fixture.store.listEvents({ roomId: "room:main", afterSeq, limit: 20 });
      collected.push(...page.events.map((event) => event.seq));
      afterSeq = page.nextAfterSeq;
      if (!page.hasMore) break;
    } while (true);
    expect(collected).toHaveLength(55);
    expect(new Set(collected).size).toBe(55);
    expect(collected).toEqual([...collected].sort((left, right) => left - right));
    expect(fixture.store.listEvents({ roomId: "room:main", afterSeq, limit: 20 })).toEqual({
      events: [],
      afterSeq,
      nextAfterSeq: afterSeq,
      hasMore: false
    });

    fixture.store.advanceDeliveryCursor("agent:codex", "room:main", 50, {
      lastSummarySeq: 40
    });
    const cursor = fixture.store.advanceDeliveryCursor("agent:codex", "room:main", 10, {
      lastSummarySeq: 5
    });
    expect(cursor.lastDeliveredSeq).toBe(50);
    expect(cursor.lastSummarySeq).toBe(40);
  });

  it("persists operator.dispatch for replay and current-task content without a chat bubble", () => {
    const fixture = createFixture();
    fixture.store.createAgentInstance({
      instanceId: "instance:operator",
      actorId: "user:assistant",
      adapterId: "operator",
      processStartedAt: "2026-08-11T00:00:00.000Z",
      status: "ready"
    });
    fixture.store.createSessionBinding({
      bindingId: "binding:operator",
      instanceId: "instance:operator",
      actorId: "user:assistant",
      protocol: "local-operator",
      protocolVersion: "operator/1",
      status: "ready",
      capabilities: { prompt: true },
      createdAt: "2026-08-11T00:00:00.000Z",
      lastReadyAt: "2026-08-11T00:00:00.000Z"
    });

    const input: AcceptMessageInput = {
      sourceBindingId: "binding:operator",
      clientCommandId: "op-dispatch-1",
      roomId: "room:main",
      targets: [target("agent:codex")],
      content: "review the plan",
      sourceEventType: "operator.dispatch",
      operation: "worker_dispatch"
    };
    const first = fixture.store.acceptMessageWithDisposition(input);
    expect(first.disposition).toBe("accepted");
    const event = fixture.store.getEvent(first.result.messageEventId);
    expect(event).toMatchObject({
      eventType: "operator.dispatch",
      actorId: "user:assistant"
    });
    expect(event && isRoomContextMessage(event)).toBe(true);
    expect((event?.body as { content?: string }).content).toBe("review the plan");
    expect(
      fixture.store.listEvents({ roomId: "room:main", limit: 100 }).events.filter(
        (item) => item.eventType === "message.created"
      )
    ).toHaveLength(0);
    expect(first.result.turns).toEqual([
      expect.objectContaining({ target: "agent:codex", status: "queued" })
    ]);

    reopen(fixture);
    const replay = fixture.store.acceptMessageWithDisposition(input);
    expect(replay).toEqual({ result: first.result, disposition: "replayed" });
    expect(fixture.store.getEvent(first.result.messageEventId)?.eventType).toBe("operator.dispatch");
  });

  it("lists the latest assistant conversation page and finds the next reply", () => {
    const fixture = createFixture();
    for (let index = 0; index < 120; index += 1) {
      fixture.store.appendAssistantMessage({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `side-${index}`,
        createdAt: new Date(Date.UTC(2026, 7, 11, 0, 0, 0, index)).toISOString(),
        ...(index % 2 === 0 ? { clientCommandId: `asst-cmd-${index}` } : {})
      });
    }
    const listed = fixture.store.listAssistantMessages(10);
    expect(listed).toHaveLength(10);
    expect(listed[0]?.content).toBe("side-110");
    expect(listed.at(-1)?.content).toBe("side-119");

    const user = fixture.store.getAssistantMessageByClientCommandId("asst-cmd-118");
    expect(user?.content).toBe("side-118");
    expect(fixture.store.getAssistantReplyAfter(user!.messageId)?.content).toBe("side-119");
  });

  it("enforces one in-process writer and fails closed after close", () => {
    const fixture = createFixture();
    expectGroupXCode(() => new SqliteGroupXStore(fixture.databasePath), "STORE_CONFLICT");
    fixture.store.close();
    expectGroupXCode(() => fixture.store.listActors(), "STORE_UNAVAILABLE");
  });
});
