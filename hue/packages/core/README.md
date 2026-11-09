# @hue/core

Hue 的内核：类型、事件合同、六个端口、agent loop。**零 I/O，零运行时依赖。**

core 不发网络请求、不读写文件、不认识任何具体模型或数据库。它只定义「一个 agent 的一轮对话怎么跑」，其余一切（调模型、存日志、执行命令、压缩上下文）都由你从外面插进来。

```
你的代码 ──传入──▶ runTurn({ model, tools, ... }) ──吐出──▶ 事件流 ──▶ 你的代码（落盘 / 渲染 / 统计）
                       │
                       └── 只通过 6 个端口接触外部世界
```

设计动机和取舍见 [docs/packages/core.md](../../../docs/packages/core.md)。本文是使用手册。

## 状态与定位（先读这一段）

**core 是内核规范加参考实现，不是可以直接拿来做 agent 的框架。** 单独安装它，你得不到一个能用的 agent。

它自己不含这些东西，下面的示例因此用的都是假模型和手写的内存存储：

| 要跑真实 agent 还差 | 对应的包 | 现状 |
|---|---|---|
| 调真实模型 | `@hue/ai` | 未实现 |
| 真实工具（bash、读写文件、MCP） | `@hue/tools` | 未实现 |
| 持久化事件 | `@hue/store` | 未实现 |
| 把它们装配起来 | `@hue/runtime` | 未实现 |

**适合读它的人：** 想给某个端口写实现的人；想看清 harness 内核（loop、事件日志、崩溃恢复）怎么设计的人。

**不适合的人：** 想快速做出一个 agent 的人。请用 Pi、Claude Code 或 AI SDK，它们开箱即用。

**它今天能证明什么：** 一个会产生副作用的 agent 被杀掉后，重启时能判断「哪些调用可能已经发生」。证据是 [test/crash-sweep.test.ts](test/crash-sweep.test.ts)，故事和边界见 [docs/application/portfolio-story.md](../../../docs/application/portfolio-story.md)。

**什么时候变得可用：** 当 `@hue/ai`、`@hue/tools`、`@hue/store` 做出来、一个脚本能用它修好真实仓库里的 bug 时。顺序和理由见仓库根目录的 [README.md](../../../README.md)。

下面的快速开始是为了让你**看懂 loop 怎么转**，不是接入教程。

- 环境：TypeScript（`strict`）、ESM、Node ≥ 20.3
- 代码：`src/` 约 900 行（预算 1000，`npm run budget` 检查）
- 状态：v0.2，接口已冻结，改接口的流程见文末

---

## 1. 看懂 loop 怎么转：跑通一个 turn（假模型，无需 API key）

一个 **turn** 是「一条用户输入 → 若干步（模型调用 + 工具执行）→ 结束」。`runTurn()` 是一个 async generator，你一边消费它吐出的事件，它一边往前走。

下面是可直接运行的最小例子，用一个脚本化的假模型，不需要任何 API key：

