import { describe, expect, it } from "vitest";

import {
  parseSetupSaveRequest,
  parseSetupSaveResponse,
  parseSetupSnapshot
} from "../../../src/contracts/index.js";

function agent(id = "codex") {
  return {
    id,
    driver: "codex" as const,
    name: "",
    identity: "",
    command: { executable: "codex", prefixArgs: [] },
    cwd: ".",
    enabled: true
  };
}

describe("setup contracts", () => {
  it("accepts a multi-instance roster without exposing transport or access", () => {
    const request = parseSetupSaveRequest({
      config: {
        serverPort: 4_310,
        storagePath: ".groupx/groupx.db",
        agents: [agent(), { ...agent("reviewer"), name: "Reviewer", identity: "Review the room" }]
      }
    });

    expect(request.config.agents.map(({ id }) => id)).toEqual(["codex", "reviewer"]);
    expect(request.config.agents[1]?.identity).toBe("Review the room");
    expect(JSON.stringify(request)).not.toContain("access");
    expect(JSON.stringify(request)).not.toContain("transport");
  });

  it("rejects duplicate ids, no enabled Agent, and policy-shaped fields", () => {
    expect(() => parseSetupSaveRequest({
      config: {
        serverPort: 4_310,
        storagePath: ".groupx/groupx.db",
        agents: [agent(), agent()]
      }
    })).toThrowError(expect.objectContaining({ code: "INVALID_ENVELOPE" }));
    expect(() => parseSetupSaveRequest({
      config: {
        serverPort: 4_310,
        storagePath: ".groupx/groupx.db",
        agents: [{ ...agent(), enabled: false }]
      }
    })).toThrowError(expect.objectContaining({ code: "INVALID_ENVELOPE" }));
    expect(() => parseSetupSaveRequest({
      config: {
        serverPort: 4_310,
        storagePath: ".groupx/groupx.db",
        agents: [{ ...agent(), approval: "never" }]
      }
    })).toThrowError(expect.objectContaining({ code: "INVALID_ENVELOPE" }));
  });

  it("validates snapshots and save responses as strict outputs", () => {
    expect(parseSetupSnapshot({
      configPath: "D:\\GroupX\\groupx.json",
      existing: false,
      runtimeActive: false,
      drivers: [
        { driver: "codex", found: true },
        { driver: "grok", found: false },
        { driver: "kimi", found: true },
        { driver: "hermes", found: true },
        { driver: "claude", found: true }
      ],
      config: {
        serverPort: 4_310,
        storagePath: ".groupx/groupx.db",
        agents: [agent()]
      }
    }).drivers).toHaveLength(5);
    expect(parseSetupSaveResponse({
      saved: true,
      configPath: "D:\\GroupX\\groupx.json",
      agentCount: 2,
      enabledAgentCount: 2,
      restartRequired: true
    })).toMatchObject({ saved: true, restartRequired: true });

    expect(() => parseSetupSnapshot({
      configPath: "D:\\GroupX\\groupx.json",
      existing: false,
      runtimeActive: false,
      drivers: [
        { driver: "codex", found: true },
        { driver: "codex", found: false },
        { driver: "kimi", found: true },
        { driver: "hermes", found: true },
        { driver: "claude", found: true }
      ],
      config: {
        serverPort: 4_310,
        storagePath: ".groupx/groupx.db",
        agents: [agent()]
      }
    })).toThrowError(expect.objectContaining({ code: "INVALID_ENVELOPE" }));

    expect(() => parseSetupSaveResponse({
      saved: true,
      configPath: "D:\\GroupX\\groupx.json",
      agentCount: 1,
      enabledAgentCount: 2,
      restartRequired: false
    })).toThrowError(expect.objectContaining({ code: "INVALID_ENVELOPE" }));
  });
});
