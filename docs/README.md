# Hue 设计文档（骨架 v0.1，2026-10-29）

> 目的：这批文档是 Hue 的"方案骨架"。核心决定写清楚，复杂但必须深挖的问题全部留标记，
> 之后拿到 ThreadChat 里逐个深度探索，结论回填到文档，再变成代码。

## 两个目标（按优先级）
1. **求职投递包**：仓库 + 长文 + 横评拆解 + eval 报告 + 简历重写（见 `00-goal.md`）
2. **把 Hue 写出来**：13 层、13 个小包，先做求职版切片（见 `03-roadmap.md`）

## 标记约定（grep 这些就能拿到全部待办）
| 标记 | 含义 | 处理方式 |
|---|---|---|
| `DECIDE:` | 需要拍板的设计选择，已列出候选 | 在 ThreadChat 里比较候选 → 写 ADR → 改文档 |
| `TODO(deep):` | 复杂、必须深挖的问题 | 单独开一轮探索，结论写进对应文档 "结论" 段 |
| `TODO(verify):` | 对其他 harness 的说法，需对照源码核实 | 读 Pi / AI SDK / Mastra / fx / Claude Code 源码或文档 |
| `LATER:` | 求职版不做，全色版再做 | 不动 |

`grep -rn "DECIDE:\|TODO(deep)\|TODO(verify)" docs/`

## 目录
- `00-goal.md` 目标、投递包、成功标准
- `01-why-article-outline.md` 长文《我为什么要亲手写一个 harness》大纲
- `02-architecture.md` 13 层 → 包、依赖方向、事件合同、组装方式
- `03-roadmap.md` 3 周切片与之后
- `04-challenges.md` 重点、难点、挑战与越过方法、面试追问、每周检查点
- `packages/*.md` 每个包一页（求职版：core, ai, tools, store, context, skills, memory, runtime, eval；另有 gateway 骨架；后置：deferred.md）
- `research/teardown-framework.md` 横评维度与 5 家对比表
- `application/kit.md` 投递包清单；`application/resume-rewrite.md` 简历改写
- `decisions/ADR-000-template.md` 决策记录模板

## 在 ThreadChat 里怎么用（建议流程）
1. 每轮只喂：`README.md` + `02-architecture.md` + 目标包那一页（+ 相关 ADR）
2. 让它只处理该页的一个 `DECIDE:` 或 `TODO(deep):`
3. 产出：一份 ADR + 对该页的 diff + （可选）原型代码
4. 回填后把标记删掉或改成 `DONE(ADR-xxx)`
