# GroupX 架构决策记录

状态说明：

- `Accepted`：实现必须遵守；变更需更新本文件和相关合同。
- `Provisional`：方向已定，但具体机制依赖 M0 证据。
- `Deferred`：明确推迟，不得在首版偷偷引入。

## 决策索引

| ID | 决策 | 状态 |
| --- | --- | --- |
| D-001 | 单机透明 Broker，而不是三个 CLI 物理 P2P | Accepted |
| D-002 | Web 使用 REST command + SSE event | Accepted |
| D-003 | Structured 是唯一 active/release transport；Direct deprecated，禁止自动 fallback | Accepted |
| D-004 | 内部 GroupX Envelope；A2A 作为以后边缘适配 | Accepted |
| D-005 | SQLite/WAL 是权威事实源，JSONL 仅导出 | Accepted |
| D-006 | Broker 根据通道绑定生成 sender identity | Accepted |
| D-007 | access 固定 unrestricted，只用原生进程/会话最大放开配置 | Accepted |
| D-008 | transcript、公共记忆、摘要、身份记忆分离 | Accepted |
| D-009 | 每 Agent lane 单飞，不同 Agent 并行 | Accepted |
| D-010 | GroupX MCP 提供异步 send 与同步 ask/read | Accepted |
| D-011 | 因果循环与资源限制属于可靠性，不属于权限 | Accepted |
| D-012 | Node/TypeScript 单进程、原生 Web UI | Accepted |
| D-013 | SQLite Node 驱动在 M0 后固定 | Provisional |
| D-014 | 完整 A2A Server、多房间、多用户 | Deferred |
| D-015 | GroupX 不构成安全边界，也不实现审批子系统 | Accepted |
| D-016 | 所选 transport 派发不确定时绝不自动重放或切换 | Accepted |
| D-017 | 配置驱动的 Agent 名册(driver/name/自定义 id)与 npm CLI 分发 | Accepted |
| D-018 | 推理记录可回放但不进入上下文 | Accepted |
| D-019 | 工具进度可回放但不进入上下文 | Accepted |
| D-020 | `groupx start` 复用同配置的现有 runtime | Accepted |
| D-021 | Agent 记忆拆分为显式核心记忆与自动日期记忆 | Accepted |
| D-022 | Hermes 作为独立 ACP driver 接入 Structured transport | Accepted |
| D-023 | Agent 日期记忆由逐 Turn 原文改为可恢复的每日批量 rollup | Accepted |
| D-024 | Claude Code 作为独立 stream-json driver 接入 Structured transport | Accepted |
| D-025 | ask 超时不加回送机制，harness 只以有界文本指导模型闭环 | Accepted |
| D-026 | 放宽消息 wire 上限（131,072）、运行超时与互调链路默认值 | Accepted |
| D-027 | 同步监督是房间协作配对，不是治理或审批层 | Accepted |
| D-028 | 房间助理是 user:assistant 操作员客户端，不是名册 worker | Accepted |
| D-029 | 无 schema 的协作闭环：publish、pending/collect、队列可见性与默认 reply chain | Accepted |
| D-030 | 协作工具保持拓扑中立，由 Agent 自主组织讨论与收敛 | Accepted |
| D-031 | `groupx stop` / `groupx restart` 以配置路径作用域优雅控制 runtime | Accepted |

## D-001：透明 Broker

决定：所有 UI/CLI 消息通过一个本地 Broker。

原因：

- 多套 CLI 没有统一 peer server；
- 连接数保持 O(N)；
- 公共记忆和 sender provenance 只有一个事实源；
- 新增 Adapter 不需要修改现有 CLI；
- 本地转发开销相对模型耗时很小且可以测量。

变更条件：出现跨机器、高频二进制数据或 Broker 可靠性需求，允许大 payload 走直连/引用，但 Broker 仍保留控制面和事实账本。

## D-002：REST + SSE

决定：浏览器用 REST 提交命令，用 SSE 接收 durable/transient events。

原因：

- 命令与事件方向清晰；
- 浏览器原生重连和 `Last-Event-ID`；
- 比自定义 WebSocket command protocol 更少状态；
- cancel、memory 与 identity 写入天然适合 REST。

变更条件：需要浏览器端双向二进制或极高频交互时再增加 WebSocket，不替换现有 Envelope。

## D-003：Structured active，Direct deprecated

决定：v0.1 的存储/历史合同仍识别两个 transport 值，但公开运行入口只接受 Structured：

```yaml
transport: direct | structured
```

默认值为 `structured`，同一次 Broker 运行对全部已配置 Agent 使用同一选择：

- `structured`：Codex 使用 App Server，Grok/Kimi/Hermes 使用 ACP，维持长驻 session，支持原生事件、语义化取消、resume/load 和 GroupX MCP；
- `direct`：deprecated compatibility vocabulary。既有 one-shot/resume 源码和历史数据库记录保持可读；配置解析、Adapter factory 与 runtime constructor 均 fail-closed，不启动 Direct；不再新增能力、不维护 live Gate、不参与 release，也不作为 Structured 失败后的 fallback；
- 两者共用同一个 Broker、Envelope、sender provenance、Turn、记忆和 SSE 合同；
- 选择是显式的。任何启动、握手、执行或能力失败都在所选 transport 内收敛，不自动切换到另一 transport。

原因：产品目标已经收敛到 Codex App Server + ACP driver。保留 Direct enum/实现可避免破坏旧数据和已有调用方，但继续把它当 active 产品会重复维护 argv、wire、Gate 和能力说明。

M0 只维护 Structured active release baseline。Direct baseline、Agent 与适用 case 固定为 `DEPRECATED`；已有 Direct live/fixture evidence 仅作历史事实，`canSatisfyCurrentGate=false`。

## D-004：A2A 边缘化

决定：GroupX 内部不采用完整 A2A Task 模型。内部 Envelope 保留可映射字段，M3 以 Adapter 暴露/接入 A2A。

原因：本机配置名册不需要 discovery、远程认证和完整 Task/Artifact 生命周期；TendrilFlow 的当前 A2A 实现也采用外部适配到内部房间的边界。

## D-005：SQLite/WAL

决定：单 SQLite/WAL 数据库是唯一权威来源；Broker 唯一写入。JSONL 是导出，不是并发协调层。

原因：消息与多目标 Turn 需要事务；重启恢复、幂等、分页、状态查询和记忆索引都不应重新手工实现文件数据库。

## D-006：通道绑定身份

决定：`from` 由 Broker 根据 Adapter 进程/会话 binding 填写；API/工具不接受调用者设置 sender。

行为：正常 Adapter/会话通道内，Broker 从 binding registry 取得 actor，正文和工具参数没有设置 sender 的字段。

边界：binding 是来源关联和 correlation handle，不是 secret、认证或能力令牌。GroupX 不承诺抵御本机进程仿造 binding 或修改数据库。

## D-007：固定 native unrestricted

决定：v0.1 的 `access` 只有一个值 `unrestricted`，不进入公开配置，也不提供安全档位。GroupX 在进程、thread 或 session 范围固定应用各 CLI 的原生最大放开方式：

