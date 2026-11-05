# @hue/core 设计 v0.2（2026-10-30）

> 代码：`hue/packages/core/src/`（887 行，`tsc --strict` 通过，11 个测试全过；loop.ts 266 行）。
> 这一页讲**为什么这样设计**。代码是参考实现，ThreadChat 里可以继续打磨，但**改接口必须先改这一页**。

---

## 0. 一句话

**事件日志是唯一事实源；loop 是一个吐事件的 async generator；其他 12 个包都是插在 6 个端口上的实现。**

core 零 I/O、零运行时依赖：不发网络请求、不读写文件、不认识任何具体模型或数据库。它只依赖平台自带的 `AbortSignal.any / AbortSignal.timeout / crypto.randomUUID`（Node ≥ 20.3、现代浏览器）。

---

## 1. 词汇表（全项目统一）

| 词 | 含义 |
|---|---|
| **Session** 会话 | 一段持续对话，对应一条事件日志。子 agent 是一个带 `parent` 的新会话 |
| **Turn** 回合 | 一条用户输入 → 若干步 → 结束。`runTurn()` 的作用域 |
| **Step** 步 | 一次模型调用 + 它发起的全部工具调用 |
| **Call** 调用 | 一次工具调用，`callId` 由模型给出 |
| **Transcript** | 完整消息历史，只增不删 |
| **Model view** | 某一步实际发给模型的消息（压缩、折叠后的 transcript） |
| **Port** 端口 | core 定义、其他包实现的接口 |
| **Capability** 能力 | 给 agent 加"说明 + 工具"的东西（skills、memory、MCP server、子 agent） |

---

## 2. 文件地图

| 文件 | 内容 | 谁会 import |
|---|---|---|
| `json.ts` | Json、JsonSchema、ProviderMetadata | 所有包 |
| `message.ts` | Hue 自己的消息格式 | ai、context、store |
| `errors.ts` | 可序列化错误 + 封闭错误码 | 所有包 |
| `model.ts` | **ModelPort**、ModelChunk、Usage | ai |
| `tool.ts` | **Tool**、ToolContext、Effects | tools、skills、memory、runtime |
| `ports.ts` | **ContextStrategy、Capability、PolicyPort、InputPort、SandboxPort、EventStore** | context、skills、memory、policy、sandbox、store、runtime |
| `event.ts` | **HueEvent 联合类型（合同本体）** | 所有包 |
| `fold.ts` | 事件 → ConversationState 的纯函数投影 | store、runtime、eval |
| `loop.ts` | `runTurn()` | runtime |
| `recover.ts` | 崩溃后修复悬空调用 | runtime |
| `stop.ts` | 停止条件 | 配方 |
| `queue.ts` | 内部用的异步队列 | （内部） |

---

## 3. 七条核心决定

### D1. 事件日志是唯一事实源，消息历史只是投影
- `fold(events) → ConversationState` 是纯函数。transcript、压缩状态、悬空调用、用量全部由事件推出来。
- **自举一致**：loop 维护 state 的方式就是用 `reduce` 折叠自己发出的事件。所以 turn 结束时的 state **恒等于** `fold(日志)`。测试第 1 条就在验这个。
- 好处：回放、崩溃恢复、分支、子 agent 事件树、eval 归因，全部是"读日志"这一件事。
- 代价：消息格式变了要在 fold 里兼容旧事件（靠 `v` 字段）。

### D2. loop 是 async generator（拉），不是 EventEmitter（推）
- 消费者 `next()` 一次，loop 才往前走一步 —— 天然背压。
- **拉取即落盘**：消费者只要在下一次 `next()` 之前 `await store.append(e)`，就保证 `tool.call` 在工具真正执行前已经写进日志（写前日志）。core 不碰 I/O，却拿到了持久化保证。这是整个设计里最值得在面试里讲的一点。
- 返回值 `TurnResult` 通过 generator 的 return 给出（reason、usage、steps、最终 state）。

### D3. Hue 自己定义消息格式，不用 AI SDK 的
- core 不能依赖 AI SDK；事件日志需要我们能长期保证稳定的格式。
- 没有 system 消息：instructions 每步单独传。压缩和回放永远碰不到 system prompt。
- `providerMetadata` 原样保留（Anthropic thinking signature 之类），否则下一轮 provider 会拒绝。
- 适配在 @hue/ai 里做，成本是一个双向转换函数。

### D4. 六个端口，loop 只认端口
| 端口 | 实现包 | 默认（不传时） |
|---|---|---|
| `ModelPort` | ai | 必传 |
| `ContextStrategy` | context | 直接用 `modelView(state)`，不压缩 |
| `Capability[]` | skills、memory、tools(MCP)、runtime(子 agent) | 无 |
| `PolicyPort` | policy | 全部放行 |
| `InputPort` | runtime / gateway | 无；工具要输入时报 `input_unavailable` |
| `SandboxPort` | sandbox | 无；工具自己决定怎么办 |
| `EventStore` | store | loop 不用，runtime 用 |

