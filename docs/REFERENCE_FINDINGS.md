# 参考项目与协议核查

核查日期：2026-08-11
用途：区分可复用设计模式、官方/现场事实和 GroupX 自己的产品决定。

## 1. 最终 transport 选择

GroupX v0.1 支持：

```text
transport=direct      -> deprecated compatibility: 每个 Turn 一次非交互 CLI
transport=structured  -> Codex App Server / Grok ACP / Kimi ACP / Hermes ACP / Claude Code CLI stream-json
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

### 6.4 Hermes ACP

官方资料：[ACP integration](https://github.com/nousresearch/hermes-agent/blob/main/website/docs/developer-guide/programmatic-integration.md)、[Hermes ACP guide](https://github.com/nousresearch/hermes-agent/blob/main/website/docs/user-guide/features/acp.md)、[CLI reference](https://github.com/nousresearch/hermes-agent/blob/main/website/docs/reference/cli-commands.md)

- 官方入口是 `hermes acp`，`hermes acp --check` 可执行不发模型请求的安装检查；
- GroupX 固定使用 `hermes --yolo acp`，并在每次 `session/new`/`session/load` 后发送 `session/set_mode {modeId:"dont_ask"}`；
- 本机 0.20.1 的 ACP initialize 支持 `loadSession`，session new/load/set-mode 已完成无模型 probe；
- 0.20.1 initialize 未声明 `mcpCapabilities.http`，但官方 server 实现会接收 new/load 的 HTTP MCP descriptor。GroupX 只在 Hermes driver 内使用这个窄兼容规则，raw capability report 仍保留未声明事实；
- GroupX 不追加会持久化 hook approval 的参数，也不写 Hermes 全局配置；任何 permission/question request 继续按 `UNEXPECTED_NATIVE_INTERACTION` 失败当前 Turn。

以上只证明命令、握手、会话配置与恢复 wire。Hermes 模型回复、真实 GroupX MCP `tools/call` 和模型执行中的 cancel 尚未作为 matching live evidence 记录，不能写成 verified。

### 6.5 Claude Code CLI stream-json

官方资料：[Claude Code headless](https://docs.claude.com/en/docs/claude-code/headless)、[Claude Code overview](https://docs.claude.com/en/docs/claude-code/overview)

- Claude Code 不是 ACP，也不是 Codex App Server，而是自成一族的 stdio stream-json 适配面；协议串为 `claude-cli-stream-json-v1`（对照：Codex 为 `codex-app-server-stdio-jsonrpc-v2`，ACP driver 为 `acp`）；
- GroupX 固定追加 `--print --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-mode bypassPermissions`；有 GroupX MCP 绑定时追加 `--mcp-config <json>`，末尾追加 `--session-id <uuid>`（新建）或 `--resume <uuid>`（恢复）；
- stream-json 是换行分隔的消息流而非 JSON-RPC，所以 Adapter 直接建立在通用 JSONL 进程层上，不复用 JSON-RPC 层；
- `system`/`init` 帧要在首条用户消息之后才发出，不能当作握手。GroupX 改用 SDK control request：`control_request`/`initialize` 返回 `current_permission_mode`（观测）且不消耗模型回合，随后 `control_request`/`set_permission_mode` 建立 `bypassPermissions`；只有 set 拒绝或降级即 `NATIVE_POLICY_BLOCKED`。这是 Codex `configRequirements/read` 与 Kimi/Hermes `session/set_mode` 的对应形态；
- 延后到达的 `system`/`init` 帧仍在首个 Turn 内校验 `session_id` 与 `cwd` 是否与 GroupX 启动值一致，不一致则该 Turn 失败；
- 取消发送 `control_request`/`interrupt`。中止原因有两个：流式输出中取消为 `terminal_reason: "aborted_streaming"`，工具执行中取消为 `"aborted_tools"`；两者都归一化为 `turn.cancelled`，stdio 进程仍可用于下一个 Turn。interrupt 输给正在收敛的 Turn 时，CLI 仍会为它补发一个 `result`，Adapter 在 cancel 窗口内吸收该帧；`result.num_turns` 是单次 prompt 内部的 agent 迭代计数，不是会话级单调计数器，不能用于跨 Turn 关联；
- `--mcp-config` 同时接受 stdio 与 http 描述符。GroupX 注入单个名为 `groupx` 的 server：http 带 header `X-GroupX-Binding: <bindingId>`，stdio 追加 `--binding <bindingId>`；不使用 `--strict-mcp-config`，与用户自有 MCP server 合并；
- unrestricted 由 argv 申请、由 `set_permission_mode` 建立，GroupX 不写 Claude Code 的 settings 文件。CLI→client 的交互类 control request 实测为 `can_use_tool`、`elicitation` 与 `request_user_dialog`，三者都在 wire 边界拒绝并以 `UNEXPECTED_NATIVE_INTERACTION` 失败当前 Turn；`hook_callback`、`mcp_message`、`host_auth_token_refresh`、`oauth_token_refresh` 不是决策请求，只回协议错误；
- Windows 命令解析顺序为 `PATH`、`%USERPROFILE%\.local\bin\claude.exe`（原生单文件构建）、npm 全局入口 `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\cli.js`（经 node 启动；此层才需要 `APPDATA`）；POSIX 为 `PATH`、`$HOME/.local/bin/claude`，再按当前 Node 安装前缀 / Homebrew `/opt/homebrew` / `/usr/local` 查找 npm 全局 `cli.js`（经 node 启动，不调用 `npm root -g`）。

2026-08-16 已对 win32 上的 Claude Code 2.1.233 完成独立 native-live probe：基础 Turn、streaming delta、经 http binding 恰好一次的 GroupX MCP `memory_search` 调用、runtime 重启后的 `--resume` 恢复、clean shutdown、无遗留进程、用户 settings 未被修改，证据在 `.groupx/evidence/claude-live/`。它是 Claude 自己的版本化 probe（比照 Hermes 先例），不进入 codex/grok/kimi 的核心 M0 三 Agent Gate。

### 6.6 ACP v1

官方资料：[Agent Client Protocol v1](https://agentclientprotocol.com/protocol/v1/overview)

ACP 定义 client-agent initialize、session/new/load/prompt/update/cancel 和 permission request。ACP initialize 只有 request/response，不发送 Codex App Server 的 `initialized` notification；`session/cancel` 是 notification；`session/prompt` matching response 提供 terminal stop reason。ACP 不是 Agent 消息总线。

### 6.7 MCP

MCP 只在 Structured 解决“CLI 在当前生成回合调用 GroupX 工具”。调用者来自 session-specific binding，不来自 tool arguments 的 `from`。这是 Broker 正常 binding 流程内的 provenance/correlation，不是认证或抵抗恶意本机进程的安全边界。Direct 不注入、不发现、不宣告 MCP。

旧 Structured evidence 曾观察到 Codex/Grok actual `tools/call`，但未使用新版完整 unrestricted profile，仍只保留为 `legacy-nonconforming`。当前 native run `20260811T130102169Z` 已在新版合同下让 Codex/Grok/Kimi 各自真实完成一次 `groupx.send` tools/call、binding attribution、stream、cancel 后复用、配置不写与 clean close；它与独立 fixture evidence 共同关闭默认 Structured release Gate。

### 6.8 Native approval/permission wire

App Server/ACP 官方协议能够表达 approval、permission 或 user-input request，这只是 wire 事实，不是 GroupX 产品能力。GroupX v0.1 没有 ApprovalService、表、REST、UI、event 或 pending 状态；任何此类 request 都按 [M0 失败合同](M0_TRANSPORT_SPIKE.md#5-无审批子系统与失败合同) 终止 Turn。

旧 Kimi permission options/reject evidence 不能证明新版 `native_policy_blocked`；该错误需要明确 enterprise/server/static deny evidence。

### 6.9 A2A

官方资料：[A2A specification](https://a2a-protocol.org/latest/specification/)

A2A 面向独立/远程 Agent，包含 Agent Card、Message、Task、Artifact、发现与异步生命周期。GroupX 首版面向本地配置名册，不把这些网络边界搬进内部核心；A2A 只作为 M3 edge adapter。

## 7. 当前证据适用性

| Evidence | 事实价值 | v0.1 unrestricted Gate |
| --- | --- | --- |
| 旧 Codex App Server session/cancel/resume/MCP | 历史 wire evidence | `legacy-nonconforming`，不可关闭 |
| 旧 Grok ACP session/cancel/load/MCP | 历史 wire evidence | `legacy-nonconforming`，不可关闭 |
| 旧 Kimi ACP session/cancel/load/permission | 历史 wire evidence | `legacy-nonconforming`，不可关闭 |
| 当前 Kimi ACP new/set-mode/prompt/MCP/close | matching live evidence | 作为 Structured Kimi 历史匹配证据保留；global-config preflight 已从 active 路径移除 |
| 当前 Structured runtime Web 群发/resume/三回复/close | matching live evidence | Codex/Grok/Kimi 的 M0-02/M0-03/M0-09/M0-15 为 PASS |
| Hermes 0.20.1 `acp --check` + initialize/new/set-mode/cold-load | matching no-model probe | 命令与 session wire 为 `probed`；模型回复/MCP actual call/cancel 尚未 `verified` |
| Claude Code 2.1.233 (win32) 基础 Turn/delta/MCP `memory_search`/`--resume`/clean close | matching live evidence（`.groupx/evidence/claude-live/`） | 只支撑 Claude 自己的能力分级；不进入 codex/grok/kimi 的核心 M0 三 Agent Gate |
| 本机 argv/help/parser 与最小 wire probe | advertised/probed | 可固定命令/字段，不等于 live PASS |
| 当前 Direct runtime 新会话 + 重启续会话 | deprecated historical evidence | 仅说明旧兼容实现曾具备连续性，不满足当前 Gate |
| Direct unrestricted native live `20260811T132505879Z` + fixture `20260811T132257280Z` | deprecation 前三 Agent one-shot/cancel/resume 与 104 项 fixture 曾 PASS | `canSatisfyCurrentGate=false`；Direct baseline 固定 `DEPRECATED` |
| Structured unrestricted native live + fixture | 三 Agent native PASS；105 项 fixture PASS | release `PASS` |

实现、README、M0 合同和 generated matrix 必须使用同一命令、transport/access revision、`M0-01..M0-15` 编号和 evidence matching 规则。没有真实同合同 evidence 的能力不得写成“已支持”。
