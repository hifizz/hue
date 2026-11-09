# @hue/ai

把模型统一成 core 的 `ModelPort`。目前只有 Anthropic（含兼容 `/v1/messages` 的中转站）。手写 fetch + SSE 解析，零运行时依赖。

```ts
import { model } from '@hue/ai'

const m = model('anthropic:claude-haiku-5-5', {
  apiKey: process.env.AI_GATEWAY_API_KEY,    // 默认读 ANTHROPIC_API_KEY
  baseURL: process.env.AI_GATEWAY_BASE_URL,  // 默认读 ANTHROPIC_BASE_URL，再默认官方地址；带不带 /v1 都行
  thinking: { type: 'adaptive', display: 'summarized' }, // 可选
})
// m 是 ModelPort：交给 core 的 runTurn({ model: m, ... })
```

选项：`apiKey`、`baseURL`、`maxRetries`（默认 2）、`anthropicVersion`（默认 `2026-10-21`）、`thinking`、`effort`、`cache`（默认 true）。
其他 Anthropic 字段走 `settings.providerOptions.anthropic`，会合并进请求体最外层。

## 结构

```
src/
  index.ts      model(id, opts)：按前缀分发
  anthropic.ts  ModelPort：请求 → 重试 → 字节流 → ModelChunk；失败路径都在这里
  request.ts    Hue ModelRequest → Anthropic 请求体（含 cache 断点）
  stream.ts     Anthropic SSE 事件 → ModelChunk（工具参数拼装、推理签名）
  http.ts       错误分类、退避、retry-after、可取消的 sleep
  sse.ts        字节 → SSE 事件
  info.ts       已知模型的 contextWindow / supports
```

教学版在 [`learn/`](../../learn/README.md)，这里是它的迁移：消息和块类型换成 core 的，错误换成 `HueError`（`source: 'ai:anthropic'`）。

## 行为约定

- `tool-call` 只在参数完整后发一次；JSON 解析失败时 `input = { __raw }`，有 tool-call 时 `finishReason` 一律 `tool-calls`。
- 推理块的 `signature` / `redactedData` 放进 `reasoning-end.providerMetadata.anthropic`，下一轮原样发回；别家的、没签名的推理在发出前丢掉。
- 超窗（400 + 文案）→ `context_overflow`；限流 / 5xx / 网络失败 → 先退避重试，放弃后 `model_error, retryable: true`；401 等 → `retryable: false`。
- 重试只发生在响应开始之前。流中途的错误不重试（delta 已经交给消费者，重试会让文本重复）。
- 取消 → 抛 `AbortError`，并释放底层连接。
- **`temperature` 被忽略**（API 版本 `2026-10-21` 起已移除）。
- 未知模型的 `info` 用保守默认值（200k 上下文、8192 输出、不支持 reasoning），详见 [DECISIONS.md](DECISIONS.md)。

## 测试

```bash
cd hue
npx tsc -p packages/ai
node --import tsx --test packages/ai/test/*.test.ts                                   # 离线，35 个
node --env-file=.env.local --import tsx --test packages/ai/test/contract.test.ts      # 真实 API 的 ModelPort 合同（4 个）
```

`npm test` 会跑离线部分；真实 API 的合同没有 key 时 skip。

## 没验证的

- **真实 API 的 `modelPortContract` 还没跑过**（需要带 key 运行上面第三条命令）。教学版对中转站做过一次真实工具往返，但新包的 cache 断点、`tool_choice` 强制调用、取消都没在线上验证。
- **thinking 签名往返没有用真实数据验证过**：第 3 课那次实测没有出现推理块。
- **fixture 是按官方文档构造的，不是线上录制。**
- **没有 OpenAI。** 验收标准"同一配方切换两家"尚未满足。
- `pause_turn` 归为 `other`；`countTokens` 未实现；强制 `tool_choice` 与 thinking 同时开会被 API 拒绝（合同的强制调用测试用默认配置，不开 thinking）。