每个端口带 `specVersion`（如 `'hue.model.v1'`），借鉴 AI SDK 的 specificationVersion：接口变了就升版本，适配器会编译报错而不是悄悄坏掉。

### D5. skills 和 memory 在 loop 眼里都是 Capability
- Capability = `instructions()` + `tools()`，每个 turn 开始时解析一次，turn 内固定。
- loop 完全不知道 skills、memory 是什么。skills 是"索引说明 + load_skill 工具"，memory 是"召回摘要 + remember/recall 工具"，MCP server 是"空说明 + 远端工具"，子 agent 是"一个 spawn 工具"。
- **prompt cache 友好**：instructions 拼接顺序 = 声明顺序，工具顺序 = 声明顺序，turn 内不变。
- 工具重名在 turn 开始就报错，不等模型调到。

### D6. 副作用等级决定调度、重跑和权限
`Effects = 'none' | 'idempotent' | 'unsafe'`，一个字段驱动三件事：
| | none（读） | idempotent | unsafe（bash、发消息） |
|---|---|---|---|
| 调度 | 连续的可并发 | 串行 | 串行 |
| 崩溃 / 断流后 | 可自动重跑 | 可自动重跑 | 不重跑，交给模型判断 |
| policy 默认 | 放行 | 视规则 | 视规则 |

调度规则：连续的 `none` 调用合成一批并发，其他各自一批串行，整体保持模型给出的顺序；结果按 call 顺序排给模型。同一字段也被 MCP 断流重发复用（见 tools.md）。

### D7. 一个通道处理所有"需要人"的情况
- `InputPort` 统一承接：policy 的 `ask`、工具自己的确认、MCP MRTR 的 `input_required`。
- 工具通过 `ctx.requestInput()` 调用；loop 发 `input.requested / input.resolved` 事件，所以等待人的时间、人的回答都在日志里。

---

## 4. 事件合同

信封（每个事件都有）：`v`、`id`、`sessionId`、`seq`、`at`、`turnId?`、`step?`。

| 事件 | 持久化 | 说明 |
|---|---|---|
| `session.created` | ✅ | 子 agent 带 `parent: {sessionId, turnId, callId}`，构成事件树 |
| `turn.started` / `turn.ended` | ✅ | ended 带 reason、usage、steps、error |
| `user.message` | ✅ | turn 输入，以及中途插话（`steer: true`） |
| `step.started` | ✅ | 带估算 token |
| `model.delta` | ❌ | 文本 / 推理流 |
| `tool.input.delta` | ❌ | 工具参数流（给 UI） |
| `model.message` | ✅ | 完整 assistant 消息 + usage + finishReason + 耗时 |
| `context.compacted` | ✅ | 压缩结果本身存进日志，回放不再调模型 |
| `tool.call` | ✅ | **写前日志**，执行前落盘 |
| `policy.decided` | ✅ | 审计 |
| `input.requested` / `input.resolved` | ✅ | 人在回路 |
| `tool.progress` | ❌ | 进度 |
| `tool.result` | ✅ | 带 `synthetic`：interrupted / denied / crashed / not_run |
| `ext` | 自定 | 包加自己的事件，不改核心联合类型 |

规则：
- `seq` 只分配给持久化事件，会话内从 1 单调递增；临时事件 `seq = 0`。
- `isDurable(e)` 是唯一判断依据，store 只存它为 true 的。
- 包加事件一律用 `ext`（如 `{type:'ext', name:'skills.loaded', durable:true}`），核心联合类型保持封闭、可穷举。

---

## 5. 不变量（测试守着的承诺）

1. **成对**：每个 `tool.call` 恰好有一个 `tool.result`。打断、拒绝、没执行、崩溃时由 loop 或 `repairDangling` 补 synthetic 结果。
2. **写前**：`tool.call` 一定在工具开始执行之前被 yield。
3. **自举一致**：`runTurn` 的最终 state === `fold(它发出的持久化事件)`。
4. **顺序**：给模型的 tool 消息里，结果顺序 = assistant 消息里 call 的顺序（不管谁先跑完）。
5. **固定**：一个 turn 内 instructions 与工具列表不变。
6. **错误回给模型**：未知工具、参数错误、工具抛错、超时、被拒绝，都变成 `isError: true` 的结果交给模型，而不是让 turn 失败。只有模型调用本身失败才结束 turn。

---

## 6. runTurn 流程

