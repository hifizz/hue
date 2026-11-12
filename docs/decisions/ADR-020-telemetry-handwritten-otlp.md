# ADR-020 telemetry 手写 span 和 OTLP/HTTP JSON，不用 OTel SDK；ID 由事件决定
- 状态：已接受（2026-11-12 回填，2026-11-12 经用户阅读确认）
- 包：@hue/telemetry
- 来源标记：无 `DECIDE:`。出处 telemetry DECISIONS 第 1、3、6 条

## 问题
怎么把事件日志变成 OTel span？用不用 OTel SDK？trace / span ID 怎么来？

## 候选
1. 用官方 OTel SDK。
2. 手写 span 数据模型加 OTLP/HTTP JSON 一种编码。
3. ID：随机 / 由会话、turn、调用 id 决定。

## 各家怎么做（附出处）
遵循 OTel GenAI 语义约定，但该约定本身仍是 Development 状态。没有核实其他 harness 的做法。

## 决定
- 手写，约 100 行。SDK 带来几十个依赖和全局状态（全局 tracer provider），与"零依赖、可读"冲突，也没法让 span ID 由事件决定。
- `observeStore(store, t)` 包住 `EventStore`，每个事件落盘成功后上报；不在 core 的 loop 里加钩子（core 已冻结，且违反"telemetry 只订阅事件"）。
- 形状：turn → `invoke_agent`，`model.message` → `chat`，`tool.call/result` → `execute_tool`，三者都是 turn 的直接子 span。一个用户请求一条 trace，同一会话的多个 turn 靠 `gen_ai.conversation.id` 串起来。
- traceId / spanId 是会话、turn、调用 id 的 SHA-256 前缀：同一份日志导出多次不重复，崩溃后补导出结果一致，子会话不用传 trace 上下文就能挂到父 trace 下。
- 默认不导出任何内容；`captureContent: true` 才导出工具参数和结果，截 4096 字符。
- 绝不拖累 agent：入队不抛不等，批量发送，失败的批次不放回队列，队列满丢最老的。

## 代价
不会自动支持采样、gRPC、批处理背压、资源探测、metrics / logs；要这些就该用 SDK（转换只需几十行）。只能看到 durable 事件，所以没有首 token 延迟。collector 长时间宕机会丢数据（有意）。进程直接 `process.exit` 不调 `shutdown` 会丢最后一批。ID 可预测（只用来关联，不是安全边界）。

## 如何验证（eval / 测试）
- `telemetry/test/`：span 的层级和属性（`spans.test.ts`）、OTLP JSON 编码与重试 / 取消（`otlp.test.ts`）、批量 / 队列上限 / 导出失败不影响后续 / `observeStore` 落盘成功后才上报（`telemetry.test.ts`）。
- **没有对着真实 collector 发过。**
