# GroupX 消息与路由协议

状态：Draft v0.1
协议名：GroupX Envelope
首版 schema：`groupx.event/0.1`

## 1. 设计目标

协议需要同时满足：

- 浏览器、Broker、三个 CLI 使用同一语义事件；
- 正常 Adapter invocation/会话流程中的 actor 由 binding 决定，正文和工具参数不能指定 sender；
- 所有消息在群内可见，但只有明确目标被唤醒；
- Web/REST 在 active Structured 模式表达用户或本地客户端路由；GroupX MCP `send/ask/read` 提供 Agent 当前回合主动异步发送与同步问答；deprecated Direct 只保留兼容语义；
- 可重放的 durable event 与高频 transient delta 分离；
- 原生 CLI 事件可以扩展，而不把核心绑定到某个 CLI schema；
- 将来可以映射到 A2A Message/Task/Artifact，但首版不承担完整 A2A 生命周期。

运行合同：存储/历史 Envelope 可出现 `direct | structured`，但公开运行配置只接受 `structured`。Direct 标记为 deprecated，配置解析、Adapter factory 与 runtime constructor 均拒绝启动。同一次运行三个 Agent 使用 Structured；REST、MCP 和单 Turn 都不能覆盖，也不允许自动 fallback。`access` 是内部固定值 unrestricted，不进入请求、Envelope 或可变数据库策略。

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
  forwardedEventId?: string;
  causationId?: string;
  correlationId: string;
  rootCorrelationId: string;
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

