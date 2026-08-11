# GroupX M0 能力矩阵

来源：[m0-capabilities.json](m0-capabilities.json)

schema：`groupx.m0-capabilities/2`

contract：`unrestricted-v0.1`

生成时间：`2026-08-11T13:37:46.633Z`

> 此文件由 `npm run m0:matrix` 确定性生成；不要直接编辑。

## 当前结论

| Baseline | Codex | Grok | Kimi | Gate |
| --- | --- | --- | --- | --- |
| Direct | `DEPRECATED` | `DEPRECATED` | `DEPRECATED` | `DEPRECATED` |
| Structured | `PASS` | `PASS` | `PASS` | `PASS` |

默认且唯一 active release transport：`structured`；Gate：`PASS`；passed=`true`。Direct 已 deprecated，仅保留兼容实现与历史 evidence，不维护独立 Gate，也不会自动 fallback。

## M0 case 结果

| ID | 用例 | Direct Codex | Direct Grok | Direct Kimi | Structured Codex | Structured Grok | Structured Kimi |
| --- | --- | --- | --- | --- | --- | --- | --- |
| M0-01 | executable version and exact unrestricted argv | `DEPRECATED` | `DEPRECATED` | `DEPRECATED` | `PASS` | `PASS` | `PASS` |
| M0-02 | process startup or structured handshake | `DEPRECATED` | `DEPRECATED` | `DEPRECATED` | `PASS` | `PASS` | `PASS` |
| M0-03 | prompt final and transport-specific continuity | `DEPRECATED` | `DEPRECATED` | `DEPRECATED` | `PASS` | `PASS` | `PASS` |
| M0-04 | stream capability and unique terminal | `DEPRECATED` | `DEPRECATED` | `DEPRECATED` | `PASS` | `PASS` | `PASS` |
| M0-05 | sender provenance within normal broker-created binding flow | `DEPRECATED` | `DEPRECATED` | `DEPRECATED` | `PASS` | `PASS` | `PASS` |
| M0-06 | cancel and subsequent availability | `DEPRECATED` | `DEPRECATED` | `DEPRECATED` | `PASS` | `PASS` | `PASS` |
| M0-07 | GroupX MCP actual tool call and binding provenance | `NOT_APPLICABLE` | `NOT_APPLICABLE` | `NOT_APPLICABLE` | `PASS` | `PASS` | `PASS` |
| M0-08 | native interaction fail-closed with no approval surface | `DEPRECATED` | `DEPRECATED` | `DEPRECATED` | `PASS` | `PASS` | `PASS` |
| M0-09 | native session resume or load | `DEPRECATED` | `DEPRECATED` | `DEPRECATED` | `PASS` | `PASS` | `PASS` |
| M0-10 | cross-adapter failure isolation | `DEPRECATED` | `DEPRECATED` | `DEPRECATED` | `PASS` | `PASS` | `PASS` |
| M0-11 | malformed timeout exit and stderr handling | `DEPRECATED` | `DEPRECATED` | `DEPRECATED` | `PASS` | `PASS` | `PASS` |
| M0-12 | global configuration non-write and native policy-block classification | `DEPRECATED` | `DEPRECATED` | `DEPRECATED` | `PASS` | `PASS` | `PASS` |
| M0-13 | bounded diagnostics | `DEPRECATED` | `DEPRECATED` | `DEPRECATED` | `PASS` | `PASS` | `PASS` |
| M0-14 | evidence and capability grading truthfulness | `DEPRECATED` | `DEPRECATED` | `DEPRECATED` | `PASS` | `PASS` | `PASS` |
| M0-15 | bounded shutdown and process cleanup | `DEPRECATED` | `DEPRECATED` | `DEPRECATED` | `PASS` | `PASS` | `PASS` |

## Release blockers

- 无。

## Evidence index

