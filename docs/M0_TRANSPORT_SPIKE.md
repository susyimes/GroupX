# M0 三 CLI 传输验证合同

状态：Ready for implementation
执行状态：尚未运行真实 CLI handshake
日期：2026-08-11

## 1. 目标

M0 只验证 GroupX 与本机三套 CLI 的真实传输能力，不实现完整 Web UI、持久群组记忆或业务编排。

M0 必须回答：

1. 能否完成协议握手并建立持续会话；
2. 能否发送 prompt、接收增量事件并可靠判定 Turn 结束；
3. 能否取消进行中的 Turn，且进程之后仍可继续使用；
4. 能否恢复原生 thread/session；
5. 能否在不修改全局配置的情况下绑定最小 GroupX MCP；
6. 能否将 CLI 自身的 approval/permission request 原样交给客户端；
7. CLI 超时、退出或非法输出是否只影响对应 Adapter；
8. GroupX 是否没有覆盖用户现有 CLI 权限配置；
9. Adapter 通道与 MCP binding 是否能可靠确定真实发送者。

## 2. 事实等级

M0 报告使用以下等级：

```text
documented   官方协议或 CLI 文档明确说明
advertised   本机 command help 或 capability response 声明
probed       在安装版本上完成无模型或最小协议探测
verified     完成端到端用例并保存脱敏证据
degraded     通过明确的 GroupX 降级路径工作
unsupported  明确不支持，GroupX 必须清晰报告
```

“命令存在”和“帮助声称支持”不能写成 verified。

## 3. 当前基线

| Adapter | 本机版本 | documented/advertised | M0 必须验证 |
| --- | --- | --- | --- |
| Codex | `0.147.0` | `codex app-server`；stdio JSON-RPC；thread/turn；server-initiated approvals | 当前 schema、初始化、stream、interrupt、thread resume、稳定 MCP 配置注入、长期进程稳定性 |
| Grok | `1.0.0` | `grok agent stdio` 宣称 ACP | ACP 版本/capabilities、session new/load、stream、cancel、permission request、MCP server 支持 |
| Kimi | `0.34.0` | `kimi acp` 宣称 ACP | 与 Grok 相同，尤其验证 load、permission request 和 MCP 调用 |

OpenAI 官方当前说明：

- App Server 每条连接先 `initialize`，随后发送 `initialized`；
- stdio 是默认且受支持的 JSONL 传输；
- `thread/start` 创建线程，`thread/resume` 继续已记录 thread；
- approvals 是 server-initiated JSON-RPC request；
- App Server WebSocket transport 和 `dynamicTools` 均不作为 GroupX M0 依赖。

