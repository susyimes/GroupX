# GroupX 验收测试矩阵

状态：Draft v0.1
日期：2026-08-11

## 1. 测试原则

- fake transport/fixture 证明 GroupX 状态机；真实 CLI probe 证明本机互操作，两者不能互换；
- Structured 记录 Agent、CLI version、transport、`accessContract=unrestricted-v0.1`、run ID 与 evidence；Direct evidence 只作为 deprecated 历史参考；
- Structured 是 v0.1 唯一 runnable/release transport；Direct runtime 入口必须保持关闭并标记 deprecated；
- `documented/advertised/probed` 不能冒充 `verified`；另一 transport 或旧 access 合同不能借 PASS；
- GroupX 没有审批系统。native interaction fail-closed fixture 的测试可以 PASS，但其预期 Turn 结果是 failed；
- 自动 fallback、已派发 Turn replay、隐藏能力降级和跨 transport 恢复都使验收失败。

## 2. 测试层级

| 层级 | 覆盖 | 是否需要 native CLI |
| --- | --- | --- |
| unit | Envelope、binding、幂等、Context Packet、错误归类 | 否 |
| broker integration | SQLite、Turn/attempt、恢复、SSE cursor、memory/identity | 否 |
| Direct fixture | JSON/JSONL、exit、stderr、取消、interaction detection | 否 |
| Structured fixture | App Server/ACP wire、session、cancel、resume、interaction detection | 否 |
| native live | 3 Agent × Structured 的 fixed unrestricted profile 与实际能力 | 是 |
| MCP integration | `send/ask/read`、binding、因果循环、native actual call；仅 Structured | fixture 必跑；Structured live 必跑 |
| browser e2e | 发送、并行回复、sender、memory/identity、无审批 UI | fake 必跑；live 显式运行 |
| performance | 测量 Structured Broker/session/stream 延迟 | native 模型耗时不计入 Broker 指标 |

## 3. 启动配置与固定 access

| ID | 用例 | 通过标准 |
| --- | --- | --- |
| G-001 | 配置省略 transport | 启动选择为 `structured`，三个 Agent 相同 |
| G-002 | transport=`direct` / `structured` | Structured 正常启动；Direct 在配置解析与 programmatic runtime 入口 fail-closed，且未打开运行时资源 |
| G-003 | POST message 带 transport/access | 返回 `INVALID_ENVELOPE`，不能按 Turn 覆盖 |
| G-004 | access 配置项 | schema 不提供；任何值都不能改变内部 `unrestricted` 常量 |
| G-005 | transport 启动失败 | Turn 明确失败，不自动切到另一 transport |
| G-006 | 重启后 queued Turn transport snapshot 不同 | `TRANSPORT_MODE_MISMATCH`，不跨 transport 派发 |
| G-007 | Kimi 官方默认全局配置 | global permission=`manual` 或配置键缺省不阻断 Structured ACP；new/load 后在首 prompt 前成功发送 `session/set_mode(auto)` |
| G-008 | Kimi session mode 负向 | `session/set_mode(auto)` 的明确 native policy 拒绝为 `NATIVE_POLICY_BLOCKED`；普通协议失败按 Adapter 错误收敛；不写全局配置、不 fallback |

精确 native profile：

| Agent | Direct（deprecated reference，不可启动） | Structured |
| --- | --- | --- |
| Codex | 新会话：`codex --yolo --dangerously-bypass-hook-trust exec --json -`；续会话：同一前缀 `exec resume --json <sessionId> -` | `codex --dangerously-bypass-hook-trust app-server --listen stdio://`；thread start/resume 为 `approvalPolicy="never"`、`sandbox="danger-full-access"` |
| Grok | flags 在前：`--no-auto-update --permission-mode bypassPermissions --sandbox off --no-plan [--resume <sessionId>] --output-format streaming-json --single <prompt>` | 同一 flags 在前，追加 `agent stdio` |
| Kimi | deprecated Direct 参考实现保留 preflight 后的 one-shot argv | `kimi acp`；不要求 global default mode；new/load（含 Adapter resume）后首 prompt 前 `session/set_mode {sessionId,modeId:"auto"}` |

Kimi ACP 不读取 global defaults 作为启动门禁；mode 不持久化，任何新建或恢复 session 都要重设。Codex thread sandbox 必须是当前 0.147 wire 的 kebab-case `danger-full-access`；不能误用 `dangerFullAccess`。

## 4. M0 Structured Gate 与 deprecated Direct 矩阵

