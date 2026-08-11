# GroupX

GroupX 是一个只在本机运行的多 CLI 群聊系统：用户通过 Web UI 与 Codex CLI、Grok CLI、Kimi CLI 共同交流，三者的回复共享公共 transcript、群组记忆与各自的群内身份记忆；Structured 模式还可通过 GroupX MCP 在当前回合显式互调。

当前阶段：**v0.1 的唯一 runnable/active/release transport 是 `structured`：Codex App Server、Grok ACP、Kimi ACP。`direct` 状态为 `deprecated`，公开入口已关闭；源码与历史存储值仅为审计/迁移兼容而保留。不再维护 Direct M0 Gate、不接收新功能，也不会成为 Structured 的 fallback。`access` 是不可配置的内部固定值 `unrestricted`。Structured 三 Agent matching unrestricted native-live + fixture Gate 当前为 `PASS`。**

## 核心决定

- 使用一个本地透明 Broker，而不是让三个 CLI 建立物理 P2P 网状连接。
- Adapter 仍能读取 `direct | structured` 以保持兼容；Structured 是唯一 active 路径并维持长驻原生会话。Direct 的 one-shot/resume 实现保留，但已 deprecated。
- transport 只在启动配置中显式选择。所选模式启动、握手或执行失败时明确失败，不静默切换到另一模式；prompt 可能已派发时绝不自动重放。
- GroupX MCP 提供显式 `send/ask/read`，只在 Structured 挂载，用于 Agent 在当前回合主动互调。Deprecated Direct 不具备该能力。普通模型文本中的 `@某人` 不触发派发。
- Web UI 使用 REST 上行、SSE 下行。
- SQLite/WAL 是唯一权威存储；JSONL 仅用于可读审计导出。
- v0.1 的 `access` 固定为 `unrestricted`，不暴露配置项：GroupX 在进程/thread/session 范围应用三套 CLI 各自的原生最大放开设置，不实现 ApprovalService、审批表、审批 REST、审批 UI 或审批事件，也不写全局 CLI 配置。Kimi 是唯一的只读配置预检例外：解析原生 config 后只投影两项 access/Plan 默认值，不保存或输出其他字段。
- “unrestricted”只表示在当前 Windows 用户本身拥有的权限范围内默认执行。它不能绕过 Windows UAC、文件 ACL、企业强制策略、服务端策略或 Kimi 等原生 static deny；外部强制阻断显示为 `native_policy_blocked`。
- 发送者归属由 Broker 根据当前 Direct invocation/process 或 Structured session binding 写入，不能由消息正文或工具参数改写；该绑定只用于来源关联，不是认证凭据。
- 如果 native adapter 发出 approval、permission、`requestUserInput`、question 或 elicitation，说明 unrestricted 启动/会话合同未生效：GroupX 做有界 native cancellation/teardown，并且一律以 `UNEXPECTED_NATIVE_INTERACTION` 终止当前 Turn。`NATIVE_POLICY_BLOCKED/native_policy_blocked` 是独立路径，只能来自明确的外部策略预检或 native 启动/session 拒绝，不得从 interaction request 或 options 推断。不弹审批框、不代选、不持久化 pending request，也不自动 fallback/replay。
- 内部使用简单的 GroupX Envelope；完整 A2A 以后作为边缘适配器加入。

## 文档索引

1. [实现设计](docs/IMPLEMENTATION.md) —— 需求、架构、模块、运行流程、里程碑和完成标准。
2. [消息与路由协议](docs/PROTOCOL.md) —— Envelope、发送者身份、路由、REST/SSE 和 MCP 工具合同。
3. [存储与记忆](docs/STORAGE_AND_MEMORY.md) —— SQLite 模型、恢复、公共记忆、身份记忆和上下文注入。
4. [M0 传输验证](docs/M0_TRANSPORT_SPIKE.md) —— Structured release Gate、deprecated Direct 历史证据与 unrestricted 启动合同。
5. [验收测试](docs/ACCEPTANCE_TESTS.md) —— M0-M3 的协议、恢复、记忆、数据最小化与性能测试矩阵。
6. [架构决策](docs/DECISIONS.md) —— 已接受决定、暂定决定及变更条件。
7. [参考项目核查](docs/REFERENCE_FINDINGS.md) —— Species、memsuOS、TendrilFlow 的可借鉴与不可复用边界。

## 当前环境基线

核查日期：2026-08-11。

| 组件 | 当前发现 | 说明 |
| --- | --- | --- |
| Node.js | `v24.14.1` | 可用于 Broker；本机 `node:sqlite` 仍提示 experimental，因此实现不直接锁定该 API。 |
| npm | `11.11.0` | 依赖版本将在 M0 后固定。 |
| Codex CLI | `0.147.0` | Active：`codex --dangerously-bypass-hook-trust app-server --listen stdio://`，thread start/resume 固定 `approvalPolicy="never"`、`sandbox="danger-full-access"`。Direct argv 仅在历史文档中保留。 |
| Grok CLI | `1.0.0` | Active：`grok --no-auto-update --permission-mode bypassPermissions --sandbox off --no-plan agent stdio`。Direct argv 仅在历史文档中保留。 |
| Kimi CLI | `0.34.0` | Active：只读预检有效 `default_permission_mode ∈ {yolo,auto}`、`default_plan_mode=false` 后启动 `kimi acp`；每次 `session/new` 或 `session/load` 后、首 prompt 前发送 `session/set_mode(modeId="auto")`。Direct argv 仅在历史文档中保留。 |

