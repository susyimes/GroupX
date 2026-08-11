import { describe, expect, it } from "vitest";

import {
  BUILTIN_ACTORS,
  GROUPX_SCHEMA,
  type GroupXEnvelope
} from "../../../../src/core/envelope.js";
import {
  encodeSseEnvelope,
  SSE_HEARTBEAT_FRAME,
  sseFrameBytes
} from "../../../../src/web/sse/index.js";

function envelope(seq: number | null): GroupXEnvelope<{ text: string; turnId: string }> {
  return {
    schema: GROUPX_SCHEMA,
    eventId: seq === null ? "evt_transient" : `evt_${seq}`,
    seq,
    roomId: "room:main",
    type: seq === null ? "turn.content.delta" : "message.created",
    actor: BUILTIN_ACTORS.codex,
    to: ["agent:grok"],
    correlationId: "corr_codec",
    rootCorrelationId: "corr_codec",
    occurredAt: "2026-08-11T00:00:00.000Z",
    durability: seq === null ? "transient" : "durable",
    body: { text: "line 1\nline 2\r🙂", turnId: "turn_codec" }
  };
}

function dataFrom(frame: string): unknown {
  const line = frame.split("\n").find((candidate) => candidate.startsWith("data: "));
  if (!line) {
    throw new Error("missing SSE data line");
  }
  return JSON.parse(line.slice("data: ".length)) as unknown;
}

describe("encodeSseEnvelope", () => {
  it("uses durable seq as id and serializes the complete envelope", () => {
    const input = envelope(42);
    const frame = encodeSseEnvelope(input);

    expect(frame).toContain("id: 42\n");
    expect(frame).not.toContain("event:");
    expect(dataFrom(frame)).toEqual(input);
    expect(frame.split("\n").filter((line) => line.startsWith("data: "))).toHaveLength(1);
  });

  it("omits id for transient events but still sends the complete envelope", () => {
    const input = envelope(null);
    const frame = encodeSseEnvelope(input);

    expect(frame).not.toContain("id:");
    expect(frame).not.toContain("event:");
    expect(dataFrom(frame)).toEqual(input);
  });

  it("keeps future envelope types on the default message event", () => {
    const input = {
      ...envelope(43),
      type: "adapter.future-observation"
    } as unknown as GroupXEnvelope;
    const frame = encodeSseEnvelope(input);

    expect(frame).not.toContain("event:");
    expect(dataFrom(frame)).toMatchObject({
      eventId: "evt_43",
      type: "adapter.future-observation"
    });
  });

  it("counts UTF-8 bytes and encodes heartbeat as an SSE comment", () => {
    const frame = encodeSseEnvelope(envelope(null));

    expect(sseFrameBytes(frame)).toBe(Buffer.byteLength(frame, "utf8"));
    expect(sseFrameBytes(frame)).toBeGreaterThan(frame.length);
    expect(SSE_HEARTBEAT_FRAME).toBe(": heartbeat\n\n");
  });

  it("rejects durability and seq mismatches", () => {
    const invalidDurable = { ...envelope(1), seq: null };
    const invalidTransient = { ...envelope(null), seq: 1 };

    expect(() => encodeSseEnvelope(invalidDurable)).toThrow(/durable.*seq/iu);
    expect(() => encodeSseEnvelope(invalidTransient)).toThrow(/transient.*seq/iu);
  });
});
