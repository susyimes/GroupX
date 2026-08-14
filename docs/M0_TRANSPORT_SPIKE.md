# M0 Structured 传输验证合同（Direct deprecated）

状态：v0.1 Structured active；Direct deprecated compatibility
执行状态：Structured release Gate 已完成 matching unrestricted evidence，三 Agent 状态均为 `PASS`；Direct 无 active Gate
日期：2026-08-11

## 1. 产品合同与 Gate

GroupX v0.1 的历史类型保留两个值：

```yaml
transport: direct | structured
```

- 公开运行入口只接受 `structured`，同一次 Broker 运行对全部已配置 Agent 使用同一值；
- `direct` 仅为旧记录和已有 one-shot 源码保留，状态固定 `DEPRECATED`；配置解析、factory 与 runtime 均拒绝启动；
- `structured` 使用 Codex App Server 与 ACP driver 长驻 session；当前 driver 为 Grok、Kimi、Hermes；
- message/Turn API 不接受 transport 覆盖；
- Structured 失败时绝不自动 fallback 到 Direct；
- `access` 不进入配置，v0.1 恒为 `unrestricted`。

M0 只有一个 active Structured release baseline。Direct baseline 仍保留在机器可读矩阵中以说明历史兼容面，但 baseline、Agent 和适用 case 均固定为 `DEPRECATED`，已有 evidence 的 `canSatisfyCurrentGate=false`。GroupX MCP 当前回合主动互调只属于 Structured Gate。

## 2. 事实、测试与运行结果

事实等级：

```text
documented   官方协议或 CLI 文档明确说明
advertised   本机 help 或 capability response 声明
probed       在安装版本上完成解析器或最小协议探测
verified     完成端到端用例并保存同 Agent/transport/access 合同的有界证据
unsupported  当前实现明确不支持
```

测试结果：

```text
PASS
FAIL
PARTIAL
NOT_RUN
NOT_APPLICABLE
UNSUPPORTED
DEPRECATED
```

运行时结果另行记录，例如 `turn.failed + UNEXPECTED_NATIVE_INTERACTION`。一个 fail-closed fixture 可以测试 `PASS`，即使它预期观察到的 Turn 结果是 failed。帮助文本、旧 transport、旧 access 合同、MCP descriptor 或 `tools/list` 不能替代当前 Gate 的 live `verified`。

## 3. 固定 unrestricted 启动合同

| Agent | Direct（deprecated reference，不可启动） | Structured |
| --- | --- | --- |
| Codex | 新会话：`codex --yolo --dangerously-bypass-hook-trust exec --json -`；续会话：`codex --yolo --dangerously-bypass-hook-trust exec resume --json <sessionId> -` | `codex --dangerously-bypass-hook-trust app-server --listen stdio://`；`thread/start`/`thread/resume` 固定 `approvalPolicy="never"`、`sandbox="danger-full-access"` |
| Grok | `grok --no-auto-update --permission-mode bypassPermissions --sandbox off --no-plan [--resume <sessionId>] --output-format streaming-json --single <prompt>`；`-p` 是 `--single` 短别名 | `grok --no-auto-update --permission-mode bypassPermissions --sandbox off --no-plan agent stdio` |
| Kimi | deprecated Direct 参考实现保留只读配置 preflight 后使用 `kimi [--session <id>] --prompt <prompt> --output-format stream-json` | 直接启动 `kimi acp`；不以全局默认 permission/plan 为门禁。每次 `session/new` 或 `session/load`（含 Adapter resume）后、首个 prompt 前发送 `session/set_mode {sessionId, modeId:"auto"}` |
| Hermes | `NOT_APPLICABLE` | `hermes --yolo acp`；每次 `session/new` 或 `session/load` 后、首个 prompt 前发送 `session/set_mode {sessionId, modeId:"dont_ask"}` |

Codex 0.147 的 thread-level `sandbox` 是 kebab-case 字符串 `danger-full-access`；camel-case `dangerFullAccess` 是 `turn/start.sandboxPolicy.type` 的另一种 wire shape，不能混用。Codex child 使用 Agent 配置的 OS cwd，thread params 省略 cwd。Structured 启动前发送 `configRequirements/read {}`：requirements 为 null/缺失表示无约束；显式 allowlist 不含 `never` 或 `danger-full-access` 时以 `NATIVE_POLICY_BLOCKED` 失败。证据只保存有界结论。

Grok 的全局 flags 必须位于 `agent stdio` 或 `--single` 之前。企业策略可禁用 bypass permissions；旧 session 的 sandbox profile 与当前 `off` 不一致时应失败，不得 fallback。

Kimi Direct 已 deprecated；其历史 one-shot 代码仍因 `--prompt` 与权限 flags 的互斥关系保留只读配置 preflight。Active Structured 不使用这条 preflight：官方 ACP 提供 `session/set_mode`，所以默认 global `manual` 允许启动，GroupX 在每次 `session/new` 或 `session/load`（含 Adapter resume）后设置当前 session 为 auto。mode 不持久化，必须逐 session 重设；auto 仍受 static deny。

