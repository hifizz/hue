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
<!-- 探索后回填：选了什么、为什么、代价、对应 ADR -->

## 验收
同一配方切换两家模型无需改其他代码

## 对应 JD
工程基本功

## 博客素材
<!-- 构建日志里值得写的坑与数据 -->
