import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { renderM0CapabilityMatrix } from "./matrix-renderer.js";
import { M0_ACCESS_CONTRACT, M0_AGENTS, type M0AgentId, sha256File } from "./probe-report.js";

type JsonRecord = Record<string, unknown>;

const NATIVE_CASES = ["M0-01", "M0-04", "M0-05", "M0-06", "M0-07", "M0-12", "M0-15"];
const FIXTURE_CASES = ["M0-08", "M0-10", "M0-11", "M0-12", "M0-13", "M0-14"];

export interface ApplyStructuredGateInput {
  projectRoot: string;
  matrixPath: string;
  markdownPath: string;
  nativeEvidencePath: string;
  fixtureEvidencePath: string;
}

export async function applyStructuredGateEvidence(input: ApplyStructuredGateInput): Promise<void> {
  const matrix = record(JSON.parse(await readFile(input.matrixPath, "utf8")), "matrix");
  const native = record(JSON.parse(await readFile(input.nativeEvidencePath, "utf8")), "native report");
  const fixture = record(JSON.parse(await readFile(input.fixtureEvidencePath, "utf8")), "fixture report");
  assertNativeReport(native);
  assertFixtureReport(fixture);

  const baselines = record(matrix.baselines, "baselines");
  const structured = record(baselines.structured, "structured baseline");
  const agents = record(structured.agents, "structured agents");
  const evidence = arrayOfRecords(matrix.evidenceIndex, "evidenceIndex");
  await normalizeExistingEvidence(input.projectRoot, evidence);

  const nativeHash = await sha256File(input.nativeEvidencePath);
  const fixtureHash = await sha256File(input.fixtureEvidencePath);
  const nativeRelative = relativeEvidencePath(input.projectRoot, input.nativeEvidencePath);
  const fixtureRelative = relativeEvidencePath(input.projectRoot, input.fixtureEvidencePath);
  const nativeRunId = stringField(native, "runId");
  const fixtureRunId = stringField(fixture, "runId");
  const recordedAt = stringField(native, "recordedAt");
  const fixtureRecordedAt = stringField(fixture, "recordedAt");
  const newEntries: JsonRecord[] = [];

  for (const agent of M0_AGENTS) {
    const nativeId = `structured-release-native-${agent}-${nativeRunId}`;
    const fixtureId = `structured-release-fixture-${agent}-${fixtureRunId}`;
    const nativeResult = agentResult(native, agent);
    const fixtureResult = agentResult(fixture, agent);
    const expectedVersion = stringField(record(agents[agent], `${agent} baseline`), "installedVersion");
    if (nativeResult.installedVersion !== expectedVersion) {
      throw new Error(`${agent} installed version does not match the tracked baseline`);
    }
    newEntries.push(
      {
        id: nativeId,
        evidenceClass: "native-live",
        sourceKind: "current-live-conformance",
        agent,
        transport: "structured",
        accessContract: M0_ACCESS_CONTRACT,
        conformance: "matching-pass",
        runId: nativeRunId,
        recordedAt,
        relativePath: nativeRelative,
        sha256: nativeHash,
        supportsCurrentCaseIds: NATIVE_CASES,
        exactArgvAndVersion: true,
        streamObserved: true,
        uniqueTerminal: true,
        bindingProvenance: true,
        nativeCancellation: true,
        subsequentTurnAvailable: true,
        actualMcpToolCall: true,
        globalConfigInvariant: true,
        cleanShutdownAndNoResidual: true,
        canSatisfyCurrentGate: true,
        canSatisfyEntireAgentBaseline: false
      },
      {
        id: fixtureId,
        evidenceClass: "fixture",
        sourceKind: "current-fixture-conformance",
        agent,
        transport: "structured",
        accessContract: M0_ACCESS_CONTRACT,
        conformance: "matching-pass",
        runId: fixtureRunId,
        recordedAt: fixtureRecordedAt,
        relativePath: fixtureRelative,
        sha256: fixtureHash,
        supportsCurrentCaseIds: FIXTURE_CASES,
        interactionFailClosed: true,
        noApprovalSurface: true,
        failureIsolation: true,
        faultConvergence: true,
        explicitPolicyClassification: true,
        explicitPolicyEvidence: true,
        boundedDiagnostics: true,
        truthfulGrading: true,
        canSatisfyCurrentGate: true,
        canSatisfyEntireAgentBaseline: false
      }
    );

    const tracked = record(agents[agent], `${agent} baseline`);
    const cases = record(tracked.caseResults, `${agent} caseResults`);
    const existing = (caseId: string): string[] =>
      stringArray(record(cases[caseId], `${agent} ${caseId}`).evidenceRefs);
    const refs: Record<string, string[]> = {
      "M0-01": [nativeId],
      "M0-02": existing("M0-02"),
      "M0-03": existing("M0-03"),
      "M0-04": [nativeId],
      "M0-05": [nativeId],
      "M0-06": [nativeId],
      "M0-07": [nativeId],
      "M0-08": [fixtureId],
      "M0-09": existing("M0-09"),
      "M0-10": [fixtureId],
      "M0-11": [fixtureId],
      "M0-12": [nativeId, fixtureId],
      "M0-13": [fixtureId],
      "M0-14": [fixtureId],
      "M0-15": [nativeId]
    };
    for (const [caseId, evidenceRefs] of Object.entries(refs)) {
      if (evidenceRefs.length === 0) throw new Error(`${agent} ${caseId} has no evidence`);
      cases[caseId] = { status: "PASS", factLevel: "verified", evidenceRefs };
    }
    tracked.status = "PASS";
    tracked.evidenceRefs = [...new Set(Object.values(refs).flat())];
    delete tracked.blockingReason;
  }

  const newIds = new Set(newEntries.map((entry) => String(entry.id)));
  matrix.evidenceIndex = [
    ...newEntries,
    ...evidence.filter((entry) => !newIds.has(String(entry.id)))
  ];
  structured.gateStatus = "PASS";
  const releaseGate = record(matrix.releaseGate, "releaseGate");
  releaseGate.status = "PASS";
  releaseGate.passed = true;
  releaseGate.blockingReasons = [];
  matrix.generatedAt = new Date(
    Math.max(Date.parse(recordedAt), Date.parse(fixtureRecordedAt))
  ).toISOString();

  await writeFile(input.matrixPath, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");
  await writeFile(input.markdownPath, renderM0CapabilityMatrix(matrix), "utf8");
}

async function normalizeExistingEvidence(projectRoot: string, evidence: JsonRecord[]): Promise<void> {
  for (const entry of evidence) {
    const sourceKind = String(entry.sourceKind);
    entry.evidenceClass = sourceKind.startsWith("legacy-")
      ? "legacy"
      : sourceKind.includes("fixture") || entry.evidenceClass === "fixture"
        ? "fixture"
        : "native-live";
    if (!String(entry.id).startsWith("group-runtime-direct-")) continue;
    const relativePath = stringField(entry, "relativePath");
    const report = record(
      JSON.parse(await readFile(path.resolve(projectRoot, relativePath), "utf8")),
      String(entry.id)
    );
    if (report.runtimeClosedCleanly !== true || report.matchingResidualDirectChildren !== 0) {
      throw new Error(`${entry.id} cannot support Direct M0-15 cleanup`);
    }
    entry.cleanShutdownAndNoResidual = true;
  }
}

function assertNativeReport(report: JsonRecord): void {
  if (
    report.schema !== "groupx.m0-structured-native-conformance/1" ||
    report.evidenceClass !== "native-live" ||
    report.transport !== "structured" ||
    report.accessContract !== M0_ACCESS_CONTRACT ||
    report.status !== "PASS" ||
    report.runtimeClosedCleanly !== true ||
    report.matchingResidualChildCount !== 0
  ) {
    throw new Error("Native report does not satisfy the Structured release contract");
  }
  for (const agent of M0_AGENTS) {
    const result = agentResult(report, agent);
    for (const claim of [
      "exactArgvAndVersion",
      "streamObserved",
      "uniqueTerminal",
      "bindingProvenance",
      "actualMcpToolCall",
      "nativeCancellation",
      "subsequentTurnAvailable",
      "globalConfigInvariant",
      "cleanShutdownAndNoResidual"
    ]) {
      if (result[claim] !== true) throw new Error(`${agent} native report is missing ${claim}`);
    }
  }
}

function assertFixtureReport(report: JsonRecord): void {
  if (
    report.schema !== "groupx.m0-fixture-conformance/1" ||
    report.evidenceClass !== "fixture" ||
    report.transport !== "structured" ||
    report.accessContract !== M0_ACCESS_CONTRACT ||
    record(report.suite, "fixture suite").passed !== true ||
    record(report.staticAudit, "fixture static audit").noApprovalSurface !== true
  ) {
    throw new Error("Fixture report does not satisfy the Structured Gate contract");
  }
  for (const agent of M0_AGENTS) {
    const claims = record(agentResult(report, agent).claims, `${agent} fixture claims`);
    for (const claim of [
      "interactionFailClosed",
      "noApprovalSurface",
      "failureIsolation",
      "faultConvergence",
      "explicitPolicyClassification",
      "boundedDiagnostics",
      "truthfulGrading"
    ]) {
      if (claims[claim] !== true) throw new Error(`${agent} fixture report is missing ${claim}`);
    }
  }
}

function agentResult(report: JsonRecord, agent: M0AgentId): JsonRecord {
  const results = arrayOfRecords(report.agentResults, "agentResults");
  const result = results.find((candidate) => candidate.agent === agent);
  if (!result) throw new Error(`Evidence report is missing ${agent}`);
  return result;
}

function relativeEvidencePath(projectRoot: string, evidencePath: string): string {
  const relative = path.relative(projectRoot, path.resolve(evidencePath));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Evidence path must remain inside the project root");
  }
  return relative.replaceAll("\\", "/");
}

function record(value: unknown, label: string): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function arrayOfRecords(value: unknown, label: string): JsonRecord[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => record(item, `${label}[${index}]`));
}

function stringField(value: JsonRecord, field: string): string {
  if (typeof value[field] !== "string" || value[field].length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value[field];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error("Expected a string array");
  }
  return value;
}