固定 argv/mode 只作用于 GroupX 启动的 process/thread/session。GroupX 不写任何受支持 CLI 的全局配置，也不允许通用 `extraArgs` 改写这些常量。Structured Kimi 不读取全局配置来决定是否启动；Hermes 不追加会持久化 hook approval 的参数。

## 4. Wire 合同

### 4.1 Direct（deprecated compatibility reference）

1. 为目标 Turn 建立 invocation binding 和 attempt；
2. 在调用 native prompt 前先持久化 `prompt_invoked + delivery_certainty=unknown`；
3. 完成 Agent-specific preflight 后，以显式 argv、`shell:false`、`windowsHide:true`、配置 cwd 启动一次性进程；Kimi 0.34 在每次 spawn 前重复配置 preflight；
4. 解析各 CLI 的 JSON/JSONL 输出，stdout 与有界 stderr 分离；
5. final + exit code 归一化为唯一 terminal；
6. 取消只终止该 Turn 的进程树；
7. 从输出解析 native session ID；后续显式新 Turn 在新进程使用 Codex `exec resume`、Grok `--resume` 或 Kimi `--session`，同时注入 GroupX Context Packet；
8. Direct 不挂载 GroupX MCP。resume 只延续 session，不能重放已派发/不确定的当前 Turn。

### 4.2 Codex App Server

1. 启动固定 argv，发送 `initialize`，收到 response 后发送 `initialized`；
2. `thread/start` 或 `thread/resume` 带固定 unrestricted 字段；
3. `turn/start`，归一化 item/delta/turn events；
4. 取消使用 `turn/interrupt`；
5. 唯一 `turn/completed` 是 terminal；
6. GroupX MCP 通过 thread/process 范围配置绑定，不写全局配置。

### 4.3 Grok/Kimi/Hermes ACP

1. 启动固定 argv，发送 ACP `initialize`；ACP client-agent 生命周期不发送 App Server 的 `initialized` notification；
2. `session/new`，或 capability verified 后 `session/load`；
3. Kimi 不要求 global-config preflight；在每次 new/load 后、首 prompt 前完成 `session/set_mode(auto)`；Hermes 以 `--yolo acp` 启动，并在同一位置完成 `session/set_mode(dont_ask)`；
4. `session/prompt` 与 `session/update` 归一化，matching response/`stopReason` 是 terminal；
5. `session/cancel` 是 notification；
6. 原生支持时 `session/close`，随后有界关闭进程。

## 5. 无审批子系统与失败合同

GroupX 没有 ApprovalService、approval table、approval REST、approval UI、批准/拒绝按钮或 `approval.*` 群组事件。

在 fixed unrestricted 已正确应用后，如果 native adapter 仍发出 approval、permission、`requestUserInput`、question 或 elicitation request：

1. 不 relay、不自动决定、不等待用户；
2. 若协议必须结清请求，只发送 cancellation/error 并取消当前 Turn；Kimi ACP 对 `session/request_permission` 返回 `cancelled`，再发 `session/cancel`；
3. 当前 Turn 一律以 `UNEXPECTED_NATIVE_INTERACTION` 失败；request/options 中的 policy 字样或后续 stderr 都不能升级错误码；
4. 不 fallback、不 replay，不持久化 pending/options/decision。

`NATIVE_POLICY_BLOCKED/native_policy_blocked` 是独立的负向路径：只有 preflight、startup/session 创建或 mode 设置拒绝的明确 enterprise/server/static-deny evidence 才能使用，不得从 interaction request 推断。

“unrestricted”只在当前 Windows 用户已有权限内成立，不能绕过 UAC、ACL、企业 requirements、服务端策略或 native static deny。

## 6. M0-01..M0-15

每条结果必须同时带 Agent、transport、access contract revision、事实等级和 evidence refs。

| ID | 验证内容 | Direct | Structured |
| --- | --- | --- | --- |
| M0-01 | executable/version/精确 argv | `DEPRECATED` | 必过 |
| M0-02 | 启动与协议握手 | `DEPRECATED` | App Server/ACP initialize |
| M0-03 | prompt/final/连续性 | `DEPRECATED` | 同 session 连续两个 Turn |
| M0-04 | stream 与唯一 terminal | `DEPRECATED` | event/update 能力分级 |
| M0-05 | sender provenance | `DEPRECATED` | session/MCP binding + 正文伪装 |
| M0-06 | 取消与后续可用 | `DEPRECATED` | native cancel；同 session/进程复用 |
| M0-07 | GroupX MCP actual call | `NOT_APPLICABLE` | descriptor、discovery、真实 `tools/call`、binding attribution 全部必过 |
| M0-08 | native interaction fail-closed | `DEPRECATED` | request fixture 导致预期 Turn fail；无 approval surface |
| M0-09 | native resume/load | `DEPRECATED` | thread/resume 或 session/load 后新 Turn |
| M0-10 | 故障隔离 | `DEPRECATED` | 必过 |
| M0-11 | malformed/timeout/exit | `DEPRECATED` | JSON-RPC/timeout/EOF fault |
| M0-12 | global config 与 policy block | `DEPRECATED` | 无全局写；固定 session mode；外部 block 正确归类 |
| M0-13 | 有界诊断 | `DEPRECATED` | 必过 |
| M0-14 | 报告真实性 | `DEPRECATED` | 不借旧 non-unrestricted 证据 |
| M0-15 | 关闭与清理 | `DEPRECATED` | bounded close，无遗留 Adapter 进程 |

