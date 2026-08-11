# GroupX 消息与路由协议

状态：Draft v0.1
协议名：GroupX Envelope
首版 schema：`groupx.event/0.1`

## 1. 设计目标

协议需要同时满足：

- 浏览器、Broker、三个 CLI 使用同一语义事件；
- 发送者不可由正文或 Agent 参数伪造；
- 所有消息在群内可见，但只有明确目标被唤醒；
- 异步发送与同步问答都可表达；
- 可重放的 durable event 与高频 transient delta 分离；
- 原生 CLI 事件可以扩展，而不把核心绑定到某个 CLI schema；
- 将来可以映射到 A2A Message/Task/Artifact，但首版不承担完整 A2A 生命周期。

## 2. Envelope

```ts
type GroupXEnvelope = {
  schema: "groupx.event/0.1";
  eventId: string;
  seq: number | null;
  roomId: string;
  type: GroupXEventType;
  actor: ActorRef;
  to: string[];
  replyToEventId?: string;
  causationId?: string;
  correlationId: string;
  idempotencyKey?: string;
  occurredAt: string;
  durability: "durable" | "transient";
  body: unknown;
  provenance?: PublicProvenance;
};

type ActorRef = {
  actorId: string;
  kind: "user" | "agent" | "system";
  instanceId?: string;
  displayName: string;
};
```

规则：

- `eventId` 全局唯一；
- durable event 在数据库提交时获得单调递增 `seq`；
- transient delta 的 `seq` 为 `null`，不能用于断线重放；
- `correlationId` 标识一个根交互链；
- `causationId` 指向直接导致本事件的事件或 Turn；
- `replyToEventId` 表示用户可见回复关系；
- `to` 表示需要被唤醒的 Agent，不表示私密可见范围；
- M0-M2 的所有 message 都对房间可见。

### 2.1 durable event

必须持久化：

```text
message.created
turn.queued
turn.started
turn.completed
turn.failed
turn.cancelled
turn.interrupted
session.starting
session.ready
session.resumed
session.stopped
session.failed
approval.requested.redacted
approval.resolved
memory.remembered
memory.superseded
memory.retracted
identity.remembered
identity.superseded
routing.loop_stopped
system.error
```

### 2.2 transient event

默认不持久化：

```text
turn.content.delta
turn.reasoning.delta
turn.progress
tool.progress
adapter.heartbeat
```

Turn 结束时，Broker 持久化最终 message 和 terminal 状态。若崩溃发生在 final commit 前，可保存已合并的 partial text 并将 Turn 标记为 `interrupted`，但不能把 partial text伪装成 completed message。

## 3. 发送者身份合同

### 3.1 四级身份

```text
actorId          稳定群内身份：agent:codex
instanceId       运行实例：codex/main@<id>
nativeSessionId  CLI 原生 thread/session，由私有 Session 记录保存
bindingId        本次 Adapter/MCP 通道绑定
```

`actorId` 和 `instanceId` 可进入公开 Envelope。`nativeSessionId` 与 `bindingId` 默认只保留在 Broker 私有存储及脱敏诊断中。

### 3.2 不可信字段

以下信息都不能决定发送者：

- 正文中的“我是 Grok”；
- 正文中的 `@kimi`；
- Agent 返回的任意 `from` JSON；
- MCP 工具参数中的自报名称；
- forwarded message 中复制出来的作者文本。

Web API 和 MCP 工具都不接受调用方指定 `from`。若请求携带未知 sender 字段，Broker 应拒绝或忽略并记录协议错误，绝不能采用该值。

### 3.3 通道绑定

- 每个 CLI Adapter 的 stdout/协议连接在启动时绑定一个 `bindingId`；
- 每个 CLI 会话使用独立的 GroupX MCP binding；
- 三个 CLI 不共用无法区分调用方的匿名 MCP 入口；
- `groupx.send/ask/remember` 根据 binding 得到 actor；
- Adapter 重启产生新 `instanceId/bindingId`，但可继续使用同一稳定 `actorId`。

### 3.4 保证边界

GroupX 保证正常受控 Adapter 通道内“正文不能伪造发送者”。GroupX 不宣称能抵御已经拥有本机任意进程执行、调试或数据库修改能力的恶意程序。要抵御这种对手需要系统级鉴权或能力令牌，超出当前“本机单用户、无额外权限层”的范围。

## 4. 可见性与路由

GroupX 将两个概念分开：

- `visibility`：M0-M2 全部消息进入公共房间 transcript，并在 Web UI 可见；
- `to`：哪些 Agent 因该消息获得一个新 Turn。

CLI 会话不是持续读取每条群消息的常驻订阅者。未被寻址的 Agent 不会立即启动 Turn，但它在下次被唤醒时可通过增量 Context Packet 或 `groupx.read` 看到未读公共消息。

