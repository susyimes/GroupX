import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const AGENTS = ["codex", "grok", "kimi"] as const;
const TRANSPORTS = ["direct", "structured"] as const;
const CASE_IDS = Array.from({ length: 15 }, (_, index) =>
  `M0-${String(index + 1).padStart(2, "0")}`
);
const CASE_STATUSES = new Set([
  "PASS",
  "FAIL",
  "PARTIAL",
  "NOT_RUN",
  "NOT_APPLICABLE",
  "UNSUPPORTED",
  "DEPRECATED"
]);
const BASELINE_STATUSES = new Set(["PASS", "BLOCKED", "DEPRECATED"]);
const AGENT_STATUSES = new Set(["PASS", "FAIL", "PARTIAL", "NOT_RUN", "NOT_APPLICABLE", "DEPRECATED"]);

const NATIVE_LIVE_CASES = new Set([
  "M0-01",
  "M0-02",
  "M0-03",
  "M0-04",
  "M0-05",
  "M0-06",
  "M0-07",
  "M0-09",
  "M0-15"
]);
const FIXTURE_CASES = new Set(["M0-08", "M0-10", "M0-11", "M0-13", "M0-14"]);
const EVIDENCE_CLASSES = new Set(["native-live", "fixture", "legacy"]);

type JsonRecord = Record<string, unknown>;

export interface M0ValidationIssue {
  path: string;
  message: string;
}

export interface ValidateM0Options {
  projectRoot?: string;
  verifyEvidenceFiles?: boolean;
}

function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : undefined;
}

