# @hue/telemetry 决定记录

## 1. 怎么拿到事件？

- **选了**：`observeStore(store, t)` 包住 `EventStore`，每个事件落盘成功后上报。另有 `t.onEvent(e)` 给自己喂的人，`exportSession` 给事后补导。
- **否决的**：在 core 的 loop 里加 telemetry 钩子（core 已冻结，且违反"telemetry 只订阅事件"）；挂在 `drain` 的 `onEvent` 上（拿不到子 agent 的事件，见 README）。
- **代价**：只能看到 durable 事件。`model.delta`、`tool.progress` 看不到，所以没有"首 token 延迟"；模型调用失败而没有 `model.message` 时，没有 `chat` span，只有 turn 上的错误。
- **何时要改**：要首 token 延迟时，需要 runtime 或 ai 往日志里写一个 durable 的时间点（走 `ext` 事件）。

## 2. span 的形状

- **选了**：turn → `invoke_agent`，model.message → `chat`，tool.call/result → `execute_tool`。三者都是 turn 的直接子 span（工具不挂在 `chat` 下面，约定里的 agent 例子也是这样）。
- **一个用户请求一条 trace**，而不是一个会话一条：会话可以跨天，挂在一条 trace 里没法看。代价：同一会话的两个 turn 在后端里是两条 trace，靠 `gen_ai.conversation.id` 串起来。
- **时间**：`chat` 的开始 = 事件时间 − `durationMs`；`execute_tool` 从 `tool.call` 开始，所以**包含策略判断和等人批准的时间**（批准时间另记在 `hue.input.wait_ms`，可以扣掉）。
- **被打断不算错误**（用户要的），只记 `hue.turn.end_reason = interrupted`；被打断的半截回复（finish aborted）的 `chat` 标 `error.type = aborted`，`finish_reasons` 记 `interrupted`。

## 3. ID 为什么要由事件决定？

- **选了**：traceId / spanId 是会话、turn、调用 id 的 SHA-256 前缀，不用随机数。
- **为什么**：①同一份日志导出多次不会产生重复的 trace；②崩溃后补导出得到的和当时一样；③子会话不需要运行时传 trace 上下文——它的 `session.created.parent` 里有父 turn 和调用 id，足以算出父的 trace 和 span；单独导出子会话也能对上父。
- **代价**：ID 是可预测的（不是安全边界，只用来关联）；碰撞概率按 64/128 位算，忽略。事件里没有 `turnId` 的（崩溃恢复补出来的 `tool.result`）挂不到 turn 下面，会单独成一个根 span。
- **限制**：子会话必须先于它的 turn 事件看到 `session.created`（正常日志如此）；构建器里的映射表上限 2000 项，超了淘汰最老的，极长的单进程会话里，被淘汰后到来的子 agent 事件会退回到按哈希算——仍然对得上。

## 4. 内容要不要导出？

- **选了**：默认不导出任何内容；`captureContent: true` 导出工具参数和结果，截 4096 字符。不导出提示词和模型回复。
- **为什么**：约定里这些就是 Opt-In，且标了可能敏感。trace 后端通常是共享的、保留期长，而 agent 的参数里有文件路径、命令、密钥。
- **代价**：默认的 trace 看得到"调了什么工具、多久、成不成功"，看不到"为什么"。要回放内容用 `examples/replay.ts`（读 sqlite，不出本机）。

## 5. 绝不拖累 agent

- `onEvent` 同步入队，不抛、不等；批量发送由定时器（2 秒）或攒够 64 个触发；发送串行；失败的批次**不放回队列**（重试已在导出器里做过，再放回去会在后端宕机时无限增长）；队列满了丢最老的并报告。
- **代价**：collector 长时间宕机会丢数据。这是有意的：观测数据比 agent 的正确性便宜。
- `shutdown` 会等发完（最多受调用方给的信号限制）。**进程直接 `process.exit` 不调 `shutdown` 会丢最后一批**——`examples/agent.ts` 在退出前调了。

## 6. 为什么不用 OTel SDK

- 要的只是 span 的数据模型和 OTLP JSON 一种编码，手写约 100 行；SDK 带来的依赖（几十个包）和全局状态（全局 tracer provider）与"零依赖、可读"冲突，也没法让 span ID 由事件决定。
- **代价**：不会自动支持采样、gRPC、批处理背压、资源探测、metrics / logs。要这些就该用 SDK，这个包的 `Span` 到 SDK 的转换只需要几十行。

## 7. 命名：`hue.*` 属性

约定里没有的信息放 `hue.` 前缀下：`hue.tool.effects`、`hue.policy.action`、`hue.input.wait_ms`、`hue.turn.end_reason`、`hue.turn.steps`、`hue.step`、`hue.estimated_input_tokens`、`hue.tool.synthetic`、`hue.compaction.*`。这些没有语义约定保护，随时可能改名。
