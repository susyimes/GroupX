# 参考项目与协议核查

核查日期：2026-08-11
用途：区分可复用设计模式、官方/现场事实和 GroupX 自己的产品决定。

## 1. 最终 transport 选择

GroupX v0.1 支持：

```text
transport=direct      -> deprecated compatibility: 每个 Turn 一次非交互 CLI
transport=structured  -> Codex App Server / Grok ACP / Kimi ACP
default=structured
automatic fallback=false
```

两个 transport 值都只连接 Broker，不构成物理 P2P。Structured 是唯一 active/release 路径，保持长驻 session 并提供语义化 cancel 与 GroupX MCP 当前回合主动互调。Direct 的 one-shot/resume 结论仅解释 deprecated 兼容实现和历史记录，不是当前产品建议。

`access` 是不可配置的内部固定值 `unrestricted`。这是一条 GroupX native launch/session 合同，不是安全边界，也不能绕过 Windows/企业/服务端/native 强制策略。

## 2. 仓库基线

| 项目 | 核查基线 | 状态说明 |
| --- | --- | --- |
| Species | 本地 `D:\species` `65fdc5f`; 远端 main `4caea4b` | 核心房间结论不依赖本地/远端差异 |
| memsuOS | `D:\memsuOS` `4bd21fa` | 核查时与远端 main 一致 |
| TendrilFlow | 本地 `D:\TendrilFlow` `181b513`; 远端 main `642b843` | A2A 结论以远端当前实现为准 |

GroupX 不复制参考项目源码。参考项目只用于提炼边界；许可与 provenance 必须独立判断。

## 3. Species

