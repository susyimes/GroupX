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
| D-003 | Codex App Server stdio；Grok/Kimi ACP stdio | Provisional |
| D-004 | 内部 GroupX Envelope；A2A 作为以后边缘适配 | Accepted |
| D-005 | SQLite/WAL 是权威事实源，JSONL 仅导出 | Accepted |
| D-006 | Broker 根据通道绑定生成 sender identity | Accepted |
| D-007 | 不增加 CLI 权限层，只透传原生 approval | Accepted |
| D-008 | transcript、公共记忆、摘要、身份记忆分离 | Accepted |
| D-009 | 每 Agent lane 单飞，不同 Agent 并行 | Accepted |
| D-010 | 同时提供异步 send 与同步 ask/read | Accepted |
| D-011 | 因果循环与资源限制属于可靠性，不属于权限 | Accepted |
| D-012 | Node/TypeScript 单进程、原生 Web UI | Accepted |
| D-013 | SQLite Node 驱动在 M0 后固定 | Provisional |
| D-014 | 完整 A2A Server、多房间、多用户 | Deferred |

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
- approval resolve、cancel、memory 写入天然适合 REST。

变更条件：需要浏览器端双向二进制或极高频交互时再增加 WebSocket，不替换现有 Envelope。

## D-003：原生持续会话传输

决定：

- Codex 首选 `codex app-server --listen stdio://`；
- Grok 首选 `grok agent stdio`；
- Kimi 首选 `kimi acp`。

M0 前为 Provisional，因为命令存在不证明当前登录态、完整 schema、MCP/approval/resume 能力。一次性 prompt/JSON 模式只可作为诊断降级，不视为通过持续会话目标。

## D-004：A2A 边缘化

决定：GroupX 内部不采用完整 A2A Task 模型。内部 Envelope 保留可映射字段，M3 以 Adapter 暴露/接入 A2A。

原因：本机固定三 Agent 不需要 discovery、远程认证和完整 Task/Artifact 生命周期；TendrilFlow 的当前 A2A 实现也采用外部适配到内部房间的边界。

## D-005：SQLite/WAL

决定：单 SQLite/WAL 数据库是唯一权威来源；Broker 唯一写入。JSONL 是导出，不是并发协调层。

原因：消息与多目标 Turn 需要事务；重启恢复、幂等、分页、状态查询和记忆索引都不应重新手工实现文件数据库。

## D-006：通道绑定身份

决定：`from` 由 Broker 根据 Adapter/MCP binding 填写；API/工具不接受调用者设置 sender。

保证：正常受控通道内，正文不能伪造发送者。

不保证：抵御已经拥有本机任意进程、调试或数据库修改能力的恶意程序。该威胁需要额外系统鉴权，当前不引入。

## D-007：原生权限继承

决定：GroupX 不添加 model、sandbox、approval、tool、YOLO 或自动允许策略，不修改全局 CLI 配置。

GroupX 允许：

- 指定协议启动子命令；
- 指定 cwd；
- 会话/进程级附加 GroupX MCP；
- 原样转发原生 approval decisions；
- 做输入校验、幂等、大小、超时、队列和循环限制。

最后一项是协议可靠性，不判断 CLI 是否有权执行某个动作。

## D-008：记忆分层

决定：

- transcript 是完整事件事实；
- public memory 是显式固定记录；
- summary 是可失效派生物；
- identity memory 是 GroupX 群内身份叠加；
- CLI 原生身份、instructions、配置和私有记忆不由 GroupX 覆盖。

纠错使用 supersede/tombstone，不原地抹除来源。

## D-009：并发

决定：每个 native session FIFO 单飞；不同 Agent 并行。`@all` 不串行等待。

原因：同一会话的上下文顺序比理论并发更重要；跨 Agent 并行保留效率和故障隔离。

## D-010：send、ask、read

决定：

- `send` 持久化后异步返回；
- `ask` 等待目标 terminal response 并作为 MCP 工具结果返回；
- `read` 查询异步 correlation；
- 所有问答同时写入公共房间。

没有 ask 时，发送 Agent 在当前回合无法可靠看到目标回答；只看公共 UI 不等于回答进入发送方上下文。

## D-011：因果循环与资源限制

决定：同步 ask 不能调用 active causal stack 中的祖先。显式长链受 hop/root-turn/queue/timeout 限制，达到边界产生公开错误事件。

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

## 决策变更规则

任何 Accepted 决策变更必须同时提供：

1. 触发它的真实证据；
2. 对用户五项原始需求的影响；
3. 协议/存储迁移方案；
4. 新增复杂度和回滚边界；
5. 更新后的测试与完成标准。
