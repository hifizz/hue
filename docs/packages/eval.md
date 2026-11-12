# @hue/eval

## 职责
任务集、执行器、评分、报告。只订阅事件。

## 不做
不影响运行行为。

## 接口草图（非最终）
```ts
export interface EvalTask { id: string; setup(): Promise<Workspace>; prompt: string; check(ws: Workspace, events: HueEvent[]): Promise<Score> }
// hue eval run --recipe coding-agent --model X --tasks evals/tasks
```

## 关键问题
- TODO(deep): 任务集设计——~20 个：编码 bug 修复、长上下文、需要 skill、需要 MCP、需要记忆、需要子 agent 各几题
- DECIDE: 对照组——同模型下 Pi（必选）、Claude Code（可选）
- TODO(deep): 失败案例分析模板——现象、发生在哪一层、改了什么、前后数据
- DONE(ADR-013): 只用客观判分（命令退出码），暂无 LLM judge

## 各家怎么做（对照答案）
- SWE-bench Lite / Terminal-Bench 作为任务来源参考 TODO(verify)
- TARS GUI bench 方法复用

## 结论
最小版已实现（`hue/packages/eval`，取舍见该包 DECISIONS.md）：
- 任务 = `setup` 造仓库 + `check` 判分；`repoTask()` 是"一组文件 + 一条判分命令"。判分在 agent 用的同一个执行环境里跑，判分前测试文件被写回，改测试没用。
- 评分只做客观的（测试通过），没有 LLM judge；状态 `pass / fail / timeout / error`，`error` 是评测自己的问题，单独计数。
- 报告：成功率、token（含缓存）、耗时、按任务 / 标签、失败分层（粗略）、失败案例（最后几步 + 会话 id）；Markdown 和 JSON 两份。
- 还没做：20 道题（现在 5 道）、对照组、前后对比、失败案例分析模板。没有用真实模型跑过。

## 验收
一条命令复现报告；报告含成功率、token、耗时、3 个失败案例

（`examples/eval.ts` 一条命令出报告，格式齐了；真实模型的报告还没有。）

## 对应 JD
对模型行为有品味

## 博客素材
<!-- 构建日志里值得写的坑与数据 -->
