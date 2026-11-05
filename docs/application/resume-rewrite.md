# 简历改写（用 harness 语言）

## Hue（新增，放第一）
- 从零实现 13 层 agent harness：loop、手写 MCP client、上下文压缩、skills、跨会话记忆、子 agent 编排
- 公开横评 5 家 harness；eval：<数据待填>

## ThreadChat
- 多执行器 coding agent 派发：<把"派发"改写为 runtime / gateway 层的设计取舍>
- 沙箱、计费：<对应 sandbox / telemetry 层>
- TODO(deep): 挑 2 个可量化结果

## TARS
- 常驻 agent：崩溃恢复、副作用不重放、routines（sleepUntil）→ 对应 store / runtime 层
- GUI bench：无障碍树让 glm-5.3 L1–L3 成功率 18% → 100% → "感知接口比模型更重要"

## 金融大模型评测题库
- 对应 eval 能力
