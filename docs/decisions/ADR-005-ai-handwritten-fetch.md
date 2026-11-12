# ADR-005 @hue/ai 手写 fetch + SSE，不封装 AI SDK
- 状态：已接受（2026-11-12 回填，2026-11-12 经用户阅读确认）
- 包：@hue/ai
- 来源标记：`DECIDE: 直接封装 AI SDK provider 还是 pi-ai。求职版不在这层花时间`（docs/packages/ai.md:15）

## 问题
ModelPort 的实现，是封装现成的 provider 包，还是自己调 HTTP？

## 候选
1. 封装 `@ai-sdk/anthropic`，再桥接成 ModelPort。
2. 手写 fetch + SSE 解析。
3. 封装 pi-ai（设计页提过，`TODO(verify)`，没有评估过）。

## 各家怎么做（附出处）
没有核实过。教学版 `learn/02`、`learn/03` 已经把手写版跑通。

## 决定
选 2。这一层最容易出错的是 tool call 流式拼装和推理签名往返，手写才讲得清、测得到；也保住 core "零依赖"的叙事。教学版已验证，迁移成本低。

当前只实现了 Anthropic，`model('openai:…')` 抛"未实现"，所以验收里"同一配方切换两家"**还没满足**。

## 代价
每加一家 provider 约 300 行（请求转换 + 流拼装）。没有 AI SDK 的社区修复，API 出新字段要自己跟（用 `providerOptions.anthropic` 缓解）。

## 何时要改
provider 超过 3 家，或要支持 Bedrock / Vertex 这类签名认证时，改为封装官方 SDK，并用同一套 `checkChunkStream` 合同兜住行为。

## 如何验证（eval / 测试）
- 离线 fixture 测试（按官方文档构造，不是线上录制）。
- 在线的 `modelPortContract`（4 个测试）一直是 skip，没跑过；thinking 签名往返没实测。
