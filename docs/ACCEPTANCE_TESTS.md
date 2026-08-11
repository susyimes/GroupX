# GroupX 验收测试矩阵

状态：Draft v0.1
当前执行状态：尚未实现或运行测试

## 1. 测试原则

- 测试验证用户可观察语义，不只验证函数被调用；
- fake transport 证明状态机，真实 CLI probe 证明本机互操作，两者不能相互替代；
- 所有可重复用例使用固定 `clientCommandId`、correlation 和脱敏 fixture；
- 真实 CLI 测试不修改全局配置、不制造权限绕过、不执行有副作用工具；
- Broker、Adapter、Browser、存储的失败必须分别归因；
- 未观察到的能力标为 `NOT_OBSERVED`，不写成 PASS；
- 任何真实测试证据在进入 Git 前必须 secret scan。

事实等级沿用 [M0_TRANSPORT_SPIKE.md](M0_TRANSPORT_SPIKE.md)：documented、advertised、probed、verified、degraded、unsupported。

## 2. 测试层级

| 层级 | 目标 | 是否使用真实 CLI |
| --- | --- | --- |
| unit | Envelope、路由、状态机、幂等、记忆版本、脱敏 | 否 |
| adapter fixture | 原生 JSON-RPC/ACP 事件归一化、approval、异常 | 否 |
| adapter live | 安装版本握手、session、stream、cancel、resume、MCP | 是 |
| integration | Broker + SQLite + fake/live Adapter + SSE | 分开运行 |
| browser e2e | 用户发送、并行回复、sender、memory、approval UI | fake 为必跑，live 为显式运行 |
| recovery | Broker/Adapter 强制退出和数据库恢复 | fake 必跑，live 选择性运行 |
| performance | Broker 自身延迟、背压、分页、内存 | fake Adapter |

CI 默认不得依赖用户登录态。真实 CLI suite 单独标记并由明确命令启动。

## 3. M0 传输

M0-01 至 M0-15 的完整定义见 [M0_TRANSPORT_SPIKE.md](M0_TRANSPORT_SPIKE.md)。

M0 完成输出：

```text
docs/generated/M0_CAPABILITY_MATRIX.md
docs/generated/m0-capabilities.json
```

这些文件只有在真实运行并脱敏后创建。本次文档阶段不得预填 PASS。

## 4. 协议与身份

| ID | 用例 | 通过标准 |
| --- | --- | --- |
| P-001 | Codex 正文写“我是 Grok” | Envelope actor 和 UI badge 仍为 `agent:codex` |
| P-002 | MCP 调用试图携带 `from=agent:grok` | schema 拒绝或忽略该字段，来源仍由 binding 生成，并记录协议错误 |
| P-003 | Web 请求试图携带 `from` | 不采用该值；消息 actor 固定为 `user:web` |
| P-004 | Adapter 重启 | 新 instance/binding，稳定 actor 不变，lineage 可查询 |
| P-005 | 两个 Codex 实例 | `agent:codex/main` 与 `agent:codex/reviewer` 可区分，不共用匿名 binding |
| P-006 | 转发 Kimi 消息 | 转发者 actor 不变，原作者从引用事件读取，不能篡改 `forwardedFrom` |
| P-007 | author 与 subject 不同的身份观察 | 保留两个 actor，不提升为 subject 自我身份 |
| P-008 | 未知 actor/target | 返回明确错误，不创建半条 message 或 Turn |

## 5. 路由与群聊语义

| ID | 用例 | 通过标准 |
| --- | --- | --- |
| R-001 | 用户只选择 Grok | 只有 Grok 新建 Turn；消息仍在公共 transcript/UI 可见 |
| R-002 | 用户 `@all` | 三个 Turn 在一次事务创建，commit 后跨 lane 并行启动 |
| R-003 | Codex 普通回复正文含 `@kimi` | Kimi 不被唤醒 |
| R-004 | Codex `groupx.send(kimi)` | 创建公开 message 与一个 Kimi Turn，工具立即返回 IDs |
| R-005 | 未被寻址的 Grok 后续被用户唤醒 | Context Packet 或 read 可看到此前公共消息增量，但此前没有额外 Grok Turn |
| R-006 | Agent `@all` | 唤醒其他启用 Agent，默认不唤醒发送者自己 |
| R-007 | reply 不带 recipients | reply 关系保留，但不因 reply 自动创建新 Turn |
| R-008 | 一个 `@all` 目标失败 | 其他目标继续并独立产生 terminal 结果 |

