# @hue/telemetry

把事件日志变成 OpenTelemetry 的 GenAI span，用 OTLP/HTTP JSON 发给任何 collector（Jaeger、Tempo、Langfuse、Honeycomb……）。只读事件，不影响 agent 的行为；只依赖 `@hue/core`，不引 OTel SDK（`node:crypto` 加全局 `fetch`）。

```ts
import { telemetry, observeStore } from '@hue/telemetry'

const t = telemetry({ url: 'http://localhost:4318/v1/traces', serviceName: 'my-agent', headers: { authorization: '…' } })
const agent = createAgent({ model, store: observeStore(store, t) /* 其余照旧 */ })
await drain(agent.run('修好 add'))
await t.shutdown()   // 退出前发完；进程直接 exit 的话最后一批会丢
```

**为什么包住 store，而不是挂在 `drain` 上**：子 agent 的事件只经过它自己那次 `run` 的循环，不会出现在父的事件流里；但所有 durable 事件都要 `store.append`。包住 store，父子会话一次收齐，且事件落盘成功之后才上报（落盘失败的不会出现在 trace 里）。

| Hue 事件 | span | 要点 |
|---|---|---|
| 一个 turn | `invoke_agent`（CLIENT） | `gen_ai.conversation.id` = 会话 id；总用量；`hue.turn.end_reason`；上下文压缩作为 span 事件 |
| `model.message` | `chat <模型>`（CLIENT） | provider / 模型取自 `anthropic:claude-…`；`finish_reasons`；用量 |
| `tool.call` → `tool.result` | `execute_tool <工具>`（INTERNAL） | `hue.tool.effects`、`hue.policy.action`；等人批准的时间 `hue.input.wait_ms` 和两个 span 事件 |

- **一个用户请求 = 一条 trace**。子 agent 的 turn 挂在父会话派它的那次 `execute_tool` 下面，同一条 trace。
- **ID 由事件决定**（哈希会话 / turn / 调用 id）：同一份日志导出多次得到同样的 span；`exportSession(store, id, t)` 可以事后补导出一个会话，包括崩溃留下的（没结束的标 `error.type = unfinished`）。
- **`gen_ai.usage.input_tokens` 含缓存读写**（约定如此；Hue 日志里的 `inputTokens` 不含，这里加回去）。
- **内容默认不导出**：`captureContent: true` 才带工具参数和结果（各截到 4096 字符），里面可能有代码、路径、密钥。
- **永远不拖累 agent**：`onEvent` 不抛、不等；队列上限 2048，导出器跟不上就丢最老的并通过 `onError` 报告；发送串行。
- **重试照 OTLP 规范**：429 / 502 / 503 / 504 和连接失败指数退避重试（认 `Retry-After` 秒数），其它 4xx / 5xx 不重试，部分成功不重试（重发只会重复）。
- 不是 `url` 而想自己发：传 `exporter: { export(spans, signal) }`；`toOtlp(spans, resource)` 是纯函数。

## 测试

```bash
cd hue
npx tsc -p packages/telemetry
node --import tsx --test packages/telemetry/test/*.test.ts      # npm test 也会跑
node --import tsx --test examples/telemetry.test.ts              # 真 runtime + sqlite + 子 agent
```

状态机用构造的事件测（层级、时间、用量、批准等待、子 agent 链接、崩溃残留、确定性）；导出器对着真 HTTP server 测（重试、退避、`Retry-After`、不可重试、部分成功、超时、取消）。

## 没验证的

- **没有对着真实的 collector / Jaeger / Langfuse 发过**，OTLP JSON 的字段只对着我读到的规范写；各后端怎么显示这些 span 没看过。
- GenAI 约定整体还是 **Development** 状态（只有 `error.type` 是 Stable），名字以后可能改。我读的是 `open-telemetry/semantic-conventions-genai` 的 `client-inference.md`、`execute-tool.md`、`client-invoke-agent.md`（2026-11-11）；inference 那页后 1/4 没读到。
- 没做：`gen_ai.input.messages` / `output.messages`（日志里没有发出去的完整请求，且结构要对着规范写）、指标（metrics）、日志（logs）、gRPC、`traceparent` 往 MCP 请求里透传。
- `finish_reasons` 是 Hue 归一化后的值（`tool-calls`），不是 provider 原始值（`tool_use`），偏离了约定的偏好。