type PublicProvenance = {
  sourceKind: "web" | "adapter" | "mcp" | "system" | "generated_summary";
  authorActorId?: string;
  subjectActorId?: string;
  sourceEventId?: string;
  labels?: string[];
};
```

规则：

- `eventId` 全局唯一；
- durable event 在数据库提交时获得单调递增 `seq`；
- transient delta 的 `seq` 为 `null`，不能用于断线重放；
- `correlationId` 标识一个根交互链；
- `rootCorrelationId` 固定保存整条 Agent ask/send 链的根 correlation；
- `causationId` 指向直接导致本事件的事件或 Turn；
- `replyToEventId` 表示用户可见回复关系；
- `forwardedEventId` 只引用原事件，不复制可被篡改的作者字段；
- `to` 表示需要被唤醒的 Agent，不表示私密可见范围；
- M0-M2 的所有 message 都对房间可见。
- `provenance` 由 Broker 从已绑定通道和持久记录生成；请求方不能提交或覆盖，且其中不公开 binding/native session/process ID。

### 2.1 durable event

必须持久化：

```text
message.created
turn.queued
turn.dispatched
turn.started
turn.completed
turn.failed
turn.cancelled
turn.interrupted
session.starting
session.retrying
session.ready
session.resumed
session.stopped
session.failed
context.compaction.started
context.compaction.retrying
context.compaction.completed
context.compaction.failed
memory.remembered
memory.superseded
memory.retracted
identity.remembered
identity.superseded
identity.retracted
routing.loop_stopped
system.error
```

`session.*` 表达 native session lineage，而不是进程是否长驻：Structured 在长驻连接上产生；Direct 只有实际解析到 native session ID 或 resume 成功时才产生相应事件。`session.resumed` 只在 Codex `exec resume`、Grok `--resume`、Kimi `--session`、App Server `thread/resume` 或 ACP `session/load` 真实成功时产生。Active Kimi ACP 不以 global config preflight 为启动门禁；`session/set_mode(auto)` 必须在 new/load 后、首 prompt 前完成。协议中不存在 `approval.*` 事件。

`session.retrying` 与 `context.compaction.*` 是 transient 运行进度，重连后不回放。body 只包含 operation/Agent、attempt/maxAttempts、下一次退避时间、覆盖序号及稳定错误码等有界投影，不包含 prompt、摘要正文、raw stderr 或 CLI 配置。

每个派发 attempt 持久化以下可靠性投影：

```ts
type TurnAttemptDelivery = {
  attemptId: string;
  turnId: string;
  transport: "direct" | "structured";
  dispatchPhase: "prepared" | "prompt_invoked" | "native_started" | "terminal";
  deliveryCertainty: "not_delivered" | "delivered" | "unknown";
  nativeTurnId?: string;
};
```

`transport` 是从不可变 Turn snapshot 投影的只读值；最小 v4 不在 `turn_attempts` 重复存列，claim 用 `expectedTurnId + expectedTransport` 校验 Turn、binding、instance 三者一致。

调用原生 prompt 前，Broker 必须先持久化 `prompt_invoked + unknown`。只有 transport snapshot 等于当前启动选择且仍为 `prepared + not_delivered` 才可自动重新排队；snapshot 不同以 `TRANSPORT_MODE_MISMATCH` 失败。`delivered` 或 `unknown` 在 reconciliation 失败后进入 terminal `interrupted`，绝不自动创建第二次原生执行或切换 transport。

### 2.2 transient event

默认不持久化：

```text
turn.content.delta
turn.reasoning.delta
turn.progress
tool.progress
adapter.heartbeat
```

`tool.progress.body` 至少携带 `turnId` 与 `nativeType`；原生事件提供稳定 id 时同时携带 `toolCallId`，`details` 只包含 Adapter 已投影的结构字段。Web UI 用 `turnId + toolCallId` 合并同一次工具调用，并将其折叠显示在对应 Agent 气泡内。transient 事件本身不在刷新后重放；terminal transaction 会为已观察到的工具 started/completed 投影按原顺序写入 durable `tool.progress.recorded`，其 body 与 live 投影同形，刷新时继续按相同 key 合并，不能退化成独立全量 JSON 卡片。

`turn.reasoning.delta` 本身仍不落库。若 native Turn 实际产生过推理增量，Broker 在 terminal transaction 中把已观察到的增量按原顺序合并成最多一条 durable `turn.reasoning.recorded`：

```json
{
  "turnId": "turn_...",
  "content": "聚合后的推理文本",
  "terminalStatus": "completed"
}
```

该事件有 durable `seq`，可以随 SQLite cursor 在刷新或重连后回放。`turn.reasoning.recorded` 与 `tool.progress.recorded` 都只服务本地时间线与审计，不属于 message、memory、identity 或 summary；Context Packet、reply chain、房间压缩与自动记忆只能消费明确的 `message.created`/记忆数据，不得读取两类记录正文。

每个 Turn 恰好有一个 durable terminal event。可选 reasoning record、tool progress records、成功 response message、terminal event、Turn 与 attempt terminal 更新在同一事务提交，durable 顺序固定为 reasoning → tool progress → response（仅成功）→ terminal。若崩溃发生在 final commit 前，可保存已合并的 partial text 并将 Turn 标记为 `interrupted`，但不能把 partial text 伪装成 completed message。

## 3. 发送者身份合同

### 3.1 四级身份

```text
actorId          稳定群内身份：agent:codex
instanceId       运行实例：codex/main@<id>
nativeSessionId  CLI 实际返回的 thread/session 标识；Direct 也可持久化用于后续新进程 resume
bindingId        本次 Direct invocation 或 Structured session 来源绑定
```

`actorId` 和 `instanceId` 可进入公开 Envelope。`nativeSessionId` 与 `bindingId` 是 Broker 内部关联字段，默认不进入公共事件。

### 3.2 非权威字段

以下信息都不能决定发送者：

- 正文中的“我是 Grok”；
- 正文中的 `@kimi`；
- Agent 返回的任意 `from` JSON；
- MCP 工具参数中的自报名称；
- forwarded message 中复制出来的作者文本。

Web API 和 MCP 工具都不接受调用方指定 `from`、`actor` 或 `provenance`。出现任一字段固定返回 `SENDER_FIELD_FORBIDDEN`，绝不能忽略后继续采用请求的一部分 sender 信息。

### 3.3 通道绑定

- Direct 一次性 invocation 或 App Server/ACP session 在原生派发前绑定一个 `bindingId`；Direct binding 可引用从前一 Turn 取得的 native session ID，但仍是新的进程/binding lineage；
- 只为 Structured 且 capability 已验证可挂载 MCP 的会话建立独立 MCP binding，三个 CLI 不共用匿名入口；
- `groupx.send/ask/remember` 根据 MCP binding 得到 actor；
- Adapter 重启产生新 `instanceId/bindingId`，但可继续使用同一稳定 `actorId`。Structured 业务 Turn 持久收敛为 `failed + PROTOCOL_INVALID_MESSAGE` 后，Broker 可自动重建该 Adapter 的进程/session；原失败 Turn 保持 terminal，不进入新 binding，也不自动重放。

### 3.4 来源关联边界

GroupX 在正常 Adapter invocation/会话流程中从 binding registry 取得 actor，正文和工具 schema 都没有设置 sender 的入口。binding 只是 provenance/correlation handle，不是 secret、认证或能力令牌；本机进程仿造 binding、修改数据库或调用 loopback API 不属于 GroupX 的防御范围。

## 4. 可见性与路由

GroupX 将两个概念分开：

- `visibility`：M0-M2 全部消息进入公共房间 transcript，并在 Web UI 可见；
- `to`：哪些 Agent 因该消息获得一个新 Turn。

未被寻址的 Agent 不会立即启动 Turn。它在下次被唤醒时可通过增量 Context Packet 看到未读公共消息，也可在当前 Structured 原生回合显式调用 `groupx.read`。

路由来源只有：

1. Web UI 的结构化 recipients；
2. Structured CLI 在已绑定的原生会话中显式调用 `groupx.send` 或 `groupx.ask`。

普通 CLI 回复和自然语言 `@name` 不触发新 Turn。

### 4.1 `@all`

- 用户 `@all`：唤醒所有已启用 Agent；
- Agent `@all`：仅 Structured GroupX MCP 的工具参数可触发，默认不唤醒自己；
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
queued
  -> dispatching
  -> running
  -> completed | failed | cancelled | interrupted

queued -> cancelled
dispatching | running -> cancelling -> completed | cancelled | failed | interrupted
```

