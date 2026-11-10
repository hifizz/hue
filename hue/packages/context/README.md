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

| 策略 | 做什么 | 长任务内部能用吗 |
|---|---|---|
| `foldToolResults()` | 旧的大工具结果换成占位说明，最近 8 条原样 | **能** |
| `truncate()` | 丢最早的几轮，换成一句说明 | 不能，只切在用户消息之前 |
| `summarize({ model })` | 被丢的部分写成摘要，最近 2 轮原文 | 不能，同上 |
| `chain(a, b, …)` | 依次试，前一个不够后一个接着压 | 取决于组成 |

共同选项：`budget`（默认窗口的 80%）、`target`（默认预算的 50%）。估算按字符，故意偏高。

**要先知道的局限**：编码 agent 的一个任务通常只有一条用户消息，`truncate` / `summarize` 在这种长任务里无处可切，起作用的只有 `foldToolResults`。详见 [DECISIONS.md](DECISIONS.md) 第 0 条。

## 测试

```bash
cd hue
npx tsc -p packages/context
node --import tsx --test packages/context/test/context.test.ts   # npm test 也会跑
```

覆盖：估算、触发条件（预算 / 超窗重试）、三种策略、下标换算（在已压缩的视图上再压）、摘要失败回退、`chain`，以及两个用真 core `runTurn` 的集成（长任务窗口始终够用且 `fold(日志)` 等于 turn 的 state；模型报超窗后 loop 重来并成功）。

## 没验证的

- **摘要质量没测过**：只验证了机制，没验证摘要有没有丢掉关键信息。要等 `@hue/eval`。
- **80% / 50% / 保留 8 条等数值都是经验值**，没用真实长任务调过；也没量过压缩对 prompt cache 命中率的实际代价。
- token 估算没和 `usage.inputTokens` 对比过。
- 没有用真实模型跑过 `summarize`。