路由来源只有：

1. Web UI 的结构化 recipients；
2. CLI 显式调用 `groupx.send` 或 `groupx.ask`。

普通 CLI 回复和自然语言 `@name` 不触发新 Turn。

### 4.1 `@all`

- 用户 `@all`：唤醒所有已启用 Agent；
- Agent `@all`：默认唤醒所有其他已启用 Agent，不唤醒自己；
- 每个目标生成独立 Turn；
- 多目标并行进入不同 Agent lane；
- 任何一个目标失败不取消其他目标。

### 4.2 reply 与 forward

- reply 使用 `replyToEventId`，不会自动改变 recipients；
- forward 使用对原消息的引用，不允许调用方填写可修改的 `forwardedFrom`；
- UI 从原消息 Envelope 读取原作者；
- 转发者仍然是当前 actor。

## 5. Turn 状态机

```text
accepted
  -> queued
  -> dispatched
  -> streaming
  -> completed | failed | cancelled | interrupted
```

REST/MCP 命令返回 `accepted` 只代表 Broker 已持久化消息和 Turn，不代表目标 CLI 已完成。

Terminal 状态不可回到 running。若用户显式重试，创建新的 Turn，并用 `causationId` 指向旧 Turn。

## 6. Agent 互发工具

### 6.1 `groupx.send`

异步派发，立即返回持久化结果：

```ts
type SendInput = {
  to: string[];
  content: string;
  replyToEventId?: string;
  clientCommandId: string;
};

type SendResult = {
  messageEventId: string;
  correlationId: string;
  turns: Array<{ target: string; turnId: string; status: "queued" }>;
};
```

适合通知、异步委托和不需要在当前模型回合读取结果的消息。

### 6.2 `groupx.ask`

发起目标 Turn，并等待目标的 terminal response 作为当前 MCP 工具结果返回；同时，问题与回复仍进入公共群聊。

```ts
type AskInput = {
  to: string[];
  content: string;
  replyToEventId?: string;
  clientCommandId: string;
  timeoutMs?: number;
  cancelOnTimeout?: boolean;
};

type AskResult = {
  messageEventId: string;
  correlationId: string;
  results: Array<{
    target: string;
    status: "completed" | "failed" | "cancelled" | "timeout";
    responseEventId?: string;
    content?: string;
    errorCode?: string;
  }>;
};
```

多目标 ask 并行等待，逐目标返回状态。一个目标失败不能丢弃其他目标已完成的结果。

默认 `cancelOnTimeout=false`：ask 超时只停止当前工具等待，目标 Turn 可以继续，调用方之后用 `groupx.read` 获取结果。若显式为 true，Broker 对仍运行的 ask child Turn 发起 best-effort 原生 cancel。取消发起 ask 的父 Turn 时，Broker 默认也 best-effort 取消尚未 terminal 的同步 ask child；异步 `send` 创建的 Turn 不随父 Turn 取消。

### 6.3 `groupx.read`

查询异步消息、Turn 或 correlation 状态：

```ts
type ReadInput = {
  correlationId?: string;
  afterSeq?: number;
  limit?: number;
};
```

### 6.4 同步 ask 因果循环

典型死锁：A 正在同步 `ask(B)`，B 又同步 `ask(A)`。

Broker 为每个 ask 维护 active causal stack。目标若是当前同步调用链的祖先，拒绝该同步 ask：

```text
errorCode = CAUSAL_CYCLE
```

B 仍可使用异步 `groupx.send(A)`；该消息进入公共房间并排队，但不阻塞 B 当前工具调用。

## 7. 循环、资源与背压

无自然语言隐式路由是第一层保护。显式工具仍可能形成长链，因此 Envelope/Turn 保留：

```text
rootCorrelationId
parentTurnId
hopCount
actorCallCountWithinRoot
```

Broker 必须支持可配置的：

- 每个根交互的最大 Agent Turn 数；
- 最大 hop count；
- 每个 Agent 在同一因果链的调用次数；
- 每 Agent 队列长度；
- message 字节数和 attachment 引用数；
- ask timeout 和 Turn idle timeout。

达到限制时创建可见的 `routing.loop_stopped` 或 `turn.failed`，绝不静默丢弃。上述是资源可靠性约束，不判断 Agent 是否有权执行 CLI 工具。

## 8. 幂等与顺序

### 8.1 命令幂等

幂等键由：

```text
sourceBinding + clientCommandId
```

唯一约束保证同一调用方重试不会创建第二条消息或第二组 Turn。相同键、不同 canonical payload 返回 `CLIENT_COMMAND_CONFLICT`。

### 8.2 派发幂等

每个目标 Turn 唯一键：

```text
sourceMessageEventId + targetActorId
```

重复命令不能重新唤醒目标。