`accepted` 是 REST/MCP 命令的接收结果，不是 Turn 状态。它只代表 Broker 已持久化消息和 queued Turn，不代表目标 CLI 已完成。`streaming` 是 running 期间的可选事件活动，不是持久状态；没有 delta 的 Adapter 也可以从 running 直接进入 terminal。

Terminal 状态不可回到 running。若用户显式重试，创建新的 Turn，并用 `causationId` 指向旧 Turn。

`PROTOCOL_INVALID_MESSAGE` 表示 GroupX 无法继续信任当前 Structured 进程/session 的 wire 状态。当前 Turn 必须先以一次 durable `failed` 收敛；随后允许自动替换 Adapter instance/binding，并优先 resume/load 同一 native session 以服务**后续** Turn。这个恢复动作不是 Turn retry，不创建第二个 native turn，也不改变原 Turn 的 terminal 状态。

状态恢复必须结合 attempt 的 `dispatchPhase` 与 `deliveryCertainty`。`dispatching/running` 不是自动重试许可：只有状态不是 `cancelling` 且确认 `not_delivered` 才能重排；`cancelling + not_delivered` 收敛为 `cancelled`。已派发的 `cancelling` 保留取消意图并尝试对同一 native Turn 重发 cancel；若 native completion 已抢先成功，允许收敛为 `completed`。`delivered` 或 `unknown` 无法关联回同一 native Turn 时进入 `interrupted`，由用户显式继续或重试；已有 `delivered` 证据不能倒退成 `unknown`。

## 6. Agent 互发工具（仅 Structured）

GroupX 必须实现 `send/ask/read`，它们是 Structured Agent 在当前原生回合主动互调的主路径。某个 Adapter 只有在现场 probe 已验证 MCP 注入、发现和实际调用后，才向该 session 暴露工具；普通 attach/call 失败只能分级为 `unsupported` 或 `not_observed`。只有 Agent 已通过独立外部策略 evidence 投影为 `native_policy_blocked` 时，MCP 不可用原因才可引用该状态。三种情况都返回 `MCP_UNAVAILABLE`；不能启用 deprecated Direct 作为替代。Web/REST 也可创建相同路由命令，公共 transcript、公共记忆和身份记忆不依赖 MCP。

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
  turns: Array<{
    target: string;
    turnId: string;
    status: "queued";
    transport: "structured";
  }>;
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
    transport: "structured";
    status: "completed" | "failed" | "cancelled" | "interrupted" | "timeout";
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

Store 对每个 MCP child Turn 都严格验证 `parentTurnId`存在、`rootCorrelationId` 与父链一致、`hopCount = parent.hopCount + 1`，并从持久父链重建 ancestor actor chain。只有 `commandType="mcp.ask"` 且该命令显式进入 `waitsForChildren` 集合时，目标出现在 ancestor actor chain 才拒绝该同步 ask：

```text
errorCode = CAUSAL_CYCLE
```

B 仍可使用异步 `groupx.send(A)`；它可以回发祖先 actor，该消息进入公共房间并排队，但不阻塞 B 当前工具调用。异步 send 仍必须通过 parent/root/hop 完整性、root-turn、actor-call、hop 和 queue 限额；不得对它误报 `CAUSAL_CYCLE`。

## 7. 循环、资源与背压

自然语言正文不触发路由。Structured GroupX MCP 显式工具可能形成长链，因此 Envelope/Turn 保留以下可靠性字段：

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

