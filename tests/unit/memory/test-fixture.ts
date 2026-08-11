import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteGroupXStore } from "../../../src/storage/sqlite-store.js";
import type { StoredEventRecord } from "../../../src/storage/types.js";

export interface MemoryTestFixture {
  directory: string;
  store: SqliteGroupXStore;
}

const fixtures = new Set<MemoryTestFixture>();

export function createMemoryTestFixture(): MemoryTestFixture {
  const directory = mkdtempSync(join(tmpdir(), "groupx-memory-"));
  const fixture = {
    directory,
    store: new SqliteGroupXStore(join(directory, "groupx.db"))
  };
  fixtures.add(fixture);
  return fixture;
}

export function cleanupMemoryTestFixtures(): void {
  for (const fixture of fixtures) {
    fixture.store.close();
    rmSync(fixture.directory, { recursive: true, force: true });
  }
  fixtures.clear();
}

export function appendMessage(
  fixture: MemoryTestFixture,
  input: {
    eventId: string;
    actorId: string;
    content: string;
    targets?: readonly string[];
    replyToEventId?: string;
    occurredAt?: string;
  }
): StoredEventRecord {
  return fixture.store.appendDurableEvent({
    eventId: input.eventId,
    roomId: "room:main",
    eventType: "message.created",
    actorId: input.actorId,
    targets: input.targets ?? [],
    ...(input.replyToEventId === undefined
      ? {}
      : { replyToEventId: input.replyToEventId }),
    correlationId: "corr_memory_tests",
    occurredAt: input.occurredAt ?? "2026-08-11T00:00:00.000Z",
    body: { content: input.content }
  });
}
