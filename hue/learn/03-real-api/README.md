# 第 3 课：接真实 API

文件：[request.ts](request.ts) · [http.ts](http.ts) · [client.ts](client.ts) · [http-fixtures.ts](http-fixtures.ts) · [live-demo.ts](live-demo.ts) · [real-api.test.ts](real-api.test.ts)

前两课都没有网络。这一课补上"和真实服务打交道"的那一层，也就是 `@hue/ai` 任务书里要求的消息转换、重试、错误映射、取消。成功路径几乎没有新逻辑，新东西都在失败路径上。

## 四层结构

```
ModelRequest ─toAnthropicBody─▶ JSON ─fetchWithRetry─▶ Response ─bodyBytes─▶ 字节 ─parseSSE─▶ ─toChunks─▶ Chunk
  request.ts                              http.ts          client.ts            └──── 第 2 课 ────┘
```

## 第一层：请求体（[request.ts](request.ts)）

第 2 课把 provider 的碎片拼成我们的消息，这里反过来拆回去。两个方向必须互为逆运算。

| 我们的消息 | Anthropic 的格式 |
|---|---|
| `user` | `user` + `text` 块 |
| `assistant` 的文本 | `text` 块 |
| `assistant` 的 tool-call | `tool_use` 块 `{id, name, input}` |
| `assistant` 的推理 | `thinking` 块 `{thinking, signature}`，或 `redacted_thinking` 块 `{data}` |
| `tool`（一步里所有结果） | **一条 `user` 消息**，里面一组 `tool_result` 块，用 `tool_use_id` 对应回去 |

几条来自官方文档的规则（出处见文末），每条都有测试：

- **推理块必须原样发回。** 改、重排、过滤、重新构造都会 400。签名为空串的 `thinking` 文本（`display: "omitted"`）也要发，真正被校验的是 `signature`。没有签名的（别家 provider 的、没收完的）只能丢掉，发出去也是 400。
- **`redacted_thinking` 也要带上。** 它没有 `thinking_delta`，内容是 `start` 里一次给全的 `data`。第 2 课原来没存它，多轮工具循环会断。这一课修了，见下文。
- **最后一条必须是 user。** 新模型不支持 assistant 预填，本地先拦住，不浪费一次往返。
- **不能带 `temperature`、`top_p`、`top_k`。** 官方文档记录 API 版本 `2026-10-21` 起移除这三个参数，任何一个都是 400。
- **`max_tokens` 必填**，thinking 的 token 也算在里面，默认给 16000。

## 第二层：HTTP（[http.ts](http.ts)）

### 错误分类

| 状态码 | 含义 | 重试？ |
|---|---|---|
| 400 | 请求本身有问题 | 否。文案是超窗时标 `context_overflow` |
| 401 / 403 | 密钥或权限 | 否 |
| 402 | 账单 | 否 |
| 404 / 413 | 资源不存在 / 请求太大 | 否 |
| 429 | 限流 | 是 |
| 500 / 504 / 529 | 服务端 / 超时 / 过载 | 是 |
| 502 / 503 / 408 | 网关与超时的常见形态 | 是 |

网关或中转返回的可能是 HTML 而不是 JSON，所以解析失败要兜底，不能崩。

### 重试策略

- **指数退避 + 抖动**：等待 500ms、1s、2s……乘一个 0.5 到 1 的随机系数，避免大量客户端同时重试。
- **优先听服务端的 `retry-after`**（秒数或 HTTP 日期）。
- **等待时间超过上限（默认 30s）就不等了**，直接报错。官方文档提到，额度用完的 429 没有 `retry-after` 并且会一直失败；交互式 agent 等不起，也没必要等。
- **取消必须能打断等待**：退避睡眠用的是可取消的 `sleep`。

### 一个关键边界：只在"响应开始之前"重试

HTTP 200 一旦开始流出，delta 已经交给了消费者，UI 已经显示了半句话。这时重试会让文本重复。所以**流中途的错误**（比如 `overloaded_error` 事件）**不在这一层重试**，而是作为带 `retryable: true` 的 error 块交给上层决定。有测试专门验证：这种情况下只发一次请求。