## 9. Native interaction 失败合同

v0.1 固定 unrestricted，GroupX 没有 approval、permission 或 user-input 状态机。Adapter 若收到 approval、permission、`requestUserInput`、question 或 elicitation request：

- 不创建群组事件、pending 记录或 REST 资源；
- 不把 request/options 发送给 UI，不替用户选择 allow/deny；
- 协议必须结清请求才能退出时，只回复 cancellation/error 并发起 native cancel；Kimi ACP 对 `session/request_permission` 回复 `cancelled` 后发送 `session/cancel`；
- native request 证明 prompt 已越过可能交付边界，attempt 推进为 `delivered + terminal`；当前 Turn 恰好产生一次 durable `turn.failed`，并且错误码一律为 `UNEXPECTED_NATIVE_INTERACTION`；
- 不自动 fallback 或重放。

失败事件只保存 request kind、adapter、turn correlation 和有界 native reason code；不保存可选决定、完整命令或未建模 payload。

`NATIVE_POLICY_BLOCKED` 是独立的 Adapter 启动/session 失败合同：必须由外部策略 preflight 或 native 启动/session 拒绝明确证明 enterprise requirement、server policy 或 static deny，才把 Agent health 投影为 `native_policy_blocked`。不得从 interaction request、options 或普通 MCP attach/call 失败推断。

## 10. REST 合同

### 10.1 Bootstrap

`GET /api/bootstrap` 在同一 SQLite read snapshot 中返回房间投影和该投影已包含的最大 durable `cursor`。查询只读取有界的最近事件以及当前房间的非终态 Turn，不扫描完整历史；公开 Turn 仅含 `turnId/targetActorId/status/sourceEventId`，不回显 binding、adapter、native ID 或调度字段。客户端随后以该 cursor 打开 `/api/events`；在 bootstrap commit snapshot 与 SSE 连接之间提交的事件会由同一 SQLite tail 以 `seq > cursor` 读取，不依赖一次性 live 广播。

### 10.2 创建用户消息

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
    { "target": "agent:codex", "turnId": "turn_...", "status": "queued", "transport": "structured" },
    { "target": "agent:grok", "turnId": "turn_...", "status": "queued", "transport": "structured" }
  ]
}
```

### 10.3 取消

`POST /api/turns/:turnId/cancel` 表达取消意图。Structured Adapter 调用 App Server/ACP 原生 cancel 或 interrupt，只作用于所属进程树。响应成功不等于 native CLI 已完成取消；最终结果由 SSE terminal event 确认。历史 Direct Turn 只返回其已持久终态，不启动旧 Adapter。

响应中的 `transport` 是 Broker 启动选择的只读快照。请求不得携带 `transport` 或 `access`；存在这些字段时返回 `INVALID_ENVELOPE`，不能按 Turn 改模式。

### 10.4 记忆与身份

公共记忆与身份记忆是 Broker REST 基础能力，不依赖 MCP：

```text
GET  /api/memory
POST /api/memory
POST /api/memory/:memoryId/supersede
POST /api/memory/:memoryId/retract

