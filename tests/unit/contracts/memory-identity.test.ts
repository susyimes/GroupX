import { describe, expect, it } from "vitest";

import {
  MAX_MESSAGE_CONTENT_LENGTH,
  ContractValidationError,
  parseMcpIdentityRememberInput,
  parseMcpIdentityRememberResult,
  parseMcpMemoryRememberInput,
  parseRememberIdentityRequest,
  parseRememberMemoryRequest
} from "../../../src/contracts/index.js";

function expectCode(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ContractValidationError);
    expect((error as ContractValidationError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}

const MEMORY_INPUT = {
  clientCommandId: "memory-command-1",
  scope: { type: "room", id: "room:main" },
  kind: "fact",
  content: "The room uses a transparent Broker."
} as const;

const IDENTITY_INPUT = {
  clientCommandId: "identity-command-1",
  subjectActorId: "agent:grok",
  kind: "note",
  content: "Focuses on protocol interoperability."
} as const;

describe("separate memory and identity write contracts", () => {
  it("keeps REST memory scope fields out of identity writes", () => {
    expect(parseRememberMemoryRequest(MEMORY_INPUT).scope.type).toBe("room");
    expectCode(
      () => parseRememberIdentityRequest({ ...IDENTITY_INPUT, scope: MEMORY_INPUT.scope }),
      "INVALID_ENVELOPE"
    );
  });

  it("keeps identity subject fields out of ordinary memory semantics unless explicit observation", () => {
    const observation = parseRememberMemoryRequest({
      ...MEMORY_INPUT,
      kind: "note",
      subjectActorId: "agent:grok"
    });
    expect(observation.subjectActorId).toBe("agent:grok");

    expectCode(
      () => parseRememberMemoryRequest({ ...MEMORY_INPUT, identityId: "identity:spoof" }),
      "INVALID_ENVELOPE"
    );
  });

  it("P-008 rejects unknown actors used as memory subjects or agent scopes", () => {
    expectCode(
      () =>
        parseRememberMemoryRequest({
          ...MEMORY_INPUT,
          subjectActorId: "agent:not-registered"
        }),
      "UNKNOWN_TARGET"
    );
    expectCode(
      () =>
        parseRememberMemoryRequest({
          ...MEMORY_INPUT,
          scope: { type: "agent", id: "agent:not-registered" }
        }),
      "UNKNOWN_TARGET"
    );
  });

  it("fixes MCP identity.remember subject to the bound caller by omitting subject from input", () => {
    const ownIdentity = parseMcpIdentityRememberInput({
      clientCommandId: "mcp-identity-1",
      kind: "preference",
      content: "Prefer concise reviews."
    });
    expect(ownIdentity).not.toHaveProperty("subjectActorId");

    expectCode(
      () =>
        parseMcpIdentityRememberInput({
          ...ownIdentity,
          subjectActorId: "agent:kimi"
        }),
      "INVALID_ENVELOPE"
    );
  });

  it("never accepts caller assigned author or provenance on memory/identity writes", () => {
    expectCode(
      () => parseMcpMemoryRememberInput({ ...MEMORY_INPUT, actor: "agent:grok" }),
      "SENDER_FIELD_FORBIDDEN"
    );
    expectCode(
      () => parseRememberIdentityRequest({ ...IDENTITY_INPUT, provenance: { source: "self" } }),
      "SENDER_FIELD_FORBIDDEN"
    );
    expectCode(
      () => parseRememberMemoryRequest({ ...MEMORY_INPUT, authorActorId: "agent:grok" }),
      "INVALID_ENVELOPE"
    );
  });

  it("uses the same content ceiling for memory and identity writes", () => {
    expect(
      parseRememberMemoryRequest({
        ...MEMORY_INPUT,
        content: "x".repeat(MAX_MESSAGE_CONTENT_LENGTH)
      }).content
    ).toHaveLength(MAX_MESSAGE_CONTENT_LENGTH);

    expectCode(
      () =>
        parseRememberIdentityRequest({
          ...IDENTITY_INPUT,
          content: "x".repeat(MAX_MESSAGE_CONTENT_LENGTH + 1)
        }),
      "MESSAGE_TOO_LARGE"
    );
  });

  it("does not allow callers to label their own write as a generated summary", () => {
    expectCode(
      () => parseRememberMemoryRequest({ ...MEMORY_INPUT, kind: "summary" }),
      "INVALID_ENVELOPE"
    );
  });

  it("validates MCP identity outputs while allowing future optional fields", () => {
    const parsed = parseMcpIdentityRememberResult({
      identity: {
        identityId: "identity_1",
        subjectActorId: "agent:grok",
        authorActorId: "agent:grok",
        kind: "preference",
        content: "Prefer protocol evidence.",
        sourceKind: "mcp",
        status: "active",
        createdAt: "2026-08-11T12:00:00.000Z",
        futureRecordField: true
      },
      futureResultField: true
    });

    expect(parsed.identity.futureRecordField).toBe(true);
    expect(parsed.futureResultField).toBe(true);
  });
});
