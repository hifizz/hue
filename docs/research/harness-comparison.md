# 10 个 harness 与 @hue/core 的对照调研

调研日期：2026-11-06。本文是后续多次调研的起点，结论以"可复查"为准：每条事实尽量给出 `仓库/路径`，没读到的写「未读」，推测的写「推测」。

## 0. 范围与方法

### 0.1 源码快照

源码克隆在 `sources/`（已 gitignore，不进版本库），浅克隆 `--depth 1`。复查时先 `git -C sources/<repo> log -1` 确认还是下面这个提交。

| 目录 | 来源 | 提交 | 日期 | 主语言 |
|---|---|---|---|---|
| `ai` | vercel/ai | 9207c2b | 2026-11-05 | TS |
| `mastra` | mastra-ai/mastra | 1e53ce2 | 2026-11-05 | TS |
| `codex` | openai/codex | 2a32e7c | 2026-11-05 | Rust（另有 TS） |
| `goose` | aaif-goose/goose | d663232 | 2026-11-05 | Rust |
| `kimi-code` | MoonshotAI/kimi-code | df90d90 | 2026-11-05 | TS |
| `ZCode` | zai-org/ZCode | a9fe401e | 2026-11-03 | TS |
| `grok-build` | xai-org/grok-build | 2bdd1d6 | 2026-09-29 | Rust |
| `minimax-code` | MiniMax-AI/minimax-code | 3c21163 | 2026-11-04 | TS |
| `dim` | arcships/dim | 7458296 | 2026-11-05 | Rust |
| `OpenHands` | OpenHands/OpenHands | f7ea223 | 2026-11-05 | TS（仅前端） |

### 0.2 读取注意

- **`mastra` 的工作区几乎是空的**（只检出了稀疏的一部分）。读它一律用 `git -C sources/mastra show HEAD:<路径>` 和 `git -C sources/mastra ls-tree -r HEAD --name-only | grep ...`。`goose` 现已完整，但上一轮调研也是用 `git show` 读的，路径相同。
- 原因：克隆时用了 `--filter=blob:none`，检出要逐个拉文件，太慢，后来又被并发命令互相干扰。以后重新克隆请去掉这个参数。
- **`OpenHands` 这个仓库没有 agent 循环**，它是前端 Agent Canvas，循环在 `OpenHands/software-agent-sdk`（README 第 153、173 行提到，未克隆）。要研究它需要另行克隆。
- **`minimax-code` 不自带循环**，调用外部包 `@earendil-works/pi-agent-core` 的 `runAgentLoop`（`packages/agent-core/src/pi-turn-runner/index.ts`），源码在 `third_party/pi-mono/`，本次未读循环本体。

### 0.3 本文如何得来，可信度

5 个子任务并行读源码（循环、事件与持久化、上下文与记忆、工具与权限、文档写法），我再抽查关键引用。抽查结果：

- **文件存在与关键代码属实**：goose 取消时补 interrupted 结果、kimi 的 `ToolAccesses` 与冲突调度、grok-build 的重复调用熔断常量、codex 的四态 `Decision`、mastra 的并查集分组、kimi 的 `canSplitAfter`、8 个 AGENTS.md 行数。
- **子任务有路径写错**（文件存在但目录不对）：kimi 调度器在 `src/agent/toolExecutor/`；ZCode 调度器在 `packages/core/src/tool/`；dim 的 `Decision` 在 `dim-agent-capabilities`；grok-build 的 `select.rs` 在 `crates/common/xai-grok-compaction/src/`。下文已用正确路径。
- **有一条结论被反证推翻**，见 §3.3。
- **没有逐条核对**报告里的几十个行号。凡是我没亲眼看到的数字，下文用「报告称」标出。

## 1. 先看规模