```ts
import { runTurn, emptyState, fold, userText, isDurable, textResult, stepCountIs } from '@hue/core'
import type { ModelPort, ModelChunk, Tool, EventStore, HueEvent } from '@hue/core'

// 1) 模型：core 只认 ModelPort。真实项目里由 @hue/ai 提供，这里用脚本代替。
const replies: ModelChunk[][] = [
  [{ type: 'tool-call', callId: 'c1', name: 'add', input: { a: 2, b: 3 } },
   { type: 'finish', finishReason: 'tool-calls', usage: { inputTokens: 10, outputTokens: 5 } }],
  [{ type: 'text-delta', text: '2 + 3 = 5' },
   { type: 'finish', finishReason: 'stop', usage: { inputTokens: 20, outputTokens: 6 } }],
]
let call = 0
const model: ModelPort = {
  specVersion: 'hue.model.v1',
  id: 'mock:demo',
  info: { contextWindow: 100_000, supports: { tools: true, parallelToolCalls: true, reasoning: false, images: false } },
  async *stream() { yield* replies[call++]! },
}

// 2) 工具
const add: Tool<{ a: number; b: number }> = {
  name: 'add',
  description: 'Add two numbers and return the sum.',
  inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  effects: 'none', // 纯读：可并发、可重跑
  parse(input) {
    const { a, b } = input as { a?: unknown; b?: unknown }
    if (typeof a !== 'number' || typeof b !== 'number') throw new Error('a and b must be numbers')
    return { a, b }
  },
  async execute({ a, b }) { return textResult(String(a + b)) },
}

// 3) 事件存储（真实项目里由 @hue/store 提供）
function memoryStore(): EventStore {
  const log = new Map<string, HueEvent[]>()
  return {
    specVersion: 'hue.store.v1',
    async append(events) { for (const e of events) log.set(e.sessionId, [...(log.get(e.sessionId) ?? []), e]) },
    async *read(id, opts) { for (const e of log.get(id) ?? []) if (e.seq >= (opts?.fromSeq ?? 1)) yield e },
    async lastSeq(id) { return log.get(id)?.length ?? 0 },
  }
}

// 4) 驱动一个 turn
const store = memoryStore()
const sessionId = 's1'
const turn = runTurn({
  sessionId,
  state: emptyState(sessionId), // 新会话；续聊时传 fold(sessionId, 日志里的事件)
  input: userText('2+3?'),
  model,
  tools: [add],
  instructions: 'You are a calculator.',
  stopWhen: [stepCountIs(10)],
})

let result
while (true) {
  const next = await turn.next()
  if (next.done) { result = next.value; break }  // generator 的返回值 = TurnResult，for await 拿不到，必须手动 next()
  const e = next.value
  if (isDurable(e)) await store.append([e])      // ← 关键：落盘之后才会再 next()
  else if (e.type === 'model.delta') process.stdout.write(e.delta) // 增量只给 UI，不落盘
}

console.log(result.reason, result.steps, result.usage) // 'stop' 2 { inputTokens: 30, outputTokens: 11, ... }
```

实际事件顺序（已运行验证）：

```
turn.started → user.message → step.started → model.message → tool.call → tool.result
→ step.started → model.delta → model.message → turn.ended
```

**两条必须记住的规则：**

1. **用 `next()` 手动驱动，不要用 `for await`**，否则拿不到 `TurnResult`（`reason`、`steps`、`usage`、最终 `state`）。
2. **在下一次 `next()` 之前先 `await store.append(e)`**。loop 是「拉一次走一步」，所以只要你先落盘再拉，就保证 `tool.call` 在工具真正执行前已经写进日志。详见 §5。

---

## 2. 核心概念

| 词 | 含义 |
|---|---|
| **Session** | 一段持续对话，对应一条事件日志。子 agent 是一个带 `parent` 的新 session |
| **Turn** | 一条用户输入 → 若干步 → 结束。`runTurn()` 的作用域 |
| **Step** | 一次模型调用 + 它发起的全部工具调用 |
| **Call** | 一次工具调用，`callId` 由模型给出 |
| **Transcript** | 完整消息历史，只增不删 |
| **Model view** | 某一步实际发给模型的消息（压缩、折叠后的 transcript） |
| **Port** | core 定义、其他包实现的接口 |
| **Capability** | 给 agent 加「说明 + 工具」的东西（skills、memory、MCP、子 agent） |

**事件日志是唯一事实源，消息历史只是它的投影。** `fold(events)` 是纯函数，从事件算出 `ConversationState`；loop 自己也用同样的 `reduce` 维护状态，所以 turn 结束时的 `result.state` 恒等于 `fold` 日志的结果。

---

## 3. `runTurn()` 参数

```ts
runTurn(options: TurnOptions): AsyncGenerator<HueEvent, TurnResult>
```

### 必填

| 参数 | 类型 | 说明 |
|---|---|---|
| `sessionId` | `string` | 会话 ID，进每个事件 |
| `state` | `ConversationState` | 起点状态。新会话用 `emptyState(id)`；续聊用 `fold(id, 已有事件)` |
| `input` | `UserMessage` | 本 turn 的用户输入，用 `userText('...')` 构造 |
| `model` | `ModelPort` | 模型端口（§4.1） |