`M0-01..M0-15` 的完整定义见 [M0_TRANSPORT_SPIKE.md](M0_TRANSPORT_SPIKE.md)。Structured case 使用实际结果；Direct 适用 case 固定为 `DEPRECATED`，M0-07 为 `NOT_APPLICABLE`。

Direct 不再有“最低可用”发布合同。旧 argv/preflight/resume 实现与测试只保障兼容性维护时不误伤，不产生 active Gate 或产品能力声明。

Structured release 合同：三 Agent 都能用 fixed argv/mode 握手、建立/恢复 session、完成 Turn、取消后复用、可靠关闭，并完成 Structured MCP live actual call。任一 native interaction request 必须按负向合同失败 Turn。

当前 Structured Gate 已通过，且没有跨 transport 或沿用旧 non-unrestricted evidence：native run `20260811T130102169Z` 覆盖三 Agent 的 fixed argv/version、stream、sender provenance、actual MCP、cancel 后复用、配置不写与清理，fixture run `20260811T125831853Z` 覆盖负向合同。Direct 的两条后续 live/fixture run 仅保留为 deprecated historical evidence，`canSatisfyCurrentGate=false`。

## 5. 协议与 sender provenance

| ID | 用例 | 通过标准 |
| --- | --- | --- |
| P-001 | Deprecated Direct 历史 binding 回归 | 只验证旧记录投影，不启动 Direct runtime |
| P-002 | Structured Codex 正文自称 Grok | actor 仍来自 Codex session binding |
| P-003 | MCP 参数携带 `from=agent:grok` | 固定返回 `SENDER_FIELD_FORBIDDEN`；actor 仍只来自 Structured MCP binding |
| P-004 | Web 请求携带 sender/from/actor/provenance | 固定返回 `SENDER_FIELD_FORBIDDEN`，永不采用该值 |
| P-005 | Adapter 重启 | instance/binding 变化，稳定 actor 不变 |
| P-006 | Direct runtime 入口 | 配置/factory/runtime 均拒绝，零 CLI child |
| P-007 | UI badge | 只读 Envelope actor，不解析正文 |
| P-008 | Structured Turn 返回 `PROTOCOL_INVALID_MESSAGE` | 原 Turn 只失败一次且 prompt 不重放；并发恢复合并为一次 Adapter 重建，下一 Turn 使用新 instance/binding 正常完成 |

binding 是 provenance/correlation handle，不是 secret、token 或本机抗伪造认证机制。

## 6. 路由与群聊

| ID | 用例 | 通过标准 |
| --- | --- | --- |
| R-001 | 用户定向单 Agent | 只创建一个目标 Turn；消息公共可见 |
| R-002 | 用户 `@all` | 三 Turn 在不同 lane 并行，一个失败不取消其他两个 |
| R-003 | 普通正文包含 `@kimi` | 不创建额外 Turn |
| R-004 | reply/forward | 原作者从引用 Envelope 读取；转发 actor 是当前调用方 |
| R-005 | 重复 clientCommandId | 返回原结果，不重复派发 |
| R-006 | Direct 配置请求 | 明确失败并指向 Structured，不创建 Turn |

## 7. Structured MCP `send/ask/read`

| ID | 用例 | 通过标准 |
| --- | --- | --- |
| C-001 | Structured `groupx.send` | commit 后异步返回 correlation/turn IDs |
| C-002 | Structured `groupx.ask` | 目标结果进入 transcript，并作为当前 tool result 返回 |
| C-003 | Structured `groupx.read` | 按 correlation/cursor 查询异步结果 |
| C-004 | A ask B，B ask A | 后者返回 `CAUSAL_CYCLE`，不死锁 |
| C-005 | ask timeout 默认 | 停止等待但不强制取消目标，之后可 read |
| C-006 | ask timeout + cancelOnTimeout | best-effort native cancel，最终状态来自 terminal event |
| C-007 | 三 Structured Adapter native call | 都观察到真实 `tools/call`，actor 来自各自 binding |
| C-008 | descriptor/tools/list 无 actual call | 保持 PARTIAL/NOT_RUN，不升级 PASS |
| C-009 | Deprecated Direct runtime | 入口在 MCP attachment 之前已关闭，不创建 HTTP/MCP surface |
| C-010 | Structured MCP 未 verified 或 native policy blocked | 返回 `MCP_UNAVAILABLE`（503），不误用 `SESSION_NOT_AVAILABLE`，不改自然语言或 Direct fallback |
| C-011 | B 异步 `mcp.send(A)`，A 是祖先 actor | 允许入队，不报 `CAUSAL_CYCLE`；仍应用 hop/root/actor/queue 限额 |
| C-012 | child 伪造 parent/root/hop 或父链断裂 | Store 拒绝整个命令，不创建 message/Turn |
| C-013 | 非 `mcp.ask` 或未进入 `waitsForChildren` 的命令命中祖先 actor | 不应用 `CAUSAL_CYCLE`；只同步等待 ask 禁止 |