| Agent | Direct（deprecated reference，不可启动） | Structured |
| --- | --- | --- |
| Codex | 新会话：`codex --yolo --dangerously-bypass-hook-trust exec --json -`；续会话：同一前缀后 `exec resume --json <sessionId> -` | `codex --dangerously-bypass-hook-trust app-server --listen stdio://`；`thread/start`/`thread/resume` 使用 `approvalPolicy: "never"` 与 `sandbox: "danger-full-access"` |
| Grok | `grok --no-auto-update --permission-mode bypassPermissions --sandbox off --no-plan [--resume <sessionId>] --output-format streaming-json --single <prompt>`（`-p` 是短别名） | 同一全局前缀后追加 `agent stdio` |
| Kimi | deprecated Direct 参考实现保留只读配置预检后使用 `kimi [--session <id>] --prompt <prompt> --output-format stream-json` | 直接启动 `kimi acp`；不要求全局默认模式。每次 `session/new` 或 `session/load`（含 Adapter resume）后、首个 prompt 前调用 `session/set_mode`，`modeId="auto"`；mode 不持久化 |
| Hermes | 不提供 Direct 产品入口 | `hermes --yolo acp`；每次 `session/new` 或 `session/load` 后、首个 prompt 前调用 `session/set_mode`，`modeId="dont_ask"` |

Codex 0.147 的 thread-level `sandbox` 是 kebab-case 字符串 `danger-full-access`；camel-case `dangerFullAccess` 只出现在 `turn/start.sandboxPolicy.type` 这类不同 wire shape，不能写进 thread params。Codex child 的 OS cwd 使用 Agent 配置值，thread params 不重复发送 cwd，避免触发不必要的原生 trust 持久化。

GroupX 仍不写 Codex/Grok/Kimi/Hermes 的全局配置，不允许用户透传任意额外权限 argv，也不再实现第二套 GroupX 审批或沙箱判断。Active Structured Kimi 的 session mode 是 GroupX 唯一依据：官方默认 `manual` 不阻止 ACP 启动，随后必须以原生 `session/set_mode(auto)` 覆盖当前 session。Hermes 同时使用进程级 `--yolo` 与 session 级 `dont_ask`，但不追加会持久化用户选择的 hook allowlist 参数。明确 native policy 拒绝才失败；不会先要求用户修改全局配置。

Direct/Kimi one-shot 的旧 preflight 规则只保留作历史实现说明，不再构成产品能力。Active Structured Kimi 不执行 global-config preflight，但必须在每次 new/load 后重设 session auto mode。

“unrestricted”只在当前 Windows 用户已有权限内成立，不能绕过 UAC、文件 ACL、企业 requirements、服务端限制或 Kimi static deny。若原生结果明确表明外部策略阻止该模式，Turn 以 `NATIVE_POLICY_BLOCKED` 失败，Agent 状态显示 `native_policy_blocked`；GroupX 不修改、探测规避或绕过该策略。

## D-008：记忆分层

决定：

- transcript 是完整事件事实；
- public memory 是显式固定记录；
- summary 是可失效派生物；
- identity memory 是 GroupX 群内身份叠加；
- CLI 原生身份、instructions、配置和私有记忆不由 GroupX 覆盖。

纠错使用 supersede/tombstone，不原地抹除来源。

Room Context Engine 使用累计 checkpoint summary + 近期真实消息，默认 `256,000` 字符硬上限、约 `75%` 的压缩软目标。预算不是 token window；不同 CLI/模型窗口无需伪装成相同。触发压缩时按房间配置顺序使用第一个健康 Agent，不可用或输出无效时再尝试下一个。摘要持久化、attempt `summary_through_seq` 与 delivery cursor 的推进顺序必须保证：失败只会让当前 Turn 明确失败，绝不会以裁剪历史换取继续运行。

单房间 UI 可显示 checkpoint + 未压缩消息的字符估算并显式请求压缩。该命令仍由 Broker 接收、以 `clientCommandId` 单飞，复用自动压缩的摘要 CAS，保留最近 12 条消息；它不是清空会话或删除 transcript，也不把字符估算称为 token 数。

## D-009：并发

决定：每个 Structured Agent lane FIFO 单飞；不同 Agent 并行。`@all` 不串行等待。

原因：同一会话的上下文顺序比理论并发更重要；跨 Agent 并行保留效率和故障隔离。

## D-010：GroupX MCP 的 send、ask、read

决定：GroupX MCP 是 M2 的 Structured Agent 主动互调合同。Deprecated Direct 不存在可替代入口：

- `send` 持久化后异步返回；
- `ask` 等待目标 terminal response 并作为 MCP 工具结果返回；
- `read` 查询异步 correlation；
- 所有问答同时写入公共房间。

没有 ask 时，发送 Agent 在当前回合无法可靠看到目标回答；只看公共 UI 不等于回答进入发送方上下文。

Web/UI 的显式 recipients 可发起普通群聊；普通模型文本中的 `@某人` 不自动派发。若某个 Structured Adapter 无法附加 GroupX MCP 或无法完成真实工具调用，普通能力结论只能标为 `not_observed` 或 `unsupported`；只有独立 preflight/startup/session/mode 拒绝已经确立外部强制策略时，Agent 才能已处于 `native_policy_blocked`。对应 M2 验收不能标记完成；不得解析自然语言或恢复 Direct 冒充工具调用。

## D-011：因果循环与资源限制

决定：所有 child Turn 都必须严格验证 parent/root/hop 和父链完整性。只有进入 `waitsForChildren` 的同步 `mcp.ask` 不能把 active causal stack 中的祖先 actor 作为目标，返回 `CAUSAL_CYCLE`。异步 `mcp.send` 允许回发祖先，但显式长链仍受 hop/root-turn/actor-call/queue/timeout 限制，达到边界产生公开错误事件。

这不改变 CLI 的工具/文件/网络权限，只防止 Broker 死锁和无限资源占用。

## D-012：简单技术栈

决定：Node.js + TypeScript；单进程 Broker；首版原生 HTML/CSS/TypeScript UI。

首版不引入前端框架、消息队列服务、向量数据库、LangGraph 或插件市场。

## D-013：SQLite 驱动

方向：使用稳定、固定版本的 SQLite Node 驱动。

当前本机 Node `v24.14.1` 的 `node:sqlite` 仍输出 experimental warning，因此不在文档阶段锁定为默认。M0 比较安装可靠性、Node 24 兼容性、事务/WAL、备份和 CI 后决定。

## D-014：延期范围

延期：

- 完整 A2A server/discovery；
- 多用户登录/RBAC；
- LAN/互联网监听；
- 多房间 UI；
- 远程 Broker federation；
- 自动 Agent 自治循环；
- 向量数据库；
- 大型 artifact 数据面。

这些功能只能在 M0-M2 合同保持稳定后加入。

## D-015：无 GroupX 审批子系统

决定：GroupX 不构成安全边界。首版固定请求 CLI 以 unrestricted 运行，但 GroupX 不判断某个命令是否安全，也不提供 ApprovalService、审批表、审批 REST、审批 UI、批准/拒绝按钮或 `approval.*` 群组事件。

如果 native adapter 发出 approval、permission、`requestUserInput`、question 或 elicitation request，unrestricted 运行合同已经失效。Adapter 必须：

1. 不把 request 转发给 Web UI，也不选择 allow/deny；
2. 以协议允许的 cancellation/error 做有界收尾，避免子进程永久悬挂；该动作只是终止 Turn，不是审批决定；
3. 一律用 `UNEXPECTED_NATIVE_INTERACTION` 失败当前 Turn；interaction request 及其 options 绝不能被重分类为 `NATIVE_POLICY_BLOCKED`；
4. 不自动改 transport、不重放 prompt、不创建 pending 状态。

`NATIVE_POLICY_BLOCKED` 是独立的启动/会话失败路径：只有外部策略预检或 native 启动/session 拒绝明确证明 enterprise/server/static deny 时才能使用，并投影 `native_policy_blocked`。