function add(issues: M0ValidationIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function isWithin(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === "" || (!isAbsolute(child) && child !== ".." && !child.startsWith(`..${sep}`));
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function validateM0Capabilities(
  value: unknown,
  options: ValidateM0Options = {}
): M0ValidationIssue[] {
  const issues: M0ValidationIssue[] = [];
  const document = record(value);
  if (!document) return [{ path: "$", message: "matrix must be a JSON object" }];

  if (document.schemaVersion !== "groupx.m0-capabilities/2") {
    add(issues, "$.schemaVersion", "unsupported schemaVersion");
  }
  if (document.contractRevision !== "unrestricted-v0.1") {
    add(issues, "$.contractRevision", "current matrix must use unrestricted-v0.1");
  }

  const contract = record(document.contract);
  const transportContract = record(contract?.transport);
  if (!contract || !transportContract) {
    add(issues, "$.contract.transport", "transport contract is required");
  } else {
    const publicValues = stringArray(transportContract.publicRuntimeConfigAccepted);
    if (
      transportContract.directRuntimeEntryEnabled !== false ||
      publicValues?.length !== 1 ||
      publicValues[0] !== "structured"
    ) {
      add(issues, "$.contract.transport", "Direct runtime entry must remain disabled and Structured-only");
    }
  }
  const nativeProfiles = record(document.nativeProfiles);
  if (record(nativeProfiles?.direct)?.runtimeEntryEnabled !== false) {
    add(issues, "$.nativeProfiles.direct.runtimeEntryEnabled", "Direct native profile must not expose a runtime entry");
  }

  const cases = Array.isArray(document.m0Cases) ? document.m0Cases : [];
  const caseIds = cases.map((item) => record(item)?.id).filter((id): id is string => typeof id === "string");
  if (caseIds.length !== CASE_IDS.length || CASE_IDS.some((id, index) => caseIds[index] !== id)) {
    add(issues, "$.m0Cases", "matrix must define M0-01 through M0-15 exactly once in order");
  }

  const evidenceEntries = Array.isArray(document.evidenceIndex) ? document.evidenceIndex : [];
  const evidence = new Map<string, JsonRecord>();
  for (const [index, raw] of evidenceEntries.entries()) {
    const entry = record(raw);
    const path = `$.evidenceIndex[${index}]`;
    if (!entry) {
      add(issues, path, "evidence entry must be an object");
      continue;
    }
    const id = entry.id;
    if (typeof id !== "string" || id.length === 0) {
      add(issues, `${path}.id`, "evidence id is required");
      continue;
    }
    if (evidence.has(id)) add(issues, `${path}.id`, "evidence id must be unique");
    evidence.set(id, entry);
    if (!EVIDENCE_CLASSES.has(String(entry.evidenceClass))) {
      add(issues, `${path}.evidenceClass`, "evidenceClass must be native-live, fixture, or legacy");
    }
    if (entry.canSatisfyCurrentGate === true) {
      if (entry.accessContract !== "unrestricted-v0.1") {
        add(issues, `${path}.accessContract`, "current Gate evidence must match unrestricted-v0.1");
      }
      if (!stringArray(entry.supportsCurrentCaseIds)?.length) {
        add(issues, `${path}.supportsCurrentCaseIds`, "current Gate evidence must name supported cases");
      }
    }
    if (entry.transport === "direct" && entry.canSatisfyCurrentGate === true) {
      add(issues, `${path}.canSatisfyCurrentGate`, "deprecated Direct evidence cannot satisfy a current Gate");
    }
    if (options.verifyEvidenceFiles === true) {
      const relativePath = entry.relativePath;
      const expectedHash = entry.sha256;
      if (typeof relativePath !== "string" || typeof expectedHash !== "string") {
        add(issues, path, "evidence file path and sha256 are required");
        continue;
      }
      const projectRoot = resolve(options.projectRoot ?? process.cwd());
      const absolutePath = resolve(projectRoot, relativePath);
      if (!isWithin(projectRoot, absolutePath)) {
        add(issues, `${path}.relativePath`, "evidence path must stay within the project root");
      } else if (!existsSync(absolutePath)) {
        add(issues, `${path}.relativePath`, "evidence file is missing");
      } else if (sha256(absolutePath) !== expectedHash.toLowerCase()) {
        add(issues, `${path}.sha256`, "evidence file hash does not match the index");
      }
    }
  }

  const baselines = record(document.baselines);
  if (!baselines) {
    add(issues, "$.baselines", "baselines object is required");
    return issues;
  }
  for (const transport of TRANSPORTS) {
    const baseline = record(baselines[transport]);
    if (!baseline) {
      add(issues, `$.baselines.${transport}`, "baseline is required");
      continue;
    }
    const agents = record(baseline.agents);
    if (typeof baseline.gateStatus !== "string" || !BASELINE_STATUSES.has(baseline.gateStatus)) {
      add(issues, `$.baselines.${transport}.gateStatus`, "unknown baseline Gate status");
    }
    if (transport === "direct" && baseline.gateStatus !== "DEPRECATED") {
      add(issues, `$.baselines.${transport}.gateStatus`, "Direct Gate must remain DEPRECATED");
    }
    if (transport === "structured" && baseline.gateStatus === "DEPRECATED") {
      add(issues, `$.baselines.${transport}.gateStatus`, "Structured is the active release transport");
    }
    if (!agents) {
      add(issues, `$.baselines.${transport}.agents`, "agents object is required");
      continue;
    }
    for (const agent of AGENTS) {
      const agentResult = record(agents[agent]);
      const agentPath = `$.baselines.${transport}.agents.${agent}`;
      if (!agentResult) {
        add(issues, agentPath, "agent result is required");
        continue;
      }
      if (typeof agentResult.status !== "string" || !AGENT_STATUSES.has(agentResult.status)) {
        add(issues, `${agentPath}.status`, "unknown agent status");
      }
      if (transport === "direct" && agentResult.status !== "DEPRECATED") {
        add(issues, `${agentPath}.status`, "Direct agent status must remain DEPRECATED");
      }
      const caseResults = record(agentResult.caseResults);
      if (!caseResults) {
        add(issues, `${agentPath}.caseResults`, "caseResults object is required");
        continue;
      }
      for (const caseId of CASE_IDS) {
        const result = record(caseResults[caseId]);
        const resultPath = `${agentPath}.caseResults.${caseId}`;
        if (!result) {
          add(issues, resultPath, "case result is required");
          continue;
        }
        if (typeof result.status !== "string" || !CASE_STATUSES.has(result.status)) {
          add(issues, `${resultPath}.status`, "unknown case status");
          continue;
        }
        if (transport === "direct" && caseId === "M0-07" && result.status !== "NOT_APPLICABLE") {
          add(issues, `${resultPath}.status`, "Direct MCP must remain NOT_APPLICABLE");
        }
        if (transport === "direct" && caseId !== "M0-07" && result.status !== "DEPRECATED") {
          add(issues, `${resultPath}.status`, "Direct cases are historical only and must remain DEPRECATED");
        }
        const refs = stringArray(result.evidenceRefs) ?? [];
        if (result.status === "PASS") {
          if (result.factLevel !== "verified") {
            add(issues, `${resultPath}.factLevel`, "PASS requires verified evidence");
          }
          if (refs.length === 0) add(issues, `${resultPath}.evidenceRefs`, "PASS requires evidence");
        }
        for (const ref of refs) {
          const entry = evidence.get(ref);
          if (!entry) {
            add(issues, `${resultPath}.evidenceRefs`, `unknown evidence reference ${ref}`);
            continue;
          }
          if (result.status === "PASS") {
            const supported = stringArray(entry.supportsCurrentCaseIds) ?? [];
            if (
              entry.agent !== agent ||
              entry.transport !== transport ||
              entry.accessContract !== "unrestricted-v0.1" ||
              entry.canSatisfyCurrentGate !== true ||
              !supported.includes(caseId)
            ) {
              add(issues, `${resultPath}.evidenceRefs`, `evidence ${ref} does not match this PASS`);
            }
            if (NATIVE_LIVE_CASES.has(caseId) && entry.evidenceClass !== "native-live") {
              add(issues, `${resultPath}.evidenceRefs`, `${caseId} requires native-live evidence`);
            }
            if (FIXTURE_CASES.has(caseId) && entry.evidenceClass !== "fixture") {
              add(issues, `${resultPath}.evidenceRefs`, `${caseId} requires fixture evidence`);
            }
            if (result.claimsNativePolicyBlocked === true && entry.explicitPolicyEvidence !== true) {
              add(issues, `${resultPath}.evidenceRefs`, "native_policy_blocked requires explicit policy evidence");
            }
          }
        }
        if (result.status === "PASS") {
          const matchingEntries = refs
            .map((ref) => evidence.get(ref))
            .filter((entry): entry is JsonRecord => entry !== undefined);
          requireCaseClaim(issues, resultPath, caseId, matchingEntries);
        }
      }
      if (agentResult.status === "PASS") {
        const incomplete = CASE_IDS.some((caseId) => {
          const status = record(caseResults[caseId])?.status;
          return status !== "PASS" && status !== "NOT_APPLICABLE";
        });
        if (incomplete) add(issues, `${agentPath}.status`, "agent PASS requires every applicable case PASS");
      }
    }
  }

  const releaseGate = record(document.releaseGate);
  if (!releaseGate) {
    add(issues, "$.releaseGate", "releaseGate is required");
  } else {
    if ((releaseGate.status === "PASS") !== (releaseGate.passed === true)) {
      add(issues, "$.releaseGate", "status PASS and passed=true must agree");
    }
    if (releaseGate.passed === true) {
      const structured = record(baselines.structured);
      const agents = record(structured?.agents);
      if (structured?.gateStatus !== "PASS") {
        add(issues, "$.baselines.structured.gateStatus", "release PASS requires Structured Gate PASS");
      }
      for (const agent of AGENTS) {
        if (record(agents?.[agent])?.status !== "PASS") {
          add(issues, `$.baselines.structured.agents.${agent}.status`, "release PASS requires agent PASS");
        }
      }
    }
  }
  const directReadiness = record(document.directReadiness);
  if (
    directReadiness !== undefined &&
    (directReadiness.status !== "DEPRECATED" || directReadiness.releaseBlocking !== false)
  ) {
    add(issues, "$.directReadiness", "Direct readiness must be DEPRECATED and non-release-blocking");
  }
  return issues;
}

function requireCaseClaim(
  issues: M0ValidationIssue[],
  resultPath: string,
  caseId: string,
  entries: readonly JsonRecord[]
): void {
  const has = (claim: string, evidenceClass?: string): boolean =>
    entries.some(
      (entry) =>
        entry[claim] === true &&
        (evidenceClass === undefined || entry.evidenceClass === evidenceClass)
    );
  const require = (claim: string, message: string, evidenceClass?: string): void => {
    if (!has(claim, evidenceClass)) add(issues, `${resultPath}.evidenceRefs`, message);
  };

  switch (caseId) {
    case "M0-01":
      require("exactArgvAndVersion", "M0-01 requires exact argv and version observation", "native-live");
      return;
    case "M0-04":
      require("streamObserved", "M0-04 requires a native stream observation", "native-live");
      require("uniqueTerminal", "M0-04 requires unique terminal evidence", "native-live");
      return;
    case "M0-05":
      require("bindingProvenance", "M0-05 requires binding-derived sender provenance", "native-live");
      return;
    case "M0-06":
      require("nativeCancellation", "M0-06 requires native cancellation evidence", "native-live");
      require(
        "subsequentTurnAvailable",
        "M0-06 requires a successful subsequent Turn",
        "native-live"
      );
      return;
    case "M0-07":
      require("actualMcpToolCall", "M0-07 requires an actual native MCP tools/call", "native-live");
      require("bindingProvenance", "M0-07 requires binding attribution", "native-live");
      return;
    case "M0-08":
      require("interactionFailClosed", "M0-08 requires fail-closed native interaction fixtures", "fixture");
      require("noApprovalSurface", "M0-08 requires a no-approval-surface audit", "fixture");
      return;
    case "M0-10":
      require("failureIsolation", "M0-10 requires cross-adapter failure isolation", "fixture");
      return;
    case "M0-11":
      require("faultConvergence", "M0-11 requires malformed timeout exit and stderr fixtures", "fixture");
      return;
    case "M0-12":
      require("globalConfigInvariant", "M0-12 requires native global-config invariance", "native-live");
      require(
        "explicitPolicyClassification",
        "M0-12 requires explicit policy classification fixtures",
        "fixture"
      );
      return;
    case "M0-13":
      require("boundedDiagnostics", "M0-13 requires bounded diagnostic fixtures", "fixture");
      return;
    case "M0-14":
      require("truthfulGrading", "M0-14 requires evidence grading validation", "fixture");
      return;
    case "M0-15":
      require(
        "cleanShutdownAndNoResidual",
        "M0-15 requires bounded clean shutdown and residual-process audit",
        "native-live"
      );
      return;
    default:
      return;
  }
}

export function readAndValidateM0Capabilities(
  matrixPath: string,
  options: ValidateM0Options = {}
): { document: JsonRecord; issues: M0ValidationIssue[] } {
  const parsed = JSON.parse(readFileSync(matrixPath, "utf8")) as unknown;
  const document = record(parsed);
  if (!document) throw new Error("M0 matrix root must be an object");
  return { document, issues: validateM0Capabilities(document, options) };
}
