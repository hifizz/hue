# @hue/context

## 职责
在 token 预算内决定喂给模型什么：压缩、折叠、裁剪。

## 不做
不存储（store）、不决定长期记什么（memory）。

## 接口草图（非最终）
```ts
export const compaction: {
  truncate(opts: { budget: number }): ContextPort
  summarize(opts: { budget: number; model?: ModelPort; keepLastTurns?: number }): ContextPort
  foldToolResults(opts: { budget: number; maxToolChars: number }): ContextPort
}
```

## 关键问题
- TODO(deep): 何时触发压缩——阈值（如 80%）、按轮、模型报错后？
- TODO(deep): 摘要 prompt 设计与评估——摘要丢了关键信息怎么发现（用 eval 测）
- DONE(ADR-012): 压缩结果写回日志（context.compacted 事件）
- TODO(deep): prompt caching 友好性——压缩会打破缓存前缀，代价多少
- DONE(ADR-006): token 计数用偏高的近似，不用 tokenizer（实现的系数与"字符/4"不同，见 ADR）

## 各家怎么做（对照答案）
- Pi：compaction 在 coding-agent 内 TODO(verify)
- Claude Code：auto-compact 行为 TODO(verify)
- Codex CLI：TODO(verify)

## 结论
<!-- 探索后回填：选了什么、为什么、代价、对应 ADR -->

## 验收
长任务（> 预算 3 倍）能跑完；三种策略在 eval 上有对比数据

## 对应 JD
上下文

## 博客素材
<!-- 构建日志里值得写的坑与数据 -->