GET  /api/identity
POST /api/identity
POST /api/identity/:identityId/supersede
POST /api/identity/:identityId/retract
```

Web identity 写入请求包含 `clientCommandId`、`subjectActorId`、`kind`、`content` 和可选 `sourceEventId`；author 固定为 `user:web`。supersede 追加新版本并引用旧 identity ID，retract 写 tombstone。任何请求都不能指定 author/from。

Web UI 不再暴露 identity 写入面板；稳定 Agent 身份由 `/setup` 写入对应 Agent 配置。`/api/identity` 与 MCP identity 工具仅作为兼容接口保留。`/api/memory` 同时承载 room scope 的公共记忆与 agent scope 的独立记忆；客户端按 scope 分区展示，agent scope 以 `createdAt` 日期分组。

### 10.5 本机 Agent 引导与配置

`GET /api/setup` 返回 config 路径、是否已有配置、runtime 是否正在运行、三种 native driver 的默认命令检测结果，以及可编辑的 `serverPort/storagePath/agents[]` 草稿。`POST /api/setup` 严格接收同一草稿并要求稳定 Agent ID 唯一、至少一个 Agent 启用；每个 Agent 只包含 `id/driver/name/command/cwd/enabled`。

setup contract 不包含 `transport`、`access`、approval、sandbox、model 或任意 native flags。standalone `groupx init` 成功保存后启动正式 runtime，并让引导页轮询同源 `GET /api/setup/launch`；只有该接口返回 loopback 正式 origin 的 `ready` 状态后，页面才自动跳转到群聊，随后关闭临时服务。运行中的 `/setup` 可以更新配置文件，但响应必须标记 `restartRequired=true`，不能自动跳转或在旧 runtime 中热换 binding/session。

`GET /api/health` 的正式 runtime 响应必须包含 `service="groupx"`、`protocol="groupx.runtime/1"` 和 64 位十六进制 `runtimeKey`。key 是 canonical config 与 canonical config path 的 SHA-256，只用于本机重复启动的实例相关性，不是 credential、安全边界或远程发现标识。`groupx start` 仅在 service/protocol/key 全部匹配时把已运行实例视为成功；其他 listener 必须 fail-closed 并提示端口冲突。CLI 的预检不能替代 `listen` 的原子租约，`EADDRINUSE` 后必须再做有界探测以处理并发启动竞态。

## 11. SSE 合同

```http
GET /api/events?afterSeq=123
Accept: text/event-stream
Last-Event-ID: 123
```

durable event：

```text
id: 124
data: { ...GroupXEnvelope... }
```

transient delta：

```text
data: { "type":"turn.content.delta", "body":{ "turnId":"...", "chunkIndex":4, "text":"..." }, ... }
```

回合结束后的聚合推理与工具进度分别使用普通 durable event `turn.reasoning.recorded` / `tool.progress.recorded`，带 SSE `id`，不是 delta 通道。

规则：

- 只提供 `afterSeq` 或 `Last-Event-ID` 时，它是该连接的 cursor；两者同时存在必须数值相同，不同时以 `INVALID_ENVELOPE` 拒绝，不猜测优先级；
- 服务端不得使用有窗口的“查询历史，然后另行订阅 live”两步切换。SQLite-backed SSE 反复读取 `seq > cursor ORDER BY seq`；commit notification 只负责唤醒下一次查询，因此 replay/live cutover 不会漏 durable event；
- 所有 Envelope 使用默认 SSE `message` 事件，业务类型只读取 Envelope `type`，新增类型无需预注册浏览器 listener；
- transient delta 不使用 durable SSE id；
- `turn.reasoning.recorded` 使用 durable seq/id 并可回放，但 Web 不把它注册为普通消息或发送目标；
- `tool.progress.recorded` 使用 durable seq/id 并复用折叠工具 UI，但不注册为普通消息或发送目标；
- 慢客户端的瞬时 delta 可以合并或丢弃，terminal event 不可丢；
- 超出发送缓冲时关闭连接，客户端使用 `Last-Event-ID` 重连；
- 服务器只绑定 loopback，这是 M0-M2 的产品范围，不是认证或安全保证；
- 首版以普通文本节点显示模型内容，不提供可执行 HTML 渲染。

## 12. Structured MCP 工具与身份

Structured 每个 MCP 请求上下文必须带内部 binding，不把它暴露为可编辑工具参数。Deprecated Direct 没有 runtime/MCP attachment 入口。

selected transport 不是 Structured、对应 Adapter 的 native MCP capability 尚未 `verified`，或 Agent 已由独立的外部强制策略 evidence 投影为 `native_policy_blocked` 时，MCP attachment/HTTP 入口返回稳定 `MCP_UNAVAILABLE`（HTTP 503），不能改用 `SESSION_NOT_AVAILABLE`，也不能 fallback 到 Direct。普通 attach/call 失败本身不能生成 `native_policy_blocked`。

首版工具面：

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
TRANSPORT_MODE_MISMATCH
UNEXPECTED_NATIVE_INTERACTION
NATIVE_POLICY_BLOCKED
MCP_BINDING_MISMATCH
MCP_UNAVAILABLE
```

错误进入公共房间还是只进入诊断流取决于影响范围：影响用户操作的错误必须公开可见；纯协议噪声可进入有界诊断摘要，但不得静默改变消息语义。

## 15. 版本规则

- 新增可选字段属于向后兼容；
- 改变字段含义、删除字段或改变状态机需要提升 schema version；
- 未知 event type 应保留并允许 UI 以 generic event 渲染，但 `approval.*`、`permission.*` 和 `user_input.*` 是保留禁止命名空间，不得进入 GroupX event store 或 generic UI；
- Adapter 原生 schema 变化不直接提升 GroupX schema，除非归一化语义变化；
- 协议变更必须同时更新 fixtures、存储迁移和端到端测试。
