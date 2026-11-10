# @hue/context

core 的 `ContextStrategy`：每一步调模型前，在 token 预算内决定喂给模型什么。估算超预算就压缩，压缩结果以 `context.compacted` 事件落进日志。零运行时依赖。

```ts
import { chain, foldToolResults, summarize } from '@hue/context'

const context = chain(
  foldToolResults(),            // 先把旧的大工具结果折成占位说明：不花钱、可恢复
  summarize({ model }),         // 还超，再让模型写摘要
)
runTurn({ /* … */, context })
```

| 策略 | 做什么 | 一条用户消息的长任务里 |
|---|---|---|
| `foldToolResults()` | 旧的大工具结果换成占位说明，最近 8 条原样 | **能** |
| `truncate()` | 丢最早的几轮 / 几步，换成一句说明，任务原文保留 | 能，切在工具结果之后，至少留 6 步 |
| `summarize({ model })` | 被丢的部分写成摘要，最近 2 轮原文，任务原文保留 | 能，同上 |
| `chain(a, b, …)` | 依次试，前一个不够后一个接着压 | 取决于组成 |

共同选项：`budget`（默认窗口的 80%）、`target`（默认预算的 50%）；`truncate` / `summarize` 另有 `keepTurns`（最近几轮不动）和 `keepSteps`（切在一轮中间时至少剩几步，默认 6）。估算按字符，故意偏高。

**要先知道的局限**：`keepSteps` 是下限不是上限——最近 6 步里单个结果很大时，`truncate` 压不进预算，要先 `foldToolResults`。切点规则和取舍见 [DECISIONS.md](DECISIONS.md) 第 0 条。

## 测试

```bash
cd hue
npx tsc -p packages/context
node --import tsx --test packages/context/test/context.test.ts   # npm test 也会跑
```

覆盖：估算、触发条件（预算 / 超窗重试）、三种策略（含只有一条用户消息的长任务、任务原文带过去、二次压缩不叠加、任意预算和参数下的结构检查）、下标换算（在已压缩的视图上再压）、摘要失败回退、`chain`，以及两个用真 core `runTurn` 的集成（长任务窗口始终够用且 `fold(日志)` 等于 turn 的 state；模型报超窗后 loop 重来并成功）。

## 没验证的

- **摘要质量没测过**：只验证了机制，没验证摘要有没有丢掉关键信息。要等 `@hue/eval`。
- **80% / 50% / 保留 8 条等数值都是经验值**，没用真实长任务调过；也没量过压缩对 prompt cache 命中率的实际代价。
- token 估算没和 `usage.inputTokens` 对比过。
- 没有用真实模型跑过 `summarize`。
