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

分发形态为 npm 公共 scoped包 `@susyimes/groupx`,`bin.groupx` 指向 `dist/src/cli.js`，提供 `start`(默认，自动打开浏览器，可 `--no-open`)、`doctor`(系统/Node/CLI 检测)、`init`(浏览器 Agent 引导并在保存后启动/进入群聊)、`update`(查询 npm latest 并更新当前全局安装，可 `--check`)子命令。`update` 先读取 Registry 的稳定精确版本，再把该版本固定传给 npm 全局安装；已最新或本地版本更高时不重装/降级。Windows 通过当前 Node 执行 `npm-cli.js`，macOS/Linux 使用同安装入口或 PATH 中可执行 npm，全程 `shell:false`。首次 `start` 未找到配置时先进入引导页；引导页允许重复添加同一 driver、编辑稳定 id/name/cwd/command，并只写 GroupX 配置。standalone 保存后由临时同源 launch 状态等待正式 runtime ready，再在当前页面自动跳转；运行中的 `/setup` 可编辑现有名册，保存后明确要求重启，不自动跳转且不在运行中热换 session。静态资源根从进程 cwd 改为按模块位置解析(`dist/web`)，使全局安装后可在任意目录启动。进程管理与命令解析的跨平台分支(win32 taskkill / posix 负 pid 进程树、PATH 查找)已内置于 supervisor 与 launch 层,macOS/Linux 行为通过依赖注入测试覆盖。

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

1. **第三条路由是配对，不是自然语言**。`POST /api/messages` 的可选 `supervision: { observers, mode: "live_steer" }` 在同一 `rootCorrelationId` 下并行创建 worker Turn 与 `supervision.watch` Turn。Observer 不复用用户正文当执行提示。角色只写在本次配对行，不进入 Agent 名册枚举。`sourceKind: "supervision"` 由 Broker 写入；请求方不能自报监督者。
2. **同步 = 并行 running + 有界里程碑**。`groupx.watch` 只在 Watch Turn 成功；等待 `next_milestone | terminal`，快照只含 status、deliveryCertainty、任务引用、公开消息摘要、工具名+status+toolCallId、steer 计数。不转发 token，不带推理正文或完整工具参数。
3. **打断 = 整段 Turn cancel + 新 Worker Turn**。`steer(interrupt)` 复用现有 cancel 对账，再以 supervisor 公开指导为 `current_message` 入队；`nudge` 不打断，只在当前 worker 自然结束后 FIFO 入队。不能取消 Turn 内部某一次 native 工具。已 `delivered`/`unknown` 的原 prompt 不重放（D-016）。
4. **steer ≠ approval**。不产生 `approval.*`，不出现允许/拒绝按钮，不改变 unrestricted argv/mode，不代答 `requestUserInput`。Watch Turn 对正在被观察的 worker 再 `ask`/`send` 返回 `SUPERVISION_STEER_REQUIRED`。
5. **观察是第四类可见数据**。`supervision.paired|observed|steered` 可回放，但不进入公共记忆、core/dated memory 或房间压缩输入。Watch brief 不进 Context Packet 的 unread transcript。Observer Turn 不登记 dated-memory source。Worker 的业务包不自动塞进监督评语。
6. **可靠性沿用 D-011**。Watch/steer 仍走 parent/root/hop/queue；另计 `steersPerSubjectTurn`（默认 3）。触顶可见失败。Broker 不在 steer 后自动再开监督循环第 N 轮。

对原始需求的影响：R2 增加一条显式协作路由，不改变「自然语言不派发」。R3 不变——监督不是安全或审批层。R4 增加独立观察数据类，不与记忆层合并。R5 不把 memsuOS 治理内核搬进 Broker。

协议/存储迁移：schema v8 增加 `supervision_pairs` / `supervision_pair_turns` / `supervision_steer_counts`；Envelope `sourceKind` 增加 `supervision`。

复杂度与回滚：配对只在用户显式带 `supervision` 时创建；关闭开关即回到原两条路由。回滚可停用 watch/steer 工具面并停止写配对表，历史事件保留审计。

完成标准：fixture 证明并行观察、里程碑有界、interrupt 改道、steer 上限、自报角色无效、观察包不进记忆/压缩、不产生 `approval.*`、不改 unrestricted argv。不把「真实模型抓到了漂移」写成发布 Gate。

## 决策变更规则

任何 Accepted 决策变更必须同时提供：

1. 触发它的真实证据；
2. 对用户五项原始需求的影响；
3. 协议/存储迁移方案；
4. 新增复杂度和回滚边界；
5. 更新后的测试与完成标准。