| 仓库 | 循环主体 | 说明 |
|---|---|---|
| **@hue/core** | `loop.ts` 266 行 | 刻意收窄的骨架 |
| codex | `run_turn` 约 800 行（`core/src/session/turn.rs:216-1014`），整个文件 3814 行 | 旁边是几十个压缩、hook、MCP、沙箱文件 |
| kimi-code | `agent-core-v2/src/agent/` 约 38000 行 | 报告称 `loopService.ts` 2450 行（未核实） |
| goose | 状态机，`Vec<Step>` 优先级链（`goose-agent/src/machine.rs`） | 行为散在数十个算子文件 |

这个差距说明：core 现在是"最小可用骨架"，其他实现里一半以上的代码在处理 core 还没做的事（压缩、重试、hook、沙箱、审批）。

## 2. 循环

| 仓库 | 形态 | 一步怎么继续/停止 | 输出形态 |
|---|---|---|---|
| **Hue** | `while(true)` + async generator（`loop.ts:103`） | 无工具且无 steer 就停；`maxSteps`；`stopWhen`；abort | **拉取式**，天然反压 |
| vercel/ai | 递归 `streamStep`（`stream-text.ts`），在 flush 里自调 | 非 tool-calls 的 finish、工具缺 execute、待审批、`stopWhen` | ReadableStream + 回调 |
| mastra | 工作流 `dowhile`（`core/src/loop/loop-builder.ts`） | 谓词综合 finishReason、stopWhen、maxSteps 等 | 流 |
| codex | 外层 `loop`（`turn.rs:542`），内层采样 `loop` | 无 follow-up 且无 pending input | 事件通道（推测） |
| goose | 状态机，`Vec<Step>` 按优先级取第一个 `Applied` | `RunStatus::Yielded/Cancelled`，MaxTurns 算子 | 效果落盘 + 事件 |
| kimi-code | xstate 状态机 + `LoopService` | `maxStepsPerTurn`、`stopTurn`、steer | 事件 + `Turn.result` |
| ZCode | `while(true)`（`packages/core/src/runtime/methods/turn-loop.ts`） | `runModelBackedTurnStep` 返回 `"break"` | 事件（推测） |
| grok-build | `loop` + 重试嵌套（`turn.rs`） | `max_turns`；**相同工具调用 8/12 次熔断**；权限拒绝取消 | ACP 事件 |
| dim | 事件溯源 + 响应式 plugin，无显式 `while` | 事件驱动 | 追加到 Timeline |

### 2.1 Hue 做得更好的

1. **成对不变量在循环内收敛。** abort、拒绝、未执行三条路径都在 `loop.ts` 里补 synthetic 结果（`:190-193, 238, 242`）。对照：goose 在 `finalize` 里事后补；codex 在读历史时补（`context_manager/normalize.rs` 的 `ensure_call_outputs_present`）；dim 靠事件回放。
2. **写前日志语义明确。** 整批 `tool.call` 先 yield，消费者落盘后才开始执行（`:197`）。其他家没读到等价的"先落盘再执行"保证。这是「没读到」，不是「没有」。
3. **拉取式反压。** 其他家是推送流、事件通道或回调。
4. **错误出口收敛。** 工具异常、参数解析失败、未知工具都回给模型。对照：grok-build 权限拒绝直接终止整个 turn（`turn.rs:3824-3832`），Hue 回给模型让它换方案。

### 2.2 Hue 的缺口

| # | 缺口 | 参照 |
|---|---|---|
| 1 | **打断模型流时丢掉已发出的 tool-call**（`loop.ts:142-147`，代码里是 `TODO(deep)`） | goose `machine.rs` 的 `interrupted_tool_responses`：对所有未完成请求补一条 "Tool call was interrupted before completing"（我已读到代码） |
| 2 | **一个 turn 内不能按步改工具、指令、模型** | vercel/ai 的 `prepareStep`；ZCode 每轮重取 MCP 和工具；grok-build 每轮 `prepare_tool_definitions` |
| 3 | **没有死循环熔断**，只有 `maxSteps` | grok-build `turn.rs:3897-3899`：`NUDGE_AFTER_IDENTICAL_TOOL_CALLS=8`、`MAX_CONSECUTIVE_IDENTICAL_PROBLEMATIC_TOOL_CALLS=8`、`MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS=12`（我已读到） |
| 4 | **压缩、重试、stop hook 在循环里是硬编码或靠注入** | goose 把它们做成可插拔 Step |

