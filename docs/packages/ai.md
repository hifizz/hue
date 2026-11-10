# @hue/ai

## 职责
把各家模型统一成 core 的 ModelPort。

## 不做
不做重试策略以外的业务逻辑；不做 prompt 拼装。

## 接口草图（非最终）
```ts
export function ai(id: `${string}:${string}`, opts?: ProviderOptions): ModelPort
```

## 关键问题
- DECIDE: 直接封装 AI SDK provider 还是 pi-ai。求职版不在这层花时间
- DECIDE: token 计数放这里还是 context
- LATER: 自己实现 Anthropic/OpenAI 原生 provider（适合写一篇拆解）

## 各家怎么做（对照答案）
- AI SDK：LanguageModelV2/V3 规范带版本号 TODO(verify)
- pi-ai：统一多家 provider TODO(verify)

## 结论
- 选型（2026-11 交付）：不引 SDK。@hue/ai = fetch + 手写 SSE 解析 + Anthropic 事件折叠，产出 core 的 ModelChunk；运行时零第三方依赖（只有 @hue/core 类型）。
- 为什么：包哲学是“一下午能读完”；Anthropic 的流式协议一个文件讲得清（learn/02-streaming 已验证过一遍），SDK 会把“事件→chunk”的关键黑盒藏起来。
- 代价：换 provider 要再写一个文件；没有内建重试（错误带 retryable 标记上抛，策略归上层）；thinking 只做透传映射，不主动开启。
- 细节与何时改：见 packages/ai/DECISIONS.md。接口按草图落地为 `ai(id): ModelPort | undefined`，缺凭据返回 undefined（合同测试 skip 用）。

## 验收
- 离线：11 字节切包回放（含中文切碎）→ `checkChunkStream` 通过；坏 JSON/断流都走 error 收尾。
- 在线：`modelPortContract` 真实调用，无 `ANTHROPIC_API_KEY` 自动 skip（contracts.test.ts）。

## 对应 JD
工程基本功

## 博客素材
<!-- 构建日志里值得写的坑与数据 -->
