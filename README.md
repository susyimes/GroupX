<div align="center">

# ⚡ GroupX

**把 Codex、Grok、Kimi 三位 CLI 选手拉进同一个本地群聊。**

一句话 `@all` 齐发，多个本地 Agent 同屏协作——会话、记忆与数据都留在你的机器上。

![npm](https://img.shields.io/npm/v/@susyimes/groupx?color=3370ff&label=npm)
![Node](https://img.shields.io/badge/node-24.14.x-3c873a)
![Tests](https://img.shields.io/badge/tests-455%20passing-0d9f6e)
![Platform](https://img.shields.io/badge/platform-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-0078d6)
![Transport](https://img.shields.io/badge/transport-structured-9440c9)

<img src="https://cdn.jsdelivr.net/npm/@susyimes/groupx@0.1.4/docs/assets/ui-light.png" width="49.4%" alt="GroupX · 浅色主题"> <img src="https://cdn.jsdelivr.net/npm/@susyimes/groupx@0.1.4/docs/assets/ui-dark.png" width="49.4%" alt="GroupX · 夜间模式">

</div>

## 🧠 这是什么

GroupX 是一个**只跑在本机的多 CLI 群聊 Broker**：你在 Web UI 里发一条消息，Codex、Grok、Kimi 可以在同一个房间里一起回复。Agent 共享公共 transcript 与群组记忆，并拥有各自独立的群内身份。

Structured 模式下，它们还能通过 GroupX MCP 在当前回合**显式互调**（`send / ask / read`），不只是各说各话。

> 当前唯一可运行的 transport 是 `structured`（Codex App Server / Grok ACP / Kimi ACP）。`direct` 已废弃并关闭入口，源码仅保留用于历史审计兼容。

## ✨ 0.1.4 更新

- 新增房间上下文引擎：接近预算时由首个可用 Agent 生成滚动摘要，原始聊天记录仍完整保留。
- 压缩与会话启动过程现在有可见状态提示；临时连接和压缩故障采用有界重试，绝不自动重放可能已送达的业务 Prompt。
- Agent 身份配置移入 Agent 设置，并为每个 Agent 增加按日期分隔的独立记忆；公共记忆继续保持独立。
- 初始化向导与 Agent 名册支持任意数量和同类多实例，保存后直接进入群聊。
- 收紧会话 UI、折叠工具进度和记忆编辑器，并移除 Agent 卡片上多余的单发入口。

## 0.1.3 更新

- 新增 `groupx update`：检查 npm Registry 并把全局安装更新到观察到的精确 `latest` 版本。
- `groupx update --check` 只检查，不修改安装。
- Windows 使用当前 Node 直接执行 npm CLI；macOS/Linux 使用 shell-free npm 入口。
- 更新不会触碰 `groupx.json` 或 SQLite；先用 `Ctrl+C` 停止正在运行的 GroupX，更新后重新执行 `groupx start`。

> `0.1.2` 及更早版本还没有 `update` 命令。首次升级到 `0.1.3` 需执行 `npm i -g @susyimes/groupx@latest`，以后可直接使用 `groupx update`。

## 0.1.2 更新

- **浏览器初始化**：首次执行 `groupx start` 会自动打开 Agent 引导页，保存后继续启动群聊。
- **同类 Agent 多实例**：可以添加多个 Codex App Server，分别设置稳定 ID、显示名、工作目录与命令。
- **运行中可编辑**：主页面右上角“Agent 设置”可重新打开名册；保存后重启 GroupX 生效。
- **Kimi 默认配置可用**：Kimi ACP 不再要求用户预先修改 `default_permission_mode`；GroupX 在每次新建/恢复 session 后调用原生 `session/set_mode(auto)`。
- **更紧凑的主会话 UI**：减少左右留白，并修复 390px 窄屏横向滚动。

GroupX 不修改 Codex、Grok 或 Kimi 的全局配置。

## 🚀 六十秒起飞

前置条件：Node.js `>=24.14.1 <25`，以及 `codex`、`grok`、`kimi` 中至少一个已安装并完成自己的登录配置。Node 22 会出现 `EBADENGINE`，不在当前支持范围内。Windows 已实机验证；macOS/Linux 的启动与命令解析路径由自动化测试覆盖。

```bash
npm i -g @susyimes/groupx
groupx start
```

首次启动会依次完成：

1. 在浏览器打开 Agent 引导页；
2. 检测本机 CLI，允许添加、禁用或重复添加任意 driver；
3. 保存 `groupx.json`；
4. 启动 Broker 并打开群聊页面。

常用辅助命令：

```bash
groupx doctor                  # 检测 Node 与三个 CLI
groupx init                    # 配置 Agent，保存后启动并自动进入群聊
groupx update                  # 检查 npm latest 并更新全局安装
groupx update --check          # 只检查，不安装
groupx start --no-open         # 不自动打开浏览器，终端会显示本地 URL
groupx start --config x.json   # 使用指定配置
```

也可以直接从源码运行：`npm ci && npm run build && npm start`。

启动后默认打开 **http://127.0.0.1:4310/**。`Ctrl+C` 有界停机，SQLite 数据原样保留。

> 全局安装后命令名是 `groupx`，不是 `group`。若 shell 仍提示找不到命令，请重新打开终端并确认 npm 全局 bin 目录已在 `PATH`。

## 🧩 自定义 Agent(改名 / 多实例)

`agents` 是显式房间名册:内置 id(`codex`/`grok`/`kimi`)可省略 `driver`,自定义 id 必须声明 driver;`name` 是群内显示名。同一 driver 可以挂多个分身,各自持有独立长驻 session:

```json
{
  "transport": "structured",
  "server": { "host": "127.0.0.1", "port": 4310 },
  "storage": { "path": ".groupx/groupx.db" },
  "agents": {
    "codex": { "command": "codex", "cwd": ".", "enabled": true },
    "kimi": { "command": "kimi", "cwd": ".", "enabled": true, "name": "小K" },
    "rex": { "driver": "kimi", "name": "小R", "command": "kimi", "cwd": ".", "enabled": true },
    "grok": { "command": "grok", "cwd": ".", "enabled": false }
  }
}
```

目标 chips、Agent 卡片、身份记忆下拉都按名册动态渲染;自定义 Agent 按 id 分配固定色调。

## 🎯 能玩出什么花

- **🗣️ 一个房间,三位选手** — `@all` 群发并行，或在输入区明确选择目标 Agent；回复引用、跳转高亮、逐条复制都配齐
- **📡 直播式输出** — SSE 下行,流式增量实时上屏,断线自动重连
- **🛠️ 工具进度不刷屏** — 工具调用归入对应 Agent 气泡，默认折叠为一行，需要时再展开详情
- **🧠 公共记忆** — 显式固定的事实 / 决定 / 偏好 / 约束,注入后续每个回合;支持替换与移除
- **🎭 身份记忆** — 给每个 Agent 叠一层群内人设(比如"评审时优先盯协议风险"),不动 CLI 的全局配置
- **🤝 Agent 互调** — Structured 下挂载 GroupX MCP,`send / ask / read` 让 Agent 当前回合主动对话
- **🌗 双主题 UI** — 飞书蓝浅色默认 + 深色夜间模式,纸飞机发送键,代码块带复制,零前端依赖原生 ESM
- **💾 本地持久化** — SQLite/WAL 是唯一权威存储，重启后恢复 transcript、Turn 与记忆

## 🏗️ 架构一图流

```
                ┌───────────────────────────────┐
                │            Web UI             │
                │    双主题 · 实时 · 零依赖      │
                └───────────────┬───────────────┘
                     REST 上行  │  SSE 下行
                ┌───────────────┴───────────────┐
                │       GroupX Broker(本机)     │
                │  路由 · 共享 Transcript ·      │
                │  公共记忆 · 身份记忆 · SQLite  │
                └───┬──────────┬──────────┬────┘
            App Server         │ ACP      │ ACP
                ┌───┴───┐  ┌───┴───┐  ┌───┴───┐
                │ Codex │  │ Grok  │  │ Kimi  │
                │  CLI  │  │ CLI   │  │ CLI   │
                └───────┘  └───────┘  └───────┘
```

## 🧭 设计原则(较真版见文档)

- **透明 Broker,不拉 P2P 网** — 三个 CLI 互不知晓对方进程,全部经由本机 Broker 路由
- **失败要响亮** — 所选 transport 握手/执行失败就明确报错,绝不静默切换模式,绝不自动重放已派发 prompt
- **`unrestricted` ≠ 提权外挂** — 只在你当前 Windows 用户权限范围内放开;UAC、ACL、企业策略、服务端策略照旧生效,被拦显示 `native_policy_blocked`
- **归属不可伪造** — 发送者身份由 Broker 按进程/session 绑定写入,消息正文和工具参数改不了
- **不代点审批** — native 侧冒出审批/询问说明 unrestricted 合同失效:有界终止当前 Turn,不弹框、不代选、不持久化 pending
- **长房间不灌满模型窗口** — 默认 Context Packet 硬上限为 `256,000` 字符，并在约 `75%`（`192,000` 字符）软目标处开始滚动压缩，给原生 instructions、工具和回复留余量。旧对话由配置顺序中第一个健康 Agent 生成持久检查点，近期消息仍逐条原文注入；完整 transcript 始终保留在 SQLite
- **压缩与连接过程可见** — 页面提示正在压缩、当前重试次数、完成或失败；会话启动和压缩只对明确临时故障做有界退避重试，可能已送达的业务回合绝不自动重放
- **身份与记忆分层** — 左侧可折叠区只管理公共记忆；每个 Agent 的身份和按日期分组的独立记忆都在“Agent 设置”对应卡片中维护，二者互不混用

旧版自动生成配置中的 `48,000` 会在读取时迁移到新默认；其他自定义 `limits.contextCharacters` 保持原值。

## 🛠️ 开发

```powershell
npm run typecheck   # TS strict 全量检查
npm test            # vitest,455 用例
npm run build       # tsc + 拷贝 web 静态资源到 dist
```

M0 Structured Gate(会真实启动三个 CLI,谨慎运行):

```powershell
npm run m0:probe:fixtures
npm run m0:probe:structured -- --config .\groupx.json
npm run m0:apply:structured-gate -- --native <native-conformance.json> --fixture <fixture-conformance.json>
```

## 📚 文档索引

| 文档 | 内容 |
| --- | --- |
| [实现设计](docs/IMPLEMENTATION.md) | 需求、架构、模块、运行流程、里程碑 |
| [消息与路由协议](docs/PROTOCOL.md) | Envelope、身份、路由、REST/SSE、MCP 合同 |
| [存储与记忆](docs/STORAGE_AND_MEMORY.md) | SQLite 模型、恢复、记忆与上下文注入 |
| [M0 传输验证](docs/M0_TRANSPORT_SPIKE.md) | Structured release Gate 与现场证据 |
| [验收测试](docs/ACCEPTANCE_TESTS.md) | M0–M3 测试矩阵 |
| [架构决策](docs/DECISIONS.md) | 已接受决定与变更条件 |
| [参考项目核查](docs/REFERENCE_FINDINGS.md) | 可借鉴与不可复用边界 |

## 🚧 边界(首版不做什么)

不做任务板、Host Agent、工作树编排、共识投票、自治组织、远程账号系统、完整 A2A Server、插件市场。一个房间,三个 Agent,聊明白再说。

## 🔗 官方资料

- [OpenAI Codex App Server](https://developers.openai.com/codex/app-server/) · [Codex CLI reference](https://developers.openai.com/codex/cli/reference/)
- [Agent Client Protocol](https://agentclientprotocol.com/protocol/v1/overview) · [A2A Protocol](https://a2a-protocol.org/latest/specification/)
- [Kimi CLI command reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command) · [Kimi ACP reference](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp)
- [xAI Grok CLI reference](https://docs.x.ai/build/cli/reference) · [Grok permissions](https://docs.x.ai/build/features/permissions)

<div align="center">

**GroupX — 三个 CLI,一个群,本机自嗨。** 🎉

</div>
