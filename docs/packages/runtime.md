# @hue/runtime

## 职责
唯一组装处：把各包拼成 agent；管子 agent、消息排队、打断、恢复。

## 不做
不定义新接口（都在 core）。

## 接口草图（非最终）
```ts
export function createAgent(cfg: AgentConfig): Agent
interface Agent { run(input: string, opts?): AsyncIterable<HueEvent>; steer(msg: string): void; interrupt(): void }
// 子 agent：作为一个 Tool 暴露（task / spawn_agent）
```

## 关键问题
- TODO(deep): 子 agent——作为工具暴露、上下文隔离、结果如何回传、并发上限、事件树怎么记
- TODO(deep): 运行中用户插话——排队到下一轮（queue）还是注入当前轮（steer）；和工具执行的交错
- TODO(deep): 打断与恢复——从 store 恢复进行中的会话
- DONE: 子 agent 能否递归 spawn——由构造决定，见 hue/packages/runtime/DECISIONS.md 第 6 条

## 各家怎么做（对照答案）
- Claude Code Task 工具 TODO(verify)
- Pi steer/queue TODO(verify)
- Mastra workflows / agent network TODO(verify)

## 结论
已实现（`hue/packages/runtime`，取舍见该包 DECISIONS.md）：
- `createAgent(cfg).run(input, { sessionId })` 是 async generator：每个事件先落盘再交给调用方；开始前自动修复崩溃残留；同一会话同一时刻一个 turn。
- 运行中插话：`steer()` 在安全点（本步工具结果齐了之后）注入同一个 turn；turn 结束瞬间才到的接着开新 turn；打断 / 出错时没送到的原样还给调用方。
- 打断：`interrupt()` 或外部 signal；调用方中途放弃 `run` 等同打断，会先补齐日志。
- 子 agent：普通 Tool（`subagentTool`），独立会话 + `parent` 构成事件树，并发由工具的 `effects` 决定；是否递归由构造决定（子配置里不放这个工具）。
- 还没做：队列式（等当前 turn 结束再处理）的插话、子 agent 用量汇总、跨进程的会话互斥（目前靠 store 的 seq 唯一约束兜底）。

## 验收
一个配方里主 agent 派 2 个子 agent 并行完成任务；运行中插话被正确处理

## 对应 JD
编排

## 博客素材
<!-- 构建日志里值得写的坑与数据 -->