缺口 2 与你自己的 `createToolStepPolicy`（第 0 步强制联网、最后一步收工具）直接相关：Hue 的"一个 turn 内固定"（不变量 5）意味着这类需求目前无法表达。`core.md` 里 `DECIDE: instructions 能否在 turn 内变化` 应当被提升。

## 3. 工具、权限、沙箱

### 3.1 对照表

| 仓库 | 副作用/并发 | 审批模型 | 沙箱 | MCP |
|---|---|---|---|---|
| **Hue** | `Effects` 三档，一个字段决定调度、重跑、权限默认值 | `PolicyPort`：allow/deny/ask；ask 走统一的 `InputPort` | `ctx.sandbox` 依赖注入，core 不带实现 | 计划手写 |
| codex | 每工具 `supports_parallel_tool_calls` + 读写锁（`core/src/tools/parallel.rs`） | `AskForApproval` 四档 + execpolicy 前缀规则 + `ApprovalsReviewer`（用户或 guardian 子模型） | **进程级包裹**：seatbelt、bwrap/landlock、Windows 沙箱 | 自写 rmcp-client |
| grok-build | `ToolKind.is_read_only()`，同路径写由客户端串行 | 规则 allow/ask/deny + 模式 + bash AST 拆分 + 分类器 | 进程级：nono（Landlock/Seatbelt）、bwrap、seccomp | rmcp |
| goose | 只用 MCP `read_only_hint` | `GooseMode` 四档 + **`ToolInspector` 链**（permission、security、adversary、egress 等多个检查器聚合） | 未找到 | rmcp |
| kimi-code | **`ToolAccesses`：按资源冲突调度**（`none/all/file(op,path,recursive)`） | mode manual/yolo/auto + 十多个 policy 文件链；**approval/question/user_tool 共用一个 InteractionRequest 事件** | 无 OS 沙箱，`os/backends` 是 Host 抽象 | 官方 SDK |
| ZCode | `readOnly/destructive/concurrentSafe/sideEffectScope/riskLevel` 多字段 | `PermissionService` + 5 种模式；bash 用 AST，遇动态结构一律保守 | 文档明说没有 | 官方 client 2.0 |
| dim | `risk` 是自由字符串 | `Decision` Allow/Ask/Deny（与 Hue 三态同构）+ `AdviseTool` 顾问 | 有 `sandbox: bool`，后端未追 | rmcp |
| vercel/ai | 无分级 | 调用方在 `generateText` 层配 `toolApproval`：approved/denied/user-approval | 无 | 自写 `packages/mcp` |
| mastra | MCP `annotations` | `requireApproval` + `beforeApproval` | workspace sandbox：seatbelt/bwrap/none | 官方 client |
| minimax-code | 按角色名过滤工具 | 规则 + ask-gate + 插件 hook | `srt-macos`，4 种文件系统模式 | 官方 SDK |

### 3.2 三个结构性差异

1. **Effects 单字段 vs 多字段/资源冲突。** Hue 简单、不会自相矛盾，但并发粒度粗：`idempotent` 与 `unsafe` 调度上等价，写不同文件的两个工具也只能串行。kimi 的 `ToolAccesses.conflict`（`src/agent/toolExecutor/toolScheduler.ts`，我已读到）能让它们并行。
2. **审批对"具体做了什么"是盲的。** `PolicyPort.decide` 收到 `{tool, effects, input}`，对 `bash`，`input` 就是一整条命令字符串，必须由 policy 实现者自己解析。codex 用前缀规则 + 批准后自动提议追加规则；ZCode 与 grok-build 做 AST。kimi 的做法是让工具先 `resolveExecution(input)` 解析出 `{accesses, approvalRule, display, execute}`，再审批、调度共用这份信息。这印证了 `wave-1/05-policy.md` 把"bash 分词"标成难点是对的。
3. **沙箱是依赖（Hue、mastra、kimi 的 Host）vs 进程级包裹（codex、grok、minimax）。** Hue 的好处是可换成远程或容器，便于测试；代价是工具若绕过 `ctx` 直接 `spawn` 就没有隔离。codex 与 grok 在 spawn 层包装，对任意子进程生效。

