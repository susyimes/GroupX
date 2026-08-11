type JsonRecord = Record<string, unknown>;

const AGENTS = ["codex", "grok", "kimi"] as const;
const TRANSPORTS = ["direct", "structured"] as const;

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function cell(value: unknown): string {
  const rendered =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : "";
  return rendered.replaceAll("|", "\\|").replaceAll("\r", " ").replaceAll("\n", " ");
}

function code(value: unknown): string {
  return `\`${cell(value)}\``;
}

function shortHash(value: unknown): string {
  const hash = text(value);
  return hash.length === 64 ? `${hash.slice(0, 8)}…${hash.slice(-7)}` : hash;
}

export function renderM0CapabilityMatrix(document: JsonRecord): string {
  const baselines = record(document.baselines);
  const cases = Array.isArray(document.m0Cases) ? document.m0Cases.map(record) : [];
  const release = record(document.releaseGate);
  const evidence = Array.isArray(document.evidenceIndex) ? document.evidenceIndex.map(record) : [];
  const lines: string[] = [
    "# GroupX M0 能力矩阵",
    "",
    "来源：[m0-capabilities.json](m0-capabilities.json)",
    "",
    `schema：${code(document.schemaVersion)}`,
    "",
    `contract：${code(document.contractRevision)}`,
    "",
    `生成时间：${code(document.generatedAt)}`,
    "",
    "> 此文件由 `npm run m0:matrix` 确定性生成；不要直接编辑。",
    "",
    "## 当前结论",
    "",
    "| Baseline | Codex | Grok | Kimi | Gate |",
    "| --- | --- | --- | --- | --- |"
  ];
  for (const transport of TRANSPORTS) {
    const baseline = record(baselines[transport]);
    const agents = record(baseline.agents);
    lines.push(
      `| ${transport === "structured" ? "Structured" : "Direct"} | ${code(record(agents.codex).status)} | ${code(record(agents.grok).status)} | ${code(record(agents.kimi).status)} | ${code(baseline.gateStatus)} |`
    );
  }
  lines.push(
    "",
    `默认且唯一 active release transport：${code(release.requiredTransport)}；Gate：${code(release.status)}；passed=${code(release.passed)}。Direct 已 deprecated，仅保留兼容实现与历史 evidence，不维护独立 Gate，也不会自动 fallback。`,
    "",
    "## M0 case 结果",
    "",
    "| ID | 用例 | Direct Codex | Direct Grok | Direct Kimi | Structured Codex | Structured Grok | Structured Kimi |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |"
  );
  for (const item of cases) {
    const id = text(item.id);
    const statuses = TRANSPORTS.flatMap((transport) => {
      const agents = record(record(baselines[transport]).agents);
      return AGENTS.map((agent) => code(record(record(agents[agent]).caseResults)[id] && record(record(record(agents[agent]).caseResults)[id]).status));
    });
    lines.push(`| ${cell(id)} | ${cell(item.name)} | ${statuses.join(" | ")} |`);
  }
  const blockers = Array.isArray(release.blockingReasons)
    ? release.blockingReasons.filter((item): item is string => typeof item === "string")
    : [];
  lines.push("", "## Release blockers", "");
  if (blockers.length === 0) lines.push("- 无。", "");
  else lines.push(...blockers.map((blocker) => `- ${cell(blocker)}`), "");

  lines.push(
    "## Evidence index",
    "",
    "| ID | Agent | Transport | Contract | Current Gate | Path | SHA-256 |",
    "| --- | --- | --- | --- | --- | --- | --- |"
  );
  for (const entry of evidence) {
    lines.push(
      `| ${code(entry.id)} | ${cell(entry.agent)} | ${cell(entry.transport)} | ${code(entry.accessContract)} | ${entry.canSatisfyCurrentGate === true ? "可用于列出的 case" : "不可用于当前 Gate"} | ${code(entry.relativePath)} | ${code(shortHash(entry.sha256))} |`
    );
  }
  lines.push(
    "",
    "## 机器校验规则",
    "",
    "- PASS 必须引用同 Agent、同 transport、同 `unrestricted-v0.1` contract 且明确覆盖该 case 的 verified evidence。",
    "- native startup/stream/MCP/cancel/resume/cleanup case 只接受 `native-live` evidence；interaction/fault/diagnostic/grading case 只接受 `fixture` evidence；M0-12 同时要求两类。",
    "- Direct baseline、Agent 与适用 case 必须保持 `DEPRECATED`；`M0-07` 保持 `NOT_APPLICABLE`。Direct evidence 仅作历史事实，不能满足当前 Gate。",
    "- legacy evidence 只保留历史 wire 事实，不能满足当前 Gate。",
    "- `NATIVE_POLICY_BLOCKED` 声明必须引用独立、明确的外部策略 evidence，不能从 native interaction request/options 推断。",
    "- `npm run m0:validate:evidence` 会额外检查本机 evidence 文件路径与 SHA-256；普通 `m0:validate` 不要求 Git 忽略的 raw evidence 存在。",
    ""
  );
  return lines.join("\n");
}