| ID | Agent | Transport | Contract | Current Gate | Path | SHA-256 |
| --- | --- | --- | --- | --- | --- | --- |
| `direct-release-native-codex-20260811T132505879Z` | codex | direct | `unrestricted-v0.1` | 不可用于当前 Gate | `.groupx/evidence/m0/direct-release/20260811T132505879Z/conformance.json` | `1ffa44d9…6378443` |
| `direct-release-fixture-codex-20260811T132257280Z` | codex | direct | `unrestricted-v0.1` | 不可用于当前 Gate | `.groupx/evidence/m0/direct-fixture/20260811T132257280Z/conformance.json` | `34ce1924…fbb5dc0` |
| `direct-release-native-grok-20260811T132505879Z` | grok | direct | `unrestricted-v0.1` | 不可用于当前 Gate | `.groupx/evidence/m0/direct-release/20260811T132505879Z/conformance.json` | `1ffa44d9…6378443` |
| `direct-release-fixture-grok-20260811T132257280Z` | grok | direct | `unrestricted-v0.1` | 不可用于当前 Gate | `.groupx/evidence/m0/direct-fixture/20260811T132257280Z/conformance.json` | `34ce1924…fbb5dc0` |
| `direct-release-native-kimi-20260811T132505879Z` | kimi | direct | `unrestricted-v0.1` | 不可用于当前 Gate | `.groupx/evidence/m0/direct-release/20260811T132505879Z/conformance.json` | `1ffa44d9…6378443` |
| `direct-release-fixture-kimi-20260811T132257280Z` | kimi | direct | `unrestricted-v0.1` | 不可用于当前 Gate | `.groupx/evidence/m0/direct-fixture/20260811T132257280Z/conformance.json` | `34ce1924…fbb5dc0` |
| `structured-release-native-codex-20260811T130102169Z` | codex | structured | `unrestricted-v0.1` | 可用于列出的 case | `.groupx/evidence/m0/structured-release/20260811T130102169Z/conformance.json` | `734d1c50…2ffa277` |
| `structured-release-fixture-codex-20260811T125831853Z` | codex | structured | `unrestricted-v0.1` | 可用于列出的 case | `.groupx/evidence/m0/release-fixture/20260811T125831853Z/conformance.json` | `a47f42aa…920a0a4` |
| `structured-release-native-grok-20260811T130102169Z` | grok | structured | `unrestricted-v0.1` | 可用于列出的 case | `.groupx/evidence/m0/structured-release/20260811T130102169Z/conformance.json` | `734d1c50…2ffa277` |
| `structured-release-fixture-grok-20260811T125831853Z` | grok | structured | `unrestricted-v0.1` | 可用于列出的 case | `.groupx/evidence/m0/release-fixture/20260811T125831853Z/conformance.json` | `a47f42aa…920a0a4` |
| `structured-release-native-kimi-20260811T130102169Z` | kimi | structured | `unrestricted-v0.1` | 可用于列出的 case | `.groupx/evidence/m0/structured-release/20260811T130102169Z/conformance.json` | `734d1c50…2ffa277` |
| `structured-release-fixture-kimi-20260811T125831853Z` | kimi | structured | `unrestricted-v0.1` | 可用于列出的 case | `.groupx/evidence/m0/release-fixture/20260811T125831853Z/conformance.json` | `a47f42aa…920a0a4` |
| `group-runtime-direct-codex-20260811` | codex | direct | `unrestricted-v0.1` | 不可用于当前 Gate | `.groupx/evidence/m0/group-runtime/20260811T204110299+0800-direct/conformance.json` | `ad8792b9…7398c2e` |
| `group-runtime-direct-grok-20260811` | grok | direct | `unrestricted-v0.1` | 不可用于当前 Gate | `.groupx/evidence/m0/group-runtime/20260811T204110299+0800-direct/conformance.json` | `ad8792b9…7398c2e` |
| `group-runtime-direct-kimi-20260811` | kimi | direct | `unrestricted-v0.1` | 不可用于当前 Gate | `.groupx/evidence/m0/group-runtime/20260811T204110299+0800-direct/conformance.json` | `ad8792b9…7398c2e` |
| `group-runtime-codex-20260811` | codex | structured | `unrestricted-v0.1` | 可用于列出的 case | `.groupx/evidence/m0/group-runtime/20260811T203536318+0800/conformance.json` | `adddd2db…70344f0` |
| `group-runtime-grok-20260811` | grok | structured | `unrestricted-v0.1` | 可用于列出的 case | `.groupx/evidence/m0/group-runtime/20260811T203536318+0800/conformance.json` | `adddd2db…70344f0` |
| `group-runtime-kimi-20260811` | kimi | structured | `unrestricted-v0.1` | 可用于列出的 case | `.groupx/evidence/m0/group-runtime/20260811T203536318+0800/conformance.json` | `adddd2db…70344f0` |
| `kimi-structured-yolo-mcp-20260811` | kimi | structured | `unrestricted-v0.1` | 可用于列出的 case | `.groupx/evidence/m0/kimi-agent/20260811T105613870Z-yolo-mcp/conformance.json` | `482744ae…70d63a1` |
| `legacy-codex-summary` | codex | structured | `legacy-native-config` | 不可用于当前 Gate | `.groupx/evidence/m0/codex-agent/SUMMARY.md` | `255dbfd4…738742f` |
| `legacy-codex-mcp-binding` | codex | structured | `legacy-native-config` | 不可用于当前 Gate | `.groupx/evidence/m0/codex-agent/run-20260811T090749Z-mcp-binding/RESULT.md` | `ac82b46f…18a00b5` |
| `legacy-grok-core` | grok | structured | `legacy-native-config` | 不可用于当前 Gate | `.groupx/evidence/m0/grok-agent/20260811T084326Z/report.redacted.json` | `a4db49c1…cbbe4cb` |
| `legacy-grok-mcp` | grok | structured | `legacy-native-config` | 不可用于当前 Gate | `.groupx/evidence/m0/grok-agent/20260811T084928Z-mcp-name/report.redacted.json` | `466d0519…c6623b8` |
| `legacy-kimi-core-permission` | kimi | structured | `legacy-native-config` | 不可用于当前 Gate | `.groupx/evidence/m0/kimi-agent/run-20260811T164518/report.json` | `af03a257…8d69082` |

## 机器校验规则

- PASS 必须引用同 Agent、同 transport、同 `unrestricted-v0.1` contract 且明确覆盖该 case 的 verified evidence。
- native startup/stream/MCP/cancel/resume/cleanup case 只接受 `native-live` evidence；interaction/fault/diagnostic/grading case 只接受 `fixture` evidence；M0-12 同时要求两类。
- Direct baseline、Agent 与适用 case 必须保持 `DEPRECATED`；`M0-07` 保持 `NOT_APPLICABLE`。Direct evidence 仅作历史事实，不能满足当前 Gate。
- legacy evidence 只保留历史 wire 事实，不能满足当前 Gate。
- `NATIVE_POLICY_BLOCKED` 声明必须引用独立、明确的外部策略 evidence，不能从 native interaction request/options 推断。
- `npm run m0:validate:evidence` 会额外检查本机 evidence 文件路径与 SHA-256；普通 `m0:validate` 不要求 Git 忽略的 raw evidence 存在。
