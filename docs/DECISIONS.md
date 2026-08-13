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

## D-001：透明 Broker

决定：所有 UI/CLI 消息通过一个本地 Broker。

原因：

- 三套 CLI 没有统一 peer server；
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

默认值为 `structured`，首版同一次 Broker 运行对三个 Agent 使用同一选择：

- `structured`：Codex 使用 App Server，Grok/Kimi 使用 ACP，维持长驻 session，支持原生事件、语义化取消、resume/load 和 GroupX MCP；
- `direct`：deprecated compatibility vocabulary。既有 one-shot/resume 源码和历史数据库记录保持可读；配置解析、Adapter factory 与 runtime constructor 均 fail-closed，不启动 Direct；不再新增能力、不维护 live Gate、不参与 release，也不作为 Structured 失败后的 fallback；
- 两者共用同一个 Broker、Envelope、sender provenance、Turn、记忆和 SSE 合同；
- 选择是显式的。任何启动、握手、执行或能力失败都在所选 transport 内收敛，不自动切换到另一 transport。

原因：产品目标已经收敛到 Codex App Server + Grok/Kimi ACP。保留 Direct enum/实现可避免破坏旧数据和已有调用方，但继续把它当 active 产品会重复维护 argv、wire、Gate 和能力说明。

M0 只维护 Structured active release baseline。Direct baseline、Agent 与适用 case 固定为 `DEPRECATED`；已有 Direct live/fixture evidence 仅作历史事实，`canSatisfyCurrentGate=false`。

## D-004：A2A 边缘化

决定：GroupX 内部不采用完整 A2A Task 模型。内部 Envelope 保留可映射字段，M3 以 Adapter 暴露/接入 A2A。

原因：本机固定三 Agent 不需要 discovery、远程认证和完整 Task/Artifact 生命周期；TendrilFlow 的当前 A2A 实现也采用外部适配到内部房间的边界。

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

Codex 0.147 的 thread-level `sandbox` 是 kebab-case 字符串 `danger-full-access`；camel-case `dangerFullAccess` 只出现在 `turn/start.sandboxPolicy.type` 这类不同 wire shape，不能写进 thread params。Codex child 的 OS cwd 使用 Agent 配置值，thread params 不重复发送 cwd，避免触发不必要的原生 trust 持久化。

GroupX 仍不写 Codex/Grok/Kimi 的全局配置，不允许用户透传任意额外权限 argv，也不再实现第二套 GroupX 审批或沙箱判断。Active Structured Kimi 的 session mode 是 GroupX 唯一依据：官方默认 `manual` 不阻止 ACP 启动，随后必须以原生 `session/set_mode(auto)` 覆盖当前 session。该设置被明确的 native static/enterprise policy 拒绝时才失败；不会先要求用户修改全局配置。

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

决定：`agents` 配置从固定的 codex/grok/kimi 三键改为显式房间名册。键即 agent id(actor `agent:<id>`)，每个条目声明 `driver`(codex/grok/kimi 原生 CLI 家族)、可选显示名 `name`、`command`、`cwd`、`enabled`。内置 id 省略 `driver` 时默认同名；自定义 id 必须显式给出 driver。名册写谁启动谁；缺省整个 `agents` 字段仍等价于内置三 Agent。同一 driver 可挂多个实例，各自持有独立长驻 session。

runtime 启动时把名册中的自定义/改名 agent upsert 进 actors 表，显示名由此流入 durable 事件与 Web UI;Web UI 的目标 chips、Agent 卡片、身份记忆下拉全部按 bootstrap 名册动态渲染，非内置 id 按 actor id 哈希分配固定调色板色调。

分发形态为 npm 公共 scoped包 `@susyimes/groupx`,`bin.groupx` 指向 `dist/src/cli.js`，提供 `start`(默认，自动打开浏览器，可 `--no-open`)、`doctor`(系统/Node/CLI 检测)、`init`(浏览器 Agent 引导并在保存后启动/进入群聊)、`update`(查询 npm latest 并更新当前全局安装，可 `--check`)子命令。`update` 先读取 Registry 的稳定精确版本，再把该版本固定传给 npm 全局安装；已最新或本地版本更高时不重装/降级。Windows 通过当前 Node 执行 `npm-cli.js`，macOS/Linux 使用同安装入口或 PATH 中可执行 npm，全程 `shell:false`。首次 `start` 未找到配置时先进入引导页；引导页允许重复添加同一 driver、编辑稳定 id/name/cwd/command，并只写 GroupX 配置。standalone 保存后由临时同源 launch 状态等待正式 runtime ready，再在当前页面自动跳转；运行中的 `/setup` 可编辑现有名册，保存后明确要求重启，不自动跳转且不在运行中热换 session。静态资源根从进程 cwd 改为按模块位置解析(`dist/web`)，使全局安装后可在任意目录启动。进程管理与命令解析的跨平台分支(win32 taskkill / posix 负 pid 进程树、PATH 查找)已内置于 supervisor 与 launch 层,macOS/Linux 行为通过依赖注入测试覆盖。

正式 runtime 的 HTTP loopback bind 必须先于 stale session recovery。端口冲突代表另一个 runtime 可能仍在运行；失败进程不得修改现有 Agent instance/session lineage。该顺序防止重复执行 `groupx start` 将活跃 binding 错标为 interrupted，并使新消息永久停在 queued。

原因：

- 用户需要给 Agent 起群内显示名，也需要同一 CLI 的多个分身实例；
- 固定三键 schema 把房间成员硬编码进了解析层，扩展必须改协议代码；
- 全局 CLI 是"安装后任意目录启动"的最小分发闭环；npm 裸名 `groupx` 已被占用，故用 owner scope。

变更条件：新增 driver 家族(非 codex/grok/kimi 的 CLI)需要新 Adapter 并走 release Gate;多房间/远程分发仍属 Deferred。

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

## 决策变更规则

任何 Accepted 决策变更必须同时提供：

1. 触发它的真实证据；
2. 对用户五项原始需求的影响；
3. 协议/存储迁移方案；
4. 新增复杂度和回滚边界；
5. 更新后的测试与完成标准。