### 常用

| 参数 | 默认 | 说明 |
|---|---|---|
| `instructions` | 无 | 系统指令。**不是消息**，每步单独传给模型，压缩和回放碰不到它 |
| `tools` | `[]` | 直接传入的工具 |
| `capabilities` | `[]` | 能力列表，提供额外的 instructions 和 tools（§4.3） |
| `stopWhen` | `[]` | 额外停止条件，见下文 |
| `maxSteps` | `50` | 硬上限，命中时 `reason = 'stop_condition'` |
| `signal` | 无 | `AbortSignal`，触发后 turn 以 `interrupted` 结束 |
| `settings` | 无 | 透传给模型：`maxOutputTokens`、`temperature`、`providerOptions` |
| `toolTimeoutMs` | `120_000` | 单个工具的超时。单个工具可用自己的 `timeoutMs` 覆盖 |

### 按需接入的端口

| 参数 | 不传时 |
|---|---|
| `context`（`ContextStrategy`） | 直接用 `modelView(state)`，不压缩 |
| `policy`（`PolicyPort`） | 全部放行 |
| `inputPort`（`InputPort`） | 需要人输入的地方报 `input_unavailable` |
| `sandbox`（`SandboxPort`） | 不提供；工具自己决定怎么办 |

### 其他

| 参数 | 说明 |
|---|---|
| `pullSteer` | `() => UserMessage[]`。每步工具执行完后调用，取用户的中途插话，有则 turn 继续 |
| `now` / `newId` | 注入时钟和 ID 生成器，用于确定性测试 |

### `stopWhen` 的一个易错点

`stopWhen` **只在「本步有工具调用」之后才会被检查**。模型直接给出纯文本回答时，turn 自然结束，不经过 `stopWhen`。内置三个：

```ts
stepCountIs(n)      // step >= n
hasToolCall(name)   // 本步调用了某个工具（常用于「交付型」工具）
tokenBudget(max)    // 累计 input + output token >= max
```

自定义条件的签名是 `({ step, usage, last, state }) => boolean`。

### 返回值 `TurnResult`

```ts
{ reason, usage, steps, state, error? }
```

`reason` 取值：`stop`（模型说完了）· `stop_condition`（命中 `stopWhen` 或 `maxSteps`）· `interrupted`（`signal` 触发）· `error`（模型调用失败、工具重名等）· `length`（模型输出被截断）。

---

## 4. 六个端口

每个端口带 `specVersion`（如 `'hue.model.v1'`）。接口变了就升版本，旧适配器会编译报错而不是悄悄坏掉。

### 4.1 `ModelPort`：谁来调模型

```ts
interface ModelPort {
  readonly specVersion: 'hue.model.v1'
  readonly id: string               // 'anthropic:claude-…'，进日志用于复现
  readonly info: ModelInfo          // contextWindow、maxOutputTokens?、supports
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelChunk>
  countTokens?(request): Promise<number>
}
```

`stream()` 吐出的 `ModelChunk`：

| chunk | 说明 |
|---|---|
| `text-delta` / `reasoning-delta` | 文本和推理增量 |
| `reasoning-end` | 一个推理块结束，**必须带上 provider 的签名**（`providerMetadata`） |
| `tool-input-delta` | 工具参数增量，**只给 UI 用** |
| `tool-call` | **参数完整后**才发一次，`input` 是解析好的 JSON；解析失败时 `input = { __raw: 原文 }` |
| `finish` | `finishReason` + `usage` |
| `error` | `HueError` |

**实现者必须遵守：**

- `finish` 至多一次，且出现时必须是最后一块
- 流必须以 `finish` 或 `error` 结束
- `callId` 在一个流内不重复
- 有工具调用时 `finishReason` 必须是 `'tool-calls'`
- 所有内容必须可 `JSON.stringify`
- 尊重 `signal`，触发后抛 `AbortError`
- 上下文超窗要映射成 `{ code: 'context_overflow' }`，loop 靠它触发压缩重试

