# GroupX

GroupX 是一个只在本机运行的多 CLI 群聊系统：用户通过 Web UI 与 Codex CLI、Grok CLI、Kimi CLI 共同交流，三个 CLI 也能显式地相互发送消息，并共享群组记忆与各自的群内身份记忆。

当前阶段：**实现文档 v0.1 已落盘；M0 真实传输验证与运行代码尚未开始。**

## 核心决定

- 使用一个本地透明 Broker，而不是让三个 CLI 建立物理 P2P 网状连接。
- Codex 首选 `codex app-server` 的 stdio JSON-RPC；Grok、Kimi 首选 ACP stdio。
- CLI 发起的群消息通过 GroupX 提供的小型 MCP 工具面进入 Broker。
- MCP 同时提供异步 `send`、同步 `ask` 和结果查询 `read`，避免“消息出现在 UI 但发送方当前回合看不到回答”。
- Web UI 使用 REST 上行、SSE 下行。
- SQLite/WAL 是唯一权威存储；JSONL 仅用于可读审计导出。
- GroupX 不增加模型、沙箱、工具或审批权限策略，只继承各 CLI 自身配置。
- 发送者身份由 Broker 根据受控会话通道写入，不能由消息正文或工具参数伪造。
- 内部使用简单的 GroupX Envelope；完整 A2A 以后作为边缘适配器加入。

## 文档索引

1. [实现设计](docs/IMPLEMENTATION.md) —— 需求、架构、模块、运行流程、里程碑和完成标准。
2. [消息与路由协议](docs/PROTOCOL.md) —— Envelope、发送者身份、路由、REST/SSE 和 MCP 工具合同。
3. [存储与记忆](docs/STORAGE_AND_MEMORY.md) —— SQLite 模型、恢复、公共记忆、身份记忆和上下文注入。
4. [M0 传输验证](docs/M0_TRANSPORT_SPIKE.md) —— 三套 CLI 的真实握手与能力探测计划。
5. [验收测试](docs/ACCEPTANCE_TESTS.md) —— M0-M3 的协议、恢复、记忆、安全与性能测试矩阵。
6. [架构决策](docs/DECISIONS.md) —— 已接受决定、暂定决定及变更条件。
7. [参考项目核查](docs/REFERENCE_FINDINGS.md) —— Species、memsuOS、TendrilFlow 的可借鉴与不可复用边界。

## 当前环境基线

核查日期：2026-08-11。

| 组件 | 当前发现 | 说明 |
| --- | --- | --- |
| Node.js | `v24.14.1` | 可用于 Broker；本机 `node:sqlite` 仍提示 experimental，因此实现不直接锁定该 API。 |
| npm | `11.11.0` | 依赖版本将在 M0 后固定。 |
| Codex CLI | `0.147.0` | 帮助面存在 `app-server`；尚未执行本项目真实握手。 |
| Grok CLI | `1.0.0` | 帮助面存在 `agent stdio`；尚未执行本项目真实握手。 |
| Kimi CLI | `0.34.0` | 帮助面存在 `acp`；尚未执行本项目真实握手。 |

“命令存在”不等于“当前登录态、协议版本和完整能力可用”。真实能力以 [M0 传输验证](docs/M0_TRANSPORT_SPIKE.md) 的现场证据为准。

## 目标边界

首个可用版本只做：

- 一个本地房间；
- 固定的 Codex、Grok、Kimi 三个 Adapter；
- 定向消息、`@all` 并行消息和 CLI 显式互发；
- 流式 UI、持久会话状态、公共记忆、身份记忆；
- 原生审批请求透传、取消、错误与重启恢复。

首版不做任务板、Host Agent、工作树编排、共识投票、自治组织、远程账号系统、完整 A2A Server 或插件市场。

## 官方协议资料

- [OpenAI Codex App Server](https://developers.openai.com/codex/app-server/)
- [Agent Client Protocol](https://agentclientprotocol.com/protocol/v1/overview)
- [A2A Protocol](https://a2a-protocol.org/latest/specification/)
- [Kimi CLI command reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command)
- [xAI Grok CLI reference](https://docs.x.ai/build/cli/reference)
