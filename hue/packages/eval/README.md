# @hue/eval

把一个 agent 放到一组任务上跑，用客观检查（测试是否通过）判分，出报告：成功率、token、耗时、失败案例。只依赖 `@hue/core`，指标全部从事件日志算，不碰 agent 的内部。

```ts
import { codingTasks, runEval, summarize, formatReport } from '@hue/eval'

const results = await runEval(codingTasks(), {
  run: async job => { /* 用 job.sandbox 跑 agent，把事件交给 job.onEvent(e) */ },
  sandbox: async dir => docker({ mount: dir }),   // 每次试跑一个新环境，判分也在里面跑
  trials: 3,
})
console.log(formatReport(summarize(results), { model: 'claude-sonnet-5-5' }))
```

- `EvalTask`：`setup(dir)` 造初始状态，`check(ctx)` 判分。`repoTask()` 是最常见的一种：一组文件 + 一条判分命令，退出码 0 算通过。
- 判分前测试文件会被**原样写回**，agent 改测试蒙混过关没用；判分命令在 agent 用的同一个执行环境里跑，agent 写的代码不在宿主上跑。
- 状态：`pass` / `fail` / `timeout`（agent 超时，不再跑 check）/ `error`（评测自己出了问题，比如 Docker 没起来）。有 `error` 时报告会警告，成功率不可信。
- 没通过的试跑会带一个粗略的"失败在哪一层"（`model` / `context` / `step-limit` / `tools` / `wrong-result` / `timeout` / `harness`…），只是看事件猜的，不是诊断；报告里每个失败案例附最后几步和会话 id，细看用 `examples/replay.ts`。
- `codingTasks()`：5 个小仓库（3 个 bug、1 个按注释实现的功能、1 个 40 个相似文件里改对一个）。

跑真实模型：`examples/eval.ts`，见 [examples/README.md](../../examples/README.md)。

## 测试

```bash
cd hue
npx tsc -p packages/eval
node --import tsx --test packages/eval/test/*.test.ts      # npm test 也会跑
node --import tsx --test examples/eval.test.ts              # 端到端：真 runtime + sqlite + local 沙箱
```

每道内置任务都自检：初始状态必须不通过，已知的正确改法必须通过；还测了改测试作弊、顺手改了别的模块、超时、runner 抛错、取消、并发、报告的统计。

## 没验证的

- **没有用真实模型跑过**，所以不知道这 5 道题对模型是太简单还是刚好；样本只有 5 道，说明不了模型行为。
- 没有对照组（同模型下的 Pi / Claude Code），也没有 LLM judge。
- Docker 路径只在 `examples/eval.ts` 里接了线，没跑过。