来源：[OpenAI Codex App Server](https://developers.openai.com/codex/app-server/)

## 4. 启动原则

固定候选启动命令：

```text
codex app-server --listen stdio://
grok agent stdio
kimi acp
```

实现规则：

- stdout 只作为协议流；
- stderr 单独捕获、限长、脱敏；
- 每个 CLI 独立子进程、Adapter、超时和退出状态；
- argv 数组启动，不经过 shell；
- Windows 使用隐藏窗口；
- 不传改变 model、sandbox、approval、tool 或自动批准行为的参数；
- 不替换 `CODEX_HOME` 或其他 CLI 配置根目录；
- 不写入任何 CLI 全局配置文件；
- 唯一允许新增的是 GroupX 通信所需的会话/进程级 MCP binding；
- MCP 注入的精确方式由现场 probe 决定，未验证前不锁定为某个实验 API。

M0 使用 `.groupx/m0-workspaces/<adapter>` 作为隔离 cwd，避免修改其他项目。该目录被 Git 忽略。

## 5. M0 Harness 边界

建议初始文件：

```text
src/m0/probe.ts
src/m0/jsonrpc-process.ts
src/m0/acp-probe.ts
src/m0/codex-probe.ts
src/m0/test-mcp-server.ts
src/m0/redaction.ts
src/m0/report.ts
tests/m0/fixtures/
```

Harness 只能执行：

- 启动/停止协议子进程；
- 发送协议初始化、session/thread、prompt、cancel/resume；
- 启动只含无副作用 GroupX 测试工具的本地 MCP；
- 收集 schema、事件顺序、耗时和状态；
- 生成脱敏 capability report。

Harness 不执行文件写入工具、联网工具、Git 操作或系统配置修改。

## 6. 通用 Adapter 合同

```ts
interface CliAdapter {
  probe(): Promise<CapabilityReport>;
  start(profile: LaunchProfile): Promise<NativeSession>;
  prompt(session: NativeSession, input: PromptInput): AsyncIterable<GroupXEvent>;
  cancel(session: NativeSession, turnId: string): Promise<CancelResult>;
  resume(nativeSessionId: string): Promise<NativeSession>;
  close(session: NativeSession): Promise<void>;
}
```

归一化事件：

```ts
type GroupXEvent = {
  adapterId: "codex" | "grok" | "kimi";
  instanceId: string;
  nativeSessionId?: string;
  nativeTurnId?: string;
  nativeEventId?: string;
  type:
    | "session.started"
    | "turn.started"
    | "content.delta"
    | "tool.started"
    | "tool.completed"
    | "approval.requested"
    | "turn.completed"
    | "turn.cancelled"
    | "turn.failed"
    | "transport.error";
  payload: unknown;
};
```

`adapterId/instanceId` 来自进程通道绑定，不能从正文、native payload 自报名称或 MCP 参数推断。

## 7. 必测用例

| ID | 验证内容 | 通过标准 |
| --- | --- | --- |
| M0-01 | 可执行文件与版本 | 记录解析后的 executable path、版本、帮助声明；不记录凭据 |
| M0-02 | 协议握手 | Codex 完成 App Server initialize；Grok/Kimi 完成 ACP initialize，无 parser desync |
| M0-03 | 新建持续会话 | 获得稳定 native thread/session ID；同一子进程连续完成两个 Turn |
| M0-04 | 流事件 | 观察 started、内容/增量及唯一 terminal event；事件顺序可关联 |
| M0-05 | 消息归属 | Codex 输出“我是 Grok”时归一化来源仍为 codex binding |
| M0-06 | 取消 | 原生 interrupt/cancel 在时限内结束 Turn，随后同一进程可新建 Turn |
| M0-07 | MCP binding | 注入仅含 `groupx.send` fixture 的测试 MCP；CLI 可发现/调用，Broker 能从绑定识别调用方 |
| M0-08 | approval 透传 | 若原生配置触发 request，保留 request ID、类型、原生 options 和关联 Turn，只返回原生 option |
| M0-09 | 原生 resume/load | 记录 ID、重启 Adapter、执行 thread resume 或 session/load，再继续 Turn |
| M0-10 | 故障隔离 | 终止一个 Adapter，Harness 和另外两个 Adapter 保持可用 |
| M0-11 | 超时/非法输出 | 握手超时、悬挂、非法 JSON、未知事件和 stderr 噪声转为明确错误，不污染其他会话 |
| M0-12 | 配置不变性 | 前后配置文件集合/哈希一致；脱敏 argv 无权限覆盖项 |
| M0-13 | 凭据保护 | 日志、report、错误和 fixture 不出现 token、API key、完整 env/config |
| M0-14 | Context fallback | 原生 resume 不支持时，新 session 可接收 GroupX context marker，且报告明确标为 degraded 而非 native resume |
| M0-15 | 关闭 | 先原生 close/cancel，再在时限后终止单个进程树；无遗留 CLI 进程 |

## 8. Adapter 专项

### 8.1 Codex App Server

验证顺序：

1. 启动 stdio；
2. 发送 `initialize` 与 client metadata；
3. 发送 `initialized`；
4. `thread/start`，记录非 ephemeral thread ID；
5. `turn/start` 执行最小无工具文本回合；
6. 验证 item/turn terminal；
7. 发起第二个 Turn；
8. 对可取消 Turn 执行原生 interrupt；
9. 关闭 App Server，重新启动；
10. `thread/resume` 并继续一个 Turn；
11. 验证配置型 MCP server 的进程级/线程级可见性；
12. 若 native settings 产生 approval request，验证 server request/response；否则使用协议 fixture 测客户端透传代码。

特殊边界：

- 不依赖 experimental WebSocket；
- 不依赖 experimental `dynamicTools`；
- 如果稳定 MCP 配置标记为 required，初始化失败必须显式失败，不能静默继续并假装 Agent 可互发；
- 不持久化 `config/read` 的完整响应；若为验证有效配置而调用，只提取经过白名单定义的非敏感布尔结论。

### 8.2 Grok ACP

验证：

- initialize 的 protocol version 和 capabilities；
- session/new；
- session/prompt 与 session/update；
- terminal stop reason；
- session/cancel；
- session/load 是否 advertised 且真实可用；
- session/new/load 中 MCP server 描述是否被接受；
- permission request 的真实 wire shape；
- 进程重启后的 session 语义。

任何未在 capabilities 中声明的能力默认 unsupported，不按“标准应该有”强行调用。

### 8.3 Kimi ACP

验证项与 Grok 相同，另需关注：

- Windows UTF-8 与 JSONL framing；
- session/load 是否回放 session/update；
- MCP server 与 permission request 是否由当前安装版本实现；
- 取消后同进程是否继续可用；
- stderr 中的用户提示不能被误解析为协议事件或 session ID。

## 9. Approval 特殊规则

- GroupX 不制造 approval；
- GroupX 不自动选择 `allow_once`、`allow_always` 或等价选项；
- 用户现有配置自动允许时，M0 记录 `NOT_OBSERVED_BY_NATIVE_CONFIG`；
- 不为了制造 approval 而修改权限配置；
- 客户端透传状态机使用脱敏 fixture 补充验证；
- UI/测试超时不能转成允许，只能保持 pending、原生超时或取消；
- CLI 拒绝 GroupX MCP 工具是有效原生权限结果，不能绕过。

## 10. Resume 判定

Codex：

- 使用原生 thread ID 和 `thread/resume`；
- resume response 与后续 Turn 均成功才算 verified。

Grok/Kimi：

- 只有 capability 声明后才尝试 ACP `session/load`；
- 若不支持，记录 `resume_supported=false`；
- 允许“新 session + GroupX context restore”作为 degraded；
- degraded 不能被描述为 native resume。

Resume verified 需要：

1. 原生协议确认载入；
2. session/thread ID 符合协议语义；
3. 恢复后可继续 prompt；
4. 历史 marker 能通过协议历史或会话行为关联；
5. 未修改全局配置。

## 11. 建议超时

```text
进程启动/握手              15 秒
普通协议 request 确认      10 秒
首次模型事件               90 秒，可配置
流事件空闲                 120 秒，可配置
取消到 terminal            10 秒
优雅退出                   5 秒
```

模型超时、协议超时和进程退出必须分别报告。

## 12. 配置不变性

在不输出内容的前提下记录：

- 启动前后已知 CLI 配置文件的存在性、大小、mtime 和 hash；
- GroupX 实际 argv 的脱敏结构；
- GroupX 是否写入用户 home/config 目录；
- MCP 注入使用的临时/进程级文件或参数及其清理结果。

如果 CLI 自身在正常启动时更新缓存或 session 文件，不应笼统判定为 GroupX 修改配置；报告必须区分：

```text
user configuration
native CLI runtime/session state
GroupX runtime state
```

## 13. 证据包

原始证据放在 Git 忽略目录：

```text
.groupx/evidence/m0/<run-id>/
```

可跟踪的脱敏结论：

```text
docs/generated/M0_CAPABILITY_MATRIX.md
docs/generated/m0-capabilities.json
```

每个 Adapter 的报告字段：

```text
adapter
executable_path
version
launch_argv_redacted
protocol_and_version
advertised_capabilities
observed_capabilities
native_session_id_redacted
test_case_results
latency_summary
exit_and_timeout_results
config_hash_before
config_hash_after
unsupported_or_not_observed
```

协议 transcript 只保留 schema、事件顺序、关联 ID 和脱敏 payload，不保存认证信息或无关私人对话。

## 14. M0 完成门槛

三套 Adapter 都必须通过：

- handshake；
- 同进程持续两个 Turn；
- stream 与唯一 terminal；
- cancel 或明确、可测试的 unsupported 边界；
- 故障隔离；
- 配置不变性；
- 凭据保护。

MCP、approval 和 resume 必须给出真实的：

```text
PASS
NOT_SUPPORTED
NOT_OBSERVED_BY_NATIVE_CONFIG
DEGRADED_WITH_CONTEXT_RESTORE
```

任何静默降级、用帮助文本冒充现场验证、或为测试而覆盖 CLI 权限配置，都使 M0 失败。
