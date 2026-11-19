# @hue/ai 决定记录

## 1. 手写 fetch，还是封装 AI SDK 的 provider 包？

- **选项**：A 手写 fetch + SSE 解析；B 封装 `@ai-sdk/anthropic`（再桥接成 ModelPort）。
- **选了**：A。
- **为什么**：这一层最容易出错的是 tool call 流式拼装和推理签名往返，手写才讲得清、测得到。零运行时依赖也保住了 core 的"零依赖"叙事。教学版（`learn/02`、`learn/03`）已经把这套写通并验证过，迁移成本很低。
- **代价**：每加一家 provider 约 300 行（请求转换 + 流拼装）。没有 AI SDK 的社区修复，API 出新字段要自己跟（用 `providerOptions.anthropic` 逃生口缓解）。
- **何时要改**：provider 数量超过 3 家，或者要支持 Bedrock / Vertex 这类签名认证时，改为封装官方 SDK，并用同一套 `checkChunkStream` 合同兜住行为。

## 2. prompt cache 断点放哪

- **选项**：A 任务书建议：instructions 末尾 + 工具列表末尾 + 倒数第二条用户消息；B instructions 末尾 + 工具列表末尾 + **最后一条消息的最后一块**；C 不放，靠服务端自动缓存。
- **选了**：B，默认开（`cache: false` 可关）。
- **为什么**：agent 循环里下一步的请求 = 这一步全部内容 + 新增，所以最后一条消息上的断点下一步必然命中；倒数第二条用户消息会少缓存最近一轮。三个断点，低于 Anthropic 的 4 个上限。
- **代价**：每步都会写缓存（cache write 比普通输入贵）。短提示低于最小可缓存长度时断点被忽略，无害。**没有在真实 API 上验证过断点的命中率**：用户的中转站在没有断点时就已经自动缓存（第 3 课实测 cacheRead 3127）。
- **何时要改**：有真实的 `cacheReadTokens / inputTokens` 数据后。如果压缩（`@hue/context`）频繁改写历史，要把断点挪到压缩边界之前。

## 3. 是否实现 `countTokens`

- **选项**：A 实现（调 Anthropic 的 `/v1/messages/count_tokens`）；B 暂不实现，context 用估算。
- **选了**：B。
- **为什么**：`@hue/context` 还不存在，没有调用方；中转站不一定转发这个端点；`countTokens` 在 ModelPort 里本来就是可选的。
- **代价**：到压缩阈值附近只能用估算，误差会让压缩早一点或晚一点触发（晚了由 `context_overflow` 兜底）。
- **何时要改**：做 `@hue/context` 时，若估算误差影响了压缩决策。

## 4. 偏离或补充任务书的地方（Anthropic，实现时做的决定）