M0-08 是负向产品合同：测试 PASS 的条件是 Turn 按预期 failed 且没有 approval 存储/API/UI/event；不是把原生 request 视为可用能力。

M0-05 只验证 Broker 正常创建的 invocation/session binding 内的 sender attribution 和 correlation，不是认证或抵抗恶意本机进程的安全证据。

Direct 的旧 M0 语义保留作兼容参考，不再是当前验收要求。M0-07 仍为 `NOT_APPLICABLE`，其余 case 在当前矩阵统一为 `DEPRECATED`。

## 7. 当前证据状态

Structured native run `20260811T130102169Z` 在 fixed unrestricted profile 下对 Codex/Grok/Kimi 分别确认精确 argv/version、SSE 增量与唯一 terminal、真实 `groupx.send` tools/call、binding-derived sender、native cancel、同 session 后续 Turn、全局配置不写和 bounded clean close；fixture run `20260811T125831853Z` 覆盖 Structured interaction、故障、policy、诊断、报告真实性和无审批面。

Direct native run `20260811T132505879Z` 与 fixture run `20260811T132257280Z` 曾在 deprecation 决定前通过 one-shot/cancel/resume 和 104 项 fixture。它们现在只作为历史事实保留：不再生成 Direct probe/Gate 命令，不能满足任何当前 Gate，也不构成继续支持承诺。

| Transport | Codex | Grok | Kimi | Gate |
| --- | --- | --- | --- | --- |
| Direct | `DEPRECATED` | `DEPRECATED` | `DEPRECATED` | `DEPRECATED` |
| Structured unrestricted | `PASS` | `PASS` | `PASS` | `PASS` |

本机 help/parser 与最小 wire probe 已确认本文件列出的若干 argv/字段形态，这些属于 `advertised/probed`，不等于端到端 `verified`。机器可读当前状态见 [generated/m0-capabilities.json](generated/m0-capabilities.json)。

Hermes 0.20.1 已完成 `acp --check`、initialize、session/new、`dont_ask` 与跨进程 session/load 的无模型 probe；当前生成矩阵仍是原有 Codex/Grok/Kimi 核心 release baseline，不含 Hermes。Hermes 模型回复、GroupX MCP actual call、模型执行中 cancel 与 clean close 必须以新的 matching live evidence 单独验证，不能借用表中 Structured `PASS`。

## 8. Release Gate

v0.1 release 至少要求：

1. 默认 Structured 下 Codex/Grok/Kimi 的 M0-01..M0-15 适用项均 PASS；
2. 三个 Structured Agent 都完成真实 GroupX MCP `tools/call` 与 binding provenance；
3. fixed unrestricted argv/session mode 有同 run 证据；
4. native interaction fixture 均按 fail-turn 合同收敛，代码/schema/API/UI 没有 approval surface；
5. timeout、malformed、exit、隔离、重启与无重放用例通过；
6. Direct baseline、Agent 和适用 case 保持 `DEPRECATED`；历史证据不能重新激活 Gate，也不能替代 Structured；
7. 关闭后没有本次测试遗留的子进程树。

## 9. 证据边界

每条新 evidence 必须包含：`runId`、Agent、transport、`accessContract=unrestricted-v0.1`、时间、CLI/OS/Node 版本、脱敏 executable+argv shape、session settings、支持的 M0 case、结果、相对路径和 SHA-256。fixture 与 native live evidence 分开。

Live probe 使用 `.groupx/m0-workspaces/<transport>/<agent>` 隔离 cwd；原始 evidence 位于 Git 忽略的 `.groupx/evidence/m0/<run-id>/`。报告不保存普通 prompt/model 正文、完整环境/config、凭据、无界 stderr 或 native interaction raw payload。

可跟踪的 JSON 是事实源；Markdown 从它确定性生成：

```text
docs/generated/m0-capabilities.json
docs/generated/M0_CAPABILITY_MATRIX.md
```

`npm run m0:validate` 校验 case、Gate 与 evidence 引用并确认 Markdown 未漂移；`npm run m0:validate:evidence` 额外读取本机 Git 忽略 evidence 做 SHA-256 核对；`npm run m0:matrix` 只从 JSON 重建 Markdown，三者都不会启动原生 CLI probe。

任何自动切换 transport、已派发 Turn 重放、用旧 access/另一 mode 证据冒充 PASS、把 native request 变成审批 UI，都会使 Gate 失败。