这些规则可以用 `checkChunkStream(chunks)` 对录制的 fixture 校验，CI 里不需要 API key（§8）。

### 4.2 `Tool`：模型能调用什么

```ts
interface Tool<I = Json, O extends Json = Json> {
  readonly name: string
  readonly description: string        // 模型唯一的使用说明
  readonly inputSchema: JsonSchema    // type 必须是 'object'
  readonly effects: 'none' | 'idempotent' | 'unsafe'
  parse?(input: Json): I              // 校验并收窄参数；抛错 → invalid_tool_input
  execute(input: I, ctx: ToolContext): Promise<ToolOutput<O>>
  readonly timeoutMs?: number
}
```

**`effects` 一个字段决定三件事：**

| | `none`（纯读） | `idempotent` | `unsafe`（bash、发消息） |
|---|---|---|---|
| 调度 | 连续的可并发 | 串行 | 串行 |
| 崩溃后 | 提示模型可安全重调 | 提示结果未知 | 提示结果未知 |
| policy 默认 | 放行 | 视规则 | 视规则 |

调度规则：连续的 `none` 调用合成一批并发，其他各自一批串行，整体保持模型给出的顺序；结果按 call 顺序排给模型，与谁先跑完无关。**拿不准就标 `unsafe`**，它最保守。

`ToolContext`（`execute` 的第二个参数）：

| 字段 | 用途 |
|---|---|
| `signal` | 取消和超时。所有可能阻塞的操作都要尊重它 |
| `sessionId` / `turnId` / `callId` | 标识 |
| `sandbox?` | 工具里所有 I/O 都应走它，这样换执行环境不用改工具 |
| `progress(data)` | 上报进度（不落盘，只给 UI） |
| `requestInput(req)` | 向外要输入：确认、表单、文本。无 `InputPort` 时 reject |

`ToolOutput`：`{ content, isError?, data? }`。`content` 是给模型看的；`data` 是给程序和 UI 看的结构化结果，**不发给模型**。`textResult('...')` 是最常用的构造器。

**core 不带 JSON Schema 校验器**（零依赖），所以参数校验由工具自己的 `parse` 完成。不提供 `parse` 就原样当 `I` 用。

### 4.3 `Capability`：skills、memory、MCP 的统一形状

```ts
interface Capability {
  readonly name: string
  instructions?(ctx): string | undefined | Promise<string | undefined>
  tools?(ctx): Tool[] | Promise<Tool[]>
}
```

loop 不需要知道 skills 或 memory 是什么，它只看到「一段说明 + 一组工具」：skills 是「索引说明 + `load_skill` 工具」，memory 是「召回摘要 + `remember`/`recall` 工具」，MCP server 是「空说明 + 远端工具」，子 agent 是「一个 `spawn` 工具」。

**turn 开始时解析一次，turn 内固定**：

- 最终 instructions = `instructions` 参数 + 各 capability 的 instructions，按声明顺序，用空行连接
- 最终 tools = `tools` 参数 + 各 capability 的 tools，按声明顺序
- 顺序固定是为了 **prompt cache 友好**
- 工具重名在 turn 开始就失败（`reason = 'error'`），不等模型调到

`CapabilityContext` 带 `input`（本 turn 的用户输入），memory 可据此做召回。

### 4.4 `PolicyPort` 与 `InputPort`：权限与「需要人」

```ts
interface PolicyPort {
  readonly specVersion: 'hue.policy.v1'
  decide(call: PolicyCall, signal): Promise<PolicyDecision>
}
// PolicyDecision: { action: 'allow' } | { action: 'deny', reason } | { action: 'ask', prompt }
```

每个工具调用执行前问一次。`deny` 的 `reason` 会被模型读到，要写清楚。`ask` 会交给 `InputPort`：

```ts
interface InputPort {
  request(req: InputRequest & { requestId, sessionId, callId? }, signal): Promise<InputResponse>
}
// InputRequest:  { kind: 'approval', prompt, detail? } | { kind: 'form', prompt, schema } | { kind: 'text', prompt }
// InputResponse: { action: 'accept', value? } | { action: 'decline', reason? } | { action: 'cancel' }
```

