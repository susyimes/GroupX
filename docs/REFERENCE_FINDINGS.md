# 参考项目与协议核查

核查日期：2026-08-11
用途：区分可复用设计模式、当前实现事实和 GroupX 自己必须实现的能力。

## 1. 仓库基线

| 项目 | 核查基线 | 状态说明 |
| --- | --- | --- |
| Species | 本地 `D:\species` `65fdc5f`; 远端 main `4caea4b` | 本地落后一个主要为 Windows YOLO 写入修复的提交；核心房间结论不依赖该差异 |
| memsuOS | `D:\memsuOS` `4bd21fa` | 本地与远端 main 一致，工作树干净 |
| TendrilFlow | 本地 `D:\TendrilFlow` `181b513`; 远端 main `642b843` | 远端新增并加固 A2A 边缘 Adapter，因此 A2A 结论以远端当前实现为准 |

GroupX 不复制参考项目源码。参考项目用于提炼边界和避免重复错误。

## 2. Species

项目：[susyimes/species](https://github.com/susyimes/species)

值得借鉴：

- `RoomEvent` 的 event/correlation/causation/idempotency/ref 结构；
- 消息先持久化，HTTP 快速确认，再异步执行 Agent Turn；
- 极薄的 AgentAdapter 边界；
- 公共记忆与 persona/identity 投影分离；
- 乐观聊天 UI、成员状态、reply/context refs。

本地证据：

```text
D:\species\src\types.ts:17-34
D:\species\src\kernel\ledger.ts:53-135
D:\species\src\server\runtime.ts:1100-1144
D:\species\src\memory\memory.ts:37-176
D:\species\src\persona\persona.ts:270-413
```

不能直接复用：

- live provider 是 OpenAI-compatible HTTP，不是三套本机 CLI 持续会话；
- Web 每 3 秒读取全量 state，不是 SSE/WebSocket cursor stream；
- background queue 全在内存，重启不恢复；
- JSONL 串行保护只在同一个 RoomLedger 实例内；
- ledger 去重不等于 end-to-end dispatch 幂等；
- side-effect approval、constitution、speaker budget 和社会状态机超出 GroupX 范围。

GroupX 结论：保留事件/异步模型，改用单 Broker + SQLite/WAL + durable Turn + REST/SSE。

## 3. memsuOS

项目：[susyimes/memsuOS](https://github.com/susyimes/memsuOS)

值得借鉴：

- 开放 ProtocolArtifact/ProtocolEvent；
- actor/ref/correlation/causation 的弱耦合引用；
- append-only 事实源与派生 Observatory view；
- provider adapter 接口思想；
- provenance 与 supersedes 思想。

本地证据：

```text
D:\memsuOS\src\autonomous_org\core\artifact.py:66-170
D:\memsuOS\src\autonomous_org\core\event.py:17-114
D:\memsuOS\src\autonomous_org\ledger\jsonl_store.py:12-32
D:\memsuOS\src\autonomous_org\views\interaction_observatory.py:52-336
```

不能直接复用：

- Codex 每次 `codex exec --ephemeral`，并额外强制 sandbox/approval；
- Kimi 每次临时进程/临时 workspace，临时 agent 强制 `tools: []`；
- 没有 Grok CLI Adapter；
- Open-org discussion 是中央按 round/member 顺序重建 adapter，不是持续 CLI 群聊；
- 当前 memory store 不是 GroupX 所需的持久公共/身份记忆；
- governance、AuthorizationDecision、Claim Firewall 不应成为 GroupX 执行门。

关键证据：

```text
D:\memsuOS\src\autonomous_org\intelligence\model_adapter.py:108-208
D:\memsuOS\src\autonomous_org\intelligence\model_adapter.py:357-428
D:\memsuOS\scripts\run_open_org_session.py:964-1145
```

许可注意：memsuOS 当前为个人非商业 source-available 许可，并非 OSI 开源许可。GroupX 只借鉴思想，不复制代码。

## 4. TendrilFlow

项目：[susyimes/TendrilFlow](https://github.com/susyimes/TendrilFlow)

值得借鉴：

- Legacy CLI 与 ACP session 分离；
- Kimi ACP 差异适配经验；
- task/room 和 transport 分层；
- 显式 Host/recipient 路由，不依赖自然语言自动路由；
- 远端最新实现将 A2A 作为外部 Adapter，不替换内部 ACP/room 模型。

当前 A2A 证据：[A2A spike at `642b843`](https://github.com/susyimes/TendrilFlow/blob/642b84316c7d7a2523a4272de75a926f0005073c/docs/A2A_SPIKE.md)

不能直接复用：

- Host Agent、任务板、工作树和 orchestration 对 GroupX 过重；
- 本地当前 Codex wrapper 主要是 one-shot `codex exec`；
- 前端同样依赖定时 state polling；
- 当前 Adapter 有自动选择 `allow_once/allow_always` 的逻辑，与 GroupX 原生权限透传冲突；
- 超大单体 orchestrator 不符合首版简单边界。

本地证据：

```text
D:\TendrilFlow\src\adapters.js:471-486
D:\TendrilFlow\scripts\codex-agent.js
D:\TendrilFlow\public\app.js:2903
D:\TendrilFlow\src\storage.js
```

GroupX 结论：借 ACP/Adapter 边界，不复制 Host/task/worktree；A2A 只做 M3 边缘适配。

## 5. 官方协议边界

### Codex App Server

官方文档：[OpenAI Codex App Server](https://developers.openai.com/codex/app-server/)

当前文档确认：

- bidirectional JSON-RPC，wire 上省略 `jsonrpc` header；
- stdio 是默认、换行分隔 JSON；
- initialize 后才能发其他请求；
- `thread/start`、`thread/resume`、`thread/fork`；
- `turn/start` 与 streamed item events；
- command/file approvals 是 server-initiated requests；
- WebSocket transport 当前实验且不支持生产；
- `dynamicTools` 是 experimental。

GroupX 因此使用 stdio，并把稳定 MCP 配置注入方式留给 M0 验证，不依赖 dynamicTools。

### ACP

官方文档：[Agent Client Protocol v1](https://agentclientprotocol.com/protocol/v1/overview)

ACP 定义 client-agent 生命周期，例如 initialize、session/new/load、session/prompt/update/cancel。它是 GroupX 控制 Grok/Kimi 会话的传输，不是三个 Agent 之间的群聊协议。

### A2A

官方文档：[A2A specification](https://a2a-protocol.org/latest/specification/)

A2A 面向独立/远程 Agent，包含 Agent Card、Message、Task、Artifact、发现和异步生命周期。GroupX 首版固定三 Agent，不需要把这些网络边界搬进内部核心。

### Kimi 与 Grok

- [Kimi CLI command reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command)
- [xAI Grok CLI reference](https://docs.x.ai/build/cli/reference)

本机 command help 宣称 Kimi ACP 和 Grok ACP stdio 存在；真实协议版本、resume、MCP、permission 和登录态必须由 M0 现场验证。

## 6. 事实与假设矩阵

| 陈述 | 当前等级 |
| --- | --- |
| 本机存在三个目标 CLI 与相应持续会话命令 | advertised |
| Codex App Server stdio/thread/resume/approval 语义 | documented |
| 当前 Codex 安装能完成 GroupX 真实 thread turn | 未验证 |
| 当前 Grok/Kimi 安装能完成 ACP prompt | 未验证 |
| Grok/Kimi 当前实现支持 session/load | 未验证 |
| 三个 CLI 均可绑定会话级 GroupX MCP | 未验证 |
| GroupX 不需要完整内部 A2A 即可实现群聊 | 架构决定，待 M1/M2 验收 |
| Broker 转发开销不会成为主要瓶颈 | 合理设计判断，待本地性能测试 |
| SQLite/WAL 能满足单 Broker 事务与查询 | 成熟能力，具体 Node 驱动待 M0 smoke |

实现或 README 不得把“未验证”改写为“已支持”，除非链接到脱敏 M0 证据。
