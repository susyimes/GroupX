# GroupX 存储与记忆设计

状态：Draft v0.1

## 1. 权威来源

SQLite/WAL 是 GroupX 唯一权威事实源。Broker 是唯一写入者。

存储继续接受 `direct | structured` 以读取旧记录；新产品与 release 路径使用 `structured`，`direct` 为 deprecated compatibility value。同一次 Broker 运行全部已配置 Agent 共用启动级 transport；请求不能覆盖，也不自动 fallback。`access` 恒为 unrestricted，不建立可变配置列、请求字段或数据库 policy 状态。

- CLI 不直接写数据库；
- Browser 不直接写数据库；
- JSONL 仅用于人工可读的审计导出和备份交换；
- UI、公共记忆视图、身份视图和健康摘要都是数据库事件/状态的投影；
- 任何缓存都必须可以从数据库重建。

具体 SQLite Node 驱动在 M0 做安装与性能 smoke 后固定。架构不依赖本机仍提示 experimental 的 `node:sqlite` API。

## 2. 数据分类

| 数据 | 是否权威 | 是否默认持久化 | 说明 |
| --- | --- | --- | --- |
| durable events | 是 | 是 | 群聊和状态历史 |
| turns | 是 | 是 | 队列、执行和 terminal 状态 |
| adapter runs / bindings / capabilities | 是 | 是 | Direct invocation 或 Structured session、transport 快照及实测能力 |
| final messages | 是 | 是 | 完成或明确 partial 的正文 |
| token delta | 否 | 否 | 仅 live SSE，短时内存合并 |
| aggregated reasoning record | 是 | 是 | 每个已产生推理的 terminal Turn 最多一条；仅供时间线回放，不进入上下文 |
| tool progress records | 是 | 是 | terminal 时保存 Adapter 已投影的 started/completed；折叠回放，不进入上下文 |
| public memory | 是 | 是 | 显式记忆、来源可追溯 |
| per-Agent core memory | 是 | 是 | `scope_type=agent, agent_memory_type=core`；Agent 通过绑定工具主动写自己，Web 可维护 |
| per-Agent dated memory | 是 | 是 | `scope_type=agent, agent_memory_type=dated`；成功 Turn 自动写，日期来自 `created_at` |
| identity memory | 是 | 是 | 群组层身份记录，不替换 CLI 原生身份 |
| configured Agent identity | 配置 | 是 | 存在 `groupx.json`，每轮注入，不写入 memory 表 |
| generated summary | 派生 | 是 | 标记 summary，可重新生成 |
| native interaction failure summary | 是 | 是 | 只保存 request kind、错误码与有界 native reason；没有 pending/options/decision |
| raw stderr/env/config | 否 | 否 | 不属于 GroupX 数据模型，不主动采集 |

## 3. 初始逻辑 schema

以下是语义合同，不锁定最终 SQL 方言细节。

### 3.1 actors

```sql
actors(
  actor_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)
```

预置：

```text
user:web
agent:codex
agent:grok
agent:kimi
system:groupx
```

