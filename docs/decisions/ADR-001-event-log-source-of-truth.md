# ADR-001 事件日志是唯一事实源，loop 拉取即落盘
- 状态：已接受（2026-11-12 回填，2026-11-12 经用户阅读确认；决定本身来自 core 设计 v0.2，2026-10-30）
- 包：@hue/core
- 来源标记：无 `DECIDE:`。出处 `docs/packages/core.md` D1、D2

## 问题
消息历史、崩溃恢复、回放、子 agent 事件树、eval 归因，要不要各自维护一份状态？loop 怎么把事件交出去，才能让"工具执行前调用已经在盘上"？

## 候选
1. 消息历史是主，事件是附带的日志；loop 用 EventEmitter 推事件。
2. 事件日志是唯一事实源，消息历史是 `fold(events)` 的投影；loop 是 async generator，消费者拉。

## 各家怎么做（附出处）
没有逐家核实过 `TODO(verify)`。`core.md` D4 只说 `specVersion` 借鉴了 AI SDK 的 specificationVersion，与本条无关。

## 决定
选 2。
- `fold` 是纯函数。loop 维护自己的 state 的方式就是折叠自己发出的事件，所以 turn 结束时的 state 恒等于 `fold(日志)`。
- 消费者在下一次 `next()` 之前 `await store.append(e)`，就保证 `tool.call` 在工具执行前已经写进日志。core 不碰 I/O，却拿到持久化保证。
- 临时事件（`model.delta`、`tool.input.delta`、`tool.progress`）不落盘，`seq = 0`。

## 代价
消息格式变了，fold 里要兼容旧事件（靠 `v` 字段）。每个事件一次 `append`（runtime DECISIONS 第 1 条：sqlite 里一次 fsync）。

## 如何验证（eval / 测试）
- `core/test/loop.test.ts`：turn 结束的 state 等于 `fold(日志)`。
- `core/test/crash-sweep.test.ts`：在每个事件之后"崩溃"，检查日志可恢复。
- runtime 测试：调用方收到事件时它已在盘上；工具开始时 `tool.call` 已在盘上。
- store 的 `kill -9` 测试。