## 6. send、ask、read

| ID | 用例 | 通过标准 |
| --- | --- | --- |
| C-001 | `groupx.send` | 持久化后立即返回 message/correlation/turn IDs，不等待目标模型 |
| C-002 | `groupx.read(correlation)` | 返回逐目标 queued/running/terminal 状态与公开回复引用 |
| C-003 | Codex `groupx.ask(grok)` | Grok 回复写入房间，并作为 Codex 当前 MCP 工具结果返回 |
| C-004 | 多目标 ask | 并行派发，逐目标返回；一个失败不覆盖其他结果 |
| C-005 | A ask B，B ask A | B 的同步 ask 返回 `CAUSAL_CYCLE`，两侧不死锁 |
| C-006 | B 在上例改用 send(A) | 异步消息被接受，不阻塞 B 当前 Turn |
| C-007 | ask timeout | 默认只停止等待，目标保持真实状态并可 read；`cancelOnTimeout=true` 时发起 best-effort cancel，不伪造成 completed |
| C-008 | ask 调用方自身 Turn 被取消 | 等待被解除，未 terminal 的同步 ask child 被 best-effort 取消；异步 send child 不受影响 |
| C-009 | 重复工具调用相同 client ID | 返回原结果，不创建第二个目标 Turn |
| C-010 | 相同 client ID 不同 payload | 返回 `CLIENT_COMMAND_CONFLICT` |

## 7. Turn、队列与取消

| ID | 用例 | 通过标准 |
| --- | --- | --- |
| T-001 | 同一 Agent 两条消息 | FIFO 单飞；第二条在第一条 terminal 后启动 |
| T-002 | 不同 Agent 两条消息 | 可并行 streaming |
| T-003 | Adapter 首事件超时 | 仅该 Turn failed，其他 Adapter 不受影响 |
| T-004 | Adapter 输出非法 JSON | 明确 protocol error；不会把 stderr 当正文 |
| T-005 | 用户取消 queued Turn | 不发给原生 CLI，terminal=cancelled |
| T-006 | 用户取消 running Turn | 调用原生 cancel；最终状态以原生/超时证据决定 |
| T-007 | cancel timeout | 标记明确错误，不宣称已取消，不终止其他 Adapter |
| T-008 | CLI 进程退出 | 对应非终态 Turn interrupted，其他 lane 继续 |
| T-009 | 达到 per-Agent queue 上限 | 创建可见 capacity error，不静默丢消息 |
| T-010 | 达到 root turn/hop 限制 | 创建 `routing.loop_stopped`，因果链可查询 |

## 8. 幂等与事务

| ID | 用例 | 通过标准 |
| --- | --- | --- |
| D-001 | message 接受中模拟事务失败 | message 和所有目标 Turn 全部不存在 |
| D-002 | commit 后、dispatch 前崩溃 | queued Turn 重启后恢复 |
| D-003 | dispatch 后、terminal 前崩溃 | Turn 变 interrupted/unknown，不自动重放 |
| D-004 | 重复 REST clientCommandId | 返回原 acceptance 结果，不重新唤醒 |
| D-005 | 三目标中一条 Turn 插入冲突 | 整个 command transaction 失败，不形成部分 fan-out |
| D-006 | 同一 source event + target 重复 dispatch | 唯一约束拒绝第二个 Turn |
| D-007 | durable event SSE 顺序 | 按数据库 seq；重连补齐后无重复语义事件 |
| D-008 | transient delta | 不逐 token 增长数据库；final message 唯一持久化 |