**一个通道处理所有「需要人」的情况**：policy 的 `ask`、工具自己调 `ctx.requestInput()`、MCP 的 `input_required` 都走这里。loop 会发 `input.requested` / `input.resolved` 事件，等待人的时间和人的回答都在日志里。

验证过的行为：

| 情况 | 结果 |
|---|---|
| policy 返回 `ask` + 用户 `decline` | `tool.result` 带 `synthetic: 'denied'`，`error.code = 'policy_denied'`，用户的理由出现在给模型的文本里 |
| policy 返回 `ask` 但没传 `inputPort` | `synthetic: 'denied'`，`error.code = 'input_unavailable'` |

### 4.5 `ContextStrategy`：每步调用模型前喂什么

```ts
interface ContextStrategy {
  readonly specVersion: 'hue.context.v1'
  readonly name: string
  prepare(input: ContextInput): Promise<ContextOutput>
}
```

只读 `state`，不改它。需要压缩就在返回值里带 `compaction`，loop 会发 `context.compacted` 事件落盘，下一步 `fold` 出来的 state 已经带着这次压缩，不会重复计算，回放时也不再调模型。`input.overflowed` 为 `true` 表示上次因超窗失败，策略应当更激进；每步最多重试一次。

### 4.6 `SandboxPort`：在哪里执行

`exec` / `readFile` / `writeFile` / `list`，由 `@hue/sandbox` 实现（本地进程、Docker、E2B 等）。工具通过 `ctx.sandbox` 使用它。

### 4.7 `EventStore`：事件落在哪

```ts
interface EventStore {
  readonly specVersion: 'hue.store.v1'
  append(events: HueEvent[]): Promise<void>            // 批量必须原子
  read(sessionId, opts?: { fromSeq?: number }): AsyncIterable<HueEvent>   // fromSeq 含本身
  lastSeq(sessionId): Promise<number>                  // 没有则 0
}
```

**loop 自己不调用 `EventStore`**，它只 yield 事件，由你（或 runtime）写入。只存 durable 事件。`append` 必须拒绝 seq 不连续或重复的批次，也必须拒绝 ephemeral 事件。

---

## 5. 事件：唯一的合同

所有包之间只通过事件通信。每个事件带信封：

```ts
{ v: 1, id, sessionId, seq, at, turnId?, step? }
```

- `v`：schema 版本，新旧版本可以共存于同一日志，由 `fold` 负责兼容
- `seq`：**只分配给持久化事件**，会话内从 1 单调递增；临时事件 `seq = 0`

| 事件 | 持久化 | 说明 |
|---|---|---|
| `session.created` | ✅ | 子 agent 带 `parent: {sessionId, turnId, callId}`，构成事件树 |
| `turn.started` / `turn.ended` | ✅ | `ended` 带 `reason`、`usage`、`steps`、`error` |
| `user.message` | ✅ | turn 输入，以及中途插话（`steer: true`） |
| `step.started` | ✅ | 带估算 token |
| `model.delta` | ❌ | 文本 / 推理增量 |
| `tool.input.delta` | ❌ | 工具参数增量 |
| `model.message` | ✅ | 完整 assistant 消息 + usage + finishReason + 耗时 |
| `context.compacted` | ✅ | 压缩结果本身 |
| `tool.call` | ✅ | **写前日志**：执行前落盘 |
| `policy.decided` | ✅ | 审计 |
| `input.requested` / `input.resolved` | ✅ | 人在回路 |
| `tool.progress` | ❌ | 进度 |
| `tool.result` | ✅ | 带 `synthetic`：`interrupted` / `denied` / `crashed` / `not_run` |
| `ext` | 自定 | 包加自己的事件，不改核心联合类型 |

**用 `isDurable(e)` 判断是否落盘**，它是唯一依据。包要加自己的事件，一律用 `{ type: 'ext', name: 'skills.loaded', durable: true, data }`，核心联合类型保持封闭、可穷举。

### 写前日志（为什么先落盘再 `next()`）