首版也不引入认证 token、RBAC、capability token、Origin/DNS 防护或秘密内容扫描。loopback、sender binding、输入校验、幂等、队列/循环上限、事务和普通文本渲染都是产品范围或协议正确性措施，不代表安全保证。

GroupX 只按合同字段记录数据，不主动采集完整环境、CLI 配置或无界 stderr。用户或模型提交到普通消息/记忆中的内容会按产品语义持久化，GroupX 不承诺识别其中的凭据或秘密。

## D-016：派发不确定性、无重放、无 fallback

决定：Structured Adapter 初始化、能力协商或 session 建立失败且 prompt 尚未派发时，该 Turn 明确失败并记录 Adapter 错误；只能由用户或上层编排创建新 Turn 重试，不能启用 Direct。

一旦 prompt 已提交或可能已到达原生 session，连接丢失、超时、Broker 重启或终态不明时，GroupX 必须先通过已持久化的 native session/turn 引用进行有界恢复与对账，不得创建新 native turn 或自动重放 prompt。仍无法确认时，将交付确定性单独记录为 `unknown`，并以现有证据收敛到 terminal `interrupted` 或明确失败；保留 attempt、dispatch phase 与恢复证据，避免重复执行、重复工具调用或重复计费。

Structured resume/load 不能自动重放不确定 Turn。历史 Direct attempt 保留原交付确定性和 terminal 记录用于审计，但不会由当前 runtime 恢复或重新派发。

补充：当 Structured 业务 Turn 已经 durable 收敛为 `failed + PROTOCOL_INVALID_MESSAGE`，GroupX 可以自动替换已污染的 Adapter 进程/session，并优先 resume/load 原 native session 供后续 Turn 使用。并发的人工与自动恢复必须 single-flight。这个动作只恢复会话承载，不是失败 Turn 的 retry；原 prompt 永不自动重放。

## D-017：配置驱动的 Agent 名册与 npm CLI 分发

决定：`agents` 配置从固定名册改为显式房间名册。键即 agent id(actor `agent:<id>`)，每个条目声明 `driver`(codex/grok/kimi/hermes 原生 CLI 家族)、可选显示名 `name`、`command`、`cwd`、`enabled`。内置 id 省略 `driver` 时默认同名；自定义 id 必须显式给出 driver。名册写谁启动谁；为兼容现有安装，缺省整个 `agents` 字段仍等价于原有 Codex/Grok/Kimi 三 Agent，不自动启用后来新增的 Hermes 与 Claude。同一 driver 可挂多个实例，各自持有独立长驻 session。

runtime 启动时把名册中的自定义/改名 agent upsert 进 actors 表，显示名由此流入 durable 事件与 Web UI;Web UI 的目标 chips、Agent 卡片、身份记忆下拉全部按 bootstrap 名册动态渲染，非内置 id 按 actor id 哈希分配固定调色板色调。

分发形态为 npm 公共 scoped包 `@susyimes/groupx`,`bin.groupx` 指向 `dist/src/cli.js`，提供 `start`(默认，自动打开浏览器，可 `--no-open`)、`stop`(按 D-031 优雅停止同配置路径 runtime)、`restart`(按 D-031 优雅重载同配置路径 runtime)、`doctor`(系统/Node/CLI 检测)、`init`(浏览器 Agent 引导并在保存后启动/进入群聊)、`update`(查询 npm latest 并更新当前全局安装，可 `--check`)子命令。`update` 先读取 Registry 的稳定精确版本，再把该版本固定传给 npm 全局安装；已最新或本地版本更高时不重装/降级。Windows 通过当前 Node 执行 `npm-cli.js`，macOS/Linux 使用同安装入口或 PATH 中可执行 npm，全程 `shell:false`。首次 `start` 未找到配置时先进入引导页；引导页允许重复添加同一 driver、编辑稳定 id/name/cwd/command，并只写 GroupX 配置。standalone 保存后由临时同源 launch 状态等待正式 runtime ready，再在当前页面自动跳转；运行中的 `/setup` 可编辑现有名册，保存后明确要求重启，不自动跳转且不在运行中热换 session。静态资源根从进程 cwd 改为按模块位置解析(`dist/web`)，使全局安装后可在任意目录启动。进程管理与命令解析的跨平台分支(win32 taskkill / posix 负 pid 进程树、PATH 查找)已内置于 supervisor 与 launch 层,macOS/Linux 行为通过依赖注入测试覆盖。

正式 runtime 的 HTTP loopback bind 必须先于 stale session recovery。端口冲突代表另一个 runtime 可能仍在运行；失败进程不得修改现有 Agent instance/session lineage。该顺序防止重复执行 `groupx start` 将活跃 binding 错标为 interrupted，并使新消息永久停在 queued。

原因：

- 用户需要给 Agent 起群内显示名，也需要同一 CLI 的多个分身实例；
- 固定三键 schema 把房间成员硬编码进了解析层，扩展必须改协议代码；
- 全局 CLI 是"安装后任意目录启动"的最小分发闭环；npm 裸名 `groupx` 已被占用，故用 owner scope。

变更条件：新增 driver 家族需要新 Adapter、命令解析、setup/UI 投影和该 driver 自己的 evidence Gate；多房间/远程分发仍属 Deferred。

## D-018：推理记录可回放但不进入上下文

决定：`turn.reasoning.delta` 保持 transient，不逐 token 写库。Broker 在 native Turn 生命周期内按顺序聚合推理文本，并在 terminal transaction 中最多插入一条 durable `turn.reasoning.recorded`；它先于成功 response 和 terminal event 取得 seq，因此页面刷新、SSE 重连和历史回放都能恢复推理记录。

隔离：`turn.reasoning.recorded` 只属于本地时间线与审计投影，不是 `message.created`、MemoryRecord、IdentityRecord 或 Summary。Context Packet、reply chain、Room Context Engine 压缩和自动记忆必须只消费明确的消息/记忆数据，绝不能读取推理记录正文。

原因：逐 token 持久化会放大 SQLite 与 SSE 压力，而完全 transient 会让已展示的推理在刷新后消失。每 Turn 一条终态聚合记录同时保留可恢复 UX、事务顺序和上下文隔离。

迁移与回滚：不新增表或列；旧 reader 将未知 durable event 当通用事件忽略。回滚只停止生成新记录，已存事件仍可安全读取，且不会因回滚进入上下文。

## D-019：工具进度可回放但不进入上下文

决定：live `tool.progress` 继续是 transient。Broker 在 Turn 内保留 Adapter 已经投影的 `tool.started/tool.completed` 更新，并在 terminal transaction 中按观察顺序写为 durable `tool.progress.recorded`。Web 对 live/durable 两种事件都使用 `turnId + toolCallId` 合并，同一次工具调用刷新后仍只显示为 Agent 回复气泡内的一条折叠记录。

隔离：工具记录不是聊天消息、回复链、MemoryRecord、IdentityRecord 或 Summary。Context Packet、Room Context Engine 压缩和自动记忆只读取明确的 `message.created`/记忆输入，不读取工具名称、参数、状态或详情。

原因：工具进度完全 transient 会在刷新后消失；直接把它拼进 reasoning 或最终回复会混淆数据类型并可能污染后续上下文。独立 durable event 保留 UI 与审计价值，同时维持语义隔离。

迁移与回滚：不新增表或列。旧 reader 可忽略未知 event type；回滚停止生成新记录即可，既有事件仍不会成为上下文输入。

## D-020：`groupx start` 是幂等的启动或复用

