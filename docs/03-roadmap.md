# 03 路线图

## 求职版切片（约 3 周）
### 第 1 周：能跑的最小内核
- [ ] monorepo 骨架、CI、lint
- [ ] core：类型、事件 v1、Tool/Store 接口、loop（async generator）
- [ ] ai：薄封装（DECIDE: AI SDK 还是 pi-ai）
- [ ] tools：read / edit / bash；手写 MCP client（规范 2026-07-28 无状态，stdio 先，兼容 2025-11-25 回退）
- [ ] 里程碑：编码 agent 配方在真实仓库修一个 bug
- [ ] 博客：构建日志 #1 loop、#2 MCP

### 第 2 周：上下文与能力
- [ ] context：预算 + 三种压缩策略
- [ ] skills：渐进加载
- [ ] memory：写入/召回工具 + 存储
- [ ] store：SQLite 事件日志 + 回放
- [ ] 博客：构建日志 #3 compaction、#4 skills vs memory

### 第 3 周：编排与证据
- [ ] runtime：子 agent、排队、打断、恢复
- [ ] eval：20 任务 + 报告
- [ ] 横评长文 + 《我为什么要亲手写一个 harness》
- [ ] 简历重写，开始投递

## 之后（全色版）
- policy / sandbox 实现，gateway，telemetry
- 进阶配方：常驻个人 agent
- 每周一包一篇深拆解；Playground；Show HN / Product Hunt