### 3.3 一条被推翻的结论

子任务报告称：**"`idempotent` 在所有读到的实现里缺失，是 Hue 独有的设计点"**。这条说得太满，我做了反证搜索，结果是：

- MCP 规范自带 `idempotentHint` 注解。
- **ZCode 用它做并发**：`concurrentSafe: readOnly || descriptor.annotations?.idempotentHint === true`（`apps/zcode-cli/packages/core/src/mcp/index.ts:197`）。
- codex 读取并传给审批界面，但不参与调度或重试（`core/src/mcp_tool_call.rs:2312`）。

**修正后的准确说法：没有哪家用"幂等"来决定崩溃或断流后能否自动重跑，这个具体语义仍是 Hue 独有。** 但"幂等"这个概念本身并不缺失。对 Hue 的含义：手写 MCP client 时，`readOnlyHint → none`、`idempotentHint → idempotent`、`destructiveHint → unsafe`、缺失默认 `unsafe` 有现成依据。

## 4. 事件、状态、持久化

| 仓库 | 真相源 | 持久化 | 压缩怎么记录 | 版本 |
|---|---|---|---|---|
| **Hue** | **事件日志**，消息是 `fold` 的纯函数投影 | `EventStore`，`tool.call` 先写 | `context.compacted` 事件，回放不调模型 | 逐事件 `v` |
| kimi-code | **`wire.jsonl` 记录日志**，state 由可重放 reducer 折叠 | JSONL 追加 + 分支树 | `context.apply_compaction` | 文件头 `protocol_version 1.5` + 迁移链 |
| dim | **Timeline 事件日志**（SQLite） | 批量原子提交 | `ContextCompaction` 事件 | 库级版本 |
| codex | rollout JSONL 为主，SQLite 只是派生索引 | JSONL 追加 | `Compacted{replacement_history}` | 行上无版本 |
| goose | SQLite `messages` 行 | 整体替换 | 改 `agent_visible` 标志，原消息保留 | 库级 `schema_version` |
| grok-build | `chat_history.jsonl` 消息数组，actor 独占 | 整体重写 | `replace_history`；旧段另存 markdown | 仅遥测日志有 |
| ZCode | SQLite session/message/part 表（可变行） | SQLite | `CompactionPart` | 迁移表 |
| minimax-code | `CanonicalHistoryEnvelope` JSONL | JSONL + 原子替换 | `compact()` 把旧文件发布为快照再整体替换 | 未读 |
| mastra | 对话是消息行；workflow 有追加式 journal | 存储适配器 | 未找到通用机制 | 无 |
| vercel/ai | 无持久化概念 | 只有 `onFinish` 回调 | 无 | 无 |

结论：**采用"事件日志为唯一事实源"的只有 kimi-code 和 dim**，codex 算半个。其余 6 家都用"当前状态"替代（SQLite 行或 JSONL 整体重写），代价是回退、压缩、分支要靠复制、隐藏标志或旁路文件，原始历史会丢失，崩溃一致性靠事务或原子重写。Hue 的路线与最接近的两家同类，这是正面印证。

### 4.1 与最接近的两家的区别

kimi-code（我读了 `docs/wire-manifest.d.ts` 头部确认）：

