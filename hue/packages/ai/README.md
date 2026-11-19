# @hue/ai

把模型统一成 core 的 `ModelPort`。目前有 Anthropic（`/v1/messages`，含兼容中转）和 OpenAI（`/v1/responses`，Responses API）。手写 fetch + SSE 解析，零运行时依赖。

```ts
import { model } from '@hue/ai'

const claude = model('anthropic:claude-haiku-5-5', {
  apiKey: process.env.AI_GATEWAY_API_KEY,    // 默认读 ANTHROPIC_API_KEY
  baseURL: process.env.AI_GATEWAY_BASE_URL,  // 默认读 ANTHROPIC_BASE_URL，再默认官方地址；带不带 /v1 都行
  thinking: { type: 'adaptive', display: 'summarized' }, // 可选
})

const gpt = model('openai:gpt-6.1-sol', {
  apiKey: process.env.OPENAI_API_KEY,        // 默认读 OPENAI_API_KEY，再退 AI_GATEWAY_API_KEY
  baseURL: process.env.OPENAI_BASE_URL,      // 默认读 OPENAI_BASE_URL，再退 AI_GATEWAY_BASE_URL，再默认官方地址
  effort: 'high',                            // 可选；'none' 关思考（发 reasoning: { effort: 'none' }）
})
// 都是 ModelPort：交给 core 的 runTurn({ model: m, ... })
```

选项：`apiKey`、`baseURL`、`maxRetries`（默认 2）、`trace`（调试钩子，默认关：看到实际发出的请求体和响应头，不含 key）。
Anthropic 另有 `anthropicVersion`（默认 `2026-10-21`）、`thinking`、`effort`、`cache`（默认 true）。
其他字段走 `settings.providerOptions.anthropic` / `.openai`，合并进各自请求体的最外层。

## 结构

```
src/
  index.ts      model(id, opts)：按前缀分发
  anthropic.ts  Anthropic ModelPort：请求 → 重试 → 字节流 → ModelChunk；失败路径都在这里
  request.ts    Hue ModelRequest → Anthropic 请求体（含 cache 断点）
  stream.ts     Anthropic SSE 事件 → ModelChunk（工具参数拼装、推理签名）
  openai/       OpenAI（Responses API）的同构实现：
    index.ts      ModelPort（与 anthropic.ts 共用 http.ts / sse.ts / 重发规则）
    request.ts    Hue ModelRequest → input items（function_call / 推理回传 / store:false）
    stream.ts     Responses SSE 事件 → ModelChunk（encrypted_content 进 providerMetadata）
  http.ts       错误分类、退避、retry-after、可取消的 sleep（两家共用）
  sse.ts        字节 → SSE 事件（两家共用）
  tooljson.ts   工具参数 JSON 文本 → input（{} / { __raw }），两家共用
  info.ts       已知模型的 contextWindow / supports
```

教学版在 [`learn/`](../../learn/README.md)，这里是它的迁移：消息和块类型换成 core 的，错误换成 `HueError`（`source: 'ai:anthropic'` / `'ai:openai'`）。

## 行为约定（两家一致）

- `tool-call` 只在参数完整后发一次；JSON 解析失败时 `input = { __raw }`，有 tool-call 时 `finishReason` 一律 `tool-calls`。
- 推理的 provider 往返：Anthropic 的 `signature` / `redactedData`、OpenAI 的 `encryptedContent`（stateless 模式下 `encrypted_content`）放进 `reasoning-end.providerMetadata`，下一轮原样发回；别家的、没凭据的推理在发出前丢掉。
- 超窗（400 + 文案）→ `context_overflow`；限流 / 5xx / 网络失败 → 先退避重试，放弃后 `model_error, retryable: true`；401 等 → `retryable: false`。
- HTTP 层的重试只发生在响应头到达之前。响应头到了之后流断开：还没产出**用户可见**的 chunk 就静默重发；已经产出过（文本、推理、工具参数）就不重发，返回可重试的 error 块。
- 取消 → 抛 `AbortError`，并释放底层连接。

## 行为约定（OpenAI 侧）

- 走 Responses API（选型理由见 [DECISIONS.md](DECISIONS.md) 第 5 条）；`store: false` + 回传 `encrypted_content` 做无状态多轮推理。
- `temperature` 不透传（OpenAI 推荐新代码不设采样参数）；`settings.maxOutputTokens` 映射 `max_output_tokens`。
- `tool_choice` 用裸字符串 `'auto' | 'none' | 'required'`，强制指定才用 `{ type: 'function', name }`（对象里没有 `{type:'auto'}` 这种形式）。
- 工具结果（`function_call_output.output`）是纯字符串：text 拼接、json 序列化、文件放 `[file: url]` 占位。
- usage 细分：`input_tokens_details.cached_tokens` → `cacheReadTokens`，`output_tokens_details.reasoning_tokens` → `reasoningTokens`。
- 未知模型的 `info` 用保守默认值（200k 上下文、8192 输出、不支持 reasoning）；GPT-6 系已知款用官方数字（1.05M / 128K）。

## 测试

```bash
cd hue
npx tsc -p packages/ai
node --import tsx --test packages/ai/test/ai.test.ts packages/ai/test/openai.test.ts   # 离线，63 个
node --import tsx --test packages/ai/test/contract.test.ts                             # 真实 API 的 ModelPort 合同（8 个，无 key skip）
```

`npm test` 会跑离线部分；真实 API 的合同没有 key 时 skip。

## 依赖

- `@hue/core`：ModelPort / 消息 / 错误类型（本仓自己的包）。
- 无第三方运行时依赖；测试用 `node:test` + 手写 mock fetch。

## 没验证的

- OpenAI：`parallel_tool_calls: false`、图片输入、`reasoning.summary` 详细档以外的档位、非英文模型名中转别名。
- Anthropic 侧原有的未验证项不变（cache 断点命中率、真实签名往返等，见 git 历史）。
- `pause_turn`（Anthropic）归为 `other`；`countTokens` 两家都未实现。