项目：[susyimes/species](https://github.com/susyimes/species)

值得借鉴：

- `RoomEvent` 的 event/correlation/causation/idempotency/ref；
- 消息先持久化、HTTP 快速确认、异步 Agent Turn；
- 极薄 AgentAdapter；
- transcript、公共记忆和 persona/identity 投影分离；
- reply/context refs 与成员状态 UI。

不能直接复用：

- live provider 是 HTTP，不是本地 CLI Direct/App Server/ACP；
- Web 轮询全量 state，不是 durable cursor SSE；
- background queue 在内存，重启不恢复；
- JSONL ledger 去重不等于 native dispatch 幂等；
- side-effect approval、constitution、speaker budget 和社会状态机超出 GroupX 边界。

GroupX 采用事件/异步思想，改用单 Broker + SQLite/WAL + durable Turn/attempt + REST/SSE。

## 4. memsuOS

项目：[susyimes/memsuOS](https://github.com/susyimes/memsuOS)

值得借鉴：

- ProtocolArtifact/ProtocolEvent 与弱耦合 ref；
- append-only 事实源和派生 view；
- provider adapter、provenance、supersedes；
- one-shot `codex exec` 证明 Direct 中央编排在技术上可行。

不能直接复用：

- 其 Codex one-shot 额外强制 sandbox/approval，与 GroupX fixed unrestricted 合同不同；
- Kimi 临时 agent 强制 `tools: []`，也不是 GroupX access profile；
- 没有 Grok Adapter；
- open-org round/member 编排不是持续本地群聊；
- governance、AuthorizationDecision、Claim Firewall 不进入 GroupX 执行门。

memsuOS 当前是个人非商业 source-available 许可，并非 OSI 开源许可；GroupX 不复制代码。

## 5. TendrilFlow

项目：[susyimes/TendrilFlow](https://github.com/susyimes/TendrilFlow)

值得借鉴：

- Legacy CLI 与 ACP session 分离，说明过往 Direct/Structured Adapter 边界的来源；当前只启用 Structured；
- Kimi ACP 差异处理经验；
- task/room 与 transport 分层；
- 显式 Host/recipient 路由，不依赖自然语言自动路由；
- A2A 作为外部 Adapter，不替换内部 room/transport。

当前 A2A 证据：[A2A spike at `642b843`](https://github.com/susyimes/TendrilFlow/blob/642b84316c7d7a2523a4272de75a926f0005073c/docs/A2A_SPIKE.md)

不能直接复用：

- Host Agent、任务板、工作树和 orchestration 对 GroupX 过重；
- 定时 state polling 不满足 GroupX SSE cursor 合同；
- 自动选择 `allow_once/allow_always` 与 GroupX “无审批子系统、interaction 即 fail-turn”相冲突；
- 超大单体 orchestrator 不符合首版简单边界。

GroupX 借鉴 transport/Adapter 分层与 ACP 差异处理，同时保留 A2A 为 M3 边缘适配。

## 6. 官方产品与协议边界

### 6.1 Codex Direct（deprecated reference）/ App Server

官方资料：[Codex CLI reference](https://developers.openai.com/codex/cli/reference/)、[Codex App Server](https://developers.openai.com/codex/app-server/)

官方/本机 probe 支持以下判断：

- Direct `exec --json` 可输出 NDJSON，`exec resume --json <sessionId> -` 可在新进程续会话；`--yolo` 跳过审批与 Codex sandbox；hook trust 是独立全局 flag；
- App Server 是双向 JSON-RPC/JSONL rich-client surface，支持 thread/turn、streamed events、interrupt/resume 和 server-initiated requests；
- stdio 是 GroupX 采用的稳定 transport；实验 WebSocket 与 `dynamicTools` 不作为依赖；
- 当前 Codex 0.147 App Server 的 thread-level sandbox 字段是 `sandbox:"danger-full-access"`；`dangerFullAccess` 属于 `turn/start.sandboxPolicy.type` 的另一 wire shape；
- managed requirements 可以限制 approval/sandbox 组合。

GroupX mapping：Direct 使用 fixed yolo argv；Structured thread start/resume 固定 `approvalPolicy:"never"` 与 `sandbox:"danger-full-access"`。`configRequirements/read` 可做 bounded preflight。任何 server-initiated approval/user-input request 都终止当前 Turn，不进入 UI。

### 6.2 Grok Direct（deprecated reference）/ ACP

官方资料：[Grok CLI reference](https://docs.x.ai/build/cli/reference)、[Headless & Scripting](https://docs.x.ai/build/cli/headless-scripting)、[Permissions](https://docs.x.ai/build/features/permissions)、[Sandbox](https://docs.x.ai/build/features/sandbox)

- `--single`（短别名 `-p`）提供一次性 prompt；`--output-format streaming-json` 提供机器流；`--resume <sessionId>` 在新进程续会话；
- `agent stdio` 提供 ACP；
- `--no-auto-update` 适合 headless/ACP automation；
- `--permission-mode bypassPermissions`、`--sandbox off`、`--no-plan` 是 GroupX fixed profile；
- enterprise policy 可以禁用 bypass permissions。

所有 Grok 全局 flags 位于 `--single` 或 `agent stdio` 之前。任何 enterprise block 明确归类为 `NATIVE_POLICY_BLOCKED`，不修改配置、不 fallback。

### 6.3 Kimi Direct（deprecated reference）/ ACP

官方资料：[Kimi command reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command)、[Kimi ACP reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp)、[Kimi config files](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files)

- `--prompt` 是原生非交互入口，使用 auto 且不能与 `--auto`、`--yolo` 或 `--plan` 组合；`--session <sessionId>` 可在同 workspace 的新进程续会话；
- `default_permission_mode` 与 `default_plan_mode` 是 config.toml 顶层默认值，默认分别为 manual 与 false；进程启动时可用作 bounded preflight；
- ACP 提供 initialize/session new/load/prompt/update/cancel 与 `session/set_mode`；
- `auto` 关闭 Plan、自动处理工具权限且不向用户提问，但仍受 static deny；
- ACP mode 不持久化，`session/new` 或 `session/load`（含 Adapter resume）后首 prompt 前必须再次 `session/set_mode(auto)`。

历史 Kimi 0.34 Direct 实现曾使用只读 config preflight + `--prompt`，现已 deprecated 且入口关闭。Active Structured 不复用这个门禁：官方 `kimi acp` 支持 `session/set_mode`，因此接受默认 global `manual`，随后用 `session/set_mode(auto)` 明确关闭当前 ACP session 的 Plan。mode 拒绝按原生错误证据收敛，不自动改配置或 transport。

如果设置 auto 后仍出现 `session/request_permission`，GroupX 返回 `cancelled` 结清 request、发送 `session/cancel`，然后一律以 `UNEXPECTED_NATIVE_INTERACTION` 失败。`NATIVE_POLICY_BLOCKED` 只能由独立 preflight、startup/session 创建或 mode 设置拒绝的明确 static-deny evidence 产生，request/options 不能触发升级。

### 6.4 ACP v1

官方资料：[Agent Client Protocol v1](https://agentclientprotocol.com/protocol/v1/overview)

ACP 定义 client-agent initialize、session/new/load/prompt/update/cancel 和 permission request。ACP initialize 只有 request/response，不发送 Codex App Server 的 `initialized` notification；`session/cancel` 是 notification；`session/prompt` matching response 提供 terminal stop reason。ACP 不是三 Agent 消息总线。

### 6.5 MCP

MCP 只在 Structured 解决“CLI 在当前生成回合调用 GroupX 工具”。调用者来自 session-specific binding，不来自 tool arguments 的 `from`。这是 Broker 正常 binding 流程内的 provenance/correlation，不是认证或抵抗恶意本机进程的安全边界。Direct 不注入、不发现、不宣告 MCP。

旧 Structured evidence 曾观察到 Codex/Grok actual `tools/call`，但未使用新版完整 unrestricted profile，仍只保留为 `legacy-nonconforming`。当前 native run `20260811T130102169Z` 已在新版合同下让 Codex/Grok/Kimi 各自真实完成一次 `groupx.send` tools/call、binding attribution、stream、cancel 后复用、配置不写与 clean close；它与独立 fixture evidence 共同关闭默认 Structured release Gate。

### 6.6 Native approval/permission wire

App Server/ACP 官方协议能够表达 approval、permission 或 user-input request，这只是 wire 事实，不是 GroupX 产品能力。GroupX v0.1 没有 ApprovalService、表、REST、UI、event 或 pending 状态；任何此类 request 都按 [M0 失败合同](M0_TRANSPORT_SPIKE.md#5-无审批子系统与失败合同) 终止 Turn。

旧 Kimi permission options/reject evidence 不能证明新版 `native_policy_blocked`；该错误需要明确 enterprise/server/static deny evidence。

### 6.7 A2A

官方资料：[A2A specification](https://a2a-protocol.org/latest/specification/)

A2A 面向独立/远程 Agent，包含 Agent Card、Message、Task、Artifact、发现与异步生命周期。GroupX 首版固定三个本地 Agent，不把这些网络边界搬进内部核心；A2A 只作为 M3 edge adapter。

## 7. 当前证据适用性

| Evidence | 事实价值 | v0.1 unrestricted Gate |
| --- | --- | --- |
| 旧 Codex App Server session/cancel/resume/MCP | 历史 wire evidence | `legacy-nonconforming`，不可关闭 |
| 旧 Grok ACP session/cancel/load/MCP | 历史 wire evidence | `legacy-nonconforming`，不可关闭 |
| 旧 Kimi ACP session/cancel/load/permission | 历史 wire evidence | `legacy-nonconforming`，不可关闭 |
| 当前 Kimi ACP new/set-mode/prompt/MCP/close | matching live evidence | 作为 Structured Kimi 历史匹配证据保留；global-config preflight 已从 active 路径移除 |
| 当前 Structured runtime Web 群发/resume/三回复/close | matching live evidence | Codex/Grok/Kimi 的 M0-02/M0-03/M0-09/M0-15 为 PASS |
| 本机 argv/help/parser 与最小 wire probe | advertised/probed | 可固定命令/字段，不等于 live PASS |
| 当前 Direct runtime 新会话 + 重启续会话 | deprecated historical evidence | 仅说明旧兼容实现曾具备连续性，不满足当前 Gate |
| Direct unrestricted native live `20260811T132505879Z` + fixture `20260811T132257280Z` | deprecation 前三 Agent one-shot/cancel/resume 与 104 项 fixture 曾 PASS | `canSatisfyCurrentGate=false`；Direct baseline 固定 `DEPRECATED` |
| Structured unrestricted native live + fixture | 三 Agent native PASS；105 项 fixture PASS | release `PASS` |

实现、README、M0 合同和 generated matrix 必须使用同一命令、transport/access revision、`M0-01..M0-15` 编号和 evidence matching 规则。没有真实同合同 evidence 的能力不得写成“已支持”。
