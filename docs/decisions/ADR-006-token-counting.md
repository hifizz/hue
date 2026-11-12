# ADR-006 token 计数：context 里用偏高的近似，不依赖 provider 的计数端点
- 状态：已接受（2026-11-12 回填，2026-11-12 经用户阅读确认）
- 包：@hue/context（以及 @hue/ai 的 `countTokens`）
- 来源标记：`DECIDE: token 计数放这里还是 context`（docs/packages/ai.md:16）；`DECIDE: token 计数——近似（字符/4）还是 tokenizer`（docs/packages/context.md:23）

## 问题
压缩要知道"现在多少 token"。谁来数、怎么数？

## 候选
1. `@hue/ai` 实现 `countTokens`，调 Anthropic 的 `/v1/messages/count_tokens`。
2. `@hue/context` 里用近似估算。
3. 引入 tokenizer 库。

## 各家怎么做（附出处）
没有核实过。

## 决定
选 2，`ModelPort.countTokens` 保持可选且 ai 暂不实现（ai DECISIONS 第 3 条）。估算**故意偏高**：ASCII 每字符 0.3 个 token，非 ASCII 每字符 1 个，每条消息加固定开销，图片 / 文件按 1500 算，推理块签名也算（context DECISIONS 第 3 条）。
- 为什么偏高：估高只会让压缩早一点，估低要等 API 报错才发现，那时已浪费一次请求（报错由 `context_overflow` 重试兜底）。
- 为什么不用计数端点：中转站不一定转发；当时 context 还没有调用方。
- 为什么不用 tokenizer：零依赖。

## 代价
英文代码按约 3.5 字符一个 token 算，偏高约 5%，会比必要的略早压；这个 3.5 也是经验值，**没量过**。中文偏高不多。

## 何时要改
接了计数端点，或拿到估算与 `usage.inputTokens` 的真实对比数据之后。

## 如何验证（eval / 测试）
- `context/test/context.test.ts` 检查估算的基本性质（每条消息有固定开销、推理签名计入）；**没有和真实 `usage.inputTokens` 对比过**，这是待办。
