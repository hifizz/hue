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

## 4. 偏离或补充任务书的地方（实现时做的决定）

| 决定 | 原因 |
|---|---|
| **只实现了 Anthropic，`model('openai:…')` 抛"未实现"** | 先让一个 agent 能跑（根目录 README 的顺序）。验收里"同一配方切换两家"**尚未满足**。 |
| **`temperature` 被忽略** | API 版本 `2026-10-21` 起 `temperature / top_p / top_k` 被移除，带上就是 400。`ModelSettings.temperature` 在这个 provider 上是空操作。 |
| **有 tool-call 时 `finishReason` 一律是 `tool-calls`**，包括 `stop_reason: max_tokens` | 合同要求（`checkChunkStream`）。被截断的参数已经是 `{ __raw }`，core loop 会回给模型"参数不是合法 JSON"让它重试，所以没有信息丢失。 |
| **未知模型的 `info` 保守默认（200k 上下文、8192 输出、不支持 reasoning）** | 宁可低估：低估只让压缩早一点触发，高估要等 API 报错。已知四款（fable-5-1、opus-5-5、sonnet-5-5、haiku-5-5）用官方数字：1M / 128K。 |
| **默认 `max_tokens = min(16000, info.maxOutputTokens)`** | Anthropic 的 `max_tokens` 必填且包含 thinking 的 token；给得太小，推理会吃光预算。 |
| **`reasoningTokens` 不填** | Anthropic 的 usage 不单独报推理 token（算在 `output_tokens` 里）。 |
| **`baseURL` 带不带 `/v1` 都接受** | 中转站常写成 `https://host/v1`，官方 SDK 习惯不带。 |
| **读流中途失败 → 可重试的 error 块；取消 → 抛 `AbortError`** | 前者让 loop 看到完整的错误码；后者是合同要求，loop 靠它区分"用户打断"和"出错"。 |
| **离线 fixture 是按官方文档构造的，不是线上录制** | 任务书写的是"录制的 SSE fixture"。没有录制设施，等有真实流量再替换（见 README 的"没验证的"）。 |
