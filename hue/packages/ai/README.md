# @hue/ai

把模型统一成 core 的 `ModelPort`。目前只有 Anthropic（Messages API，流式）。

## 是什么

```ts
import { ai } from '@hue/ai'

const model = ai('anthropic:claude-sonnet-4') // 读 ANTHROPIC_API_KEY
for await (const chunk of model.stream(request, signal)) {
  // text-delta / tool-call / finish / error …
}
```

## 结构（一次请求的旅程）

```
anthropic.ts          入口：ai() 工厂 + streamMessages（fetch POST /v1/messages）
  ├─ http.ts            响应字节流 → SSE；HTTP 错误 → ModelChunk.error（带 retryable）
  ├─ sse.ts             字节 → SSE 消息（攒缓冲区，处理包边界切开的多字节字符）
  ├─ anthropic-events.ts Anthropic 事件 → ModelChunk（tool-call 攒到 block stop 才解析）
  └─ convert.ts         Hue 消息 → Anthropic 请求体（system 提升、tool_result 换 role）
```

## 依赖及理由

- `@hue/core`：类型与合同（ModelPort / ModelChunk / HueError）。core 是唯一依赖，本包零第三方运行时依赖——Anthropic 的 HTTP+SSE 协议用 Node 内置 fetch 就够了（≥ 20.3），不值得为它引入 SDK；这也是 docs/packages/ai.md 里 DECIDE 项「自己实现原生 provider」的探索。

## 测试

- `test/anthropic.test.ts`：事件流离线回放（11 字节切包、坏 JSON、断流、usage 累计语义），走与线上完全相同的 `parseSSE → toModelChunks` 代码路径。
- `test/convert.test.ts`：消息转换全分支。
- `test/anthropic-port.test.ts`：fetch mock 测请求头、URL、错误翻译。
- `test/contracts.test.ts`：`modelPortContract` 真实调用，没有 `ANTHROPIC_API_KEY` 时自动 skip。

## 边界（有意不做）

- 不做 OpenAI 等其他 provider（docs/packages/ai.md 验收标准是「切换两家无需改其他代码」，等第二家出现时再抽公共层，避免过早抽象）。
- 不做重试（错误带 `retryable` 标记，策略归上层）。
- 不处理 `pause_turn`（映射为 `other`，需要时再把「把内容发回去继续」做成显式分支）。
