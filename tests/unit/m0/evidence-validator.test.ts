import { describe, expect, it } from "vitest";

import { validateM0Capabilities } from "../../../src/m0/evidence-validator.js";

function matrix(): Record<string, unknown> {
  const caseIds = Array.from({ length: 15 }, (_, index) =>
    `M0-${String(index + 1).padStart(2, "0")}`
  );
  const agent = (transport: "direct" | "structured") => ({
    status: transport === "direct" ? "DEPRECATED" : "NOT_RUN",
    caseResults: Object.fromEntries(
      caseIds.map((id) => [
        id,
        {
          status:
            transport === "direct"
              ? id === "M0-07"
                ? "NOT_APPLICABLE"
                : "DEPRECATED"
              : "NOT_RUN",
          factLevel: null,
          evidenceRefs: []
        }
      ])
    )
  });
  return {
    schemaVersion: "groupx.m0-capabilities/2",
    contractRevision: "unrestricted-v0.1",
    contract: {
      transport: {
        publicRuntimeConfigAccepted: ["structured"],
        directRuntimeEntryEnabled: false
      }
    },
    nativeProfiles: { direct: { runtimeEntryEnabled: false } },
    m0Cases: caseIds.map((id) => ({ id, name: id })),
    baselines: {
      direct: {
        gateStatus: "DEPRECATED",
        agents: { codex: agent("direct"), grok: agent("direct"), kimi: agent("direct") }
      },
      structured: {
        gateStatus: "BLOCKED",
        agents: {
          codex: agent("structured"),
          grok: agent("structured"),
          kimi: agent("structured")
        }
      }
    },
    releaseGate: { status: "BLOCKED", passed: false },
    evidenceIndex: []
  };
}

describe("M0 evidence validator", () => {
  it("accepts an active Structured baseline with deprecated Direct compatibility", () => {
    expect(validateM0Capabilities(matrix())).toEqual([]);
  });

  it("rejects reactivating the deprecated Direct Gate", () => {
    const document = matrix();
    const baselines = document.baselines as Record<string, Record<string, unknown>>;
    baselines.direct!.gateStatus = "PASS";
    expect(validateM0Capabilities(document).map((issue) => issue.message)).toContain(
      "Direct Gate must remain DEPRECATED"
    );
  });

  it("rejects PASS without verified matching evidence", () => {
    const document = matrix();
    const structured = document.baselines as Record<string, Record<string, unknown>>;
    const agents = structured.structured!.agents as Record<string, Record<string, unknown>>;
    const cases = agents.kimi!.caseResults as Record<string, Record<string, unknown>>;
    cases["M0-01"] = { status: "PASS", factLevel: "probed", evidenceRefs: [] };
    expect(validateM0Capabilities(document).map((issue) => issue.message)).toEqual(
      expect.arrayContaining(["PASS requires verified evidence", "PASS requires evidence"])
    );
  });

  it("rejects cross-transport evidence and Direct MCP claims", () => {
    const document = matrix();
    document.evidenceIndex = [
      {
        id: "structured-kimi",
        evidenceClass: "native-live",
        agent: "kimi",
        transport: "structured",
        accessContract: "unrestricted-v0.1",
        canSatisfyCurrentGate: true,
        supportsCurrentCaseIds: ["M0-01", "M0-07"],
        exactArgvAndVersion: true,
        actualMcpToolCall: true,
        bindingProvenance: true
      }
    ];
    const direct = document.baselines as Record<string, Record<string, unknown>>;
    const agents = direct.direct!.agents as Record<string, Record<string, unknown>>;
    const cases = agents.kimi!.caseResults as Record<string, Record<string, unknown>>;
    cases["M0-01"] = {
      status: "PASS",
      factLevel: "verified",
      evidenceRefs: ["structured-kimi"]
    };
    cases["M0-07"] = {
      status: "PASS",
      factLevel: "verified",
      evidenceRefs: ["structured-kimi"]
    };
    const messages = validateM0Capabilities(document).map((issue) => issue.message);
    expect(messages).toContain("evidence structured-kimi does not match this PASS");
    expect(messages).toContain("Direct MCP must remain NOT_APPLICABLE");
  });

  it("rejects fixture evidence for a native-live case", () => {
    const document = matrix();
    document.evidenceIndex = [
      {
        id: "fixture-codex",
        evidenceClass: "fixture",
        agent: "codex",
        transport: "structured",
        accessContract: "unrestricted-v0.1",
        canSatisfyCurrentGate: true,
        supportsCurrentCaseIds: ["M0-01"],
        exactArgvAndVersion: true
      }
    ];
    const baselines = document.baselines as Record<string, Record<string, unknown>>;
    const agents = baselines.structured!.agents as Record<string, Record<string, unknown>>;
    const cases = agents.codex!.caseResults as Record<string, Record<string, unknown>>;
    cases["M0-01"] = {
      status: "PASS",
      factLevel: "verified",
      evidenceRefs: ["fixture-codex"]
    };
    expect(validateM0Capabilities(document).map((issue) => issue.message)).toContain(
      "M0-01 requires native-live evidence"
    );
  });

  it("requires both native and fixture claims for M0-12", () => {
    const document = matrix();
    document.evidenceIndex = [
      {
        id: "live-codex",
        evidenceClass: "native-live",
        agent: "codex",
        transport: "structured",
        accessContract: "unrestricted-v0.1",
        canSatisfyCurrentGate: true,
        supportsCurrentCaseIds: ["M0-12"],
        globalConfigInvariant: true
      },
      {
        id: "fixture-codex",
        evidenceClass: "fixture",
        agent: "codex",
        transport: "structured",
        accessContract: "unrestricted-v0.1",
        canSatisfyCurrentGate: true,
        supportsCurrentCaseIds: ["M0-12"],
        explicitPolicyClassification: true
      }
    ];
    const baselines = document.baselines as Record<string, Record<string, unknown>>;
    const agents = baselines.structured!.agents as Record<string, Record<string, unknown>>;
    const cases = agents.codex!.caseResults as Record<string, Record<string, unknown>>;
    cases["M0-12"] = {
      status: "PASS",
      factLevel: "verified",
      evidenceRefs: ["live-codex", "fixture-codex"]
    };
    expect(validateM0Capabilities(document)).toEqual([]);
  });
});