## 8. Turn、队列、取消与恢复

| ID | 用例 | 通过标准 |
| --- | --- | --- |
| T-001 | 同一 Agent 两 Turn | FIFO 单飞 |
| T-002 | 不同 Agent | 可以并行 |
| T-003 | terminal 重复/乱序 | 只接受一次 terminal，不回到 running |
| T-004 | Direct entry | fail-before-runtime；不产生需要取消的进程 |
| T-005 | Structured cancel | 先 native cancel/interrupt；随后 session/进程可按能力复用 |
| T-006 | write-ahead `prompt_invoked` marker 提交前崩溃 | `prepared + not_delivered` 且 transport 相同才可 CAS 重排 |
| T-007 | prompt 可能已送达后崩溃 | `unknown`；不得自动 replay 或换 transport |
| T-008 | 历史 Direct 进程失联记录 | 仅审计原 `interrupted/unknown`，当前 runtime 不恢复或 replay |
| T-009 | 历史 Direct resume evidence | 只保留 `canSatisfyCurrentGate=false` 的证据，不执行 live Gate |
| T-010 | Kimi Direct 旧 preflight | 仅兼容回归测试；公开入口始终先拒绝 Direct |
| T-011 | Structured resume/load | 只关联原 native session；失败不改走 Direct |
| T-012 | selected transport 与历史 snapshot 不同 | 旧 Turn 失败；显式新 Turn 才能使用新模式 |
| T-013 | 一个 Adapter malformed/timeout/exit | 其他 lane 与 Broker 继续运行 |
| T-014 | 关闭 | bounded cleanup，无遗留本次子进程树 |
| T-015 | marker 已提交、native prompt 调用前崩溃 | `prompt_invoked + unknown`，不自动 replay |
| T-016 | `cancelling + prepared + not_delivered` 后重启 | CAS 到 `cancelled`，不回 queued |
| T-017 | cancel 与 native completion 竞态 | 恰好一个 terminal；completion 抢先可合法收敛 completed |
| T-018 | delivered attempt 对账失败 | terminal 可为 interrupted，但 `delivery_certainty` 保留 delivered，不倒退 unknown |

## 9. Native interaction fail-closed

| ID | 用例 | 通过标准 |
| --- | --- | --- |
| A-001 | Codex approval/requestUserInput fixture | 有界 cancel/teardown，Turn failed=`UNEXPECTED_NATIVE_INTERACTION` |
| A-002 | Grok permission/question fixture | 同上；无 UI/REST/event/pending 状态 |
| A-003 | Kimi `session/request_permission` | 回复 `cancelled` 结清协议，再 `session/cancel`；Turn failed=`UNEXPECTED_NATIVE_INTERACTION` |
| A-004 | request 带 allow/deny 或 policy 字样 | 不持久化、不 relay、不选择；仍只能是 `UNEXPECTED_NATIVE_INTERACTION` |
| A-005 | 重启后 bootstrap | 没有 pending approval 或可恢复审批工作 |
| A-006 | ApprovalService/table/route/UI/event 静态审计 | active runtime/schema 全部不存在；migration 只可包含删除旧表的 `DROP`，不能创建或读取审批状态 |
| A-007 | 独立 preflight、startup/session 创建或 mode 设置拒绝的明确 enterprise/server/static deny evidence | `NATIVE_POLICY_BLOCKED`，公开状态 `native_policy_blocked` |
| A-008 | 任何 interaction request，包括 options/policy 字样或后续 stderr | 只能是 `UNEXPECTED_NATIVE_INTERACTION`，不得升级成 policy blocked |
| A-009 | interaction failure | 不 fallback、不 replay |
| A-010 | Codex `configRequirements/read {}` | null/缺失 requirements 视为无约束；显式 allowlist 缺 `never` 或 `danger-full-access` 时 `NATIVE_POLICY_BLOCKED` |
| A-011 | 配置传入 command object | 只接受 executable + 空 prefix，或 Node executable + 单一现存 JS entrypoint；拒绝 native flags、多 prefix、shell wrapper、`wrapperPrefixArgs`/`extraArgs`，不能改写 fixed unrestricted profile |

