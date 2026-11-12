# 00 目标

## 为什么做（真实理由）
我想应聘 Agent Harness 研发岗。最好的证明是亲手把 harness 写一遍，并公开讲清楚每一层的取舍。
Hue 不声称比 Pi / Claude Code 更好；它是**可读、可换**的 13 个小包，也是我的学习记录和作品集。

## JD 对照（每一条都要有可指向的证据）
| JD 要求 | 证据（Hue 里的哪一块） | 状态 |
|---|---|---|
| 内核：上下文、记忆、Skills、编排 | packages/context, memory, skills, runtime | [ ] |
| MCP 工具体系、懂调用链路底层 | packages/tools：手写 MCP client | [ ] |
| 架构方案、接入规范、文档化、原型验证 | 本 docs + decisions/ADR-* + tools 接入规范 | [ ] |
| 跟踪拆解前沿 harness | research/teardown-framework.md → 横评长文 | [ ] |
| 对模型行为有品味 | packages/eval → eval 报告 + 失败案例分析 | [ ] |
| 加分：开源 + 拆解博客 + 一人全栈 | 仓库 + 博客 + 拆解图 Page + ThreadChat/TARS | [ ] |

## 投递包（面试官 10 分钟能看完）
1. **GitHub 仓库 hue**：README 首屏 = 拆解图 + 一条命令跑起编码 agent 配方
2. **长文**《我为什么要亲手写一个 harness》（大纲见 01）
3. **横评拆解**：Pi / AI SDK 7 / Mastra / fx / Claude Code，统一维度
4. **eval 小报告**：~20 个任务，同模型下 Hue vs Pi，附 3 个失败案例分析
5. **简历重写**：用 harness 语言讲 ThreadChat 和 TARS

## 成功标准
- 编码 agent 配方能在一个真实仓库里修一个真实 bug（录屏）
- 每个求职版包 README ≤ 一下午读完：DONE(ADR-004): 用每包 src/ 行数预算量化，见 `hue/scripts/budget.mjs`
- 每个包至少 1 份 ADR
- eval 报告能复现（一条命令）

## 不做（求职版）
policy / sandbox / gateway / telemetry 的完整实现（只写接口和设计，见 packages/deferred.md）；Playground；多语言 SDK。
