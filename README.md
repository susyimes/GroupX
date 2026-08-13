<div align="center">

# ⚡ GroupX

**在一个本地 Web 房间里连接 Codex、Grok 和 Kimi CLI。**

![npm](https://img.shields.io/npm/v/@susyimes/groupx?color=3370ff&label=npm)
![Node](https://img.shields.io/badge/node-24.14.x-3c873a)
![Tests](https://img.shields.io/badge/tests-474%20passing-0d9f6e)
![Platform](https://img.shields.io/badge/platform-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-0078d6)
![Transport](https://img.shields.io/badge/transport-structured-9440c9)

</div>

GroupX 是一个运行在本机的多 Agent 群聊 Broker。Web UI 负责发消息和查看时间线，Broker 负责路由、会话、上下文与持久化，Codex App Server、Grok ACP 和 Kimi ACP 作为长驻 Agent 接入。

当前产品只启用 `structured` transport。历史 `direct` 代码不提供运行入口，也不会作为失败后的自动 fallback。

## ✨ 0.1.7

- README 只保留当前已实现能力、安装配置和排障说明，删除旧版本流水账与未落地范围描述。
- 移除不再反映当前 UI 的截图，并停止把这些图片打入 npm 包。

## 快速开始

前置条件：

- Node.js `>=24.14.1 <25`；
- 至少安装并登录 `codex`、`grok`、`kimi` 中的一种 CLI。

```bash
npm i -g @susyimes/groupx
groupx start
```

首次启动会打开 Agent 引导页。保存名册后，页面自动进入群聊。默认地址是 [http://127.0.0.1:4310/](http://127.0.0.1:4310/)。

常用命令：

```bash
groupx start                   # 启动或复用当前 GroupX
groupx start --no-open         # 不自动打开浏览器
groupx start --config x.json   # 使用指定配置
groupx init                    # 打开 Agent 配置引导页
groupx doctor                  # 检查 Node 与本机 CLI
groupx update --check          # 只检查 npm 更新
groupx update                  # 更新全局安装
```

`Ctrl+C` 会有界关闭当前进程，SQLite 数据不会被删除。运行中的 Agent 名册可以从页面右上角“Agent 设置”修改，保存后重启 GroupX 生效。

> 全局命令是 `groupx`，不是 `group`。如果安装后仍提示找不到命令，请重新打开终端，并确认 npm 全局 bin 目录已加入 `PATH`。

## 当前能力

- **多 Agent 名册**：支持启用、禁用、改名以及同一 CLI driver 的多个独立实例。
- **显式群聊路由**：可定向一个或多个 Agent，也可使用 `@all`；普通模型正文不会自动触发另一个 Agent。
- **实时与持久时间线**：SSE 展示回复、推理和折叠工具进度；回合结束后保留最终回复、聚合推理和工具记录，刷新后仍可查看。
- **上下文隔离**：推理与工具记录只用于页面回放，不进入 Context Packet、回复链、房间压缩或自动记忆。
- **公共记忆与 Agent 记忆**：公共记忆在房间内共享；身份和按日期分组的独立记忆属于各 Agent。
- **长房间压缩**：默认 Context Packet 上限为 `256,000` 字符，在约 `75%` 时生成滚动摘要；完整 transcript 始终保留在 SQLite。
- **Agent 显式互调**：Structured 会话可通过 GroupX MCP 使用 `send`、`ask`、`read`。
- **会话恢复**：启动、恢复和压缩采用有界重试；可能已经送达的业务 Prompt 不会被自动重放。

## Agent 配置

推荐从 Web 引导页和“Agent 设置”维护名册。`agents` 的键是稳定 Agent ID；内置 ID 可以省略 `driver`，自定义 ID 必须声明 `driver: codex | grok | kimi`。

```json
{
  "transport": "structured",
  "server": { "host": "127.0.0.1", "port": 4310 },
  "storage": { "path": ".groupx/groupx.db" },
  "agents": {
    "codex": {
      "name": "Builder",
      "command": "codex",
      "cwd": ".",
      "enabled": true
    },
    "reviewer": {
      "driver": "codex",
      "name": "Reviewer",
      "command": "codex",
      "cwd": "review-worktree",
      "enabled": true
    },
    "kimi": {
      "command": "kimi",
      "cwd": ".",
      "enabled": false
    }
  }
}
```

每个启用的 Agent 拥有独立 native process/session。修改名册不会热替换正在运行的 session，需要重启 GroupX。

## 数据与运行边界

- Web/API 默认只监听 `127.0.0.1`。
- SQLite/WAL 是消息、Turn、记忆和摘要的本地权威存储。
- GroupX 不修改 Codex、Grok 或 Kimi 的全局配置。
- GroupX 按固定 `unrestricted` profile 启动原生 CLI，但不会绕过操作系统权限、企业策略或服务端限制。
- GroupX 没有审批系统；如果 native CLI 仍要求审批或交互，当前 Turn 会明确失败。
- GroupX 不扫描普通消息或记忆中的秘密内容。不要把凭据发送到群聊。

## 启动问题

### 端口已经占用

相同配置的新版 GroupX 会被自动复用。如果端口属于另一配置、旧版 GroupX 或其他程序，CLI 会提示停止原进程或修改 `server.port`，不会自动终止占用进程。

### Node 版本不受支持

Node 22 会触发 `EBADENGINE`。请安装 Node `24.14.1` 或同一 Node 24 支持范围内的更新版本。

### CLI 无法启动

先运行：

```bash
groupx doctor
```

确认对应 CLI 已安装、可以在当前终端直接运行，并已完成自己的登录配置。

## 从源码运行

```bash
npm ci
npm run build
npm start
```

开发检查：

```bash
npm run typecheck
npm test
npm run build
```

## 设计文档

- [实现设计](docs/IMPLEMENTATION.md)
- [消息与路由协议](docs/PROTOCOL.md)
- [存储、记忆与上下文](docs/STORAGE_AND_MEMORY.md)
- [架构决策](docs/DECISIONS.md)

## 上游协议

- [OpenAI Codex App Server](https://developers.openai.com/codex/app-server/)
- [Agent Client Protocol](https://agentclientprotocol.com/protocol/v1/overview)
- [Kimi ACP](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-acp)
- [Grok CLI](https://docs.x.ai/build/cli/reference)