决定：loopback HTTP listener 继续是单 runtime 的原子租约，CLI 不新增第二套锁文件。正式 runtime 的 `GET /api/health` 返回 `service="groupx"`、`protocol="groupx.runtime/1"` 和 `runtimeKey`；key 由 canonical config 与 canonical config path 做 SHA-256，只用于判断重复启动是否指向同一配置，不是 secret 或认证机制。

CLI 在创建 Store、Adapter 和 native session 前先探测目标 origin：

1. service/protocol/key 全部相同：打印现有 URL、按 `--no-open` 决定是否打开页面，然后以成功状态退出；
2. GroupX key 不同、旧版/不兼容 GroupX 或其他 HTTP listener：明确提示冲突；
3. listener 不可达：正常尝试 `listen`；若发生 `EADDRINUSE`，最多有界复查三次以收敛并发启动竞态；
4. GroupX 永不自动杀掉占用进程，也不自动选择下一个端口，因为那可能创建两个 Broker 共用一份 SQLite 与 native session lineage。

回滚边界：移除 CLI 预检只会恢复原始 `EADDRINUSE` UX；健康响应新增字段是向后兼容的 JSON 扩展，不改变 REST 写合同、数据库 schema 或 Agent 协议。

## D-021：Agent 核心记忆与按日期记忆分层

决定：每个 Agent 的私有记忆拆成两个不能互相冒充的数据层：

- `core` 是少量、长期、显式维护的核心记忆。Structured Agent 通过绑定到自身的 `core_memory_remember` 工具主动写入；工具输入不接受 scope、subject、author 或 binding，Broker 一律从当前 session binding 固定为调用 Agent 自己。Web Agent 设置可以追加、替换和撤回同一 Agent 的 core；
- `dated` 是成功 Turn 的自动工作记录层；其生成频率和持久检查点由 D-023 取代原逐 Turn 方案。失败、取消、中断或终态不明的 Turn 不成为 dated source；
- dated 的日期来自 Broker 持久化的本地日期，不是模型提供的正文或参数。自动记录不读取 reasoning、tool、stderr、native payload、公共记忆或完整历史；
- Context Packet 分别投影 `[agent_core_memory]` 与 `[agent_dated_memory]`。core 在可选记忆区段中优先；dated 是有界每日语义 rollup，并受字符预算约束；
- 公共房间记忆继续使用 room scope，和两个 Agent 层完全分离。普通聊天不会自动成为公共或 core MemoryRecord。

持久化：schema v6 在 `memory_records` 增加仅对 `scope_type=agent` 有效的 `agent_memory_type=core|dated`。升级前已有 Agent 记忆保守迁移为 `core`；room/correlation 记录保持空值。supersede 必须保留原层，不能借替换把 dated 转成 core 或反向转换。

原因：核心记忆需要 Agent 主动筛选，自动日期记忆需要保留连续工作事实；混为一类会让自动摘要稀释长期偏好，也会让 Web/工具误把系统生成记录当成 Agent 明确承诺。terminal transaction 只登记来源，MemoryRecord 的批量生成边界见 D-023。

回滚边界：停止生成新 dated 或隐藏 core tool 不会破坏已有记录。回滚代码仍必须把未知 `agent_memory_type` fail-closed，不能把 dated 无条件当 core 注入；若降级到 schema v5，需要显式导出/重建数据库，不做破坏性原地降级。

## D-022：Hermes ACP driver

决定：Hermes 以独立 `hermes` driver 接入现有 Structured ACP kernel。GroupX 固定使用 `hermes --yolo acp`，校验 initialize 的 `agentInfo.name="hermes-agent"`，在每次 new/load 后设置 `dont_ask`，并把 session binding 作为 sender provenance。Hermes 可和其他 driver 一样创建多个独立房间实例。

Hermes 0.20.1 的 initialize 当前未声明 `mcpCapabilities.http`，但官方实现明确接受 ACP `session/new`/`session/load` 中的 HTTP MCP descriptor。这个兼容例外只存在于 Hermes Adapter：共享 ACP kernel 对其他 driver 仍严格要求 capability advertisement；能力报告保留 raw initialize 事实，并把描述符接收标为 `documented/probed`，不能冒充模型实际 `tools/call` 已 verified。

本次边界内已完成本机 `hermes acp --check`、ACP v1 initialize、session/new、`session/set_mode(dont_ask)` 和跨进程 session/load 的无模型 probe。Hermes native 模型回复、GroupX MCP 实调、取消中实际模型回合等仍需独立 live evidence 后才能写成 `verified`；现有 Codex/Grok/Kimi M0 矩阵不会自动替 Hermes 背书。

## D-023：日期记忆使用可恢复的每日批量 rollup

触发证据：逐 completed Turn 直接写一条 dated MemoryRecord 会把同一 `@all` 用户消息复制到每个 Agent，`memory.*` event 又复制整条正文；长期房间会产生大量低价值问候、确认和测试记录，并让 Context Packet 在 500 条候选中反复筛选原始回合片段。完整 transcript 已经是逐回合权威事实源，日期记忆应承担语义工作日志而不是第二份 transcript。

决定：

- terminal immediate transaction 仍只在 completed 时登记 source/response 外键、本地日期和字符计数；业务 response/terminal 不等待模型摘要，也不创建 dated MemoryRecord/event；
- 每个 `room + Agent + local date` 最多一条 active 自动 dated rollup。达到 8 个待处理成功 Turn、约 16K 原始字符、日期切换，或 Room Context Engine 即将压缩越过 source 时触发；普通阈值需等待最后活动后的 5 分钟；
- 使用该 dated 所属 Agent 的独立、短生命周期、无 MCP Structured session。其他 Agent 不 fallback 代写个人工作记忆；临时失败最多立即重试 3 次，随后持久记录退避时间并延后恢复；
- 输入只从登记过的当前 `message.created` 和最终 response 回读。输出最多 8K，只保留重要进展、决定、偏好、约束和未完成事项；无语义价值批次只推进 checkpoint，不创建记录；
- 同日更新把前一条 daily memory 作为输入，以 active memory id CAS/supersede。生成、版本替换、source processed 标记和 `memory.remembered|superseded` event 在一个 SQLite immediate transaction 提交；原 transcript 不删除。

对原始需求的影响：公共群组记忆、Agent 身份、透明转发和 Structured CLI 通信边界不变；Agent 私有日期记忆更少、更稳定。core 仍只能由所属 Agent 工具或 Web 显式维护，不能被自动 rollup 冒充。

迁移：schema v7 新增 `agent_dated_memory_rollups` 与 `agent_dated_memory_sources`。不回填升级前已完成 Turn，避免把旧 transcript 重复生成记忆；已有 `automatic_turn` dated 记录保持可读，之后的新记录使用 `source_kind=automatic_rollup`。v6 的 `agent_memory_type` 语义不变。

复杂度与回滚：新增一个后台定时/single-flight 引擎、两个只保存外键/检查点的表和一个 compaction 前 best-effort hook。关闭引擎即可停止新 rollup；pending source 与 transcript 都可保留，不影响聊天恢复。降级 schema 需导出/重建，不做破坏性原地删除。

完成标准：存储测试证明 completed 只登记来源、失败 Turn 不登记、同日 CAS/空批次/崩溃重开幂等；引擎测试证明 8 Turn/16K/日期/压缩触发、5 分钟 debounce、owner-only、8K 上限和失败重试；Context Packet 与 compactor 测试继续证明 reasoning/tool 不进入任何自动记忆。

## D-024：Claude Code stream-json driver