## 9. 恢复

| ID | 用例 | 通过标准 |
| --- | --- | --- |
| X-001 | Broker 正常重启 | 消息、Turn、Session、Memory、Identity 和 cursor 恢复 |
| X-002 | Codex native resume | 若 M0 verified，使用记录 thread ID 恢复并继续 Turn |
| X-003 | ACP session/load | 仅 capability verified 时使用；成功后继续 prompt |
| X-004 | 原生 resume unsupported | 新建 session + Context Packet，UI/报告明确 degraded |
| X-005 | running Turn 状态未知 | UI 显示 unknown/interrupted，不自动重复可能有副作用的执行 |
| X-006 | SQLite WAL 崩溃恢复 | 数据库通过 integrity check；已提交事务存在，未提交事务不存在 |
| X-007 | 迁移失败 | 原数据库/backup 保持可恢复，服务不带半迁移 schema 启动 |

## 10. 公共记忆与身份记忆

| ID | 用例 | 通过标准 |
| --- | --- | --- |
| M-001 | 普通聊天 | 不自动创建 MemoryRecord |
| M-002 | 用户固定公共事实 | 保存 author/source event/scope/kind，重启可检索 |
| M-003 | Agent memory.remember | author 由 binding 得到，不能指定其他 author |
| M-004 | 自动滚动摘要 | kind/source 明确为 summary，不覆盖 transcript |
| M-005 | supersede | 新旧记录与来源都保留，默认查询返回 active 新版本 |
| M-006 | retract | tombstone 生效，历史仍可审计 |
| M-007 | Codex 评价 Grok | author=codex、subject=grok，不变成 Grok self identity |
| M-008 | Grok identity.remember | subject 固定为 Grok，自我来源明确 |
| M-009 | Context Packet 超预算 | 按定义优先级裁剪，当前消息/发送者/reply chain 不丢 |
| M-010 | FTS 不可用 | 明确 degraded 或 M2 gate 失败，不静默假装语义检索 |
| M-011 | 敏感字段 | API key、token、完整 config/env 不进入 memory/identity |

## 11. 原生权限继承

| ID | 用例 | 通过标准 |
| --- | --- | --- |
| A-001 | 启动 argv 审计 | 只有 binary、协议子命令、stdio/cwd 和已记录 MCP binding；无 model/sandbox/approval/YOLO 覆盖 |
| A-002 | CLI 配置前后 hash | 用户配置不变；native runtime/session 文件变化单独分类 |
| A-003 | 原生配置自动允许 | GroupX 不新增 approval prompt |
| A-004 | 原生配置请求 approval | UI 显示原生类型和 options，只能返回原生 option |
| A-005 | UI 不响应 approval | pending/timeout/cancel，绝不自动允许 |
| A-006 | CLI 拒绝 GroupX MCP | GroupX 不绕过；记录原生拒绝或 unsupported |
| A-007 | Adapter 崩溃重启 | 不偷偷使用更宽松启动参数恢复 |

fixture 测试可覆盖 approval 状态机，但只有真实 native request 才能标为 live verified。用户配置没有触发时记录 `NOT_OBSERVED_BY_NATIVE_CONFIG`。

## 12. Web 与本地传输

| ID | 用例 | 通过标准 |
| --- | --- | --- |
| W-001 | 默认监听 | 仅 `127.0.0.1`/loopback |
| W-002 | 外部 Origin/preflight | 拒绝；不能提交 JSON command |
| W-003 | 模型输出 `<script>` | 作为文本或安全 Markdown 显示，不能执行 |
| W-004 | path traversal | 静态服务器不读取 web root 外文件 |
| W-005 | SSE 断开重连 | 使用 Last-Event-ID 补 durable events |
| W-006 | 慢 SSE 客户端 | 不阻塞 Broker；delta 合并/丢弃后可重连获得 final |
| W-007 | 两个浏览器 tab 重试 | client ID 幂等独立稳定，不产生意外冲突或重复 Turn |
| W-008 | approval 关闭页面再打开 | pending 状态可恢复，未被自动处理 |