loop 每个工具调用的事件顺序是 `tool.call → (policy.decided) → (input.*) → tool.progress* → tool.result`，并且**整批 `tool.call` 先全部 yield，再开始执行**。因为 generator 是拉取式的，你在下一次 `next()` 之前写完日志，就保证了崩溃时日志里能看到「发起了什么」，从而知道哪些调用结果未知。这是 core 零 I/O 却能提供持久化保证的方式。

---

## 6. 状态、续聊与崩溃恢复

### 续聊

```ts
const events = []
for await (const e of store.read(sessionId)) events.push(e)
const state = fold(sessionId, events)

runTurn({ sessionId, state, input: userText('继续'), model, ... })
```

新事件的 `seq` 会从 `state.lastSeq + 1` 接着走。

### 崩溃恢复

进程在工具执行中途被杀，日志里会留下「有 `tool.call` 没 `tool.result`」。**开始新 turn 之前**必须先修复，否则 provider 会拒绝（tool-call 没有对应 result）：

```ts
import { fold, repairDangling, HUE_EVENT_VERSION } from '@hue/core'
import type { HueEvent } from '@hue/core'

const state = fold(sessionId, events)
let seq = state.lastSeq
const repair = repairDangling(state).map(init => ({
  ...init, v: HUE_EVENT_VERSION, id: crypto.randomUUID(), sessionId, seq: ++seq, at: Date.now(),
}) as HueEvent)
await store.append(repair)               // 先落盘，再 fold，再开始新 turn
const resumed = fold(sessionId, [...events, ...repair])
```

`repairDangling` 返回的是 `EventInit[]`（没有信封字段），由你补齐信封。它为每个悬空调用补一条 `synthetic: 'crashed'` 的结果，并在有未结束的 turn 时补一条 `turn.ended(error)`。**一律不自动重跑**：只读调用（`effects: 'none'`）的结果文本会提示模型「可以安全地再调一次」，其他则提示「结果未知，先检查状态再重试」。

验证过的行为：修复后 `danglingCalls` 为空、`openTurnId` 为空，续接的下一个 turn 发给模型的消息是 `user → assistant → tool → user`，且 `seq` 接在 `lastSeq + 1`。

### 中途打断与插话

- **打断**：触发 `signal`。已 yield 的每个 `tool.call` 仍然恰好得到一个 `tool.result`（执行中的是 `interrupted`，没开始的是 `not_run`），turn 以 `interrupted` 结束。
- **插话**：`pullSteer` 在每步工具执行完的安全点被调用，返回的消息变成 `user.message(steer: true)`，turn 继续而不是结束。

---

## 7. 错误

进日志的错误都是可序列化的 `HueError`，`code` 是封闭集合，便于统计失败发生在哪一层：

| code | 含义 |
|---|---|
| `model_error` | provider 报错（重试归 `@hue/ai`，到这里已放弃） |
| `context_overflow` | 超出上下文窗口 |
| `tool_not_found` / `invalid_tool_input` / `tool_error` / `tool_timeout` | 工具调用的各类失败 |
| `policy_denied` | 被策略拒绝 |
| `interrupted` | `AbortSignal` |
| `crashed` | 崩溃后修复出来的结果 |
| `input_unavailable` | 需要人输入但没有 `InputPort` |
| `internal` | 其他 |

在工具或适配器里抛带错误码的错用 `new HueFault({ code, message, retryable?, source?, data? })`；`toHueError(e, fallback)` 把任意异常归一化（`AbortError` 自动识别为 `interrupted`）。

**错误回给模型，而不是让 turn 失败。** 未知工具、参数错误、工具抛错、超时、被拒绝，全部变成 `isError: true` 的 `tool.result` 交给模型，由它决定怎么办。只有**模型调用本身失败**才会结束 turn（`reason: 'error'`）。

---

## 8. 实现一个包：过合同测试

core 提供合同测试，所有实现包都必须通过。从 `@hue/core/contracts` 导入：

```ts
import { eventStoreContract, policyPortContract, sandboxPortContract, toolContract, checkChunkStream, modelPortContract, call, fakeCtx } from '@hue/core/contracts'
```