- 日志里是 `context.append_message` 这类**状态操作记录**，消息本体直接塞在记录里；Hue 是语义事件。
- 版本在**文件头**（`protocol_version` + `min_protocol_version`）并有 `v1.1`~`v1.5` 迁移文件；Hue 是逐事件 `v`，**没有迁移工具链，也没有读者最低版本门槛**。
- 类型**注册制**（`static durable = true`，"import = register"），manifest 由脚本生成并注明 "do not edit by hand"。
- 有 undo/clear 记录，靠重放时跳过；Hue 没有回退事件。
- 分支在同文件内用 `agent.switched` 边；Hue 用 `session.created.parent`。

dim：

- 输出 delta **也落盘**，只是 20ms 窗口合并写（`dim-app-server/src/storage/timeline.rs:44` 注释："Rounds of output deltas alone wait until this long…"），所以崩溃后能恢复半截输出；Hue 的 delta 是 ephemeral，崩溃会丢未完成的 assistant 文本。
- `Extension` 事件带**保留域**和 `context_render/context_state` 两个标志，能声明扩展事件是否参与上下文渲染与状态折叠。Hue 的 `ext` 没有这两个标志，包自定义事件怎样参与 `modelView` 目前无法表达（我没读 `fold.ts` 对 `ext` 的处理，`fold.ts` 的 `default: return s` 说明它被忽略）。
- 有 `RecoverySnapshot`，锚定在事件序号上加速恢复；Hue 的 `fold` 没有快照锚点，日志变长后每次都要从头折叠。

### 4.2 Hue 的缺口

1. 没有 fold 快照锚点（长会话会慢）。
2. 版本只有逐事件 `v`，缺迁移链和最低版本门槛；目前只有 `v:1`，**兼容性尚未被检验**。
3. `ext` 事件无法参与上下文。
4. delta 不落盘，流式中途崩溃丢内容（这是取舍，不一定是缺陷）。

## 5. 上下文管理

### 5.1 触发阈值

| 仓库 | 阈值 | 来源 |
|---|---|---|
| codex | 窗口 90% | `protocol/src/openai_models.rs:579-592`（已读） |
| grok-build | 默认 85% | `crates/common/xai-grok-compaction/src/code_compaction/config.rs`（已读） |
| kimi-code | 触发 0.85，另留 `reservedContextSize 50_000`；最近至少 4 条或窗口 20%；超窗重试最多 3 次 | `agent/fullCompaction/strategy.ts`（已读） |
| goose | 默认 0.8，另有 225_000 token 上限取小 | 报告称（未核实） |
| pi（minimax 内部） | `contextTokens > contextWindow - 16384`；保留最近 20_000 token | 报告称（未核实） |
| dim | 保留 25%、pinned 10%、整体 ≤50%，标注 provisional | 报告称（未核实） |

### 5.2 切分点保护（Hue 的未解 `TODO(deep)`）

几乎每家都有，Hue 没有：

- **grok-build** `snap_to_safe_boundary`（`select.rs:128`，已读）：候选落在 tool-result 上就**向前推**到这一串 tool-result 之后。只看相邻性。
- **kimi-code** `canSplitAfter`（`strategy.ts`，已读）：不能切在 user 后、带 toolCalls 的 assistant 后、下一条是 tool 时，以及 `prefixEndsWithOpenToolExchange`（数 tool 结果数量对比 toolCalls 数量，能识别并行调用）。
- **mastra** `groupLinkedToolMessages`（`core/src/memory/load-message-history.ts`，已读）：并查集按 toolCallId 成组，按组保留，**不依赖顺序**，是最稳妥的配对表示。
- **dim**：`validate_context_boundary_at` 在写入压缩事件前校验，不合法返回 Err（报告称）。
- **codex**：不预先避免，事后规范化（补缺失 output、删孤儿 output）。适合作兜底。

### 5.3 `safeCutIndex` 方案

子任务给了一份伪代码，我把它逐字翻译成 TypeScript，用 5000 个随机对话（含并行调用 1~3 个、多轮、纯文本 assistant）做性质测试。

