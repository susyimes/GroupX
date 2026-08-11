import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  M0_ACCESS_CONTRACT,
  M0_AGENTS,
  createM0RunId,
  sha256File,
  writeM0Report
} from "./probe-report.js";

const FIXTURE_FILES = [
  "tests/unit/adapters/codex/codex-app-server-adapter.test.ts",
  "tests/unit/adapters/acp/acp-v1-adapter.test.ts",
  "tests/unit/broker/broker.test.ts",
  "tests/integration/app-runtime.test.ts",
  "tests/unit/web/server/server.test.ts",
  "tests/unit/observability/diagnostics.test.ts",
  "tests/unit/m0/evidence-validator.test.ts"
] as const;

export interface FixtureProbeResult {
  reportPath: string;
  reportSha256: string;
  passed: boolean;
}

export async function runStructuredFixtureProbe(
  projectRoot = process.cwd()
): Promise<FixtureProbeResult> {
  const runId = createM0RunId();
  const startedAt = new Date();
  const noApprovalSurface = await auditNoApprovalSurface(projectRoot);
  const exitCode = await runVitest(projectRoot, FIXTURE_FILES);
  const testFiles = await Promise.all(
    FIXTURE_FILES.map(async (relativePath) => ({
      relativePath,
      sha256: await sha256File(path.resolve(projectRoot, relativePath))
    }))
  );
  const passed = exitCode === 0 && noApprovalSurface;
  const claims = {
    interactionFailClosed: passed,
    noApprovalSurface: passed,
    failureIsolation: passed,
    faultConvergence: passed,
    explicitPolicyClassification: passed,
    boundedDiagnostics: passed,
    truthfulGrading: passed
  };
  const report = {
    schema: "groupx.m0-fixture-conformance/1",
    evidenceClass: "fixture",
    runId,
    recordedAt: startedAt.toISOString(),
    transport: "structured",
    accessContract: M0_ACCESS_CONTRACT,
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
    suite: {
      command: "vitest run <allowlisted M0 fixture files>",
      exitCode,
      testFiles,
      passed: exitCode === 0
    },
    staticAudit: { noApprovalSurface },
    agentResults: M0_AGENTS.map((agent) => ({
      agent,
      status: passed ? "PASS" : "FAIL",
      verifiedCaseIds: passed ? ["M0-08", "M0-10", "M0-11", "M0-12", "M0-13", "M0-14"] : [],
      claims
    })),
    containsNativeSessionIds: false,
    containsConfigurationBody: false,
    containsCredentials: false,
    containsNativeInteractionPayload: false
  } as const;
  const output = await writeM0Report(
    projectRoot,
    `.groupx/evidence/m0/release-fixture/${runId}/conformance.json`,
    report
  );
  return { reportPath: output.relativePath, reportSha256: output.sha256, passed };
}

async function runVitest(projectRoot: string, files: readonly string[]): Promise<number> {
  const vitest = path.resolve(projectRoot, "node_modules/vitest/vitest.mjs");
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [vitest, "run", ...files], {
      cwd: projectRoot,
      shell: false,
      windowsHide: true,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

async function auditNoApprovalSurface(projectRoot: string): Promise<boolean> {
  const files = {
    envelope: await readFile(path.resolve(projectRoot, "src/core/envelope.ts"), "utf8"),
    rest: await readFile(path.resolve(projectRoot, "src/contracts/rest.ts"), "utf8"),
    server: await readFile(path.resolve(projectRoot, "src/web/server/server.ts"), "utf8"),
    schema: await readFile(path.resolve(projectRoot, "src/storage/schema.ts"), "utf8"),
    web: await readFile(path.resolve(projectRoot, "web/app.ts"), "utf8")
  };
  return (
    !/approval\.(?:requested|resolved)/u.test(files.envelope) &&
    !/(?:ResolveApproval|pendingApprovals|ApprovalService)/u.test(files.rest) &&
    !/\/api\/approvals?/u.test(files.server) &&
    !/CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+approval_requests/iu.test(files.schema) &&
    !/(?:pendingApprovals|resolveApproval|approval-button)/u.test(files.web)
  );
}