| 决定 | 原因 |
|---|---|
| **`temperature` 被忽略** | API 版本 `2026-10-21` 起 `temperature / top_p / top_k` 被移除，带上就是 400。`ModelSettings.temperature` 在这个 provider 上是空操作。 |
| **有 tool-call 时 `finishReason` 一律是 `tool-calls`**，包括 `stop_reason: max_tokens` | 合同要求（`checkChunkStream`）。被截断的参数已经是 `{ __raw }`，core loop 会回给模型"参数不是合法 JSON"让它重试，所以没有信息丢失。 |
| **未知模型的 `info` 保守默认（200k 上下文、8192 输出、不支持 reasoning）** | 宁可低估：低估只让压缩早一点触发，高估要等 API 报错。已知四款（fable-5-1、opus-5-5、sonnet-5-5、haiku-5-5）用官方数字：1M / 128K。 |
| **默认 `max_tokens = min(16000, info.maxOutputTokens)`** | Anthropic 的 `max_tokens` 必填且包含 thinking 的 token；给得太小，推理会吃光预算。 |
| **`reasoningTokens` 不填** | Anthropic 的 usage 不单独报推理 token（算在 `output_tokens` 里）。 |
| **`baseURL` 带不带 `/v1` 都接受** | 中转站常写成 `https://host/v1`，官方 SDK 习惯不带。 |
| **流在产出任何"用户可见"的 chunk 之前断开 → 静默重发（最多 `maxRetries` 次，退避同 HTTP 层）；产出之后断开 → 不重发** | 2026-11-13 首次真实运行里，中转站在慢请求上把流掐断（70 秒以上），loop 收到 error 块就结束整个 turn。重发只在消费者没看到重复内容时安全。**2026-11-16 修订（运行 E）**：规则从"任何 chunk"放宽到"用户可见的 chunk"（`text-delta` / `reasoning-delta` / `tool-input-delta`）。运行 E 在 313 ms、只交出 2 个协议骨架块（如 `reasoning-end`、`tool-call` 的头部）就被掐，按旧规则整个 turn 丢掉；这些骨架块重发不会让用户看到重复，所以算"没产出"。**局限**：已经开始输出正文后被掐（运行 C，1827 块）仍然不救，那要改 core。 |
| **读流中途失败 → 可重试的 error 块；取消 → 抛 `AbortError`** | 前者让 loop 看到完整的错误码；后者是合同要求，loop 靠它区分"用户打断"和"出错"。 |
| **离线 fixture 是按官方文档构造的，不是线上录制** | 任务书写的是"录制的 SSE fixture"。没有录制设施，等有真实流量再替换（见 README 的"没验证的"）。 |

## 5. OpenAI 用哪个端点族：Responses 还是 Chat Completions

- **选项**：A Responses API（`/v1/responses`，input/output items）；B Chat Completions（`/v1/chat/completions`，messages + choices）；C 两家都做，按模型挑。
- **选了**：A。
- **为什么**：官方明确 Responses 面向新项目（迁移指南"Responses is recommended for all new projects"），同一模型在 Responses 上推理质量更好（官方口径 SWE-bench +3% TODO(verify)）。对 agent 语义更合：函数调用有专用 `call_id` 配对（Chat Completions 要靠 assistant 消息里的 `tool_calls` 数组 + 消息级 `tool_call_id` 两层对齐）；推理项（reasoning item）只存在于 Responses，Chat Completions 拿不到推理状态的多轮凭据；gpt-6 系的 hosted 工具（web_search 等）也只在 Responses。工具调用的流式形态两家同构（增量 JSON 参数攒到 done），映射成本低。
- **代价**：兼容 OpenAI 协议的第三方（中转站、vLLM 等）对 Responses 的支持普遍弱于 Chat Completions，遇到不兼容时要靠 `baseURL` 指到实现了 Responses 的入口。
- **何时要改**：出现必须走 Chat Completions 的部署形态（比如某个推理框架只有 completions）时，再按同一套 ModelChunk 映射加一个后端，互不影响。

## 6. OpenAI 的多轮状态：无状态 + 加密推理回传

- **选项**：A `previous_response_id` 服务端续（store 默认 true）；B 无状态（`store: false`）+ 把 `encrypted_content` 存进 `reasoning-end.providerMetadata.openai`，下一轮原样发回。
- **选了**：B。
- **为什么**：hue 的事件日志本身就是唯一事实源，消息历史由 `fold(events)` 投影得到，服务端再存一份状态就出现了第二个事实源（换 baseURL / 中转、服务端过期 30 天都会断）。无状态模式（store:false 或 ZDR）下推理 item 默认带 `encrypted_content`，回传即等效多轮推理；官方文档给的 stateless 多轮做法就是这个。与 Anthropic 侧 `signature` / `redactedData` 的处理对称，core 不需要任何改动。
- **代价**：请求体变大（加密推理几 KB 起步）；若调用方丢了 providerMetadata，推理链断（等价于每轮重新想，不报错但降智）。
- **何时要改**：如果要复用服务端会话（比如让两次 run 共享上下文），那是 runtime / 配方层的决定，不在这层做。

## 7. OpenAI 侧实现时的具体决定

