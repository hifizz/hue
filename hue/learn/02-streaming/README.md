# 第 2 课：流式

文件：[sse.ts](sse.ts) · [anthropic.ts](anthropic.ts) · [loop.ts](loop.ts) · [types.ts](types.ts) · [fixtures.ts](fixtures.ts) · [demo.ts](demo.ts) · [streaming.test.ts](streaming.test.ts)

第 1 课里模型一次返回整条回复，真实 API 是一边生成一边发。这一课解决：怎样把一串零碎的网络数据，变成第 1 课的 loop 能用的完整消息。

## 三层结构

```
网络字节 ──parseSSE──▶ SSE 事件 ──toChunks──▶ Chunk ──streamingLoop──▶ 完整消息 + 事件
(sse.ts)              (anthropic.ts)            (loop.ts)
```

每层只解决一个问题，测试也按层分：哪层出错，哪组测试红。

## 第一层：字节 → SSE 事件（[sse.ts](sse.ts)）

网络包的边界和事件的边界没有关系：一个事件可能被切成三个包，一个中文字的 3 个字节可能分在两个包里。所以要自己攒缓冲区，遇到空行才算一个事件结束。

`TextDecoder` 要用 `{ stream: true }`：它会记住上一个包末尾没收完的多字节字符，否则被切开的中文会变成乱码 `�`。

## 第二层：Anthropic 事件 → Chunk（[anthropic.ts](anthropic.ts)）

Anthropic 把回复拆成内容块，每块都经历 `start → delta × N → stop`：

```
message_start                          初始 usage
content_block_start  index=0 thinking
content_block_delta  index=0 thinking_delta × N
content_block_delta  index=0 signature_delta     ← 签名在 stop 之前才到
content_block_stop   index=0
content_block_start  index=1 text …
content_block_start  index=2 tool_use {id, name, input: {}}
content_block_delta  index=2 input_json_delta × N  ← partial_json 是 JSON 片段
content_block_stop   index=2                       ← 到这里才能 JSON.parse
message_delta        stop_reason + 累计 usage
message_stop
```

关键规则（出处：Anthropic 官方 Streaming messages 文档）：

- **工具参数攒到 `stop` 才能解析。** `{"cit` 和 `y":"旧` 单独都不是合法 JSON。
- `content_block_start` 里工具的 `input` 永远是空对象，不能当真。
- **推理块的签名在 `stop` 之前才到**，要先存着，`stop` 时与 `reasoning-end` 一起发。
- **`message_delta` 里的 usage 是累计值**，覆盖而不是累加。
- **没看到 `message_stop` 就断流必须当错误**，否则会把截断的回复当成完整回复。
- 流已开始后的错误以 `error` 事件到达，不是 HTTP 状态码。
- 未知事件类型要安静地忽略（文档明确说将来会新增）。

适配器对 loop 的承诺（见 [types.ts](types.ts)）：`tool-call` 只在参数完整后发一次，坏 JSON 时 `input = { __raw: 原文 }`；`finish` 至多一次且是最后一块；异常结束时以 `error` 收尾，没有 `finish`。

## 第三层：流式 loop（[loop.ts](loop.ts)）

结构与第 1 课一样，区别是"请求模型"变成边收边拼。新增三个问题：

| 情况 | 处理 | 原因 |
|---|---|---|
| 流中途断了或被取消 | 只保留已完整的文本 | 半截的 tool-call、没签名的推理留在历史里，下次请求会被拒绝 |
| `stop_reason` 是 `max_tokens` | 不执行工具，也不进历史 | 参数可能被截断，猜出来的值可能是错的 |
| 参数是坏 JSON 但 `stop_reason` 正常 | 变成错误结果回给模型 | 模型常常能用更短的参数重试 |

推理块带着签名原样进入历史，下一次请求再原样发回（有测试检查）。

结束原因分两层：`reason` 说明 loop 为什么停（`stop`/`length`/`max_steps`/`aborted`/`error`），`finishReason` 说明模型自己怎么结束。拒答时 `reason` 是 `stop`，但 `finishReason` 是 `content-filter`，只看 `reason` 会把拒答当成正常回答。

## demo 输出

```
── step 1 ──
  推理: 用户问旧金山天气，我需要调用 get_weather。
  文本: 我来查一下。
  参数碎片: {"cit | y":"旧 | 金山"}
  [assistant 完成] tool-calls, output_tokens=42
  tool.call   get_weather({"city":"旧金山"})
  tool.result ✓ 旧金山: 15°C 多云
── step 2 ──
  文本: 旧金山现在 15°C，多云。
```

demo 还会先打印前三个 11 字节的包，让你看到事件是怎么被切碎的。

## 测试（21 个）

- **SSE（2）**：任意切包结果一致（含被切开的中文）；注释行忽略、半个事件丢弃
- **适配器（10）**：文本、工具参数拼装、无参数工具、参数截断、推理签名、usage 累计、`stop_reason` 映射、未知事件忽略、中途 `error` 事件、缺 `message_stop`
- **loop（9）**：端到端（签名往返）、增量拼接一致、参数截断不执行、坏参数回给模型、流中途断开、服务端 error、流式中取消、拒答可区分、文本与 tool-call 不混块

夹具（[fixtures.ts](fixtures.ts)）按官方文档的事件格式生成字节并任意切包，走完整链路。

## 没验证的

- **没连真实 API。** 事件格式来自官方文档，夹具是按文档构造的，不是线上录制，真实流里可能有文档没写的细节。
- **只实现了 Anthropic。** OpenAI 的流式格式不同（没有内容块 `index`，工具参数按 `tool_calls[i]` 分片），这是 `docs/tasks/wave-1/01-ai.md` 里"同一配方切换两家"的难点，本课没碰。
- `pause_turn`（服务端工具循环到上限）没处理，归为 `other`。
- 没有 HTTP 层：没有重试和指数退避，没有把超出上下文窗口映射成 `context_overflow`。
- 取消只测了"文本增量到达时"，没测工具参数到达中途，或连接建立前取消。
