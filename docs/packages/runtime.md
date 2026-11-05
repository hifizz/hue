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
- DECIDE: 子 agent 能否递归 spawn

## 各家怎么做（对照答案）
- Claude Code Task 工具 TODO(verify)
- Pi steer/queue TODO(verify)
- Mastra workflows / agent network TODO(verify)

## 结论
<!-- 探索后回填：选了什么、为什么、代价、对应 ADR -->

## 验收
一个配方里主 agent 派 2 个子 agent 并行完成任务；运行中插话被正确处理

## 对应 JD
编排

## 博客素材
<!-- 构建日志里值得写的坑与数据 -->