## 10. 幂等、事务与 SSE

| ID | 用例 | 通过标准 |
| --- | --- | --- |
| I-001 | 同 idempotency key + 同 payload | 返回相同结果 |
| I-002 | 同 key + 不同 payload | `CLIENT_COMMAND_CONFLICT` |
| I-003 | message + targets | source message、每目标 `turn.queued`、Turn 与 command result 单事务提交；`enqueue_seq` 来自 queued event，commit 后派发 |
| I-004 | attempt write-ahead | prompt 前已提交 `prompt_invoked + unknown` |
| I-005 | terminal transaction | 统一 terminal idempotency key + Turn CAS；final/failure、Turn、attempt、cursor 原子提交，跨 terminal type 也只有一条 |
| I-006 | SSE reconnect | 单一 DB cursor tail/cutover watermark 保证 durable seq 无缝补齐；不出现 replay/live 窗口丢事件 |
| I-007 | 慢客户端 | 可丢/并 transient delta，不丢 durable terminal；断开后 cursor 重连 |
| I-008 | durable publish | 按全局 seq 顺序，不按 callback 到达顺序 |
| I-009 | `afterSeq` 与 `Last-Event-ID` 同时存在 | 值相同才接受；不同返回 `INVALID_ENVELOPE` |
| I-010 | bootstrap 期间并发 durable event / 多房间 active Turn | 投影与 cursor 来自同一 DB snapshot；只返回当前房间的有界最近事件与最小公开 Turn 字段；随后 SSE 从 `seq > cursor` 无缺口追上 |
| I-011 | native reasoning delta 后刷新/重连 | delta 不逐条落库；terminal transaction 生成最多一条 `turn.reasoning.recorded`，按 seq 在 response/terminal 前回放 |
| I-012 | native tool started/completed 后刷新/重连 | live `tool.progress` 保持 transient；terminal transaction 生成 `tool.progress.recorded`，同一 `turnId + toolCallId` 仍合并为气泡内折叠记录 |

## 11. 公共记忆与身份记忆

| ID | 用例 | 通过标准 |
| --- | --- | --- |
| M-001 | 用户固定公共记忆 | author/source 可追溯，重启后可检索 |
| M-002 | 普通聊天 | 不自动升级 MemoryRecord |
| M-003 | Structured MCP memory.remember | author 来自 binding，不能冒充他人 |
| M-004 | supersede/retract | 追加版本/tombstone，不原地抹除 |
| M-005 | 用户身份记录 | subject 可选 Agent，author 固定 user:web |
| M-006 | Structured Agent identity.remember | subject 固定调用方自身 |
| M-007 | 其他 Agent 的观察 | 保留 author != subject，不转成自我认定 |
| M-008 | 历史 Direct Context Packet | 只验证旧持久记录可解释，不启动 Direct |
| M-009 | transcript/summary/memory/identity | 四类逻辑分离，摘要失效不删原事件 |
| M-010 | 长房间滚动压缩 | 默认在 256k 字符硬上限的约 75% 软目标处，若未压缩包将省略 unread transcript，则由配置顺序中第一个健康 Agent 生成累计检查点，近期消息仍逐条保留 |
| M-011 | 摘要与 cursor 原子边界 | 只有已持久且嵌入 attempt 的摘要可写 `summary_through_seq`，native start 确认后才推进 `last_summary_seq` |
| M-012 | 压缩失败 | 尝试后续健康 Agent；全失败则 Turn 明确失败，原 transcript、旧摘要和 cursor 不变 |
| M-013 | durable reasoning/tool records | 时间线可回放，但 Context Packet、reply chain、压缩输入与自动记忆均不包含其正文 |

## 12. Web 与本地传输

