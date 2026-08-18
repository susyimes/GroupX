import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GroupXAssistantHost, type OperatorBrain } from "../../../src/app/operator-runtime.js";
import type { AssistantStatus } from "../../../src/contracts/assistant.js";
import type { GroupXConfig } from "../../../src/config.js";
import { GroupXError } from "../../../src/core/errors.js";
import { SqliteGroupXStore } from "../../../src/storage/sqlite-store.js";

class Deferred<T> {
  readonly promise: Promise<T>;
  resolve!: (value: T) => void;

  constructor() {
    this.promise = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
}

class FakeBrain implements OperatorBrain {
  readonly prompts: string[] = [];
  next?: Deferred<string>;
  #status: AssistantStatus = "ready";

  setStatus(status: AssistantStatus): void {
    this.#status = status;
  }

  status(): AssistantStatus {
    return this.#status;
  }
  detail(): string | undefined {
    return undefined;
  }
  async start(): Promise<void> {}
  async prompt(text: string, signal: AbortSignal): Promise<string> {
    this.prompts.push(text);
    if (signal.aborted) throw signal.reason ?? new Error("aborted");
    if (this.next) return await this.next.promise;
    return "assistant reply";
  }
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}
}

const fixtures = new Set<{ directory: string; store: SqliteGroupXStore }>();

afterEach(() => {
  for (const fixture of fixtures) {
    fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
  fixtures.clear();
});

function createHost(brain: FakeBrain): GroupXAssistantHost {
  const directory = mkdtempSync(join(tmpdir(), "groupx-assistant-"));
  const store = new SqliteGroupXStore(join(directory, "groupx.db"));
  fixtures.add({ directory, store });
  return new GroupXAssistantHost({
    config: {
      assistant: {
        enabled: true,
        name: "房间助理",
        brain: {
          driver: "claude",
          command: { executable: "claude", prefixArgs: [] },
          cwd: "."
        }
      }
    } as unknown as GroupXConfig,
    store,
    brain
  });
}

describe("GroupXAssistantHost", () => {
  it("joins in-flight retries and replays a completed assistant reply", async () => {
    const brain = new FakeBrain();
    brain.next = new Deferred<string>();
    const host = createHost(brain);
    const signal = new AbortController().signal;
    const request = { clientCommandId: "asst-cmd-1", content: "hi" };

    const first = host.postMessage(request, signal);
    const concurrent = host.postMessage(request, signal);
    brain.next.resolve("done");
    const [firstResult, concurrentResult] = await Promise.all([first, concurrent]);

    expect(brain.prompts).toHaveLength(1);
    expect(firstResult.assistantMessage?.content).toBe("done");
    expect(concurrentResult.assistantMessage?.messageId).toBe(firstResult.assistantMessage?.messageId);

    const replayed = await host.postMessage(request, signal);
    expect(brain.prompts).toHaveLength(1);
    expect(replayed.assistantMessage?.messageId).toBe(firstResult.assistantMessage?.messageId);
  });

  it("reprompts after a user row exists without a reply", async () => {
    const brain = new FakeBrain();
    const host = createHost(brain);
    const store = [...fixtures][0]!.store;
    store.appendAssistantMessage({
      role: "user",
      content: "orphaned",
      clientCommandId: "asst-cmd-orphan"
    });

    const accepted = await host.postMessage(
      { clientCommandId: "asst-cmd-orphan", content: "orphaned" },
      new AbortController().signal
    );
    expect(brain.prompts).toHaveLength(1);
    expect(accepted.assistantMessage?.content).toBe("assistant reply");
    expect(
      store.listAssistantMessages().filter((message) => message.role === "user")
    ).toHaveLength(1);
  });

  it("maps a protocol line overflow to a bounded assistant reply", async () => {
    const brain = new FakeBrain();
    brain.prompt = async () => {
      throw new GroupXError("PROTOCOL_INVALID_MESSAGE", "Protocol stdout line exceeded 1048576 bytes");
    };
    const host = createHost(brain);
    const accepted = await host.postMessage(
      { clientCommandId: "asst-cmd-overflow", content: "look at the room" },
      new AbortController().signal
    );
    expect(accepted.assistantMessage?.content).toContain("房间记录太大");
    expect(accepted.assistantMessage?.content).not.toContain("1048576");
  });

  it("still posts when the brain snapshot is failed", async () => {
    const brain = new FakeBrain();
    brain.setStatus("failed");
    const host = createHost(brain);
    const accepted = await host.postMessage(
      { clientCommandId: "asst-cmd-retry", content: "try again" },
      new AbortController().signal
    );
    expect(brain.prompts).toHaveLength(1);
    expect(accepted.assistantMessage?.content).toBe("assistant reply");
  });
});