## 第三层：client（[client.ts](client.ts)）

把四层接起来，有两个值得注意的点：

- **失败怎么表达。** API 层面的失败（HTTP 出错、网络不通、本地校验不通过）变成 `error` 块，带 `code` 和 `retryable`；**取消和意外异常原样抛出**。这样 loop 能区分"用户要我停"和"服务出问题了"。
- **连接要释放。** `bodyBytes` 的 `finally` 里调 `reader.cancel()`。消费者提前停止（看到 `finish` 就 break、被取消）时，不 cancel 的话底层 HTTP 连接会挂着，直到服务端把整个回复发完。

## 对第 2 课的两处修改

写这一课时发现第 2 课有缺陷，已修复并各加了测试：

1. **`redacted_thinking` 没存 `data`**，多轮会 400。现在 `reasoning-end` 的 `providerMetadata` 带 `{ anthropic: { redactedData } }`。
2. **`error` 块没有 `code` 和 `retryable`。** 现在是可选字段，不影响原有用法。流中途的 `overloaded_error`、`api_error`、`rate_limit_error`、`timeout_error` 标为可重试。

## 测试（32 个）

- **请求体（4）**：四种消息转换、丢弃规则、字段与默认值（含"没有被移除的采样参数"）、预填拦截
- **错误分类（5）**：状态码表、超窗、非 JSON 响应、`retry-after` 两种写法、可取消的 sleep
- **client（7）**：URL 和头、默认值、成功路径、各种取消、连接释放
- **重试（9）**：指数退避、`retry-after`、上限、401 不重试、用尽后放弃、`maxRetries: 0`、网络错误、超窗、流中途不重试
- **端到端（4）**：签名往返、redacted 往返、401、529 重试对 loop 透明
- **真实 API（1）**：有 `ANTHROPIC_API_KEY` 才跑，否则 skip

测试用的是**真的 `Response` 和 `ReadableStream`**，所以 `reader.cancel` 这类行为也是真的在被测。我另外做了变异检查：临时去掉 `reader.cancel`、去掉 `redactedData`、去掉等待上限、丢掉 thinking 块，各自都会让对应的测试变红。

## 运行

```bash
node --import tsx --test learn/03-real-api/real-api.test.ts      # 离线
ANTHROPIC_API_KEY=... npx tsx learn/03-real-api/live-demo.ts     # 真实调用，会产生少量费用
```

## 没验证的

- **没有连过真实 API。** 开发时环境里没有 `ANTHROPIC_API_KEY`，真实调用的测试被 skip，`live-demo.ts` 也没跑过。所有请求和响应格式都来自官方文档，夹具是按文档构造的，不是线上录制。真实流里可能有文档没写的细节。
- **超窗的 400 文案是启发式匹配。** 官方错误文档没有给出确切文案，代码按 `prompt is too long`、`context window`、`context length` 匹配，这些措辞来自经验，不是文档。新模型超窗走的是 `stop_reason`，不是错误。
- **`redacted_thinking` 的 `data` 在 `content_block_start` 里一次给全**，这一点来自文档对该块类型的描述和 AI SDK 的做法，没有对照真实流验证。
- **loop 还没用 `code` 和 `retryable`。** 第 2 课的 loop 只读 `message`，`LoopResult.error` 是字符串。core 里超窗靠 `context_overflow` 触发压缩重试，这一课没有压缩，所以先不接。
- **只有 Anthropic。** OpenAI 的流式格式和请求格式都不同，这是"同一配方切换两家"的难点，仍然没碰。
- **没有 prompt cache 断点。** 任务书把 `cache_control` 放在哪列为待决定项，这一课没做。`usage` 里已经能读到 cache 的读写 token。
- **`pause_turn` 仍未处理。**
- **API 版本默认值 `2026-10-21` 取自官方文档**，如果你用的中转只认旧版本，用 `anthropicVersion` 覆盖。

## 出处

- API 版本与移除的采样参数：Anthropic 官方 Versions 页面
- 错误码、错误体形状、thinking 块不可修改、预填不支持：Anthropic 官方 API errors 页面
- 流式事件、`redacted_thinking`：Anthropic 官方 Streaming messages 与 Thinking 页面