```
turn.started → user.message
解析 capabilities（instructions + tools，重名即失败）
loop:
  若已打断 → turn.ended(interrupted)
  step++
  context.prepare(state)            ← 可能返回 compaction → context.compacted
    超窗(context_overflow) → overflowed=true 再 prepare 一次，只重试一次
  step.started
  model.stream → model.delta* → model.message
    出错/打断 → 只保留已完成文本 → turn.ended(error|interrupted)
  执行工具（按 effects 分批）：
    tool.call*（整批先发，写前）
    每个调用：parse → policy(→ input.*) → execute(带超时) → tool.result
  pullSteer() → user.message(steer)*      ← 在安全点取插话
  没有工具调用且没有插话 → turn.ended(stop | length)
  步数上限或 stopWhen 命中 → turn.ended(stop_condition)
```

---

## 7. 其他包怎么接（给并行开发用）

| 包 | 实现 / 使用 | 合同测试要点 |
|---|---|---|
| ai | 实现 `ModelPort` | finish 恰好一次且最后；tool-call 参数完整才发；超窗映射为 `context_overflow`；providerMetadata 往返 |
| tools | 实现 `Tool`；MCP 以 `Capability` 暴露 | effects 标注正确；所有 I/O 走 `ctx.sandbox`；尊重 `ctx.signal` |
| store | 实现 `EventStore` | append 顺序、seq 连续、只收 durable、`fold(read())` 可重建 |
| context | 实现 `ContextStrategy` | 不修改 state；切分点不能拆开 call/result 对；返回的 compaction 可被 fold |
| skills / memory | 实现 `Capability` | 同一输入下 instructions 确定（缓存）；工具名带前缀不撞名 |
| policy | 实现 `PolicyPort` | 只返回三种决定；不做 I/O 以外的副作用 |
| sandbox | 实现 `SandboxPort` | exec 超时与 abort；路径越界处理 |
| runtime | 调 `runTurn`、落盘、管队列、子 agent | 拉取即落盘；崩溃后先 `repairDangling` 再开新 turn |
| telemetry / eval | 只消费事件 | 不依赖任何其他包 |

---

## 8. 已有测试（`test/loop.test.ts`，11 个，全部通过）

纯文本回答 + 自举一致 · 工具循环 · 并发 / 串行调度与结果排序 · 写前日志 · 未知工具与参数错误回给模型 · policy 拒绝与经 InputPort 询问 · 工具执行中打断后仍成对 · 崩溃修复 · 插话让 turn 继续 · 工具重名提前失败 · 步数上限

**这批测试就是并行开发的门槛**：任何人改 core，这 11 个必须继续全过。

---

## 9. 留给深挖的问题

- TODO(deep): **打断时的部分消息**。现在只保留已完成文本，丢掉未执行的 tool-call 和没签名的推理。另一种做法是保留 tool-call 并补 interrupted 结果，让模型知道它试过什么。要对比两家 provider 对"不完整推理块"的实际行为
- TODO(deep): **崩溃后的自动重跑**。`repairDangling` 现在一律不重跑。none / idempotent 是否该自动重跑？原始 input 在 `tool.call` 事件里，技术上可行
- TODO(deep): **压缩的切分点**。`Compaction.throughIndex` 不能落在 assistant(tool-call) 和它的 tool 消息之间。需要一个 `safeCutIndex()` 工具函数，放 core 还是 context？
- TODO(deep): **大附件**。`FilePart.url` 只是引用；图片、长输出放哪（store 加 blob 接口？），fold 怎么不把它们加载进内存
- TODO(deep): **子 agent 的事件怎么流**。子会话事件是写进自己的日志、父日志只记 tool.result（现在的设计），还是父流里也转发子事件给 UI
- DECIDE: **instructions 能否在 turn 内变化**。现在固定（缓存友好）。memory 想每步更新召回内容时怎么办：下一 turn 生效，还是开放 `Capability.onStep`
- DECIDE: **超窗重试次数**。现在每步最多一次；是否要第二档（更激进的截断）
- DECIDE: **工具结果大小上限**。core 是否强制截断（如 100KB）防止一次结果撑爆上下文，还是全交给 context 策略
- DECIDE: **`parse` 失败的重试**。现在把错误回给模型，由模型重试；是否对同一工具连续失败 N 次后结束 turn
- LATER: 结构化输出（模型最终答案要符合 schema）；一个 turn 里切换模型；token 级别的流式取消

---

## 10. 面试时怎么讲（30 秒版）

> "Hue 的 core 只有 900 行，没有任何 I/O。事件日志是唯一事实源，消息历史只是它的投影，loop 自己也是靠折叠自己的事件维护状态，所以运行时状态和回放结果永远一致。loop 是一个 async generator，消费者落盘之后才会拉下一个事件，所以工具执行前一定已经写了日志，崩溃后能精确知道哪个调用结果未知。工具按副作用等级分三档，同一个字段同时决定并发调度、崩溃后能不能重跑、和权限默认值。skills、memory、MCP 在 loop 眼里都只是'一段说明加一组工具'。"