| 你在实现 | 用哪个 | 要点 |
|---|---|---|
| `EventStore` | `eventStoreContract(name, make)` | 顺序保持、会话隔离、`fromSeq` 含本身、拒绝不连续 / 重复 seq、拒绝 ephemeral、批量原子、`fold(read())` 可重建 |
| `PolicyPort` | `policyPortContract(name, make, cases)` | `specVersion`、每个用例的决定、`deny` 必须有理由、**确定性**（同输入同输出） |
| `SandboxPort` | `sandboxPortContract(name, make, { workdir })` | stdout / stderr / exitCode、超时杀进程、abort 抛 `AbortError`、文件往返、env 与 stdin |
| `Tool` | `toolContract(tool, { valid, invalid?, ctx? })` | 名字合法（`^[a-zA-Z0-9_-]{1,64}$`）、描述 ≥ 10 字符、`inputSchema.type === 'object'`、`effects` 合法、合法输入可执行、非法输入被 `parse` 拒绝、尊重已 abort 的 signal |
| `ModelPort` | `checkChunkStream(chunks)` 与 `modelPortContract(name, make)` | 前者纯校验，可对录制的 fixture 跑；后者真实调用，**没有凭证时自动 skip** |

示例（来自 `test/contracts.selftest.test.ts`）：

```ts
eventStoreContract('memory', async () => memoryStore())
toolContract(echoTool, { valid: { text: 'x' }, invalid: {} })
```

实现包的结构、依赖边界和完成标准见 [docs/tasks/wave-1/00-shared-rules.md](../../../docs/tasks/wave-1/00-shared-rules.md)。

---

## 9. 不变量（测试守着的承诺）

1. **成对**：每个 `tool.call` 恰好有一个 `tool.result`。打断、拒绝、没执行、崩溃时由 loop 或 `repairDangling` 补 synthetic 结果。
2. **写前**：`tool.call` 一定在工具开始执行之前被 yield。
3. **自举一致**：`runTurn` 的最终 `state` 等于 `fold(它发出的持久化事件)`。
4. **顺序**：给模型的 tool 消息里，结果顺序等于 assistant 消息里 call 的顺序。
5. **固定**：一个 turn 内 instructions 与工具列表不变。
6. **错误回给模型**：除模型调用本身失败，其他错误都不会让 turn 失败。

---

## 10. 当前限制与已知空白

使用前请知道这些：

- **打断时的部分消息**：只保留已完成的文本，丢弃未执行的 tool-call 和没签名的推理。
- **崩溃后不自动重跑**任何调用，哪怕是纯读的。
- **压缩的切分点**：`Compaction.throughIndex` 不能落在 assistant(tool-call) 和它的 tool 消息之间，目前没有 `safeCutIndex()` 工具函数，由 `@hue/context` 自行保证。
- **大附件**：`FilePart.url` 只是引用，没有 blob 存储接口。
- **子 agent 事件**：每个子 agent 写自己的日志，父日志只记 `tool.result`，不转发子事件。
- **instructions 在 turn 内固定**：想每步更新召回内容的 memory 只能下一个 turn 生效。
- **不包含**：HTTP 重试（归 `@hue/ai`）、JSON Schema 校验（归工具的 `parse`）、结构化输出、turn 内切换模型。

以上对应 [docs/packages/core.md](../../../docs/packages/core.md) 第 9 节的 `TODO(deep)` 与 `DECIDE`。

---

## 11. 开发

```bash
cd hue
npx tsc -p packages/core                              # 类型检查（strict）
node --import tsx --test packages/core/test/*.test.ts # 全部 core 测试：11 个 loop、14 个合同自测、3 个崩溃扫描
npm run budget                                        # 行数预算
```

**改接口的流程**：先改 [docs/packages/core.md](../../../docs/packages/core.md)，再改代码和合同测试，破坏性变更升 `specVersion`。现有的 loop 测试和合同测试必须一直通过，它们是所有包并行开发的门槛。一周内 core 最多改一次，攒着一起改。