| ID | 用例 | 通过标准 |
| --- | --- | --- |
| W-001 | 默认监听 | `127.0.0.1`；非 loopback 不属于 v0.1 |
| W-002 | bootstrap | 回显 selected transport、Agent process/session health、capability、cursor |
| W-003 | composer | 只能选择 recipients，不能设置 sender/transport/access |
| W-004 | transcript | sender badge、final/partial/failed 状态正确 |
| W-005 | approval surface | 没有批准/拒绝按钮、pending 卡片或 approval API 调用 |
| W-006 | 模型输出 | 作为普通文本节点，不执行 HTML/script |
| W-007 | 未知 event type | 非保留类型 generic render，不导致 SSE 断流；`approval.*`/`permission.*`/`user_input.*` 拒绝且不渲染 |
| W-008 | 首次 init/start | 无配置时打开 loopback 引导页；添加并保存后生成严格 groupx.json，再启动主 UI |
| W-009 | 多实例名册 | 可添加两个以上 Codex App Server，稳定 id 唯一，name/cwd 独立；保存后 runtime 各有独立 actor/binding/session |
| W-010 | 运行中 Agent 设置 | `/setup` 载入现有名册，保存返回 restartRequired；不热换当前 session，不出现 access/approval/sandbox 控件 |
| W-011 | `groupx update` | 查询 npm latest；已最新/本地更高不安装，`--check` 无副作用，有更新时锁定精确版本并通过 shell-free npm 入口全局安装 |

loopback 与 binding 是产品范围/来源合同，不是认证或安全保证。

## 13. 诊断与证据

| ID | 用例 | 通过标准 |
| --- | --- | --- |
| S-001 | report | 记录 Agent、transport、unrestricted contract revision、run ID、时间、版本、argv/session shape、case、hash |
| S-002 | native interaction | 只记录 kind、correlation、失败码和有界 reason；不记录 options/decision/raw payload |
| S-003 | stderr/env/config | 不保存完整环境、全局 config 或无界 raw stderr |
| S-004 | credential fixture | 合同字段中不存在凭据；普通用户正文不宣称自动秘密扫描 |
| S-005 | evidence matching | PASS 的 evidence 必须同 Agent、同 transport、同 access contract 且文件/hash 可验证 |

## 14. 性能与规模

Broker 指标不含模型网络/推理；只测 Structured session startup/reuse：

| ID | 指标 | 初始目标 |
| --- | --- | --- |
| PF-001 | POST accepted p95 | < 50 ms |
| PF-002 | commit 到 lane p95 | < 25 ms |
| PF-003 | durable SSE p95 | < 100 ms |
| PF-004 | `@all` | 三 lane 并行，不串行等待 |
| PF-005 | 10,000 durable events | bootstrap 使用有界倒序查询，不全量扫描或返回历史；旧事件由 cursor 分页 |
| PF-006 | Direct process startup | `DEPRECATED`，不再测量或纳入目标 |
| PF-007 | Structured session startup/reuse | 分 Agent 报告，不借历史 Direct 数据 |

未实际测量前不得写成达到。

## 15. 里程碑 Gate

### M0

- Structured active baseline 与 Direct deprecated baseline 都存在；
- 默认 Structured 三 Agent 的全部适用 M0 case PASS，才可关闭 v0.1 release transport Gate；
- Direct 不得被宣称为 active/完整可用；其 baseline、Agent 和适用 case 保持 `DEPRECATED`；
- Structured 三 Agent actual MCP call 全部 verified，才可宣称全向当前回合主动互调；
- native interaction 负向合同通过，且无 approval surface；
- 无自动 fallback、跨 transport recovery 或 replay。

### M1

- Web/REST/SSE、Broker、SQLite、三 Agent selected transport 闭环；
- public transcript、sender、memory、identity、Context Packet 与重启恢复通过；
- UI/health/bootstrap 明确显示 Structured `active`、Direct `deprecated`。

### M2

- 仅 Structured：GroupX MCP `send/ask/read`、binding、因果循环、超时、取消、幂等通过；
- 三 Agent native `tools/call` 与 provenance 全部 verified；
- 不新增审批、权限或 user-input 系统。

### M3

- 新 Adapter 不修改核心 Envelope/存储/记忆；
- A2A 只作为边缘 Adapter；
- 不改变 fixed unrestricted 与 native interaction fail-turn 合同，除非另立版本决策。

## 16. 测试交付

每次 Gate 交付：

1. `docs/generated/m0-capabilities.json`（事实源）；
2. 从 JSON 确定性生成的 `docs/generated/M0_CAPABILITY_MATRIX.md`；
3. Git 忽略的有界 raw evidence 与可跟踪 evidence index/hash；
4. 单元/集成/browser/performance 摘要；
5. CLI/OS/Node 版本、transport、access contract revision、run ID、时间；
6. 对 NOT_RUN/PARTIAL/FAIL 的具体下一步。

生成器必须拒绝无 evidence 的 PASS、跨 transport 引用、旧 access contract 引用，以及没有 policy evidence 却声明 `NATIVE_POLICY_BLOCKED` 的结果。
