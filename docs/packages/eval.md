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
- DECIDE: 评分方式——测试通过（客观）为主，LLM judge 为辅？

## 各家怎么做（对照答案）
- SWE-bench Lite / Terminal-Bench 作为任务来源参考 TODO(verify)
- TARS GUI bench 方法复用

## 结论
<!-- 探索后回填：选了什么、为什么、代价、对应 ADR -->

## 验收
一条命令复现报告；报告含成功率、token、耗时、3 个失败案例

## 对应 JD
对模型行为有品味

## 博客素材
<!-- 构建日志里值得写的坑与数据 -->
