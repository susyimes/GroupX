# GroupX 存储与记忆设计

状态：Draft v0.1

## 1. 权威来源

SQLite/WAL 是 GroupX 唯一权威事实源。Broker 是唯一写入者。

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
| sessions/capabilities | 是 | 是 | 原生会话及实测能力 |
| final messages | 是 | 是 | 完成或明确 partial 的正文 |
| token delta | 否 | 否 | 仅 live SSE，短时内存合并 |
| public memory | 是 | 是 | 显式记忆、来源可追溯 |
| identity memory | 是 | 是 | 群组层身份记录，不替换 CLI 原生身份 |
| generated summary | 派生 | 是 | 标记 summary，可重新生成 |
| raw approval payload | 否 | 默认否 | 只持久化白名单/脱敏字段 |
| raw stderr/env/config | 否 | 否 | 不允许进入长期存储 |

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

### 3.2 agent_instances

```sql
agent_instances(
  instance_id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  process_started_at TEXT NOT NULL,
  process_ended_at TEXT,
  status TEXT NOT NULL,
  FOREIGN KEY(actor_id) REFERENCES actors(actor_id)
)
```

不存 PID 作为稳定身份。PID 可以进入瞬时诊断，不作为恢复依据。

### 3.3 session_bindings

```sql
session_bindings(
  binding_id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
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

`native_session_id` 允许为 null，因为握手失败或某实现无持久 ID。API 默认不返回完整 native ID。

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

### 3.6 turns

```sql
turns(
  turn_id TEXT PRIMARY KEY,
  source_event_id TEXT NOT NULL,
  target_actor_id TEXT NOT NULL,
  adapter_id TEXT NOT NULL,
  binding_id TEXT,
  native_turn_id TEXT,
  parent_turn_id TEXT,
  root_correlation_id TEXT NOT NULL,
  hop_count INTEGER NOT NULL,
  enqueue_seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  partial_text TEXT,
  final_event_id TEXT,
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
dispatched
streaming
completed
failed
cancelled
interrupted
unknown_after_restart
```

### 3.7 delivery_cursors

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

该表用于构建增量 Context Packet，不表示用户已读回执。

### 3.8 memory_records

```sql
memory_records(
  memory_id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
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

### 3.9 identity_records

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

### 3.10 summaries

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

摘要永远是派生数据。删除/失效摘要不能删除原事件。

## 4. 事务不变量

### 4.1 接受消息

一次用户或 Agent 发送必须在一个事务中完成：

1. 插入或命中 `client_commands`；
2. 插入 source `message.created` event；
3. 为每个目标插入唯一 Turn；
4. 写入 command result；
5. commit。

只有 commit 成功后才能向 Adapter 派发。这样不会出现“CLI 已收到但消息账本不存在”。

### 4.2 结束 Turn

Turn terminal transaction：

1. 插入最终 `message.created` 或明确的失败事件；
2. 更新 Turn terminal 状态及 final event 引用；
3. 更新 delivery cursor；
4. commit；
5. 广播 durable SSE event。

transient delta 可以在 commit 前实时广播，但 UI 必须把它显示为未完成状态。

### 4.3 approval

approval request 的待处理记录和脱敏事件必须先 commit，再显示给 UI。resolve 必须使用 compare-and-set：只有 pending request 能被回答一次。

## 5. 崩溃恢复

### 5.1 queued

数据库中仍为 `queued` 且没有 dispatch 证据的 Turn可以重新加入 Agent lane。

### 5.2 dispatched/streaming

Broker 无法仅凭本地状态判断原生 CLI 是否已执行工具或产生副作用，因此：

- 启动时标记为 `interrupted`；
- 保存已合并的 partial text；
- 若原生协议支持查询/恢复，先尝试关联原 native Turn/session；
- 无法确认时改为 `unknown_after_restart`；
- 不自动创建第二个模型 Turn；
- UI 提供显式“继续会话”或“新建重试”，并保留因果引用。

### 5.3 session

- Codex 首选记录 thread ID 并执行 `thread/resume`；
- Grok/Kimi 只有在现场 capability 声明并验证 `session/load` 后才做原生恢复；
- 原生恢复不支持或失败时，新建 session，并注入 GroupX Context Packet；
- 新 session 属于同一稳定 actor，但有新的 binding/instance lineage；
- 不把“上下文重建”描述成“原生 session resume”。

## 6. 公共记忆

### 6.1 产生方式

公共记忆只能由以下方式产生：

- 用户在 Web UI 显式固定；
- Agent 显式调用 `groupx.memory.remember`；
- 系统生成滚动摘要，且 `kind=summary/source_kind=generated_summary`。

普通聊天内容不会自动成为 MemoryRecord。

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

IdentityRecord 不保存：

- API key、登录令牌；
- CLI config 正文；
- 本地私有密钥路径；
- 未经显式选择的大段原生会话历史；
- 其他 Agent 伪装成 subject 写入的记录。

## 8. Context Packet

每次发往 Adapter 的 Context Packet 是独立结构，不篡改原始目标消息：

```text
[groupx_protocol]
[self_identity]
[pinned_group_memory]
[relevant_memory]
[room_delta_since_cursor]
[reply_chain]
[current_message]
```

优先级由低到高：

```text
generated summary
older room delta
relevant memory
pinned memory
self identity
reply chain
current message
```

超出预算时从低优先级开始裁剪。当前消息、发送者和目标不可被摘要替代。

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
- 导出默认排除 native session ID、binding ID、raw approval、stderr 和诊断私有字段；
- 恢复导入需要独立校验和新数据库，不覆盖原数据库；
- 数据库迁移必须有 schema version 和可验证 rollback/backup 说明。

## 11. 脱敏与日志

日志只允许：

- Adapter 名称、状态、耗时；
- 脱敏 argv；
- 协议 method/event type；
- 关联 ID 的短前缀；
- 限长错误摘要和错误码。

禁止：

- 完整环境变量；
- API key/token/cookie；
- 完整 CLI 配置；
- 原始认证消息；
- 未经用户选择的完整 private prompt；
- 将 stderr 当成安全的公开文本。

M0 证据包必须经过 secret scan 后才能进入可跟踪文件。

## 12. 存储验收

1. 重复 client command 不新增 message 或 Turn。
2. 相同幂等键、不同 payload 返回 conflict。
3. message 与目标 Turns 原子提交。
4. 三个 Adapter 不能直接打开数据库写入。
5. 10,000 durable events 能按 cursor 分页，不全量重建发送。
6. token delta 不导致数据库逐 token 增长。
7. queued 在重启后恢复；running 不自动重放。
8. public/identity memory 重启后保持 author/subject/source/supersedes。
9. 摘要失效不影响原 transcript。
10. 导出不包含凭据、binding/native session 私有字段。