**测试暴露了伪代码的一个缺陷**：保留预算大于全部内容时，`raw = n`，随后 `isBoundary(msgs, n)` 越界读取，抛 `TypeError`。必须先判断 `raw >= n` 并返回 null（无需压缩）。修正后：

```
safeCutIndex(msgs, keepTokens):          // cut 表示 [0,cut) 被压缩，[cut,n) 被保留
  n = len(msgs)
  acc = 0; raw = n
  for i from n-1 down to 0:              // 1. 从后累计，找预算用完的位置
    acc += est(msgs[i])
    if acc >= keepTokens: raw = i; break
  if raw >= n: return NONE               // 2. 【修正】全部内容都在预算内，无需压缩
  cut = raw
  while cut > 0 and not isBoundary(msgs, cut): cut -= 1     // 3. 先向前吸收（多保留）
  if cut == 0 and raw > 0:               // 4. 吸收到头仍不合法，才向后找
    c = first index > raw with isBoundary(msgs, c); if none: return NONE
    cut = c
  if cut == 0 or cut >= n: return NONE   // 5. 前缀和尾部都必须非空
  return cut

isBoundary(msgs, c):
  if msgs[c].role == tool: return false                       // 绝不落在结果上
  if msgs[c-1] is assistant with toolCalls:
    return pendingCallIds(msgs, upTo=c) is empty              // 前一条带调用，则其结果必须全在 c 之前
  return true
```

**验证结果**（修正后）：5000 个随机对话，4623 个有切点，377 个返回 NONE，**0 个违规**（违规的定义：任一"调用和结果都存在"的 id，其调用与结果落在切点两侧）。

**这次验证没覆盖的**：

- **悬空调用**（崩溃遗留，有 call 无 result）只测了 4 组，且我的断言把悬空 id 排除在外，所以"算法对悬空调用安全"**没有被证明**。稳妥做法是：压缩前先修复悬空调用（补 synthetic 结果，Hue 已有 `repairDangling`），再算切点。
- 没有测多 agent 或中途插话导致的"assistant → tool*"顺序被打破的情形。kimi 的 `canSplitAfter` 隐含这个顺序假设；用 id 配对（本方案、mastra 的并查集）不依赖顺序。
- 测试文件是临时的，已删除。写 `@hue/context` 时应当把这个性质测试正式放进测试集。

**对子任务一个判断的更正**：它称 grok-build 的 `snap_to_safe_boundary` "候选若落在带 tool_calls 的 assistant 上不处理，仍可能拆开"。我读了代码，这个说法不对：切在 assistant 之前时，assistant 与它的结果同在保留侧，不会拆开；需要保护的恰恰是"落在 tool-result 上"，而它处理了。它真正的局限是只看相邻性、且只能向前推（压缩更多）。

**建议三层防护**（来自子任务综合，我认同）：① `safeCutIndex`（按 id 配对，向前吸收）；② 压缩事件写入前校验，不合法拒绝记录；③ 模型视图投影时 `repair`（补合成结果、删孤儿）。

### 5.4 其他

- **压缩结果入日志**：Hue 的 `context.compacted` 与 dim、pi 同类，比 goose、codex 的原地替换更干净。grok-build 额外把被压缩段渲染成 markdown 存盘并建索引，让模型能用 grep 回查，Hue 没有。
- **工具结果大小**：Hue 不强制截断，其他家几乎都有（报告称 goose 200_000 字符落盘给路径；kimi 50_000 字符、头 4096 尾 1024 预览并落盘；pi 读文件 2000 行/50KB）。这些数字我没逐个核实。方向一致：截断只改内容，不破坏配对。
- **skills/memory**：Hue 的 `Capability` 固定于 turn 内，对 prompt cache 友好。codex 按窗口 2% 给 skills 元数据预算（报告称）。Hue 没有后台记忆提取（codex、grok-build、mastra 都有）。

## 6. 文档写法

详见本文件末尾的建议。核心对照：