“命令存在”不等于“当前登录态、协议版本和完整能力可用”。真实能力以 [M0 传输验证](docs/M0_TRANSPORT_SPIKE.md) 的现场证据为准。

## 本地运行

需要 Node.js `24.14.1` 系列与 npm，并且 `codex`、`grok`、`kimi` 均已按各自 CLI 完成登录/配置。在 `D:\GroupX` 执行：

```powershell
npm ci
npm run build
npm start -- --config .\groupx.json
```

M0 能力矩阵以 JSON 为事实源；下列命令不会启动任何 CLI probe：

```powershell
npm run m0:validate           # 校验合同、PASS/evidence 匹配和生成的 Markdown
npm run m0:validate:evidence  # 额外校验本机 ignored evidence 文件的 SHA-256
npm run m0:matrix             # 从 JSON 确定性重建 Markdown 投影
```

下列命令会显式执行 M0 Gate：fixture 命令只启动受控测试子进程；Structured 命令会启动三个真实 CLI 并产生实际模型回合、MCP 调用与取消。只有两份报告都 PASS，apply 命令才会更新 tracked matrix：

```powershell
npm run m0:probe:fixtures
npm run m0:probe:structured -- --config .\groupx.json
npm run m0:apply:structured-gate -- --native <native-conformance.json> --fixture <fixture-conformance.json>

```

建议显式创建 `groupx.json`，最小 Structured 三 Agent 配置如下（相对路径以配置文件所在目录为基准）：

```json
{
  "transport": "structured",
  "server": { "host": "127.0.0.1", "port": 4310 },
  "storage": { "path": ".groupx/groupx.db" },
  "agents": {
    "codex": { "command": "codex", "cwd": ".", "enabled": true },
    "grok": { "command": "grok", "cwd": ".", "enabled": true },
    "kimi": { "command": "kimi", "cwd": ".", "enabled": true }
  }
}
```

不传 `--config` 时也会使用等价默认值：Structured、`127.0.0.1:4310`、当前工作目录下 `.groupx/groupx.db`、三 Agent enabled。这会真实启动 Codex App Server、Grok ACP 和 Kimi ACP，不是 fake transport；任一 CLI 缺失、未登录或无法满足 fixed unrestricted 合同都会使启动失败。

启动成功后打开 [http://127.0.0.1:4310/](http://127.0.0.1:4310/)。数据库默认位于 `D:\GroupX\.groupx\groupx.db`（若配置文件在其他目录，则按该目录解析）。使用 `Ctrl+C` 或发送 `SIGTERM` 停机；Broker 会执行有界关闭，不删除 SQLite 数据。

`transport: "direct"` 的公开配置入口已关闭：配置解析与 programmatic runtime 都会在打开数据库/启动 CLI 前明确拒绝。Direct 源码与存储枚举只用于历史审计、旧数据读取和兼容回归；主文档不提供 Direct 启动/Gate 命令，其既有 evidence 不能满足当前 release Gate。

## 目标边界

首个可用版本只做：

- 一个本地房间；
- Structured 的 Codex App Server、Grok ACP、Kimi ACP 三个 active Adapter；Direct Adapter 仅保留兼容；
- 定向消息、`@all` 并行消息和共享公共 transcript；
- Structured 增量与最终输出、公共记忆、身份记忆、原生 session continuity；
- Structured GroupX MCP `send/ask/read` 主动互调；
- 语义化取消、错误收敛、重启恢复与派发不确定性记录。

v0.1 只以 Structured 三 Agent Gate 决定发布。Direct 始终显示为 `deprecated`，不会借 Structured evidence 变回 active，也不会自动 fallback。

首版不做任务板、Host Agent、工作树编排、共识投票、自治组织、远程账号系统、完整 A2A Server 或插件市场。

## 官方资料

- [OpenAI Codex App Server](https://developers.openai.com/codex/app-server/)
- [OpenAI Codex CLI reference](https://developers.openai.com/codex/cli/reference/)
- [Agent Client Protocol](https://agentclientprotocol.com/protocol/v1/overview)
- [A2A Protocol](https://a2a-protocol.org/latest/specification/)
- [Kimi CLI command reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command)
- [Kimi ACP reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp)
- [Kimi configuration files](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files)
- [xAI Grok CLI reference](https://docs.x.ai/build/cli/reference)
- [xAI Grok permissions](https://docs.x.ai/build/features/permissions)
- [xAI Grok sandbox](https://docs.x.ai/build/features/sandbox)