| 决定 | 原因 |
|---|---|
| **`tool_choice` 用裸字符串 `'auto' / 'none' / 'required'`，强制指定才用 `{ type: 'function', name }`** | 官方语义：对象形式里没有 `{type:'auto'}`。实测（gpt-6.1-sol，经中转）400：`Invalid value: 'auto'. Supported values are: 'code_interpreter', …, 'function', …`。glm 侧当时放过了，在线合同测试抓出来。 |
| **`temperature` 不透传** | 与 Anthropic 侧对称（新 API 不建议采样参数）；`ModelSettings.temperature` 在这个 provider 上同样是空操作。 |
| **`strict: false`（函数工具）** | strict 模式要求 schema 全量覆盖且会拒绝部分合法 schema（如 optional 字段无 default）；工具是动态注册的，不值得为此加约束转换层。要 strict 走 `providerOptions.openai`。 |
| **工具结果拼成纯字符串（text 拼接 / json 序列化 / 文件 `[file: url]` 占位）** | `function_call_output.output` 官方就是 string；图片等富内容在工具结果里本来就少见。 |
| **`reasoning.summary` 文本 → `reasoning-delta`；`encrypted_content` → `providerMetadata`** | 摘要是模型自愿给的可见概述；加密内容才是下一轮要回传的凭据。两者不混。 |
| **`response.failed` 一律 `retryable: true`；流中 `error` 事件按 code 白名单（server_error / rate_limit_exceeded / timeout / temporarily_unavailable）判 retryable** | failed 事件只有 server_error 形态；白名单外的（参数错）不该重试。 |
| **`incomplete_details.reason = 'max_output_tokens'` → `length`**；有 tool-call 时一律 `tool-calls`（含被截断的） | 与 Anthropic 侧的截断处理对齐（`{ __raw }` + 合同要求）。 |
| **usage 细分映射** | `input_tokens_details.cached_tokens` → `cacheReadTokens`；`output_tokens_details.reasoning_tokens` → `reasoningTokens`（OpenAI 把推理 token 单独报，Anthropic 不报）。 |
| **GPT-6 系已知款 info 用官方数字（1.05M 上下文 / 128K 输出），未知款保守默认** | 与 Anthropic 侧同一条哲学。gpt-6.1-sol 官方页：1,050,000 上下文、128,000 输出。 |
| **`[DONE]` 哨兵跳过** | Responses 流末尾发 `data: [DONE]`（沿用 chat completions 习惯），不是 JSON，按 SSE 注释/哨兵处理。 |
| **API key 读取顺序 `OPENAI_API_KEY` → `AI_GATEWAY_API_KEY`；baseURL 同理** | 与 cli 配方 `AI_GATEWAY_* || ANTHROPIC_*` 的约定对齐，官方变量名优先。 |

## 8. 在线实测记录（gpt-6.1-sol，经中转站 relay.zilin.im，2026-11-19）

- 合同 4 项全过：specVersion+info / 纯文本 / 强制工具往返（两轮）/ abort。
- 实测数据：纯文本首块 ~2.8s、`"ok"`、usage {in 313 / out 5}；工具往返第一轮 ~3.2s（call `get_weather {"city":"Paris"}`，finish tool-calls），第二轮（结果喂回）~2.9s、finish stop；abort 在第 2 个 chunk 后 ~2.5s 抛 `AbortError`。
- 加密推理：主动要求思考时出现 reasoning item，`encrypted_content` 进 providerMetadata，带它回传第二轮成功（finish stop）；usage 里 `reasoningTokens: 11`。
- **中转站观察（不绕、只记录）**：`tool_choice: {type:'auto'}` 这类非官方形态 glm 侧放行、gpt-6.1-sol 侧 400——修复方式是把我们的映射改成官方语义（裸字符串），不是给中转站做特判。其余请求/响应形态（SSE 事件名、usage 字段、[DONE] 哨兵、encrypted_content）与官方文档一致，未见偏差。