触发证据：Claude Code CLI 没有 ACP 子命令。它的第一方结构化 stdio 面是 `--print --input-format stream-json --output-format stream-json`，一条 JSONL 消息流而不是 JSON-RPC。社区存在 ACP 桥（`@zed-industries/claude-code-acp`），复用现有 ACP kernel 只需约 40 行；但那是厂商之外的协议 shim，会让 Claude 成为唯一一个不走自己原生协议入口的 driver，并把 GroupX 的访问契约押在第三方包的版本上。

决定：Claude Code 以独立 `claude` driver 和独立 Adapter 家族（`src/adapters/claude/`）接入 Structured transport，直接架在通用 JSONL 进程层 `supervisor/jsonline-process.ts` 之上，不复用 `adapters/jsonline-rpc.ts`。protocol 串为 `claude-cli-stream-json-v1`。固定产品 argv 为 `--print --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-mode bypassPermissions`，MCP 绑定追加 `--mcp-config`，会话追加 `--session-id <uuid>` 或 `--resume <uuid>`。native session id 由 GroupX 自己指派，不向 native 协商。

握手（本次接入的核心协议差异）：Claude Code 的 `system`/`init` 帧只在收到第一条 user 消息之后才发出，因此它不能充当握手。若 `start()` 等待该帧，会在没有任何模型回合的情况下永久挂起——这一点由实机 probe 直接观测确认（写入 stdin 后 35ms 才出现 init）。GroupX 改用 SDK 控制协议：`control_request`/`initialize` 证明进程存活并投影 `current_permission_mode`（观测值，部分 CLI 会回显用户 settings 默认模式，即使 argv 已要求 `bypassPermissions`），再用 `control_request`/`set_permission_mode` **建立** `bypassPermissions`。只有 set 被拒绝或降级才判 `NATIVE_POLICY_BLOCKED`；initialize 缺字段仍是 `PROTOCOL_INVALID_MESSAGE`。每次 start/resume 都重申 set，不因 initialize 已是目标模式而跳过。这是 Codex `configRequirements/read` 与 Kimi/Hermes `session/set_mode` 在 Claude 上的对应物。延后到首个 Turn 才到达的 `init` 帧仍要校验 `session_id`、`cwd` 与 `permissionMode`，不匹配则判该 Turn 失败。

`initialize` 响应同时携带 account、organization、model、command、plugin 清单。Adapter 只投影 `current_permission_mode` 与 `pid`，其余字段不进入任何 GroupX 记录或诊断（不变量 11）。取消走 `control_request`/`interrupt`，终态是 `result` 帧且中止原因有两个：流式输出中取消为 `aborted_streaming`，工具执行中取消为 `aborted_tools`（后者才是长 Turn 里最常见的取消点），两者都归一化为 `turn.cancelled`。实机确认取消后同一 stdio 进程仍可继续下一个 Turn，因此取消不污染 session。若 interrupt 输给了正在收敛的 Turn，CLI 仍会为该 interrupt 补发一个 `result`；Adapter 在 cancel 窗口内吸收这一帧，避免它终结下一个 Turn。注意 `result.num_turns` 是单次 prompt 内部的 agent 迭代计数而非会话级单调计数器，不能用来做跨 Turn 关联。

交互类 control request 一律在协议边界拒绝并以 `UNEXPECTED_NATIVE_INTERACTION` 失败当前 Turn：实测 CLI 的交互 subtype 为 `can_use_tool`、`elicitation` 与 `request_user_dialog`；`hook_callback`、`mcp_message`、`host_auth_token_refresh`、`oauth_token_refresh` 不是决策请求，只回协议错误而不失败 Turn。GroupX 仍然没有审批子系统。

本次边界内已完成实机 native-live 证据（Claude Code 2.1.233 / win32）：基础回合、流式增量、GroupX MCP `memory_search` 经 http binding 精确实调一次、runtime 重启后 `--resume` 会话恢复、干净关停、无残留进程、用户 settings 未被改写。证据独立存放于 `.groupx/evidence/claude-live/`，沿用 Hermes 先例，不进入 Codex/Grok/Kimi 三 Agent 的核心 M0 gate。已知并记录：Claude Code 会在任何调用下重写自己的 `~/.claude.json` 会话状态文件，这是原生 CLI 行为而非 GroupX 写入，因此该文件只作诊断记录、不作 gate。

回滚边界：`claude` 是加法接入。移除它只需从名册删条目；缺省 `agents` 字段本就不自动启用它，现有 Codex/Grok/Kimi/Hermes 房间不受影响。

完成标准：Adapter 测试覆盖固定 argv、无模型控制握手（initialize 观测 / set 建立，含 initialize 报 default 而 set 升级成功）、策略拒绝与降级、延后 init 帧的 session/cwd 校验、流式增量与完整消息去重、工具起止、取消与取消超时、首事件与空闲超时、畸形帧、进程中途退出、握手前退出的 stderr、`--resume` 重启，以及 `initialize` 载荷的字段投影边界。命令解析覆盖 Windows PATH（不依赖 APPDATA）、`%USERPROFILE%\\.local\\bin\\claude.exe`、npm 回退、拒绝 `.cmd` shim，以及 POSIX `~/.local/bin/claude`、当前 Node 前缀 / Homebrew / `/usr/local` 的 npm 回退。

## D-025：ask 超时不加回送机制，harness 只以有界文本指导模型闭环

触发证据：2026-08-17 一次真实审 PR 会话（用户库 `corr_9dd9b038d2c5462084fe781cfa7faeb0`）中，Claude 以默认 120s `ask` 询问 Codex，子 Turn 实际运行 11.3 分钟；超时后 Claude 读取一次即收工，Codex 终稿以 `to=[]` 落房，提问方永远不会再被唤醒，双方在未真正对齐的状态下完成了 PR 修改。逐层核对确认：ask 超时后没有任何回送路径；MCP instructions/工具描述完全没有说明「收工回复不唤醒任何人」「超时后目标仍在运行」等语义；`timeoutMs` 上限 600s 连想等也等不了。

决定：不引入 Broker 回送/续跑 Turn、兄弟终稿门禁或任何新派发来源，保持不变量 7（只有显式工具调用或用户路由派发 Turn）不变。harness 只做四处最小干预：

1. MCP server instructions 与 `send/ask/read` 工具描述写明唤醒、超时与上下文冻结语义；
2. `ask` 超时的目标结果附带有界 `note` 指导文本（合同新增可选字段，向后兼容）；
3. Context Packet `[groupx_protocol]` 头部固定一行路由提醒，覆盖所有 driver 的每一轮；
4. `ask` 的 `timeoutMs` 调用上限从 600,000 提升到 3,600,000 ms（与 `timeouts.askMs` 配置上界一致），默认值不变，等多久由调用模型自行决定。

对原始需求的影响：交付闭环依赖模型智能与用户在房间内的最终兜底，符合透明 Broker 定位（R3/R5/R7 不变）；不新增状态机、存储表或审批语义。

协议/存储迁移：无存储迁移。`AskResult.note` 为新增可选字段，属向后兼容；PROTOCOL.md §6.2 同步更新。

复杂度与回滚：全部改动为文本与两个合同常量/字段；回滚即恢复原文案与上限，不影响任何已持久化数据。

完成标准：工具描述与 instructions 含关键语义断言；ask 超时结果携带含 correlationId 的 note；Context Packet 头部含固定提醒行；`timeoutMs` 边界测试更新。若真实运行证明纯文本引导不足，再以新证据评估最小回送机制，且必须同步修订不变量 7。

## D-026：放宽消息 wire 上限、运行超时与互调链路默认值