这些边界是 localhost 传输和渲染安全，不是 CLI 文件/工具权限系统。

## 13. 凭据与脱敏

| ID | 用例 | 通过标准 |
| --- | --- | --- |
| S-001 | stderr 含假 token fixture | 日志/事件/report 中被替换或拒绝持久化 |
| S-002 | env dump 异常 | 不记录完整 env，只输出允许字段 |
| S-003 | native approval 含敏感命令 | durable event 只保存白名单/脱敏摘要 |
| S-004 | capability report | native session ID 脱敏，认证字段不存在 |
| S-005 | JSONL 导出 | 排除 binding/native session/raw stderr/approval private fields |
| S-006 | Git secret scan | tracked 文件没有 credential-like value |

## 14. 性能与规模

指标不包含模型推理、CLI 内存和上游网络时间。

| ID | 指标 | M1/M2 目标 |
| --- | --- | --- |
| F-001 | POST accepted p95 | `< 50 ms` |
| F-002 | commit 到 Adapter enqueue p95 | `< 25 ms` |
| F-003 | durable event 到 SSE 可见 p95 | `< 100 ms` |
| F-004 | `@all` 三目标开始派发时间差 | `< 100 ms` |
| F-005 | delta 合并窗口 | `20-50 ms` 可配置范围内 |
| F-006 | 10,000 durable events | bootstrap 不全量发送；cursor 分页与恢复正确 |
| F-007 | 一个 CLI 悬挂 | 其他两个 lane 延迟不被其队列阻塞 |
| F-008 | 慢 Browser | Broker 写入/Adapter 消费不被 SSE socket 阻塞 |
| F-009 | 重启恢复 | queued 数量与恢复结果一致，running 无自动重放 |

## 15. 里程碑 Gate

测试编号的最早强制里程碑：

```text
M0: M0-01..M0-15
M1: P-001,P-003,P-004,P-006,P-008;
    R-001,R-002,R-003,R-007,R-008;
    T-001..T-010; D-001..D-008;
    X-001,X-005,X-006,X-007;
    W-001..W-008; S-001..S-006; F-001..F-009
M2: P-002,P-007; R-004,R-005,R-006;
    C-001..C-010; X-002,X-003,X-004;
    M-001..M-011; A-001..A-007
M3: P-005 以及新增 Adapter/A2A 兼容套件
```

较早里程碑可以提前实现后续测试，但不能用后续功能失败阻塞前一个里程碑。

### M0 Gate

- M0-01 至 M0-15 有脱敏结论；
- 三个 Adapter 至少 handshake/session/prompt/stream 可用；
- cancel/resume/MCP/approval 均有明确 PASS/unsupported/not-observed/degraded；
- 配置不变与 secret scan 通过。

### M1 Gate

- P、R、T、D、W、S 的 M1 范围通过；
- 浏览器可完成单目标和 `@all`；
- sender、SSE reconnect、故障隔离与基础性能通过；
- 无 Agent-to-Agent MCP 和 Memory 不算 M1 缺陷，它们属于 M2。

### M2 Gate

- C、M、A、X 全部必需语义通过；
- `send/ask/read`、因果循环、memory provenance、identity subject/author 通过；
- 原生 resume 不支持时降级明确；
- v0.1 完成标准全部满足。

### M3 Gate

- 新 Adapter 通过同一 contract suite；
- A2A 只作为边缘 Adapter，不改变内部 Envelope/身份/权限语义；
- 数据迁移和向后兼容测试通过。

## 16. 测试交付证据

每个里程碑至少交付：

```text
测试命令
版本和 capability snapshot
通过/失败/跳过数量
失败原因与 unsupported 边界
性能摘要
配置不变证据
secret scan 结果
Git diff scope
```

不能以“进程启动”“单元测试使用 fake response”或“CLI help 存在命令”替代真实端到端完成声明。
