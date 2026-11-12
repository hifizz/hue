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
- DONE(ADR-005): 手写 fetch + SSE，不封装 AI SDK provider，也没评估 pi-ai
- DONE(ADR-006): 计数放 context（近似）；`countTokens` 在 ai 里保持可选、暂不实现
- LATER: 自己实现 Anthropic/OpenAI 原生 provider（适合写一篇拆解）

## 各家怎么做（对照答案）
- AI SDK：LanguageModelV2/V3 规范带版本号 TODO(verify)
- pi-ai：统一多家 provider TODO(verify)

## 结论
手写 fetch + SSE，先只做 Anthropic；决定记录见 `hue/packages/ai/DECISIONS.md`。

## 验收
同一配方切换两家模型无需改其他代码

## 对应 JD
工程基本功

## 博客素材
<!-- 构建日志里值得写的坑与数据 -->
