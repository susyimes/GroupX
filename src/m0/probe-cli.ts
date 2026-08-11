import path from "node:path";

import { runStructuredFixtureProbe } from "./fixture-probe.js";
import { applyStructuredGateEvidence } from "./gate-updater.js";
import { runStructuredNativeProbe } from "./structured-native-probe.js";

function usage(): string {
  return [
    "Usage:",
    "  npm run m0:probe:fixtures",
    "  npm run m0:probe:structured -- --config .\\groupx.json",
    "  npm run m0:apply:structured-gate -- --native <conformance.json> --fixture <conformance.json>",
    "",
    "The fixture command starts only local Vitest fixtures.",
    "The structured command starts all three configured native CLIs and performs real model turns, MCP calls, cancellation and cleanup probes.",
    "Direct is deprecated and has no active M0 probe or Gate command."
  ].join("\n");
}

function valueFlag(argv: readonly string[], name: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === name) return argv[index + 1];
    if (value?.startsWith(`${name}=`)) return value.slice(name.length + 1);
  }
  return undefined;
}

function configFlag(argv: readonly string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--config") return argv[index + 1];
    if (value?.startsWith("--config=")) return value.slice("--config=".length);
  }
  return undefined;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const [command] = argv;
  const projectRoot = process.cwd();
  if (command === "fixtures") {
    const result = await runStructuredFixtureProbe(projectRoot);
    process.stdout.write(
      `${result.passed ? "PASS" : "FAIL"} fixture evidence ${result.reportPath} sha256=${result.reportSha256}\n`
    );
    if (!result.passed) process.exitCode = 1;
    return;
  }
  if (command === "structured") {
    const config = configFlag(argv);
    if (!config) throw new Error("Structured native probe requires --config <path>");
    const result = await runStructuredNativeProbe(path.resolve(projectRoot, config), projectRoot);
    process.stdout.write(
      `${result.passed ? "PASS" : "FAIL"} structured native evidence ${result.reportPath} sha256=${result.reportSha256}\n`
    );
    if (!result.passed) process.exitCode = 1;
    return;
  }
  if (command === "apply-structured-gate") {
    const native = valueFlag(argv, "--native");
    const fixture = valueFlag(argv, "--fixture");
    if (!native || !fixture) throw new Error("Gate apply requires --native and --fixture evidence paths");
    await applyStructuredGateEvidence({
      projectRoot,
      matrixPath: path.resolve(projectRoot, "docs/generated/m0-capabilities.json"),
      markdownPath: path.resolve(projectRoot, "docs/generated/M0_CAPABILITY_MATRIX.md"),
      nativeEvidencePath: path.resolve(projectRoot, native),
      fixtureEvidencePath: path.resolve(projectRoot, fixture)
    });
    process.stdout.write("Applied verified Structured release evidence to the M0 matrix.\n");
    return;
  }
  process.stdout.write(`${usage()}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