触发证据：真实多 Agent 审查负载的审计发现三类对模型能力的硬约束：(a) Agent 经 `send/ask` 互发内容被固定 wire 上限 32,768 字符卡死，而收工回复本身不限长，长报告无法显式交接；(b) `idleMs=120s`/`firstEventMs=90s` 会误杀长静默工具执行与大上下文冷启动；(c) `hopCount 12 / actorCallsPerRoot 8 / rootTurns 24` 截断较长的多 Agent 协作链。上下文预算族维持 256,000/75%/8,000/120,000/12 不变（评估过 512k 方案后按用户决定还原）。

决定：

1. **消息 wire 上限**：`MAX_MESSAGE_CONTENT_LENGTH` 32,768 → **131,072** 字符，统一作用于 REST/MCP 消息、记忆与身份内容 schema。`limits.messageCharacters` 仍是固定 wire bound 的运行时快照（literal 131,072），schema 兼容解析旧 literal 32,768 并由加载器升级。连动：REST 默认 body 上限 256 KiB → **2 MiB**；`limits.sseBytes` 默认 524,288 → **2,097,152**，保证单条 durable 事件帧永远能装进 SSE 发送缓冲，避免超长消息触发重连死循环。
2. **运行超时默认**：`timeouts.firstEventMs` 90,000 → **180,000**；`timeouts.idleMs` 120,000 → **300,000**（含 Codex/Claude Adapter 回退常量）。idle 计时仍由任意原生事件重置，语义不变。
3. **互调链路默认**：`limits.hopCount` 12 → **24**、`limits.actorCallsPerRoot` 8 → **16**、`limits.rootTurns` 24 → **48**。仍是防失控回路的有界安全绳，触顶行为（公开 `routing.loop_stopped`/`turn.failed`）不变。
4. **迁移**：沿用 48k 上下文预算先例，`upgradeLegacyGeneratedDefaults` 只把恰好等于历史自动生成默认值的字段升级为当前默认（32,768→131,072、24→48、12→24、8→16、524,288→2,097,152、90,000→180,000、120,000→300,000、48,000→256,000），其他显式自定义值不动；`loadConfig` 与 setup 快照共用同一函数。

对原始需求的影响：R3/R5 不变——链路限制仍是可靠性边界而非权限；R7 的本地开销仍受有界队列与限额保护。更长消息与更长静默由用户模型自行决定是否利用，GroupX 不新增内容判断。

协议/存储迁移：无 schema 变化；错误码与状态机不变。SQLite 摘要 32,768 硬上限与消息内容无关，保持不变。

复杂度与回滚：常量/默认值与一个共享迁移函数；回滚即恢复旧常量，已升级的配置文件可手动改回。

完成标准：wire 边界测试随常量收敛（接受 131,072、拒绝 131,073）；旧 literal 32,768 配置可解析并升级；全部迁移字段的精确值升级与自定义保留测试通过；超时/链路新默认断言更新。

## D-027：同步监督是房间协作配对

触发：产品需要 worker 执行、supervisor 同步观察、并可打断整轮后写入公开指导。参考评测循环里的观察词汇可以借用；治理流水线、claim firewall、双否决门和 native 工具审批不能移植。

决定：

1. **第三条路由是配对，不是自然语言**。成员 MCP `send`/`ask` 的可选 `supervision: { observers, mode: "live_steer" }` 在同一 `rootCorrelationId` 下并行创建 worker Turn 与 `supervision.watch` Turn。`POST /api/messages` 与 `local-operator` 的 `send` / `worker_dispatch` / `worker_ask` / `dispatch_event` 也可带同一字段。Web composer 仍选择 worker（`@all` 或芯片），但不再提供监督开关或观察者芯片。Observer 不复用用户正文当执行提示。角色只写在本次配对行，不进入 Agent 名册枚举。`sourceKind: "supervision"` 由 Broker 写入；请求方不能自报监督者。调用方不能把自己放进 observers。无群气泡时，pair 的任务引用是 `operator.dispatch` event id。助理自己不当 observer，也没有 `watch`/`steer`。
2. **同步 = 并行 running + 有界里程碑**。`groupx.watch` 只在 Watch Turn 成功；等待 `next_milestone | terminal`，快照只含 status、deliveryCertainty、任务引用、公开消息摘要、工具名+status+toolCallId、steer 计数。不转发 token，不带推理正文或完整工具参数。
3. **打断 = 整段 Turn cancel + 新 Worker Turn**。`steer(interrupt)` 复用现有 cancel 对账，再以 supervisor 公开指导为 `current_message` 入队；`nudge` 不打断，只在当前 worker 自然结束后 FIFO 入队。不能取消 Turn 内部某一次 native 工具。已 `delivered`/`unknown` 的原 prompt 不重放（D-016）。
4. **steer ≠ approval**。不产生 `approval.*`，不出现允许/拒绝按钮，不改变 unrestricted argv/mode，不代答 `requestUserInput`。Watch Turn 对正在被观察的 worker 再 `ask`/`send` 返回 `SUPERVISION_STEER_REQUIRED`。
5. **观察是第四类可见数据**。`supervision.paired|observed|steered` 可回放，但不进入公共记忆、core/dated memory 或房间压缩输入。Watch brief 不进 Context Packet 的 unread transcript。Observer Turn 不登记 dated-memory source。Worker 的业务包不自动塞进监督评语。
6. **可靠性沿用 D-011**。Watch/steer 仍走 parent/root/hop/queue；另计 `steersPerSubjectTurn`（默认 3）。触顶可见失败。Broker 不在 steer 后自动再开监督循环第 N 轮。

对原始需求的影响：R2 增加一条显式协作路由，不改变「自然语言不派发」。R3 不变——监督不是安全或审批层。R4 增加独立观察数据类，不与记忆层合并。R5 不把 memsuOS 治理内核搬进 Broker。

协议/存储迁移：schema v8 增加 `supervision_pairs` / `supervision_pair_turns` / `supervision_steer_counts`；Envelope `sourceKind` 增加 `supervision`。schema v9 允许配对任务引用 `operator.dispatch`。

复杂度与回滚：配对只在 `send`/`ask`/operator/`POST /api/messages` 显式带 `supervision` 时创建。回滚可停用该字段与 watch/steer 工具面并停止写配对表，历史事件保留审计。

完成标准：fixture 证明并行观察、里程碑有界、interrupt 改道、steer 上限、自报角色无效、观察包不进记忆/压缩、不产生 `approval.*`、不改 unrestricted argv。不把「真实模型抓到了漂移」写成发布 Gate。操作员派活带 `supervision` 时复用同一 pair 合同，不新开审批面。

## D-028：房间助理是操作员客户端

触发：用户需要一个平级助手来控场和派活，但不能把它做成 Host Agent、第二房间或 Broker 内置模型。自然语言「清一下历史」不能直接触发房间命令。

决定：

