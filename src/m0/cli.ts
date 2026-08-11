import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { readAndValidateM0Capabilities } from "./evidence-validator.js";
import { renderM0CapabilityMatrix } from "./matrix-renderer.js";

const DEFAULT_JSON = resolve("docs/generated/m0-capabilities.json");
const DEFAULT_MARKDOWN = resolve("docs/generated/M0_CAPABILITY_MATRIX.md");

function usage(): string {
  return [
    "Usage:",
    "  npm run m0:validate",
    "  npm run m0:validate:evidence",
    "  npm run m0:matrix",
    "",
    "These commands only read/validate evidence metadata; they never start a CLI probe."
  ].join("\n");
}

function validate(jsonPath: string, markdownPath: string, verifyEvidenceFiles: boolean): void {
  const projectRoot = resolve(dirname(jsonPath), "../..");
  const { document, issues } = readAndValidateM0Capabilities(jsonPath, {
    projectRoot,
    verifyEvidenceFiles
  });
  const expectedMarkdown = renderM0CapabilityMatrix(document);
  const actualMarkdown = readFileSync(markdownPath, "utf8").replaceAll("\r\n", "\n");
  if (actualMarkdown !== expectedMarkdown) {
    issues.push({
      path: markdownPath,
      message: "generated Markdown is stale; run npm run m0:matrix"
    });
  }
  if (issues.length > 0) {
    for (const issue of issues) process.stderr.write(`${issue.path}: ${issue.message}\n`);
    throw new Error(`M0 validation failed with ${issues.length} issue(s)`);
  }
  process.stdout.write(
    `M0 matrix valid (${verifyEvidenceFiles ? "metadata + evidence hashes" : "metadata"})\n`
  );
}

export function main(argv: readonly string[] = process.argv.slice(2)): void {
  const [command, ...flags] = argv;
  const jsonPath = resolve(flags.find((flag) => !flag.startsWith("--")) ?? DEFAULT_JSON);
  const markdownPath = DEFAULT_MARKDOWN;
  if (command === "render") {
    const { document, issues } = readAndValidateM0Capabilities(jsonPath, {
      projectRoot: resolve(dirname(jsonPath), "../..")
    });
    if (issues.length > 0) {
      for (const issue of issues) process.stderr.write(`${issue.path}: ${issue.message}\n`);
      throw new Error("Refusing to render an invalid M0 matrix");
    }
    writeFileSync(markdownPath, renderM0CapabilityMatrix(document), "utf8");
    process.stdout.write(`Rendered ${markdownPath}\n`);
    return;
  }
  if (command === "validate") {
    validate(jsonPath, markdownPath, flags.includes("--verify-evidence-files"));
    return;
  }
  process.stdout.write(`${usage()}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