此外，runtime 启动时按配置名册 upsert 自定义或被改名的 agent actor(`agent:<id>`,kind=agent,display_name 取配置 `name`,缺省为 id 本身），使 durable 事件的 `actor_display_name` 与 Web UI 显示名始终来自配置；未改名的内置 agent 仍以上述种子为准。

### 3.2 agent_instances

```sql
agent_instances(
  instance_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('direct','structured')),
  process_started_at TEXT NOT NULL,
  process_ended_at TEXT,
  status TEXT NOT NULL,
  FOREIGN KEY(actor_id) REFERENCES actors(actor_id)
)
```

不存 PID 作为稳定身份。PID 可以进入瞬时诊断，不作为恢复依据。

### 3.3 invocation/session bindings

```sql
session_bindings(
  binding_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  transport TEXT CHECK (transport IN ('direct','structured')),
  native_session_id TEXT,
  protocol TEXT NOT NULL,
  protocol_version TEXT,
  status TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_ready_at TEXT,
  closed_at TEXT
)
```

当前 binding 表示 Structured native session：Codex 使用 `codex-app-server`，Grok/Kimi/Hermes 使用 `acp`。历史 Direct binding 仍按旧 invocation 语义可读，但当前 runtime 不创建或恢复它。M2 GroupX MCP 只关联各自的 Structured session binding，不为多个 Agent 共用匿名入口。

Agent binding 的 `transport` 必须非 null，且与所属 instance 及 Turn snapshot 相同；只有 Web source binding 例外为 null。v4 物理 migration 为了 SQLite `ALTER TABLE` 兼容性可先加 nullable 列，但必须回填所有旧 Agent 行为 `structured`，Store 在创建/claim 时拒绝任何 Agent null 值。

`actor_id`、binding 与 author 只表示 Broker 正常创建通道内的 provenance/correlation，不是认证结果或能力凭据；恶意本机进程修改数据库或仿造 binding 不在 GroupX 防御范围。

`native_session_id` 允许为 null，因为 Structured 路径可能在 native ID 返回前失败。历史 Direct 行可能包含 `session.resume_hint` 取得的 ID，但只供审计读取。API 默认不返回完整 native ID，但 bootstrap/Turn 投影可回显只读 transport/continuity 状态。

### 3.4 client_commands

```sql
client_commands(
  command_id TEXT PRIMARY KEY,
  source_binding_id TEXT NOT NULL,
  client_command_id TEXT NOT NULL,
  command_type TEXT NOT NULL,
  canonical_hash TEXT NOT NULL,
  result_json TEXT,
  accepted_at TEXT NOT NULL,
  UNIQUE(source_binding_id, client_command_id)
)
```

相同唯一键和相同 `canonical_hash` 返回原结果；hash 不同返回 conflict。

### 3.5 events

```sql
events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  schema_version TEXT NOT NULL,
  room_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  instance_id TEXT,
  targets_json TEXT NOT NULL,
  reply_to_event_id TEXT,
  causation_id TEXT,
  correlation_id TEXT NOT NULL,
  idempotency_key TEXT,
  occurred_at TEXT NOT NULL,
  body_json TEXT NOT NULL,
  provenance_json TEXT,
  UNIQUE(room_id, event_type, idempotency_key)
)
```

若 `idempotency_key` 为 null，SQLite 唯一约束允许多行；非空时用于领域级去重。

为了让同一 Turn 的不同 terminal event type 也互斥，v0.1 还需要一个跨 event type 的 partial unique index：

```sql
CREATE UNIQUE INDEX events_room_idempotency_unique
ON events(room_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;
```

terminal 统一使用 `turn:<turnId>:terminal`，response 使用 `turn:<turnId>:response`。对同一 terminal key 的重放返回已提交结果；不同 outcome/hash 为 `STORE_CONFLICT`。

### 3.6 turns

```sql
turns(
  turn_id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  target_actor_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('direct','structured')),
  binding_id TEXT,
  native_turn_id TEXT,
  parent_turn_id TEXT,
  root_correlation_id TEXT NOT NULL,
  hop_count INTEGER NOT NULL,
  queued_event_id TEXT NOT NULL,
  enqueue_seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  partial_text TEXT,
  response_event_id TEXT,
  terminal_event_id TEXT,
  error_code TEXT,
  queued_at TEXT NOT NULL,
  started_at TEXT,
  terminal_at TEXT,
  UNIQUE(source_event_id, target_actor_id)
)
```

状态：

```text
queued
dispatching
running
cancelling
completed
failed
cancelled
interrupted
```

`transport` 是命令接受时 Broker 启动选择的不可变快照，不接受 message 请求覆盖。Agent Turn、session binding 与 agent instance 的 transport 必须一致，创建后不可变；Web binding 的 transport 为 null。claim 使用 `expectedTurnId + expectedTransport` 做 CAS。`streaming` 是 running 期间的事件活动，不单列持久状态。重启后无法确认的已派发 Turn 进入 terminal `interrupted`，并用诊断/交付确定性字段表达 unknown，不让 terminal 状态回退。

任何 MCP child Turn 插入都必须在同一事务内验证：`parent_turn_id` 存在，`root_correlation_id` 等于父 Turn 的 root，`hop_count = parent.hop_count + 1`，父链无断裂或环。只有 `command_type='mcp.ask'` 且父 Turn 在 `waitsForChildren` 中时，target actor 命中祖先 actor chain 才返回 `CAUSAL_CYCLE`。`mcp.send` 可异步回发祖先，但仍受上述完整性校验及 hop/root/actor/queue 限额。

最小 v4 migration 只为 `agent_instances`、`session_bindings`、`turns` 增加 transport：旧 v1-v3 的 Agent 行保守回填为 `structured`，Web binding 保持 null；不重命名 `session_bindings`，不增加 access 列，也不在 `turn_attempts` 重复 transport。

### 3.7 turn_attempts

```sql
turn_attempts(
  attempt_id TEXT PRIMARY KEY,
  turn_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  context_through_seq INTEGER NOT NULL,
  native_turn_id TEXT,
  dispatch_phase TEXT NOT NULL,
  delivery_certainty TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  prompt_invoked_at TEXT,
  started_at TEXT,
  terminal_at TEXT
)
```

`dispatch_phase` 至少区分 `prepared`、`prompt_invoked`、`native_started`、`terminal`。Structured prompt request 在越过可能交付边界前必须先持久化 `prompt_invoked + delivery_certainty=unknown + prompt_invoked_at`；因此只有仍为 `prepared + not_delivered` 的 Structured attempt 才能通过 CAS 重新排队。历史 Direct attempt 保留同一字段语义但不再被 runtime claim。

schema v5 为 attempt 增加可空 `summary_through_seq`。它只能指向该房间当前 active、且确实嵌入本次 Context Packet 的摘要边界，并且不得超过 `context_through_seq`。

这不是 exactly-once 承诺，而是守住“可能已经执行就不自动重放”的持久证据。attempt 不重复存 transport；实际 transport 从不可变 Turn 读取，并校验其 binding/instance 与 expected transport 一致，不能用另一个 transport 的 capability 或恢复路径替代。

### 3.8 delivery_cursors

```sql
delivery_cursors(
  actor_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  last_delivered_seq INTEGER NOT NULL,
  last_summary_seq INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(actor_id, room_id)
)
```

该表用于构建增量 Context Packet，不表示用户已读回执，也不证明 native session 已持有这些历史。cursor 只能推进到成功交付 Structured attempt 的 `context_through_seq`；`last_summary_seq` 只能随含该持久摘要的 attempt 在 native start 被确认后推进。历史 Direct cursor 仅按旧事实读取。

### 3.9 memory_records

```sql
memory_records(
  memory_id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  agent_memory_type TEXT,
  kind TEXT NOT NULL,
  author_actor_id TEXT NOT NULL,
  subject_actor_id TEXT,
  content TEXT NOT NULL,
  source_event_id TEXT,
  source_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  supersedes_memory_id TEXT,
  created_at TEXT NOT NULL,
  retracted_at TEXT
)
```

`agent_memory_type` 只允许 `core | dated`，仅在 `scope_type=agent` 时非空。schema v6 把升级前已有的 Agent 独立记忆迁移为 `core`，room/correlation memory 保持空值。

`scope_type`：

```text
room
agent
correlation
```

`kind`：

```text
fact
decision
preference
instruction
constraint
summary
note
```

### 3.10 identity_records

```sql
identity_records(
  identity_id TEXT PRIMARY KEY,
  subject_actor_id TEXT NOT NULL,
  author_actor_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  source_event_id TEXT,
  source_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  supersedes_identity_id TEXT,
  created_at TEXT NOT NULL,
  retracted_at TEXT
)
```

物理上 identity 也可复用 memory 表，但逻辑和 API 必须保持独立，避免公共闲聊声明自动成为身份事实。

### 3.11 summaries

```sql
summaries(
  summary_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  from_seq INTEGER NOT NULL,
  through_seq INTEGER NOT NULL,
  content TEXT NOT NULL,
  generator_actor_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
)
```

摘要永远是派生数据。每个房间最多一条 active 累计摘要；滚动更新以 compare-and-set 把旧摘要标为 superseded 后再写入新摘要。删除/失效摘要不能删除原事件。

## 4. 事务不变量

### 4.1 接受消息

一次用户或 Agent 发送必须在一个事务中完成：

1. 插入或命中 `client_commands`；
2. 插入 source `message.created` event；
3. 为每个目标插入唯一 `turn.queued` event，以其 durable `seq` 作为 `enqueue_seq`；
4. 为每个目标插入唯一 Turn，引用 `queued_event_id/enqueue_seq`，并快照当前 Broker transport；
5. 写入 command result；
6. commit。

只有 commit 成功后才能向 Adapter 派发。这样不会出现“CLI 已收到但消息账本不存在”。

### 4.2 结束 Turn

Turn terminal transaction 先对 `terminal_event_id IS NULL` 和当前 non-terminal status 执行 CAS，只有唯一胜者可以提交：

1. 若本回合观察到推理增量，插入最多一条聚合 `turn.reasoning.recorded`；不逐 delta 写库；
2. 为已观察到的工具 started/completed 写入有界 `tool.progress.recorded` 投影；不保存未建模 native payload；
3. 成功时插入唯一 response `message.created`；失败时不伪造 response；
4. 以统一 idempotency key `turn:<turnId>:terminal` 插入唯一 durable terminal event，不论 event type 为 completed/failed/cancelled/interrupted；
5. 成功时从 source `message.created` 和最终 response 构造一条有界 `agent_memory_type=dated` 记录，并追加 `memory.remembered`；不读取 reasoning/tool 记录；
6. 更新 Turn terminal 状态、错误码及 event 引用；
7. 更新当前 attempt 的 `dispatch_phase=terminal`、delivery certainty 和 `terminal_at`；
8. 仅在 confirmed delivered 时把 delivery cursor 最多推进到该 attempt 的 `context_through_seq`；若 attempt 带 `summary_through_seq`，同事务推进 `last_summary_seq`；
9. commit；
10. 唤醒 SQLite-backed SSE cursor tail，再由它按 reasoning → tool progress → response（仅成功）→ terminal → dated memory 的 durable seq 发布。

transient delta 可以在 commit 前实时广播，但 UI 必须把它显示为未完成状态。浏览器刷新时不会重放历史 delta；terminal commit 后由聚合 reasoning record 与 tool progress records 恢复推理和折叠工具展示。

### 4.3 Native interaction failure

schema 不包含 approval request/decision 表。若 Adapter 在 unrestricted 合同下收到 approval、permission、user-input、question 或 elicitation request，Turn terminal transaction 只持久化：

- `turn.failed`，且关联 attempt 记录 `delivery_certainty=delivered`、`dispatch_phase=terminal`；
- 错误码一律为 `UNEXPECTED_NATIVE_INTERACTION`；
- request kind、adapter/instance/turn correlation 与有界 native reason code。

不持久化 pending 状态、available decisions、用户选择或完整 native payload，也不产生可恢复的审批工作。Kimi ACP 为协议收尾返回 `cancelled` 只是 Turn 终止动作，不是审批记录。

`NATIVE_POLICY_BLOCKED` 只从独立外部策略 preflight 或 native 启动/session 拒绝记录产生，不得从 native interaction request/options 推断。

## 5. 崩溃恢复

### 5.1 queued

数据库中仍为 `queued` 且没有 dispatch attempt 的 Turn 可以重新加入 Agent lane。已经 claim 但 Turn 不是 `cancelling`、attempt 明确为 `prepared + not_delivered` 时，也可通过 CAS 回到 queued；`cancelling + prepared + not_delivered` 以 CAS 收敛为 `cancelled`，其他 attempt 不自动重放。

### 5.2 dispatching/running

Broker 启动时先枚举非终态 attempt，不先写 terminal：

- `prepared + not_delivered` 只有 Turn 不是 `cancelling`、transport snapshot 与当前启动选择相同才可用 CAS 回到 queued；transport 不同以 `TRANSPORT_MODE_MISMATCH` 失败，`cancelling` 则收敛为 `cancelled`；
- `prompt_invoked/native_started` 先用记录的 binding/native process/session 做 reconciliation；对 `cancelling` 保留取消意图，关联成功后对同一 native Turn 重发 cancel；
- 只有确实关联到同一个 native Turn 时才能继续 running、重发 cancel 或提交已知 terminal；native completion 在 cancel 前抢先成功时可收敛为 `completed`；
- 无法确认时一次性提交 terminal `interrupted` 并保留已合并 partial text；若已有 native event 证明 delivered，`delivery_certainty` 保留 `delivered`，否则保留 `unknown`，终态不明用独立 bounded reconciliation outcome 表达；
- 不使用 `unknown_after_restart` 作为 Turn 状态，也不从 terminal 回到 running；
- 不自动创建第二个模型 Turn；UI 提供显式“继续会话”或“新建重试”，并保留因果引用。

### 5.3 Structured session 与历史 Direct invocation

- 历史 Direct attempt 保留原 terminal、delivery certainty 和 native session ID，但当前 runtime 不 claim、不 resume、不 replay；
- Codex App Server 记录 thread ID；只有 capability verified 后才使用 `thread/resume`；
- Grok/Kimi/Hermes 只有在各自 capability evidence 支持时才使用 ACP `session/load`；
- Structured 原生 resume/load 不支持、未取得 session ID 或失败时，只为后续新 Turn 建立新 session，并注入 GroupX Context Packet；
- `prompt_invoked` 或更晚阶段的当前 Turn 不因连接丢失、恢复失败或终态不明而自动重放；
- 新 session 属于同一稳定 actor，但有新的 binding/instance lineage；
- 不把“上下文重建”描述成“原生 session resume”。

## 6. 公共记忆

### 6.1 产生方式

公共记忆只能由以下方式产生：

- 用户在 Web UI 显式固定；
- Structured Agent 通过 GroupX MCP 显式调用 `groupx.memory.remember`；
- 系统生成滚动摘要，且 `kind=summary/source_kind=generated_summary`。

普通聊天内容不会自动成为公共 MemoryRecord；成功 Agent Turn 会按第 6.3 节自动形成该 Agent 自己的 dated memory。

### 6.3 Agent 核心记忆与日期记忆

- `core`：长期、少量、显式维护。`core_memory_remember` 的 wire input 不含 scope、subject、author 或 binding，Broker 始终从当前 Structured binding 固定为调用 Agent 自己；Web Agent 设置也可追加、替换或撤回 core。
- `dated`：每个成功 Turn 自动追加一条 episodic 记录，包含有界的当前 `message.created` 与最终 response。失败、取消或 interrupted Turn 不写 dated；reasoning、tool progress、stderr 与 native payload 永不进入。
- 自动记录与 response/terminal 在同一个 SQLite immediate transaction 中提交；terminal CAS 保证重试不会生成第二条日期记忆。
- dated 记录在其 response 仍已由 unread transcript/reply chain 表示时不重复注入 Context Packet；跨过 delivery cursor 或房间摘要边界后才作为该 Agent 的私有日期记忆参与预算。

### 6.2 冲突与纠正

不原地覆盖：

- 新记录可以 `supersedes` 旧记录；
- 撤回使用 tombstone/retracted status；
- 相互冲突的记录可以并存；
- 检索默认返回 active 版本，同时允许查看历史；
- source event 和 author 必须保留。

M0-M2 不实现自动事实仲裁或“真相分数”。

## 7. 身份记忆

IdentityRecord 是 GroupX 群组层的身份叠加，不是 CLI 全局 persona 或配置文件。

允许的来源：

- 用户对某 Agent 的群内角色/偏好说明；
- Agent 对自己的显式 identity.remember；
- 其他 Agent 对某 Agent 的观察，但必须保留 `author != subject`，且不自动转成 subject 的自我认定。

示例：

```text
subject = agent:grok
author  = agent:codex
kind    = note
content = "Grok 在本轮更关注协议互操作"
```

这是一条 Codex 对 Grok 的观察，不是 Grok 的稳定身份事实。

IdentityRecord 没有以下专用字段：

- API key、登录令牌；
- CLI config 正文；
- 本地私有密钥路径；
- 未经显式选择的大段原生会话历史；
- 其他 Agent 作为 subject 自我来源写入的记录。

普通文本内容按提交值保存；GroupX 不扫描 identity/memory 正文来识别 API key、令牌或其他秘密。上述边界表示 GroupX 不主动采集 CLI 运行态数据，并不构成内容安全承诺。

## 8. Context Packet

每次发往 Adapter 的 Context Packet 是独立结构，不篡改原始目标消息：

```text
[groupx_protocol]
[configured_agent_identity]
[self_identity]
[agent_core_memory]
[agent_dated_memory]
[pinned_group_memory]
[relevant_memory]
[room_checkpoint_summary]
[room_delta_since_cursor]
[reply_chain]
[current_message]
```

Agent 设置中的稳定身份、滚动摘要、当前消息和完整 reply chain 是强制区段。滚动摘要是已省略旧 transcript 的覆盖证明，因此不能先推进 cursor 再丢掉摘要。其余可选区段优先保留 Agent core，再保留近期 room delta、Agent dated、公共记忆和兼容身份记录。

`turn.reasoning.recorded` 与 `tool.progress.recorded` 是可回放的 UI/审计记录，不是 Context Packet 区段。未读 transcript、reply chain 与压缩输入都只从 `message.created` 投影；两类记录不得被摘要、自动记忆或再次发送给任一 Agent。

`memory_records.scope_type=agent` 且 `scope_id=agent:<id>` 的记录只进入该目标 Agent 的 Context Packet。Web 在 Agent 设置中把 core 独立列出，把 dated 按 `created_at` 的本地日期分组；公共记忆仍使用 `scope_type=room` 并位于群聊左栏，三者不会相互提升或复制。Agent 稳定身份同样在 Agent 设置中写入配置，主界面不保留右侧记忆栏。

默认硬上限为 `256,000` 字符，可配置；该值不是 token 数。Room Context Engine 在约 `75%` 的软目标（默认 `192,000` 字符）将省略 unread transcript 时触发，并以“旧检查点 + 有界旧消息块”滚动生成下一检查点，为原生 instructions、工具和回复保留余量。不可压缩的强制区段可以使用到硬上限。生成者是配置顺序中第一个健康 Agent；不可用或返回无效摘要时尝试下一个健康 Agent。

Web 输入区域右上角的用量是 active checkpoint 加其后 `message.created` 及协议开销的保守字符估算，不是 token 计数。用户可通过 Broker 的幂等命令显式压缩；它复用同一累计摘要 CAS，并保留最近 12 条消息原文。该操作不删除 transcript，不读取 reasoning/tool 记录，也不直接推进任一 Agent 的 delivery cursor。

压缩 session 不挂载 GroupX MCP，不形成公开聊天 Turn，也不让压缩任务主动调用其他 Agent。若所有 Agent 都失败，当前业务 Turn 以 `CONTEXT_BUDGET_EXCEEDED` 结束；原文、旧摘要和 delivery cursor 保持不变。

压缩状态仅用 transient SSE 提示，不进入 `events` 表。只对生成阶段可确认的临时 session/transport 错误做有界退避重试；摘要校验或持久化失败不自动重写。只有完整生成、校验并通过摘要 CAS 后才发布 completed 并替换 active summary。会话启动重试同样不能放宽 Turn 的交付不确定边界：prompt 一旦可能送达便禁止自动 replay。

Context Packet 中每条记忆应带最小来源标签，例如：

```text
source=user
source=self
source=agent:codex-about-agent:grok
source=generated-summary
```

## 9. 检索

M2 首版支持：

- scope/kind/author/subject 过滤；
- 最近性排序；
- SQLite FTS 文本搜索；
- source event 回链；
- active/history 选择。

首版不引入向量数据库。只有真实检索质量证据证明 FTS 不足时再新增可重建的向量索引。

## 10. 数据保留、导出与备份

- 数据库默认位于 `.groupx/groupx.db`，Git 忽略；
- WAL/SHM 同样忽略；
- 支持在线一致性 backup API 或 SQLite backup 机制，不直接复制活跃 WAL 组合；
- JSONL 导出按 durable seq 排序，包含 schema version；
- 导出默认保留 durable seq、Turn transport、公开 provenance 与 memory/identity 的 author/subject/source/supersedes；排除 native session ID、binding ID、native interaction payload、stderr 和诊断私有字段；
- 恢复导入需要独立校验和新数据库，不覆盖原数据库；
- 数据库迁移必须有 schema version 和可验证 rollback/backup 说明。

## 11. 诊断数据最小化

GroupX 诊断日志只记录实现合同需要的有界字段：

- Adapter 名称、状态、耗时；
- GroupX 实际追加的协议 argv 结构；
- 协议 method/event type；
- 关联 ID 的短前缀；
- 限长错误摘要和错误码。

完整环境、CLI 配置、原始 stderr、未建模的 native interaction payload 和原生认证交换不属于 GroupX 诊断数据模型，因此不主动采集或导出。固定 unrestricted argv/mode 的结构摘要可以记录，以证明运行合同生效；限长或字段级替换只是可观测性卫生，不是秘密检测保证。

用户或模型提交到 transcript、memory 或 identity 正文的内容按产品语义持久化。GroupX 不负责识别、删除或阻止其中的凭据、秘密或其他敏感文本；用户决定是否写入和导出这些内容。

## 12. 存储验收

1. 重复 client command 不新增 message 或 Turn。
2. 相同幂等键、不同 payload 返回 conflict。
3. message 与目标 Turns 原子提交。
4. 三个 Adapter 不能直接打开数据库写入。
5. 10,000 durable events 能按 cursor 分页，不全量重建发送。
6. token delta 不导致数据库逐 token 增长。
7. queued 在重启后恢复；running 不自动重放。
8. public/identity memory 重启后保持 author/subject/source/supersedes。
9. 摘要失效不影响原 transcript；滚动替换保持单 active 摘要和完整历史。
10. 长房间触发压缩后，Context Packet 同时包含累计检查点与近期逐条原文；只有确认 native start 后 `last_summary_seq` 才推进。
11. 压缩 Agent 失败时不更新摘要或 cursor，业务 Turn 产生明确 terminal failure；不得静默漏历史。
12. 默认导出只包含合同定义的公共事件/记忆字段，不带 binding、native session、raw stderr 或未建模的原生 payload。
13. Structured binding 按 active 合同持久化；历史 Direct invocation 仍可读取与恢复其已有语义，但状态明确为 deprecated，不形成新 Gate 或跨 transport fallback。
14. binding 的 transport、协议、实测 capability 与 instance lineage 可查询；重建 process/session 不修改稳定 actor 或历史 Turn。
15. schema 中不存在 approval table；native interaction request 只形成一次 terminal failure，重启后没有 pending approval 可恢复。
16. 默认 transport 是 Structured；同一运行全部已配置 Agent 的 Turn、binding、instance transport snapshot 一致，attempt 从 Turn 推导，不重复存列；请求不能覆盖 transport/access。
17. SQLite-backed SSE cursor tail 在历史补齐与 commit 唤醒之间不丢 durable event。
18. 推理 delta 不逐条落库；terminal transaction 最多生成一条聚合 `turn.reasoning.recorded`，刷新后可回放。
19. live `tool.progress` 不直接落库；terminal transaction 保存其 started/completed 有界投影，刷新后仍合并为折叠记录。
20. `turn.reasoning.recorded` 与 `tool.progress.recorded` 均不进入 Context Packet、reply chain、房间压缩或自动记忆。