| 仓库 | AGENTS.md | 做法 |
|---|---|---|
| mastra | 18 行 | 根文件只做路由，约 10 个子目录各有自己的 AGENTS.md |
| ZCode | 85 行，中文 | `architecture-policy.yaml` + `check-stale-doc-phrases.mjs`（登记作废说法，出现在当前事实文档里就失败，历史目录豁免） |
| dim | 124 行 | ADR 接受后冻结，`adr-check.mjs` 在 CI 执行；架构图由 xtask 生成并校验 |
| kimi-code | 132 行 | `Where to Update Instructions` 一节；manifest 由脚本生成，文件头写明再生成命令 |
| minimax-code | 65 行 | 「生成文件」「单一事实来源」两张表 |
| vercel/ai | 363 行 | 包 README 有强制模板并有脚本校验 |
| codex | 无根文件 | 只在会踩坑的目录放局部 AGENTS.md |
| **Hue** | 77 行 | 靠文字约定，只有行数预算有脚本 |

我们的三个缺口：规则没有机器化；文档与代码没有一致性防腐（AGENTS.md 里"`npm run check` 不能用"就是已知漂移）；渐进披露只做了一半（没有按目录的 AGENTS.md）。

## 7. 对 Hue 的建议（按优先级，均未执行）

| # | 建议 | 依据 | 成本 |
|---|---|---|---|
| 1 | 把"打断时保留已发出的 tool-call 并补 `interrupted` 结果"定为结论，关闭 `core.md` 里对应的 `TODO(deep)` | goose `interrupted_tool_responses` | 小，但需核对两家 provider 对不完整推理块的行为 |
| 2 | 写 `safeCutIndex`，并把 §5.3 的性质测试放进测试集 | mastra、kimi、grok-build、本文验证 | 小 |
| 3 | 加"连续相同调用"熔断，作为 `stop.ts` 里与 `stepCountIs` 并列的 `StopCondition` | grok-build `turn.rs:3897-3899` | 小 |
| 4 | 在 `docs/packages/tools.md` 写明 MCP `annotations` 到 `Effects` 的映射 | 本文 §3.3 | 小 |
| 5 | 写一个 import 方向检查脚本，守住"包之间不互相 import，只依赖 core" | ZCode `architecture-policy.yaml` | 中 |
| 6 | 决定 `ext` 事件如何参与 `modelView`（是否加 render/state 标志） | dim `ExtensionEvent` | 中，需设计 |
| 7 | 决定 `instructions` 能否按步变化（影响 `createToolStepPolicy` 能否表达） | vercel/ai `prepareStep` | 中，需设计 |
| 8 | 版本策略：补迁移链与最低版本门槛 | kimi `wire/migration` | 中，等出现 `v:2` 再做也可 |
| 9 | fold 快照锚点 | dim `RecoverySnapshot` | 中，等日志变长再做 |

## 8. 未验证与后续要读的

- **未读**：mastra 的 processor 接口细节；grok-build 的工具并发实现；ZCode 的错误处理；minimax 的 `pi-agent-core` 循环；dim 的 max turns 与悬空调用补偿；codex 的输出通道形态与 `replacement_history` 为 None 时的回放；vercel/ai 的打断配对；kimi 十几个权限策略的组合顺序；各家 MCP 的 `list_changed` 与采样处理。
- **只有报告声称、我没核实的数字**：goose 的 0.8/225_000/200_000；pi 的 16384/20_000；dim 的 25%/10%/50%；kimi 的 69 种 durable 记录类型与 `loopService.ts` 2450 行；各家工具结果截断阈值。引用前请先到源码确认。
- **OpenHands 的循环**在 `software-agent-sdk`，需要另行克隆。
- **没有读 Hue 自己的 `fold.ts` 对 `ext` 的处理和 `docs/packages/core.md` D5/D6/D7 全文**的子任务只能给出推测；本文涉及这些处，已以我读到的代码为准。