1. **助理是 `user:assistant`，不是 `agent:assistant`**。binding 协议是 `local-operator`（`instance:operator` / `binding:operator`）。它与 `user:web` 平级，不进 `agents` 名册，不被 `@all` 唤醒，不吃 Context Packet，也不走成员当前回合 MCP。
2. **用户直连助理**。侧边对话走 `/api/assistant*`，不经 Broker composer，不先落房间 `message.created`，不创建 Agent Turn。默认提示词是产品常量，每次注入；`extraInstructions` 只能追加，不能绕过禁止项。
3. **控场默默做，派活留下有界来源**。cancel / compact / reset / restart / memory / setup 直接打 Broker，时间线没有助理发言。默认派活是 `worker_dispatch` / `worker_ask`：创建 Turn，写 durable `operator.dispatch`（可重放、可进目标 Context Packet、计入房间 usage/compact），不先造群聊气泡。禁止 prompt 只活在内存里。`send` 仅在用户明确要求发到群里时使用，作者不能伪造成 `user:web`。助理写入的 memory/identity 记录 `sourceKind` 是 `operator`，必须能经 REST/MCP 合同回读。`context.reset` 是后续上下文下限：压缩不得把 reset 前的 transcript 或检查点滚进新摘要；仅有 reset 审计事件、没有新的房间上下文时再次 reset 为 no-op。
4. **监督可启动，但不能自己观察**。派活或 `send` 可带与 Web 相同的 `supervision`。助理没有 `watch`/`steer`，也不能把自己放进 observers。
5. **配置在顶层 `assistant`**。禁止 `agents.assistant` 和保留 id `__assistant__`。首次引导默认启用；旧配置缺省该项时保持未启用。至少仍要有一个启用的房间 Agent。
6. **成员 MCP 面负责定向与监督**。`/mcp` 仍要求当前 Turn；`send`/`ask` 可带 `supervision`，watch/steer 仍只在 Watch Turn。`/mcp/operator` 是独立入口，不要求 Agent Turn。
7. **操作员 read 是有界公开投影**。默认 20 条，只回公开语义事件并摘录正文；推理与工具进度全文不进助理脑。成员 `groupx.read` 不变。协议行被撑爆后，私有脑可重启一次接上，不把该失败当成审批或改走 Direct。

对原始需求的影响：R1 增加一个用户表面入口，不把助理做成房间成员。R2 不变——自然语言仍不派发。R3 不变——助理不是安全或审批层。R5 增加独立 operator 客户端，不把 LLM 放进 Broker 内核。

协议/存储迁移：schema v9 增加 `assistant_conversation_messages` 与 `context_resets`；Envelope 增加 `operator.dispatch` / `context.reset`；`sourceKind` 增加 `operator`；预置 actor `user:assistant`。

复杂度与回滚：未启用助理时房间行为与 v0.1.14 相同。回滚可停 `/api/assistant` 与 `/mcp/operator`，历史 `operator.dispatch` 和侧边对话行保留审计。

完成标准：schema `documented`；无模型 fixture `probed`；用户→助理不经 `POST /api/messages`；派活可无群气泡但有可重放 `operator.dispatch`；作者是 `user:assistant`；`from`/`actor`/`provenance` 与 dated 写入失败；真实 operator `tools/call` 才 `verified`。

## D-029：无 schema 的协作闭环

更新：本决定第 5 项及旧的“单协调者两轮”完成标准已由 D-030 替代。第 1–4、6 项以及无 schema 的 publish/pending/collect/reply-chain 实现继续有效。

触发证据：2026-08-19 对 Clue Codec 三方评审真实 correlation 的审计显示，最终结论正确，但协作机制产生 28 个 Turns。14 条定向 Agent 消息中有 8 条没有 `replyToEventId`；一次 ask 和随后一次 read 各等待约 300 秒后失败，而同一语义已被 active root Turns 从房间读取并回答；最后又出现 12 条滞后的 Codex response。审计同时确认每 Agent FIFO、parent/root/hop 和 sender provenance 正常，问题集中在「公开进度也会唤醒」「busy lane 上同步等待」「ask 后重复派发」与「回复链默认缺失」，无需重做队列或数据模型。

本决定以该新证据取代 D-025 对成员 ask 超时返回、跟进方式和 3,600,000 ms 上限的选择；D-025 仍保留为当时的历史决策与证据记录。

决定：

1. **公开与唤醒拆开**。新增成员 MCP `publish`：经 Broker 幂等写 durable `message.created`，固定 `targets=[]`，不创建 Turn、不触发 Adapter。公开进度、阶段结论和协调者 checkpoint 使用 publish；send/ask 只用于确实需要目标 Agent 新行动的场景。
2. **ask 先暴露队列，再有界等待**。send 返回 `queuePosition/activeTurnId`。ask 新 child Turn 前方已有非 terminal 工作时立即返回 `state=pending`；否则最多等待 60 秒。未完成结果是 pending，不再把“停止等待”冒充目标 timeout 终态。
3. **pending 只续收，不重放**。新增 `collect(messageEventId)`，只按已有 `turns.source_event_id` 收集原 ask 的 exact child Turns；collect 不写命令、消息或 Turn。pending note 和工具说明要求调用方 collect，不得 resend/re-ask 同一问题。仍不增加自动回送或 Broker 自发 Turn，保持不变量 7。
4. **默认形成回复链**。成员 send/ask/publish 未显式给 `replyToEventId` 时，Broker API 使用当前 active Turn 的 `sourceEventId`。actor、causation、root/hop 仍由 binding/lifecycle 决定，模型不能自报来源。
5. **历史协作提示（已由 D-030 替代）**。本阶段最初把评审提示固定为单协调者 fan-out/collect/汇总，并限制 reviewer 互审。后续同场景核查证明该规则把可靠性优化误写成了讨论拓扑，现不再属于有效产品合同。
6. **不兼容旧 Agent 工具合同**。ask result 改为显式 `state`，每目标带 `turnId/queuePosition`，未完成状态改为 `pending`，MCP wait 上限改为 60 秒。运行中的旧 native session 需要随 runtime 重启重新发现工具；不为旧 descriptor/result 维持双协议。

对原始需求的影响：R1 的公共 transcript 保持完整但进度不再制造 Turn；R2 获得明确的发起、公开、续收三种语义；R3 的 unrestricted/无审批边界不变；R4 不新增记忆数据类；R5 复用 Broker、Envelope 和现有表；R6 sender 仍由 binding 决定；R7 减少长等待和重复 lane 工作。

协议/存储迁移：无 schema migration。`mcp.publish` 使用现有 `client_commands/events`；collect 使用现有 `turns.source_event_id`；queue metadata 从既有 `target_actor_id/enqueue_seq/status` 计算。历史事件和 Turn 原样可读。只有 MCP wire/tool instructions 是有意的破坏性升级。

复杂度与回滚：新增两个成员工具、一个 exact-source wait filter、一个 queue snapshot 和 active lifecycle 的 `sourceEventId`。不增加表、后台 scheduler、回送队列、`subsumed` 状态或 exactly-once 协调器。回滚可移除 publish/collect 和新结果字段；已写 publish event 仍是合法 `message.created`，无需数据清理。

完成标准（已由 D-030 修订）：聚焦合同/Store/Broker/MCP/Context tests 通过，类型检查与构建通过；同场景语义重放的快照、任务和评估口径以 D-030 为准。Turn 数不再作为优化目标。

## D-030：协作工具拓扑中立，Agent 自主组织讨论

触发证据：对同一 Clue Codec 任务的两次真实 correlation 复核发现，28→5 Turns 的算术成立，但两次任务并不等价。原场景从整份原始方案出发，三个 Agent 自行发起交叉质疑、修正和最终收敛；用户只指定 Codex 最后记录结论，没有指定协调者。后一次重放改成只读复核已生成的第 18 节，并在提示中加入“唯一协调者、不要互相讨论、固定两轮”，实际验证的是 ask/pending/collect 的机械链路，而不是原场景的自主讨论衔接。Turn 下降因此不能作为讨论质量改善的证据。

决定：

