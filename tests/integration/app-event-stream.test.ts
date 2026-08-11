import { describe, expect, it } from "vitest";

import { SequencedEventPublisher, SqliteSseEventReader } from "../../src/app/event-stream.js";
import { toDurableEnvelope } from "../../src/app/record-mappers.js";
import {
  asTransientEnvelope,
  BUILTIN_ACTORS,
  DEFAULT_ROOM_ID,
  type GroupXEnvelope
} from "../../src/core/envelope.js";
import { SqliteGroupXStore } from "../../src/storage/sqlite-store.js";

function append(
  store: SqliteGroupXStore,
  input: { roomId?: string; correlationId: string; content: string }
) {
  return store.appendDurableEvent({
    roomId: input.roomId ?? DEFAULT_ROOM_ID,
    eventType: "message.created",
    actorId: BUILTIN_ACTORS.web.actorId,
    targets: [BUILTIN_ACTORS.codex.actorId],
    correlationId: input.correlationId,
    body: { content: input.content },
    provenance: { sourceKind: "web", authorActorId: BUILTIN_ACTORS.web.actorId }
  });
}

describe("SQLite event replay and live sequencing", () => {
  it("maps committed sender provenance without consulting message content", () => {
    const store = new SqliteGroupXStore(":memory:");
    try {
      const stored = append(store, {
        correlationId: "corr_mapper",
        content: "I claim to be Grok"
      });
      const envelope = toDurableEnvelope(stored);
      expect(envelope).toMatchObject({
        eventId: stored.eventId,
        seq: stored.seq,
        roomId: DEFAULT_ROOM_ID,
        actor: BUILTIN_ACTORS.web,
        to: [BUILTIN_ACTORS.codex.actorId],
        correlationId: "corr_mapper",
        rootCorrelationId: "corr_mapper",
        durability: "durable",
        provenance: {
          sourceKind: "web",
          authorActorId: BUILTIN_ACTORS.web.actorId
        }
      });
      expect(envelope.actor.actorId).not.toBe(BUILTIN_ACTORS.grok.actorId);
    } finally {
      store.close();
    }
  });

  it("reads a fixed snapshot in order across storage pages and room gaps", () => {
    const store = new SqliteGroupXStore(":memory:");
    try {
      for (let index = 0; index < 503; index += 1) {
        append(store, { correlationId: `corr_${index}`, content: String(index) });
        if (index === 250) {
          append(store, {
            roomId: "room:other",
            correlationId: "corr_other",
            content: "other"
          });
        }
      }
      const reader = new SqliteSseEventReader(store, { pageSize: 37 });
      const controller = new AbortController();
      const throughSeq = reader.captureHighWaterSeq(DEFAULT_ROOM_ID, controller.signal);
      const events = [...reader.readDurableRange({
        roomId: DEFAULT_ROOM_ID,
        afterSeq: 0,
        throughSeq,
        signal: controller.signal
      })];

      expect(events).toHaveLength(503);
      expect(events.map((event) => event.seq)).toEqual(
        [...events].map((event) => event.seq).sort((left, right) => left - right)
      );
      expect(events.every((event) => event.roomId === DEFAULT_ROOM_ID)).toBe(true);
      expect(events.at(-1)?.seq).toBe(throughSeq);
    } finally {
      store.close();
    }
  });

  it("honors an aborted replay signal", () => {
    const store = new SqliteGroupXStore(":memory:");
    try {
      append(store, { correlationId: "corr_abort", content: "abort" });
      const reader = new SqliteSseEventReader(store);
      const controller = new AbortController();
      const reason = new Error("stop replay");
      controller.abort(reason);
      expect(() => [
        ...reader.readDurableRange({
          roomId: DEFAULT_ROOM_ID,
          afterSeq: 0,
          throughSeq: 1,
          signal: controller.signal
        })
      ]).toThrow(reason);
    } finally {
      store.close();
    }
  });

  it("drains committed durable rows by sequence before transient delivery", async () => {
    const store = new SqliteGroupXStore(":memory:");
    const delivered: GroupXEnvelope[] = [];
    const publisher = new SequencedEventPublisher(store, {
      publish(envelope) {
        delivered.push(envelope);
      }
    });
    try {
      const historical = append(store, {
        correlationId: "corr_historical",
        content: "historical"
      });
      publisher.initialize([DEFAULT_ROOM_ID]);
      const first = append(store, { correlationId: "corr_first", content: "first" });
      const second = append(store, { correlationId: "corr_second", content: "second" });

      // A later notification can arrive first; SQLite commit order remains the source of truth.
      await publisher.publish(toDurableEnvelope(second));
      await publisher.publish(toDurableEnvelope(first));
      await publisher.publish(toDurableEnvelope(second));
      await publisher.publish(
        asTransientEnvelope({
          eventId: "evt_transient",
          roomId: DEFAULT_ROOM_ID,
          type: "turn.content.delta",
          actor: BUILTIN_ACTORS.codex,
          to: [],
          correlationId: "corr_second",
          rootCorrelationId: "corr_second",
          body: { text: "delta" }
        })
      );

      expect(delivered.map((event) => event.eventId)).toEqual([
        first.eventId,
        second.eventId,
        "evt_transient"
      ]);
      expect(delivered.some((event) => event.eventId === historical.eventId)).toBe(false);
    } finally {
      await publisher.close();
      store.close();
    }
  });
});
