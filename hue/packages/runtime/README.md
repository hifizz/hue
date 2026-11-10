# @hue/runtime

唯一组装处：把 model、store、tools、policy、sandbox、context 拼成一个 agent，并管会话、崩溃恢复、插话、打断、子 agent。只依赖 `@hue/core`，别的包由调用方传进来。

```ts
import { createAgent, drain } from '@hue/runtime'

const agent = createAgent({ model, store, tools: codingTools(), sandbox, policy, context, input })
const r = await drain(agent.run('修好 add', { sessionId: 's1' }), printer) // 同一个 sessionId 再 run 就是续聊
agent.steer('s1', '顺便跑一下测试')   // 运行中插话，在下一个安全点送给模型
agent.interrupt('s1')                 // 打断当前 turn
```

| | 做什么 |
|---|---|
| `run(input, opts?)` | async generator。每个事件交给你之前已经落盘；开始前自动修复上次崩溃留下的悬空工具调用；返回 `RunResult`（含 `undelivered`） |
| `steer(sessionId, input)` | 排进队列，本步工具结果齐了之后送给模型；会话没在跑返回 `false` |
| `interrupt(sessionId)` | 打断；会话没在跑返回 `false` |
| `load(sessionId)` | 从日志重建状态 |
| `drain(gen, onEvent?)` | 把 `run()` 跑完，拿返回值 |

## 子 agent

```ts
const researcher = createAgent({ model, store, tools: [read, grep], instructions: '只读调研，给出结论和证据' })
const lead = createAgent({ model, store, tools: [...codingTools(), subagentTool({ agent: researcher, effects: 'none' })] })
```

子 agent 是父 agent 的一个工具：独立上下文、独立会话（`session.created.parent` 指回父的那次调用）、父只看到最后一条回复。`effects: 'none'`（子 agent 全是只读工具时）会让同一步里派的多个子 agent 并发跑，`maxConcurrent` 限上限。

同一个会话同一时刻只能有一个 `run`（再 `run` 会抛错）；不同会话互不影响。提前 `return()` 等于打断：先补齐日志再释放会话。取舍见 [DECISIONS.md](DECISIONS.md)。

## 测试

```bash
cd hue
npx tsc -p packages/runtime
node --import tsx --test packages/runtime/test/*.test.ts   # npm test 也会跑
```

测试里用内存日志和脚本化模型，覆盖子 agent（并发、上下文隔离、事件树、失败、打断含排队中的）和：落盘顺序（调用方收到事件时已在盘上、工具开始时 tool.call 已在盘上）、续聊、崩溃恢复、会话互斥、插话（含 turn 结束瞬间才到的）、打断、放弃 run、落盘失败。

## 没验证的

- 没接真实模型和真实 store 跑过（`examples/agent.ts` 接了之后才算）。
- steer 只在步与步之间送达，模型正在长输出时不会被截断（见 DECISIONS 第 2 条）。