1. **Broker 提供协作工具，不规定协作拓扑**。GroupX 不指定唯一协调者、最终记录者、互评方向或讨论轮数，也不禁止 Agent 经 Broker 直接质疑、修正、委托或形成临时协调方式。用户可以在具体任务中指定最终记录者；“最终记录”不自动等于“负责调度”。
2. **工具提示只解释可观察效果**。final/publish 对房间可见但不唤醒；send/ask 创建目标 Turn；collect 只续收原 ask；read 补读冻结上下文之后的公共状态；replyTo 连接所回应的具体消息。Agent 根据任务自行组合这些能力。
3. **去重规则只约束同一请求**。pending ask 的同一逻辑请求使用 exact `messageEventId` collect，避免重复 Turn。实质不同的追问、反驳或新发现可以新建 send/ask；GroupX 不做语义去重，也不把“不要重发”扩大成“不要继续讨论”。
4. **运行中的同根讨论不排延迟回合**。send/ask 即使面对同一 correlation 中已有 running Turn 的目标，也会创建一个排队的独立后续 Turn；publish 则只公开消息。因此模型应先 read 状态，并用 publish/read 在各自当前 Turn 中交换进行中的质疑与回应；只有有意要求后续独立行动时才 send/ask。这是工具效果说明，不限制谁质疑谁、讨论顺序或轮数。
5. **显式触发边界不变**。公共消息和自然语言 `@name` 不自动唤醒 idle Agent；GroupX 不增加后台调度器、自动回送、共识状态机或隐式自治循环。运行中的参与者主动 read，idle 目标需要新行动时仍由 Agent 或用户显式 send/ask。
6. **同场景重放按语义而非 Turn 数验收**。测试必须使用相同源内容初始快照和相同任务语义，最好在隔离副本上运行。至少 80% 的重要观点需要得到另一 Agent 有理由的明确回应；关键分歧必须解决或显式保留；同时不得出现 pending 重发、过期回复错接和重复 Turn。总 Turn 数仅作诊断记录，不能作为减少目标。若原始快照无法恢复，只能标为近似复现，不能声称同场景重放。

对原始需求的影响：R1/R2 更贴近透明群聊——公开可见与显式唤醒仍分离，但讨论角色和路径交还模型智能；R3 的 unrestricted/无审批边界不变；R4 不新增记忆或共识数据类；R5 继续复用 Broker、Envelope 和现有表；R6 sender 仍由 binding 决定；R7 保留 exact collect、队列可见性、因果循环和资源上限，只删除过度的语义工作流限制。

协议/存储迁移：无 schema migration。只修订 MCP instructions、工具 description、pending note、Context Packet 路由提醒和验收文档。历史事件、Turn、publish 和 collect 结果原样可读；wire schema 与错误码不变。

复杂度与回滚：不增加表、状态、scheduler、语义去重器或自动 Agent。第一次同快照试跑证明，只写“拓扑中立”仍不足：三个 root Turn 已在 publish/read 中完成交叉回应并收敛，但早先互发的 targeted send 留下 14 个排队 child Turns，会在收敛后延迟重放。当前修订只把这个现有队列语义明确告诉模型；回滚会重新引入讨论拓扑偏置或延迟重复，因此不建议。

完成标准：聚焦 MCP/Context/pending note tests、类型检查与构建通过；相同快照与任务的真实三方重放达到上述 80% 语义标准，且无新增机械回归。模型是否每次选择同一讨论方式不是发布 Gate。

## D-031：`groupx stop` / `groupx restart` 以配置路径作用域优雅控制 runtime

触发证据：运行中从 Agent 设置保存新成员后，旧 runtime 有意不热换 Adapter/session，新成员只显示 `pending_restart`。但 `groupx start` 的幂等合同会复用完全相同的 runtime；配置内容已变化时又会按不同 `runtimeKey` 报冲突。用户只能回到拥有旧前台进程的终端按 `Ctrl+C`，既缺少从任意终端完成“关闭旧实例并加载最新名册”的产品命令，也缺少只优雅停止当前 runtime 的独立命令。

决定：

1. **新增显式 CLI 命令**。`groupx stop [--config <path>]` 与 `groupx restart [--config <path>] [--no-open]` 只处理已经在当前配置 `server.port` 上运行的正式 GroupX。实例本来未运行时 fail-closed；`restart` 提示启动应使用 `groupx start`，不会把它偷换成可能制造第二个 Store writer 的 start。`stop` 在完整关闭后结束，不创建替代 runtime。
2. **配置内容与配置路径分开相关**。现有 `runtimeKey` 继续由 canonical config + canonical config path 生成，服务 `start` 的精确复用；新增非秘密 `runtimeScopeKey` 只由 canonical config path 生成，使 Agent 名册保存后仍能确认旧、新 runtime 属于同一配置文件。它是 correlation handle，不是 credential、认证或第二套锁。
3. **只控制同作用域 runtime**。CLI 只有在 runtimeKey 完全相同，或旧 health 的 runtimeScopeKey 与当前 canonical path 相同时，才调用 `POST /api/runtime/shutdown`。另一配置文件、旧版/不兼容 GroupX、外部 listener 与 scope mismatch 均 fail-closed。若 `server.port` 同时改变，当前 origin 无法发现旧实例，必须先手动停止旧端口；不扫描端口或进程。
4. **listener 是完整关闭租约**。shutdown 的 202 响应完成后，HTTP 先进入 draining，关闭 SSE、拒绝新工作并等待已开始的 REST 请求，但不释放端口；随后有界关闭房间助理、MCP、Broker、Agent session、publisher/SSE 和 Store，最后才关闭 listener。CLI 需要连续观察不可达，避免一次连接抖动被当作退出；`stop` 此时完成，只有 `restart` 执行既有 start 竞态流程。
5. **不扩大恢复权限**。重载后的新进程仍走 D-016 与存储 5.1-5.3 的恢复：queued/明确未交付可恢复，已交付或不确定 Turn 不自动重放；Structured session resume/load 只服务后续 Turn。restart 不是当前 Turn retry。

对原始需求的影响：R1 的动态名册获得可操作的停止/加载闭环；R3 的 unrestricted 与无审批边界不变，runtimeScopeKey 也不构成安全机制；R4 的 transcript/记忆继续由同一 SQLite 事实源恢复；R5 只增加窄 CLI 命令并复用既有 loopback 生命周期面，不引入 daemon manager 或锁服务；R6 sender binding 在 restart 后按稳定 actor 重建；R7 以先完整关闭再启动避免双 Broker、双 session 与双 Store writer。

协议/存储迁移：`groupx.runtime/1` health 增加可选兼容字段 `runtimeScopeKey`，并增加严格的 `POST /api/runtime/shutdown` 请求/202 响应；draining health 为 503 + identity。没有 SQLite schema、event、`client_commands`、PID/lock 文件或配置迁移。运行中的旧版本没有端点时要求手动停止一次。

复杂度与回滚：增加一个路径 hash、一个受 scope 校验的 loopback handler、HTTP draining 阶段和 CLI 有界轮询；`stop` 与 `restart` 共用该路径。回滚可移除 stop/restart 命令与端点；已发布 health 的附加字段可被旧 reader 忽略，数据库无清理工作。不能回滚为按端口强杀、按 PID 当稳定身份或在旧 Store writer 退出前启动替代进程。

完成标准：单元测试覆盖同 path 配置变化、不同 path/占用者拒绝、旧端点缺失、连续不可达与关闭超时；HTTP 测试覆盖严格 scope 和 draining health；runtime integration 用被阻塞的 Adapter close 证明 listener 在 session 完整关闭前仍绑定；类型检查、全量测试和构建通过。

## 决策变更规则

任何 Accepted 决策变更必须同时提供：

1. 触发它的真实证据；
2. 对用户五项原始需求的影响；
3. 协议/存储迁移方案；
4. 新增复杂度和回滚边界；
5. 更新后的测试与完成标准。
