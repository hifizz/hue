# Hue Agent Harness — 项目笔记
（来源：主聊天 2026-10-28/29 的决定；状态标注为准）

## 1. 定位（提议，用户还在确认）
- 世界不缺 harness，Hue 不说自己更好。
- 主线：现有 harness 都是整块的——
  - Pi：为编码 agent 设计，无跨会话记忆，skills/compaction 写死在 pi-coding-agent
  - AI SDK 7：只到 loop，无记忆/skills
  - Mastra：一个 60+ 子模块的大 core
  - fx：Zig 单二进制
- Hue = 13 个一下午能读完、能替换的小包，用来调出自己的 agent。
- 入门配方：编码 agent；进阶配方：常驻个人 agent（来自用户做 TARS 的经历）。
- 坦白边界：只要编码 agent，就用 Pi 或 Claude Code。
- 用户最大的疑问：「为什么还要再做一个 harness」（类比 tw93 自己做 Kaku）。
- **真实理由（用户 2026-10-29 确认）**：想应聘 Agent Harness 研发岗（2026-10-28 那份 JD，或其他公司同类岗位），借此完整亲手开发、学习一遍 harness。Hue 同时是作品集。
- 建议的对外说法（待用户认可）：不说更好，说「我把 harness 13 层亲手写一遍，每层对照 Pi/AI SDK/Mastra/fx/Claude Code 讲取舍」。

## 2. 品牌
- 名字 Hue（色相），npm scope @hue。2026-10-29：@hue/core、@hue/ai 未被占；org 是否已注册未知。
- 意象：几种基础色相调出无数颜色；每个包是一种色相，每个 agent 是一份配方，13 层合上变白光。
- 色轮只用 橙→金→绿→青→天蓝。**绝不用粉色/紫色**（硬性偏好）。
- 对外写全称（Hue Agent / hue.dev），避开 Philips Hue。
- 口号备选：「几种色相，无数种 Agent。」/ Mix your own agent.

## 3. 13 层
provider, loop, tools, eventlog, context, skills, memory, policy, sandbox, subagents, gateway, telemetry, eval

## 4. 包
- 主包：@hue/ai, core（不做 I/O，含 Tool/Store/Policy/Sandbox 接口）, tools（含 MCP）, store, context, skills, memory, policy, sandbox, runtime（唯一组装处，管子 agent/排队/打断）, gateway
- 横切：telemetry, eval
- 事件是跨包合同，schema 带版本号。
- 实现顺序：core+ai+tools → store → policy+sandbox → context+skills+memory → runtime → gateway+telemetry+eval
- 借鉴：Pi 的 telemetry/MCP 零依赖独立包；AI SDK 接口带版本号（HarnessV1）；Mastra 适配器按类别分目录；fx 对外一个包加子路径导出。

## 5. 内容体系
- 四支柱：拆解 40% / 构建日志 30% / 证据(eval) 20% / 配方 10%
- 博客为事实源；公众号/即刻、X（英文 + 10 秒动画）、GitHub README 链回博客。
- 节奏：①《为什么又一个 harness》长文 + 拆解图 → ② 每周一个包一篇拆解 → ③ 全色发布（Show HN / Product Hunt + Playground）

## 6. Landing Page 信息架构（8 节，每节回答一个问题）
1. 这是什么
2. 为什么还要做
3. 由什么组成（拆解图）
4. 怎么调出我的 agent（配方）
5. 凭什么信你（可读·可换·可信 三个承诺及证明）
6. 什么时候不该用
7. 现在做到哪（路线图）
8. 下一步（读长文 或 Star，二选一）
- 第一版先做 2、3、6、7 节。

## 7. Assets
- 拆解图 Page「harness-exploded-view」：REV 0.2，13 层，含分包表和 Pi/AI SDK/Mastra/fx 对比。
- 场景代码：/workspace/work/linework-proto/harness-scene.js、linework.bundle.js（旧版 harness-scene.v10.js）
- 源码克隆：/workspace/work/pkgcmp/{ai,mastra,fx,pi}

## 求职对齐（2026-10-29 建议，待用户认可）
- JD 映射：内核(context/memory/skills/编排)→Hue 同名包+runtime；MCP 工具体系→tools 手写 MCP client；架构文档→每包 ADR；前沿研究→拆解支柱；模型品味→eval 支柱。
- 先做求职版切片（约 3 周）：core+ai+tools/MCP → context(compaction) → skills+memory → runtime(subagent/打断) + 小 eval；sandbox/gateway/telemetry 后置。
- 投递包：GitHub 仓库 + 长文 + 横评拆解 + eval 报告 + 简历用 harness 语言重写 ThreadChat/TARS。

## 下一步
- [x] 用户确认定位的「为什么」：求职 + 亲手学一遍
- [ ] 写《为什么又一个 harness》大纲
- 尚未开始任何构建。
