# @hue/core 决定记录

core 已冻结（v0.2）。它的设计决定原本就写在设计页 [`docs/packages/core.md`](../../../docs/packages/core.md) 第 3 节（D1–D7），那里是原文。这份文件补两件事：按其他包同样的格式列出每条的"选了 / 代价 / 何时要改"摘要，并记录设计页里原先开着的四个问题（第 5–8 条，已拍板）。

## 已定（摘要，原文见 core.md）

| # | 问题 | 选了 | 代价 | 何时要改 |
|---|---|---|---|---|
| D1 | 状态放哪 | 事件日志是唯一事实源，`fold(events)` 得到 state；loop 用同一个 reducer 折叠自己发的事件，所以 turn 结束的 state 恒等于 `fold(日志)`（[ADR-001](../../../docs/decisions/ADR-001-event-log-source-of-truth.md)） | 消息格式变了要在 fold 里兼容旧事件（靠 `v`） | 需要多一份派生状态时，必须能由 fold 重算（见 store DECISIONS 第 1 条） |
| D2 | 推还是拉 | `runTurn` 是 async generator，消费者拉；消费者在下一次 `next()` 前 `append`，保证 `tool.call` 先于执行落盘（ADR-001） | 落盘责任在消费者，所以 runtime 必须承担它（runtime DECISIONS 第 1 条） | 单次 append 变成毫秒级后，可改成"工具执行前必须 flush" |
| D3 | 消息格式 | Hue 自己定义，不用 AI SDK 的；没有 system 消息，instructions 每步单独传；`providerMetadata` 原样保留 | 适配在 `@hue/ai` 里做，多一个双向转换 | provider 变化需要新字段时走 `providerMetadata` / `ext`，不改核心联合类型 |
| D4 | 怎么接外部世界 | 六个端口，每个带 `specVersion`；loop 只认端口 | 加端口方法要升 `specVersion`（例：store 的 `listSessions` 因此放在 `ListableStore` 扩展接口里） | 破坏性变更升 `specVersion`，先改 core.md |
| D5 | skills / memory / MCP / 子 agent 怎么接 | 都是 `Capability`（instructions + tools），每个 turn 开始解析一次，turn 内固定；重名在 turn 开始就报错 | instructions 不能在 turn 内变化（见第 5 条） | 见第 5 条 |
| D6 | 副作用怎么驱动调度 | `Effects = none / idempotent / unsafe`，一个字段同时决定并发、崩溃后能否重跑、policy 默认；连续的 `none` 并发，其余串行 | 标错就出事：MCP 的标注来自 server（[ADR-010](../../../docs/decisions/ADR-010-mcp-trust-annotations.md)） | 需要更细的等级时 |
| D7 | 需要人的情况怎么走 | 一个 `InputPort`，承接 policy 的 `ask`、工具自己的确认、MCP 的 `input_required`；事件 `input.requested / input.resolved` 进日志 | 等人的时间默认算在工具超时里（tools DECISIONS 第 10 条） | 见 tools DECISIONS 第 10 条 |

另有两个跨包的约定写在 core.md 第 4 节：持久化事件才有 `seq`，临时事件 `seq = 0`；包要加事件一律用 `ext`，核心联合类型保持封闭。

## 设计页上的四个 `DECIDE:`（2026-11-12 拍板，保持 core 不变）

四条都没有改 core。第 3 条在 runtime 里加了代码，其余三条是把现状正式定下来。

### 5. instructions 能否在 turn 内变化（core.md:197）
- **选了**：下个 turn 生效。instructions 在 turn 开始时解析一次，turn 内固定。不开放 `Capability.onStep`。
- **否决的**：每步更新 instructions。要改 core（已冻结，要升 `specVersion`），且每步系统提示变化会破坏 prompt cache 前缀（memory DECISIONS 第 3 条也是因为这个才不做每轮检索）。
- **代价**：模型在同一个 turn 里 `remember` 的新笔记，同一 turn 的系统提示里看不到（它自己知道，因为刚写过）；下一个 turn 才出现在索引里。
- **何时要改**：eval 里出现"同一 turn 内需要看到新笔记"的任务。

### 6. 超窗重试次数（core.md:198）
- **选了**：每步最多一次。重试时 context 策略带 `overflowed: true` 无条件压，目标 `min(目标, 估算 × 0.6)`（context DECISIONS 第 1 条）。不加第二档。
- **否决的**：第二档更激进的截断。第二次仍超，通常说明单个输入就放不下（比如一个巨大的工具结果），更激进地压历史没用；多一次请求也是浪费。
- **代价**：仍超时这一步以 `context_overflow` 错误结束 turn，由调用方处理。
- **何时要改**：真实长任务里出现连续两次超窗，且原因是历史而不是单个输入。第 7 条的工具结果上限会减少"单个输入撑爆"的情况。

### 7. 工具结果大小上限（core.md:199）
- **选了**：core 不截断；runtime 统一兜底。`createAgent` 把每个工具（包括 `capabilities` 带来的 MCP、skills、子 agent 工具）的结果文本合计限制在 `maxToolOutputBytes`（默认 100 KB，`Infinity` 关闭）以内，超出保留头尾 6/4，中间写明省略了多少字节；按字节切，不留 `�`。实现在 `runtime/src/limit.ts`。
- **只限发给模型的内容**：`text` 和 `json` 块合计；`data`（不发给模型）和文件块不动；`isError` 原样保留。写进日志的 `tool.result` 也是截过的，所以日志里没有完整原文。
- **为什么不放 core**：core 不该知道内容怎么截才不丢信息，而且改 core 要升 `specVersion`。**为什么在 runtime**：runtime 是唯一知道"所有工具"的地方，MCP 工具的结果之前没有统一上限（tools DECISIONS 第 11 条的缺口），现在被盖住。
- **与内置工具的关系**：内置工具自己截到 30 KB（tools DECISIONS 第 3 条），所以这一道对它们基本不触发，是给第三方 / MCP 工具兜底的。
- **代价**：100 KB 约 25k token，仍然很大；数值没用真实任务调过。被截掉的内容在日志里没有备份，模型想看完整内容只能让工具分页重取（对 MCP 工具不一定做得到）。直接用 `runTurn` 而不经过 runtime 的人没有这一道保护。
- **何时要改**：有真实数据后调默认值；或需要"完整原文落盘、给模型一个路径"时（tools.md 里的 `TODO(deep)`）。

### 8. `parse` 失败的重试（core.md:200）
- **选了**：不设上限。`Invalid input for <工具>: …`（`invalid_tool_input`）作为 `isError` 结果回给模型，由模型重试；整个 turn 受 `maxSteps`（默认 50）约束（[ADR-008](../../../docs/decisions/ADR-008-tool-error-format.md)）。
- **否决的**：同一工具连续失败 N 次后结束 turn。会打断模型本来能自己修好的重试；要改 core。
- **代价**：最坏情况烧掉 50 步。
- **何时要改**：真实运行里看到模型在同一个工具上反复失败的循环。

## 深挖项（`TODO(deep)`，不是决定）
core.md 第 9 节还有：打断时的部分消息、崩溃后的自动重跑、压缩切分点（已在 context DECISIONS 第 0 条解决，设计页没更新）、大附件、子 agent 的事件怎么流。这些是待研究项，不在这里写结论。
