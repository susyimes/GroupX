import { afterEach, describe, expect, it } from "vitest";

import { SUPERVISION_WATCH_KIND, SUPERVISION_WATCH_PROTOCOL_NOTE } from "../../../src/core/supervision.js";
import { isRoomContextMessage } from "../../../src/memory/context-messages.js";
import { ContextPacketBuilder, renderContextPacket } from "../../../src/memory/context-packet.js";
import {
  appendMessage,
  cleanupMemoryTestFixtures,
  createMemoryTestFixture
} from "./test-fixture.js";

afterEach(() => {
  cleanupMemoryTestFixtures();
});

describe("supervision observation isolation", () => {
  it("keeps watch briefs and supervision events out of room context messages", () => {
    const fixture = createMemoryTestFixture();
    const ordinary = appendMessage(fixture, {
      eventId: "evt_ordinary",
      actorId: "user:web",
      content: "ordinary task"
    });
    const watch = fixture.store.appendDurableEvent({
      eventId: "evt_watch",
      roomId: "room:main",
      eventType: "message.created",
      actorId: "system:groupx",
      targets: ["agent:grok"],
      correlationId: "corr_memory_tests",
      occurredAt: "2026-08-11T00:00:01.000Z",
      body: { kind: SUPERVISION_WATCH_KIND, content: "observer brief" }
    });
    const observed = fixture.store.appendDurableEvent({
      eventId: "evt_observed",
      roomId: "room:main",
      eventType: "supervision.observed",
      actorId: "agent:grok",
      correlationId: "corr_memory_tests",
      occurredAt: "2026-08-11T00:00:02.000Z",
      body: { snapshot: { status: "running" } }
    });

    expect(isRoomContextMessage(ordinary)).toBe(true);
    expect(isRoomContextMessage(watch)).toBe(false);
    expect(isRoomContextMessage(observed)).toBe(false);
  });

  it("does not inject watch briefs into unread transcript or compaction-facing room history", () => {
    const fixture = createMemoryTestFixture();
    const publicReply = appendMessage(fixture, {
      eventId: "evt_public",
      actorId: "agent:kimi",
      content: "public sibling note",
      occurredAt: "2026-08-11T00:00:00.500Z"
    });
    fixture.store.appendDurableEvent({
      eventId: "evt_watch_brief",
      roomId: "room:main",
      eventType: "message.created",
      actorId: "system:groupx",
      targets: ["agent:grok"],
      correlationId: "corr_memory_tests",
      occurredAt: "2026-08-11T00:00:01.000Z",
      body: { kind: SUPERVISION_WATCH_KIND, content: "You are a live GroupX observer" }
    });
    const current = appendMessage(fixture, {
      eventId: "evt_current",
      actorId: "user:web",
      content: "implement the feature",
      targets: ["agent:codex"],
      occurredAt: "2026-08-11T00:00:02.000Z"
    });

    const packet = new ContextPacketBuilder(fixture.store).buildContextPacket({
      roomId: "room:main",
      targetActorId: "agent:codex",
      throughSeq: current.seq,
      maxChars: 8_000,
      currentEvent: current
    });

    expect(packet.text).toContain("implement the feature");
    expect(packet.text).toContain("public sibling note");
    expect(packet.text).not.toContain("You are a live GroupX observer");
    expect(packet.sections.unreadTranscript.map((entry) => entry.id)).toContain(publicReply.eventId);
    expect(packet.sections.unreadTranscript.map((entry) => entry.id)).not.toContain("evt_watch_brief");
  });

  it("builds an observer packet from a watch brief current event", () => {
    const fixture = createMemoryTestFixture();
    const watch = fixture.store.appendDurableEvent({
      eventId: "evt_watch_current",
      roomId: "room:main",
      eventType: "message.created",
      actorId: "system:groupx",
      targets: ["agent:grok"],
      correlationId: "corr_memory_tests",
      occurredAt: "2026-08-11T00:00:01.000Z",
      body: { kind: SUPERVISION_WATCH_KIND, content: "observer brief for live steer" },
      provenance: { sourceKind: "supervision", labels: ["supervision.watch"] }
    });

    const packet = new ContextPacketBuilder(fixture.store).buildContextPacket({
      roomId: "room:main",
      targetActorId: "agent:grok",
      throughSeq: watch.seq,
      maxChars: 8_000,
      currentEvent: watch,
      packetKind: "supervision_watch"
    });

    expect(packet.text).toContain("observer brief for live steer");
    expect(packet.text).toContain(SUPERVISION_WATCH_PROTOCOL_NOTE);
    expect(packet.sections.currentMessage.content).toBe("observer brief for live steer");
  });

  it("renders a distinct watch packet note without changing unrestricted language into approval language", () => {
    const text = renderContextPacket({
      roomId: "room:main",
      targetActorId: "agent:grok",
      afterSeq: 0,
      throughSeq: 1,
      packetKind: "supervision_watch",
      sections: {
        configuredIdentity: [],
        selfIdentity: [],
        userAuthoredIdentity: [],
        observedIdentity: [],
        agentCoreMemory: [],
        agentDatedMemory: [],
        publicMemory: [],
        generatedSummary: [],
        unreadTranscript: [],
        replyChain: [],
        currentMessage: {
          entryType: "message",
          id: "watch-brief",
          authorActorId: "system:groupx",
          subject: "agent:grok",
          source: { kind: "supervision" },
          content: "observer brief"
        }
      }
    });

    expect(text).toContain(SUPERVISION_WATCH_PROTOCOL_NOTE);
    expect(text).toContain("[supervision_watch]");
    expect(text).toContain("Do not execute the user task");
    expect(text).toContain("cannot approve or deny a single native tool");
  });
});
