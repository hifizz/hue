# 01 长文大纲：《我为什么要亲手写一个 harness》

> 读者：招聘方工程师、做 agent 的同行。目标：读完相信"这个人真的懂 harness 每一层"，并点进仓库。
> 篇幅：DECIDE: 4000 字 / 6000 字？配图：拆解图 Page 嵌入 + 每节一张小图。

## 0. 开头（~300 字）
- 一句话：世界不缺 harness，我还是写了一个。
- 坦白动机：想做 harness 方向的工作；用过很多、在上面做过产品（ThreadChat、TARS），但没亲手写过 loop、工具层、compaction。
- 类比：tw93 自己写 Kaku —— 不是因为没有终端，而是想弄懂并按自己的方式拼。TODO(verify): 核实 Kaku 的出发点表述，引用原文

## 1. 我在 harness 之上踩过的坑（~800 字）
- ThreadChat：派发外部执行器时，harness 的哪些边界是黑盒（事件格式、打断、成本）
- TARS：常驻 agent 需要跨会话记忆、崩溃恢复、副作用不重放；编码 agent harness 默认没有
- bench 数据：感知接口（无障碍树）让成功率 18% → 100% —— 结论：harness 的形状比模型更影响结果
- TODO(deep): 挑 2 个最有说服力的具体事故，写成"现象 → 原因在哪一层 → 当时没法改"

## 2. 现有 harness 为什么让我想拆开（~800 字）
- 不是批评，是"整块"的取舍：
  - Pi：为编码 agent 设计；skills / compaction 在 coding-agent 包里 TODO(verify)
  - AI SDK 7：到 loop 为止，记忆 / skills 留给你 TODO(verify)
  - Mastra：功能全，core 很大（60+ 子模块）TODO(verify): 数字
  - fx：Zig 单二进制，好用但不可拆 TODO(verify)
  - Claude Code：闭源内核，只能从行为和文档反推
- 小结表（链接横评长文）

## 3. Hue 是什么（~800 字）
- 13 层地图 + 拆解图（嵌入 Page）
- 色相隐喻：每个包是一种色相，每个 agent 是一份配方，13 层合上是白光
- 三个承诺：可读（一下午读完一个包）/ 可换（接口带版本号）/ 可信（eval 公开）
- 两份配方：入门 = 编码 agent；进阶 = 常驻个人 agent

## 4. 我会怎么写（~600 字）
- 依赖方向：core 不做 I/O，runtime 是唯一组装处，事件是跨包合同
- 顺序：core+ai+tools → store → context+skills+memory → runtime → eval
- 每层的产出：代码 + ADR + 一篇拆解

## 5. 什么时候不该用 Hue（~300 字）
- 只要编码 agent：用 Pi 或 Claude Code
- 要生产级托管：DECIDE: 推荐谁？
- 想读懂 harness 或调出非编码 agent：来看 Hue

## 6. 现在做到哪 + 下一步（~200 字）
- 路线图（03）当前状态
- CTA：读拆解图 / Star 仓库（二选一，DECIDE: 主 CTA）

## 写作注意
- 每个对别家的说法必须有出处链接（源码行或文档）
- 不用"更好""革命性"；用"我选了 X，代价是 Y"