### 8.3 顺序

- durable `seq` 是数据库提交顺序；
- 同一 Agent lane 按 Turn enqueue seq FIFO；
- 不同 Agent 的完成顺序不固定；
- transient delta 只在同一 native Turn 的 `chunkIndex` 内有序；
- UI 不应按到达时间重新排序已经有 durable seq 的事件。

## 9. 原生审批事件

GroupX 不建立自己的审批策略。

- Adapter 将原生 request ID、类型、关联 session/turn 和原生 `availableDecisions` 归一化；
- UI 只显示原生提供的 decisions；
- resolve API 不接受任意自由文本 decision；
- 无用户响应时保持 pending、原生超时或取消，绝不默认允许；
- CLI 配置本身自动允许时，GroupX 不额外弹窗；
- 完整命令、路径和环境内容按脱敏规则处理。

## 10. REST 合同

### 10.1 创建用户消息

```http
POST /api/messages
Content-Type: application/json

{
  "clientCommandId": "web-uuid",
  "to": ["agent:codex", "agent:grok"],
  "content": "请分别评审这个方案",
  "replyToEventId": null
}
```

返回 `202 Accepted`：

```json
{
  "messageEventId": "evt_...",
  "correlationId": "corr_...",
  "turns": [
    { "target": "agent:codex", "turnId": "turn_...", "status": "queued" },
    { "target": "agent:grok", "turnId": "turn_...", "status": "queued" }
  ]
}
```

### 10.2 取消

`POST /api/turns/:turnId/cancel` 表达取消意图。响应成功不等于原生 CLI 已完成取消；最终结果由 SSE terminal event 确认。

### 10.3 原生 approval resolve

`POST /api/approvals/:requestId/resolve` 只接受该 request 的 `availableDecisions` 之一，并要求 request 仍处于 pending。

## 11. SSE 合同

```http
GET /api/events?afterSeq=123
Accept: text/event-stream
Last-Event-ID: 123
```

durable event：

```text
id: 124
event: message.created
data: { ...GroupXEnvelope... }
```

transient delta：

```text
event: turn.content.delta
data: { "turnId":"...", "chunkIndex":4, "text":"..." }
```

规则：

- 浏览器重连先补 durable events，再订阅 live stream；
- transient delta 不使用 durable SSE id；
- 慢客户端的瞬时 delta 可以合并或丢弃，terminal event 不可丢；
- 超出发送缓冲时关闭连接，客户端使用 `Last-Event-ID` 重连；
- 服务器只绑定 loopback，并拒绝非本地 Origin；
- 所有 Markdown/HTML 渲染必须消毒，模型输出不能执行脚本。

## 12. MCP 工具与身份

每个 MCP 请求上下文必须带内部 binding，不把它暴露为可编辑工具参数。

首版工具：

```text
groupx.send
groupx.ask
groupx.read
groupx.memory.search
groupx.memory.remember
groupx.identity.read
groupx.identity.remember
```

`identity.remember` 的 subject 固定为调用方自身。其他 Agent 对该身份的描述可以进入普通公共 memory，记录 `author != subject`，不能冒充对方的自我记忆。

## 13. A2A 映射边界

未来 A2A Adapter 可以映射：

| GroupX | A2A |
| --- | --- |
| actor/agent registry | Agent Card |
| message.created | Message |
| correlation + turns | Task |
| attachment reference | Artifact/Part |
| turn terminal state | Task status |

内部 GroupX Envelope 不引入远程 discovery、认证协商或完整 A2A Task store。A2A Adapter 是 Broker 的外部入口/出口，不替换核心路由。

## 14. 协议错误

```text
INVALID_ENVELOPE
UNKNOWN_ACTOR
UNKNOWN_TARGET
SENDER_FIELD_FORBIDDEN
CLIENT_COMMAND_CONFLICT
DUPLICATE_DISPATCH
CAUSAL_CYCLE
ROOT_TURN_LIMIT_REACHED
HOP_LIMIT_REACHED
QUEUE_CAPACITY_REACHED
MESSAGE_TOO_LARGE
ASK_TIMEOUT
APPROVAL_DECISION_INVALID
APPROVAL_NOT_PENDING
MCP_BINDING_MISMATCH
```

错误进入公共房间还是只进入诊断流取决于影响范围：影响用户操作的错误必须公开可见；纯协议噪声可进入脱敏诊断，但不得静默改变消息语义。

## 15. 版本规则

- 新增可选字段属于向后兼容；
- 改变字段含义、删除字段或改变状态机需要提升 schema version；
- 未知 event type 应保留并允许 UI 以 generic event 渲染；
- Adapter 原生 schema 变化不直接提升 GroupX schema，除非归一化语义变化；
- 协议变更必须同时更新 fixtures、存储迁移和端到端测试。
